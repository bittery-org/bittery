use std::sync::LazyLock;

use regex::Regex;
use reqwest::{header::CONTENT_TYPE, redirect::Policy, Client};

const FETCH_TIMEOUT_SECONDS: u64 = 5;
const MAX_DOWNLOAD_BYTES: usize = 1_000_000;

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

pub(crate) async fn fetch_favicon_document(
    fetcher: &dyn RemoteDocumentFetcher,
    domain: &str,
) -> Result<Option<RemoteDocument>, Box<dyn std::error::Error + Send + Sync>> {
    for candidate in resolve_candidate_urls(fetcher, domain).await? {
        if let Ok(Some(document)) = fetcher.fetch(&candidate, RemoteDocumentKind::Image).await {
            return Ok(Some(document));
        }
    }
    Ok(None)
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
