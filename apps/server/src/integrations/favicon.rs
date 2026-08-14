use std::sync::LazyLock;

use regex::Regex;
use reqwest::{header::CONTENT_TYPE, redirect::Policy, Client};
use sqlx::{query, query_scalar, PgPool};
use time::{Duration, OffsetDateTime};

const FETCH_TIMEOUT_SECONDS: u64 = 5;
const MAX_DOWNLOAD_BYTES: usize = 1_000_000;
const MAX_FAILURE_BACKOFF_MINUTES: i64 = 7 * 24 * 60;
const MIN_FAILURE_BACKOFF_MINUTES: i64 = 10;

#[derive(Debug, Clone)]
pub struct FaviconImage {
    pub data: Vec<u8>,
    pub content_type: String,
}

#[derive(Clone, Copy)]
pub enum RemoteDocumentKind {
    Html,
    Image,
}

pub struct RemoteDocument {
    pub data: Vec<u8>,
    pub content_type: String,
}

#[async_trait::async_trait]
pub trait RemoteDocumentFetcher: Send + Sync {
    async fn fetch(
        &self,
        url: &str,
        kind: RemoteDocumentKind,
    ) -> Result<Option<RemoteDocument>, Box<dyn std::error::Error + Send + Sync>>;
}

pub struct ReqwestRemoteDocumentFetcher {
    client: Client,
}

impl ReqwestRemoteDocumentFetcher {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(FETCH_TIMEOUT_SECONDS))
                .redirect(Policy::limited(5))
                .build()
                .expect("favicon http client should build"),
        }
    }
}

#[async_trait::async_trait]
impl RemoteDocumentFetcher for ReqwestRemoteDocumentFetcher {
    async fn fetch(
        &self,
        url: &str,
        kind: RemoteDocumentKind,
    ) -> Result<Option<RemoteDocument>, Box<dyn std::error::Error + Send + Sync>> {
        let mut response = self.client.get(url).send().await?;
        if !response.status().is_success() {
            return Ok(None);
        }
        let content_type = sanitize_content_type(
            response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            url,
        );
        match kind {
            RemoteDocumentKind::Html if !content_type.contains("text/html") => return Ok(None),
            RemoteDocumentKind::Image if !content_type.starts_with("image/") => return Ok(None),
            _ => {}
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_DOWNLOAD_BYTES as u64)
        {
            return Ok(None);
        }
        let mut data = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if data.len() + chunk.len() > MAX_DOWNLOAD_BYTES {
                return Ok(None);
            }
            data.extend_from_slice(&chunk);
        }
        if data.is_empty() {
            return Ok(None);
        }
        Ok(Some(RemoteDocument { data, content_type }))
    }
}

#[derive(Debug, sqlx::FromRow)]
struct DbFaviconRow {
    image_data: Option<Vec<u8>>,
    content_type: Option<String>,
    status: String,
    failed_at: Option<OffsetDateTime>,
    fail_count: i32,
}

pub fn normalize_favicon_domain(input: &str) -> Option<String> {
    let candidate = input.trim().to_ascii_lowercase();
    if candidate.is_empty() || candidate.len() > 255 {
        return None;
    }
    let candidate_url = if candidate.contains("://") {
        candidate.clone()
    } else {
        format!("https://{candidate}")
    };

    let hostname = url::Url::parse(&candidate_url)
        .ok()?
        .host_str()?
        .to_ascii_lowercase()
        .trim_end_matches('.')
        .to_string();

    if hostname.is_empty()
        || hostname.len() > 253
        || !hostname
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
    {
        return None;
    }

    let labels = hostname.split('.');
    for label in labels {
        if label.is_empty() || label.len() > 63 || label.starts_with('-') || label.ends_with('-') {
            return None;
        }
    }

    Some(hostname)
}

pub async fn get_fetched_favicon(
    pool: &PgPool,
    domain: &str,
) -> Result<Option<FaviconImage>, sqlx::Error> {
    let existing = sqlx::query_as::<_, DbFaviconRow>(
		"SELECT image_data, content_type, status::text AS status, failed_at, fail_count FROM favicon WHERE domain = $1 LIMIT 1",
	)
	.bind(domain)
	.fetch_optional(pool)
	.await?;

    let Some(existing) = existing else {
        return Ok(None);
    };

    if existing.status != "fetched" {
        return Ok(None);
    }

    let Some(data) = existing.image_data else {
        return Ok(None);
    };

    Ok(Some(FaviconImage {
        data,
        content_type: existing
            .content_type
            .unwrap_or_else(|| "image/x-icon".to_string()),
    }))
}

pub async fn list_domains_to_refresh(
    pool: &PgPool,
    limit: i64,
    stale_before: OffsetDateTime,
) -> Result<Vec<String>, sqlx::Error> {
    query_scalar::<_, String>(
		"SELECT domain FROM favicon WHERE (status = 'fetched' AND fetched_at < $1) OR status = 'failed' LIMIT $2",
	)
	.bind(stale_before)
	.bind(limit)
	.fetch_all(pool)
	.await
}

