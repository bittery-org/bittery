use std::sync::{LazyLock, OnceLock};

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

    match resolve_candidate_urls(domain).await {
        Ok(candidates) => {
            for candidate in candidates {
                if let Ok(Some((data, content_type))) = fetch_with_limit(&candidate, false).await {
                    mark_fetched(pool, domain, &data, &content_type).await?;
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

fn http_client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(std::time::Duration::from_secs(FETCH_TIMEOUT_SECONDS))
            .redirect(Policy::limited(5))
            .build()
            .expect("favicon http client should build")
    })
}

async fn resolve_candidate_urls(
    domain: &str,
) -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
    let direct_favicon = format!("https://{domain}/favicon.ico");
    let homepage_url = format!("https://{domain}/");
    let apple_touch_icon = format!("https://{domain}/apple-touch-icon.png");

    let mut html_icon_links = Vec::new();
    if let Some((html_bytes, _)) = fetch_with_limit(&homepage_url, true).await? {
        html_icon_links = extract_icon_links(&String::from_utf8_lossy(&html_bytes), &homepage_url);
    }

    let mut candidates = Vec::with_capacity(2 + html_icon_links.len());
    candidates.push(direct_favicon);
    candidates.extend(html_icon_links);
    candidates.push(apple_touch_icon);
    Ok(candidates)
}

async fn fetch_with_limit(
    url: &str,
    expect_html: bool,
) -> Result<Option<(Vec<u8>, String)>, Box<dyn std::error::Error + Send + Sync>> {
    let response = http_client().get(url).send().await?;
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

    if expect_html {
        if !content_type.contains("text/html") {
            return Ok(None);
        }
    } else if !content_type.starts_with("image/") {
        return Ok(None);
    }

    let data = response.bytes().await?.to_vec();
    if data.is_empty() || data.len() > MAX_DOWNLOAD_BYTES {
        return Ok(None);
    }

    Ok(Some((data, content_type)))
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
    use super::normalize_favicon_domain;

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
}