pub async fn fetch_and_store_favicon(
    pool: &PgPool,
    fetcher: &dyn RemoteDocumentFetcher,
    domain: &str,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    let existing = sqlx::query_as::<_, DbFaviconRow>(
		"SELECT image_data, content_type, status::text AS status, failed_at, fail_count FROM favicon WHERE domain = $1 LIMIT 1",
	)
	.bind(domain)
	.fetch_optional(pool)
	.await?;

    if let Some(existing) = &existing {
        if existing.status == "fetched"
            && existing
                .image_data
                .as_ref()
                .is_some_and(|data| !data.is_empty())
        {
            return Ok(true);
        }

        if existing.status == "failed" {
            if let Some(failed_at) = existing.failed_at {
                let backoff = compute_failure_backoff_minutes(existing.fail_count.max(1));
                let retry_after = failed_at + Duration::minutes(backoff);
                if retry_after > OffsetDateTime::now_utc() {
                    return Ok(false);
                }
            }
        }
    }

    upsert_pending(pool, domain).await?;

    match resolve_candidate_urls(fetcher, domain).await {
        Ok(candidates) => {
            for candidate in candidates {
                if let Ok(Some(document)) =
                    fetcher.fetch(&candidate, RemoteDocumentKind::Image).await
                {
                    mark_fetched(pool, domain, &document.data, &document.content_type).await?;
                    return Ok(true);
                }
            }

            mark_failed(pool, domain).await?;
            Ok(false)
        }
        Err(_) => {
            mark_failed(pool, domain).await?;
            Ok(false)
        }
    }
}

async fn resolve_candidate_urls(
    fetcher: &dyn RemoteDocumentFetcher,
    domain: &str,
) -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
    let direct_favicon = format!("https://{domain}/favicon.ico");
    let homepage_url = format!("https://{domain}/");
    let apple_touch_icon = format!("https://{domain}/apple-touch-icon.png");

    let mut html_icon_links = Vec::new();
    if let Some(document) = fetcher
        .fetch(&homepage_url, RemoteDocumentKind::Html)
        .await?
    {
        html_icon_links =
            extract_icon_links(&String::from_utf8_lossy(&document.data), &homepage_url);
    }

    let mut candidates = Vec::with_capacity(2 + html_icon_links.len());
    candidates.push(direct_favicon);
    candidates.extend(html_icon_links);
    candidates.push(apple_touch_icon);
    Ok(candidates)
}

fn extract_icon_links(html: &str, base_url: &str) -> Vec<String> {
    static RE_LINK: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"<link\b[^>]*>"#).expect("link regex should compile"));
    static RE_REL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"\brel\s*=\s*(?:"([^"]*)"|'([^']*)')"#).expect("rel regex should compile")
    });
    static RE_HREF: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')"#).expect("href regex should compile")
    });

    let mut links = Vec::new();
    for tag_match in RE_LINK.find_iter(html) {
        let tag = tag_match.as_str();
        let Some(rel_capture) = RE_REL.captures(tag) else {
            continue;
        };
        let rel_value = rel_capture
            .get(1)
            .or_else(|| rel_capture.get(2))
            .map(|value| value.as_str().to_ascii_lowercase())
            .unwrap_or_default();
        if !rel_value.contains("icon") {
            continue;
        }

        let Some(href_capture) = RE_HREF.captures(tag) else {
            continue;
        };
        let Some(href) = href_capture
            .get(1)
            .or_else(|| href_capture.get(2))
            .map(|value| value.as_str().trim())
        else {
            continue;
        };

        if let Ok(resolved) = url::Url::parse(base_url).and_then(|base| base.join(href)) {
            if matches!(resolved.scheme(), "http" | "https") {
                links.push(resolved.to_string());
            }
        }
    }

    links.sort();
    links.dedup();
    links
}

fn sanitize_content_type(content_type: Option<&str>, fallback_url: &str) -> String {
    content_type
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_else(|| infer_content_type(fallback_url))
}

fn infer_content_type(url: &str) -> String {
    if url.ends_with(".png") {
        "image/png".to_string()
    } else if url.ends_with(".svg") {
        "image/svg+xml".to_string()
    } else if url.ends_with(".ico") {
        "image/x-icon".to_string()
    } else {
        "application/octet-stream".to_string()
    }
}

fn compute_failure_backoff_minutes(fail_count: i32) -> i64 {
    let step = (fail_count - 1).max(0) as u32;
    (MIN_FAILURE_BACKOFF_MINUTES * 2_i64.pow(step)).min(MAX_FAILURE_BACKOFF_MINUTES)
}

async fn upsert_pending(pool: &PgPool, domain: &str) -> Result<(), sqlx::Error> {
    query(
		"INSERT INTO favicon (domain, status, updated_at) VALUES ($1, 'pending', $2) ON CONFLICT (domain) DO UPDATE SET status = 'pending', updated_at = EXCLUDED.updated_at",
	)
	.bind(domain)
	.bind(OffsetDateTime::now_utc())
	.execute(pool)
	.await?;
    Ok(())
}

async fn mark_fetched(
    pool: &PgPool,
    domain: &str,
    data: &[u8],
    content_type: &str,
) -> Result<(), sqlx::Error> {
    let now = OffsetDateTime::now_utc();
    query(
		"UPDATE favicon SET status = 'fetched', image_data = $1, content_type = $2, fetched_at = $3, failed_at = NULL, fail_count = 0, updated_at = $3 WHERE domain = $4",
	)
	.bind(data)
	.bind(content_type)
	.bind(now)
	.bind(domain)
	.execute(pool)
	.await?;
    Ok(())
}

async fn mark_failed(pool: &PgPool, domain: &str) -> Result<(), sqlx::Error> {
    let now = OffsetDateTime::now_utc();
    query(
		"INSERT INTO favicon (domain, status, failed_at, fail_count, updated_at) VALUES ($1, 'failed', $2, 1, $2) ON CONFLICT (domain) DO UPDATE SET status = 'failed', failed_at = EXCLUDED.failed_at, fail_count = favicon.fail_count + 1, updated_at = EXCLUDED.updated_at",
	)
	.bind(domain)
	.bind(now)
	.execute(pool)
	.await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_favicon_domain, resolve_candidate_urls, RemoteDocument, RemoteDocumentFetcher,
        RemoteDocumentKind, ReqwestRemoteDocumentFetcher, MAX_DOWNLOAD_BYTES,
    };
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    struct StubFetcher {
        fail: bool,
    }

    #[async_trait::async_trait]
    impl RemoteDocumentFetcher for StubFetcher {
        async fn fetch(
            &self,
            _url: &str,
            kind: RemoteDocumentKind,
        ) -> Result<Option<RemoteDocument>, Box<dyn std::error::Error + Send + Sync>> {
            if self.fail {
                return Err("remote failure".into());
            }
            Ok(
                matches!(kind, RemoteDocumentKind::Html).then(|| RemoteDocument {
                    data: br#"<link rel="icon" href="/brand.png">"#.to_vec(),
                    content_type: "text/html".into(),
                }),
            )
        }
    }

    #[test]
    fn normalizes_valid_domains() {
        assert_eq!(
            normalize_favicon_domain("HTTPS://Example.COM./favicon.ico"),
            Some("example.com".to_string())
        );
    }

    #[test]
    fn rejects_invalid_domains() {
        assert_eq!(normalize_favicon_domain("not a domain"), None);
        assert_eq!(normalize_favicon_domain("-example.com"), None);
    }

    #[tokio::test]
    async fn candidate_resolution_uses_injected_fetcher() {
        let candidates = resolve_candidate_urls(&StubFetcher { fail: false }, "example.com")
            .await
            .expect("stub fetch should succeed");
        assert!(candidates.contains(&"https://example.com/brand.png".to_string()));
    }

    #[tokio::test]
    async fn candidate_resolution_propagates_fetch_failures() {
        assert!(
            resolve_candidate_urls(&StubFetcher { fail: true }, "example.com")
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn production_fetcher_rejects_declared_oversized_documents() {
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\n\r\n",
            MAX_DOWNLOAD_BYTES + 1
        );
        let (url, server) = spawn_response(response.into_bytes());
        let result = ReqwestRemoteDocumentFetcher::new()
            .fetch(&url, RemoteDocumentKind::Image)
            .await
            .expect("request should complete");
        assert!(result.is_none());
        server.join().expect("server should finish");
    }

    #[tokio::test]
    async fn production_fetcher_stops_streaming_oversized_chunked_documents() {
        let chunk = vec![b'x'; MAX_DOWNLOAD_BYTES / 2 + 1];
        let mut response =
            b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nTransfer-Encoding: chunked\r\n\r\n"
                .to_vec();
        for _ in 0..2 {
            response.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
            response.extend_from_slice(&chunk);
            response.extend_from_slice(b"\r\n");
        }
        response.extend_from_slice(b"0\r\n\r\n");
        let (url, server) = spawn_response(response);
        let result = ReqwestRemoteDocumentFetcher::new()
            .fetch(&url, RemoteDocumentKind::Image)
            .await
            .expect("request should complete");
        assert!(result.is_none());
        server.join().expect("server should finish");
    }

    fn spawn_response(response: Vec<u8>) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test server should bind");
        let address = listener.local_addr().expect("test address should load");
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("request should connect");
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            stream.write_all(&response).expect("response should write");
        });
        (format!("http://{address}/document"), handle)
    }
}
