use std::{
    env,
    sync::{LazyLock, OnceLock},
    time::Duration,
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, KeyInit, Mac};
use rand::random;
use regex::Regex;
use reqwest::{
    header::{CONTENT_LENGTH, CONTENT_TYPE, HOST},
    Method,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use ts_rs::TS;
use url::Url;

type HmacSha256 = Hmac<Sha256>;

const ATTACHMENT_UPLOAD_KEY_TTL_MS: i64 = 15 * 60 * 1000;
const AWS_ALGORITHM: &str = "AWS4-HMAC-SHA256";
const S3_SERVICE: &str = "s3";
const UNSIGNED_PAYLOAD: &str = "UNSIGNED-PAYLOAD";

static ATTACHMENT_UPLOAD_KEY_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^attachments/([^/]+)/([^/]+)/(\d{13})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([A-Za-z0-9_-]{43})-([A-Za-z0-9._-]{1,120})$")
		.expect("attachment upload key regex should compile")
});

#[derive(Clone)]
pub struct StorageConfig {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PresignedUploadResult {
    pub key: String,
    pub upload_url: String,
    pub public_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StorageObjectHead {
    pub size: i64,
    pub content_type: Option<String>,
}

pub fn public_asset_url(key: &str) -> Option<String> {
    let normalized_key = key.trim().trim_start_matches('/');
    if normalized_key.is_empty()
        || !(normalized_key.starts_with("teams/") || normalized_key.starts_with("vaults/"))
    {
        return None;
    }

    let base_url = env::var("BITTERY_STORAGE_CDN_URL")
        .or_else(|_| env::var("BITTERY_STORAGE_PUBLIC_URL"))
        .ok()?;
    let normalized_base = base_url.trim().trim_end_matches('/');
    if normalized_base.is_empty() {
        None
    } else {
        Some(format!("{normalized_base}/{normalized_key}"))
    }
}

pub fn create_team_image_key(team_id: &str, file_name: &str) -> String {
    let safe_name = sanitize_file_name(file_name);
    format!("teams/{team_id}/{:016x}-{safe_name}", random::<u64>())
}

pub fn create_vault_image_key(user_id: &str, vault_id: Option<&str>, file_name: &str) -> String {
    let safe_name = sanitize_file_name(file_name);
    let vault_segment = vault_id.unwrap_or("draft");
    format!(
        "vaults/{user_id}/{vault_segment}/{:016x}-{safe_name}",
        random::<u64>()
    )
}

pub fn create_attachment_key(
    user_id: &str,
    item_id: &str,
    file_name: &str,
) -> Result<String, StorageError> {
    let safe_name = sanitize_file_name(file_name);
    let upload_id = random_uuid_like();
    let expires_at_ms = chrono::Utc::now().timestamp_millis() + ATTACHMENT_UPLOAD_KEY_TTL_MS;
    let signature =
        sign_attachment_upload_intent(&format!("{user_id}:{item_id}:{upload_id}:{expires_at_ms}"))?;
    Ok(format!(
        "attachments/{user_id}/{item_id}/{expires_at_ms}-{upload_id}-{signature}-{safe_name}"
    ))
}

pub fn is_valid_attachment_upload_key(
    key: &str,
    user_id: &str,
    item_id: &str,
    now_ms: Option<i64>,
) -> Result<bool, StorageError> {
    let pattern = &*ATTACHMENT_UPLOAD_KEY_PATTERN;
    let Some(captures) = pattern.captures(key) else {
        return Ok(false);
    };
    let key_user_id = captures
        .get(1)
        .map(|value| value.as_str())
        .unwrap_or_default();
    let key_item_id = captures
        .get(2)
        .map(|value| value.as_str())
        .unwrap_or_default();
    if key_user_id != user_id || key_item_id != item_id {
        return Ok(false);
    }
    let Some(expires_at_ms) = captures
        .get(3)
        .and_then(|value| value.as_str().parse::<i64>().ok())
    else {
        return Ok(false);
    };
    if expires_at_ms < now_ms.unwrap_or_else(|| chrono::Utc::now().timestamp_millis()) {
        return Ok(false);
    }
    let upload_id = captures
        .get(4)
        .map(|value| value.as_str())
        .unwrap_or_default();
    let signature = captures
        .get(5)
        .map(|value| value.as_str())
        .unwrap_or_default();
    verify_attachment_upload_intent(
        &format!("{key_user_id}:{key_item_id}:{upload_id}:{expires_at_ms}"),
        signature,
    )
}

pub async fn create_presigned_upload(
    key: &str,
    content_type: &str,
    content_length: Option<i64>,
    expires_in_seconds: Option<u64>,
) -> Result<PresignedUploadResult, StorageError> {
    let config = get_config()?;
    let upload_url = presigned_url(
        &config,
        "PUT",
        key,
        Some(content_type),
        content_length,
        Duration::from_secs(expires_in_seconds.unwrap_or(300)),
    )?;

    Ok(PresignedUploadResult {
        key: key.to_string(),
        upload_url,
        public_url: public_asset_url(key),
    })
}

pub async fn delete_object(key: &str) -> Result<(), StorageError> {
    let config = get_config()?;
    let response = signed_request(&config, Method::DELETE, key)?
        .send()
        .await
        .map_err(|error| StorageError::DeleteObject(error.to_string()))?;
    if !response.status().is_success() {
        return Err(StorageError::DeleteObject(format!(
            "storage returned {}",
            response.status()
        )));
    }

    Ok(())
}

pub async fn create_presigned_download(
    key: &str,
    expires_in_seconds: Option<u64>,
) -> Result<String, StorageError> {
    let config = get_config()?;
    presigned_url(
        &config,
        "GET",
        key,
        None,
        None,
        Duration::from_secs(expires_in_seconds.unwrap_or(300)),
    )
}

pub async fn head_object(key: &str) -> Result<Option<StorageObjectHead>, StorageError> {
    let config = get_config()?;
    let response = signed_request(&config, Method::HEAD, key)?
        .send()
        .await
        .map_err(|error| StorageError::HeadObject(error.to_string()))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(StorageError::HeadObject(format!(
            "storage returned {}",
            response.status()
        )));
    }

    let size = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or_default();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned);

    Ok(Some(StorageObjectHead { size, content_type }))
}

fn object_url(config: &StorageConfig, key: &str) -> Result<Url, StorageError> {
    let mut url = Url::parse(config.endpoint.trim())
        .map_err(|error| StorageError::InvalidConfig(error.to_string()))?;
    {
        let mut segments = url.path_segments_mut().map_err(|_| {
            StorageError::InvalidConfig("storage endpoint cannot be a base URL".into())
        })?;
        segments.pop_if_empty();
        segments.push(config.bucket.trim_matches('/'));
        for segment in key.trim_start_matches('/').split('/') {
            segments.push(segment);
        }
    }
    Ok(url)
}

fn get_config() -> Result<StorageConfig, StorageError> {
    let endpoint = env::var("BITTERY_STORAGE_ENDPOINT").ok();
    let bucket = env::var("BITTERY_STORAGE_BUCKET").ok();
    let access_key_id = env::var("BITTERY_STORAGE_ACCESS_KEY_ID").ok();
    let secret_access_key = env::var("BITTERY_STORAGE_SECRET_ACCESS_KEY").ok();
    let region = env::var("BITTERY_STORAGE_REGION").unwrap_or_else(|_| "auto".to_string());

    match (endpoint, bucket, access_key_id, secret_access_key) {
        (Some(endpoint), Some(bucket), Some(access_key_id), Some(secret_access_key))
            if !endpoint.trim().is_empty()
                && !bucket.trim().is_empty()
                && !access_key_id.trim().is_empty()
                && !secret_access_key.trim().is_empty() =>
        {
            Ok(StorageConfig {
                endpoint: endpoint.trim().to_string(),
                region,
                bucket: bucket.trim().to_string(),
                access_key_id: access_key_id.trim().to_string(),
                secret_access_key: secret_access_key.trim().to_string(),
            })
        }
        _ => Err(StorageError::MissingConfig),
    }
}

fn presigned_url(
    config: &StorageConfig,
    method: &str,
    key: &str,
    content_type: Option<&str>,
    content_length: Option<i64>,
    expires_in: Duration,
) -> Result<String, StorageError> {
    let mut url = object_url(config, key)?;
    let now = chrono::Utc::now();
    let date = now.format("%Y%m%d").to_string();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let scope = credential_scope(&date, &config.region);

    let mut headers = vec![("host".to_string(), host_header(&url)?)];
    if let Some(content_type) = content_type {
        headers.push(("content-type".to_string(), content_type.to_string()));
    }
    if let Some(content_length) = content_length {
        headers.push(("content-length".to_string(), content_length.to_string()));
    }
    headers.sort_by(|left, right| left.0.cmp(&right.0));
    let signed_headers = headers
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>()
        .join(";");

    let mut query_params = vec![
        ("X-Amz-Algorithm".to_string(), AWS_ALGORITHM.to_string()),
        (
            "X-Amz-Credential".to_string(),
            format!("{}/{}", config.access_key_id, scope),
        ),
        ("X-Amz-Date".to_string(), amz_date.clone()),
        (
            "X-Amz-Expires".to_string(),
            expires_in.as_secs().to_string(),
        ),
        ("X-Amz-SignedHeaders".to_string(), signed_headers.clone()),
    ];
    let canonical_query = canonical_query_string(&query_params);
    let canonical_request = canonical_request(
        method,
        url.path(),
        &canonical_query,
        &headers,
        &signed_headers,
        UNSIGNED_PAYLOAD,
    );
    let signature = signature(
        &config.secret_access_key,
        &date,
        &config.region,
        &string_to_sign(&amz_date, &scope, &canonical_request),
    )?;

    query_params.push(("X-Amz-Signature".to_string(), signature));
    url.set_query(Some(&canonical_query_string(&query_params)));
    Ok(url.to_string())
}

fn signed_request(
    config: &StorageConfig,
    method: Method,
    key: &str,
) -> Result<reqwest::RequestBuilder, StorageError> {
    let url = object_url(config, key)?;
    let now = chrono::Utc::now();
    let date = now.format("%Y%m%d").to_string();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let scope = credential_scope(&date, &config.region);
    let payload_hash = hex::encode(Sha256::digest([]));
    let headers = vec![
        ("host".to_string(), host_header(&url)?),
        ("x-amz-content-sha256".to_string(), payload_hash.clone()),
        ("x-amz-date".to_string(), amz_date.clone()),
    ];
    let signed_headers = headers
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>()
        .join(";");
    let canonical_request = canonical_request(
        method.as_str(),
        url.path(),
        url.query().unwrap_or_default(),
        &headers,
        &signed_headers,
        &payload_hash,
    );
    let signature = signature(
        &config.secret_access_key,
        &date,
        &config.region,
        &string_to_sign(&amz_date, &scope, &canonical_request),
    )?;
    let authorization = format!(
        "{AWS_ALGORITHM} Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        config.access_key_id,
    );

    Ok(http_client()
        .request(method, url)
        .header(HOST, host_header(&object_url(config, key)?)?)
        .header("x-amz-content-sha256", payload_hash)
        .header("x-amz-date", amz_date)
        .header("Authorization", authorization))
}

fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(reqwest::Client::new)
}

fn credential_scope(date: &str, region: &str) -> String {
    format!("{date}/{region}/{S3_SERVICE}/aws4_request")
}

fn canonical_request(
    method: &str,
    path: &str,
    query: &str,
    headers: &[(String, String)],
    signed_headers: &str,
    payload_hash: &str,
) -> String {
    let canonical_headers = headers
        .iter()
        .map(|(name, value)| format!("{name}:{}\n", value.trim()))
        .collect::<String>();
    format!("{method}\n{path}\n{query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}")
}

fn canonical_query_string(params: &[(String, String)]) -> String {
    let mut encoded = params
        .iter()
        .map(|(key, value)| (percent_encode(key), percent_encode(value)))
        .collect::<Vec<_>>();
    encoded.sort();
    encoded
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&")
}

fn string_to_sign(amz_date: &str, scope: &str, canonical_request: &str) -> String {
    let request_hash = hex::encode(Sha256::digest(canonical_request.as_bytes()));
    format!("{AWS_ALGORITHM}\n{amz_date}\n{scope}\n{request_hash}")
}

fn signature(
    secret_access_key: &str,
    date: &str,
    region: &str,
    string_to_sign: &str,
) -> Result<String, StorageError> {
    let date_key = hmac_sha256(
        format!("AWS4{secret_access_key}").as_bytes(),
        date.as_bytes(),
    )?;
    let region_key = hmac_sha256(&date_key, region.as_bytes())?;
    let service_key = hmac_sha256(&region_key, S3_SERVICE.as_bytes())?;
    let signing_key = hmac_sha256(&service_key, b"aws4_request")?;
    Ok(hex::encode(hmac_sha256(
        &signing_key,
        string_to_sign.as_bytes(),
    )?))
}

fn hmac_sha256(key: &[u8], payload: &[u8]) -> Result<Vec<u8>, StorageError> {
    let mut mac = HmacSha256::new_from_slice(key)
        .map_err(|error| StorageError::InvalidConfig(error.to_string()))?;
    mac.update(payload);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn host_header(url: &Url) -> Result<String, StorageError> {
    let host = url
        .host_str()
        .ok_or_else(|| StorageError::InvalidConfig("storage endpoint is missing a host".into()))?;
    match url.port() {
        Some(port) => Ok(format!("{host}:{port}")),
        None => Ok(host.to_string()),
    }
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

fn sanitize_file_name(file_name: &str) -> String {
    let trimmed = file_name.trim();
    let base = if trimmed.is_empty() { "image" } else { trimmed };
    let safe: String = base
        .chars()
        .map(|character| match character {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '_' | '-' => character,
            _ => '_',
        })
        .take(120)
        .collect();
    if safe.is_empty() {
        "image".to_string()
    } else {
        safe
    }
}

fn get_attachment_upload_signing_secret() -> Result<String, StorageError> {
    match env::var("BITTERY_ATTACHMENT_UPLOAD_SECRET").or_else(|_| env::var("JWT_SECRET")) {
        Ok(secret) if !secret.trim().is_empty() => Ok(secret),
        _ => Err(StorageError::MissingAttachmentUploadSecret),
    }
}

fn attachment_upload_mac(payload: &str) -> Result<HmacSha256, StorageError> {
    let secret = get_attachment_upload_signing_secret()?;
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|error| StorageError::InvalidConfig(error.to_string()))?;
    mac.update(payload.as_bytes());
    Ok(mac)
}

fn sign_attachment_upload_intent(payload: &str) -> Result<String, StorageError> {
    let mac = attachment_upload_mac(payload)?;
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

fn verify_attachment_upload_intent(payload: &str, signature: &str) -> Result<bool, StorageError> {
    let mac = attachment_upload_mac(payload)?;
    // An undecodable signature is treated exactly like a wrong one.
    let Ok(tag) = URL_SAFE_NO_PAD.decode(signature) else {
        return Ok(false);
    };
    // `verify_slice` compares the tag in constant time, so validation timing does not depend on how
    // many leading bytes of a supplied signature happen to be correct.
    Ok(mac.verify_slice(&tag).is_ok())
}

fn random_uuid_like() -> String {
    let bytes = random::<[u8; 16]>();
    format!(
		"{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
		bytes[0], bytes[1], bytes[2], bytes[3],
		bytes[4], bytes[5],
		bytes[6], bytes[7],
		bytes[8], bytes[9],
		bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
	)
}

#[derive(Debug)]
pub enum StorageError {
    MissingConfig,
    MissingAttachmentUploadSecret,
    InvalidConfig(String),
    DeleteObject(String),
    HeadObject(String),
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
			Self::MissingConfig => write!(
				f,
				"Missing storage config. Set BITTERY_STORAGE_ENDPOINT, BITTERY_STORAGE_BUCKET, BITTERY_STORAGE_ACCESS_KEY_ID, and BITTERY_STORAGE_SECRET_ACCESS_KEY.",
			),
			Self::MissingAttachmentUploadSecret => write!(
				f,
				"Missing attachment upload signing secret. Set BITTERY_ATTACHMENT_UPLOAD_SECRET or JWT_SECRET.",
			),
            Self::InvalidConfig(error) => write!(f, "invalid storage config: {error}"),
            Self::DeleteObject(error) => write!(f, "failed to delete storage object: {error}"),
            Self::HeadObject(error) => write!(f, "failed to inspect storage object: {error}"),
        }
    }
}

impl std::error::Error for StorageError {}

#[cfg(test)]
mod tests {
    use std::{
        future::Future,
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    use super::{
        create_attachment_key, create_presigned_download, create_presigned_upload,
        create_team_image_key, create_vault_image_key, delete_object, head_object,
        is_valid_attachment_upload_key, public_asset_url, sign_attachment_upload_intent,
        StorageError,
    };
    use crate::test_support::acquire_env_lock_async;

    #[test]
    fn public_asset_url_rejects_private_attachment_keys() {
        assert_eq!(public_asset_url("attachments/user/item/file.enc"), None);
    }

    #[test]
    fn create_vault_image_key_keeps_vault_prefix() {
        let key = create_vault_image_key("user_123", Some("vault_456"), "avatar.png");
        assert!(key.starts_with("vaults/user_123/vault_456/"));
        assert!(key.ends_with("avatar.png"));
    }

    #[test]
    fn create_team_image_key_keeps_team_prefix() {
        let key = create_team_image_key("team_123", "avatar file.png");
        assert!(key.starts_with("teams/team_123/"));
        assert!(key.ends_with("avatar_file.png"));
    }

    #[tokio::test]
    async fn presigned_upload_uses_path_style_bucket_and_signed_content_type() {
        with_storage_env_async("https://storage.example.invalid", async {
            let result =
                create_presigned_upload("vaults/user_123/avatar file.png", "image/png", None, None)
                    .await
                    .expect("presigned upload should be created");
            let url = Url::parse(&result.upload_url).expect("upload URL should parse");
            let params = url.query_pairs().collect::<Vec<_>>();

            assert_eq!(
                url.path(),
                "/bittery-test/vaults/user_123/avatar%20file.png"
            );
            assert_eq!(
                params
                    .iter()
                    .find(|(key, _)| key == "X-Amz-Expires")
                    .map(|(_, value)| value.as_ref()),
                Some("300"),
            );
            assert_eq!(
                params
                    .iter()
                    .find(|(key, _)| key == "X-Amz-SignedHeaders")
                    .map(|(_, value)| value.as_ref()),
                Some("content-type;host"),
            );
            assert!(params.iter().any(|(key, _)| key == "X-Amz-Signature"));
        })
        .await;
    }

    #[tokio::test]
    async fn presigned_download_uses_custom_expiration() {
        with_storage_env_async("https://storage.example.invalid", async {
            let url = create_presigned_download("attachments/user/item/file.enc", Some(900))
                .await
                .expect("presigned download should be created");
            let url = Url::parse(&url).expect("download URL should parse");

            assert_eq!(url.path(), "/bittery-test/attachments/user/item/file.enc");
            assert_eq!(
                url.query_pairs()
                    .find(|(key, _)| key == "X-Amz-Expires")
                    .map(|(_, value)| value.into_owned()),
                Some("900".to_string()),
            );
        })
        .await;
    }

    #[tokio::test]
    async fn storage_requires_config() {
        with_missing_storage_env_async(async {
            let error = create_presigned_download("file.txt", None)
                .await
                .expect_err("missing config should fail");
            assert!(matches!(error, StorageError::MissingConfig));
        })
        .await;
    }

    #[tokio::test]
    async fn attachment_upload_key_validation_round_trips() {
        with_storage_env_async("https://storage.example.invalid", async {
            let key = create_attachment_key("user_123", "item_456", "secret file.enc")
                .expect("attachment key should be created");

            assert!(
                is_valid_attachment_upload_key(&key, "user_123", "item_456", None)
                    .expect("validation should succeed")
            );
            assert!(
                !is_valid_attachment_upload_key(&key, "user_123", "other_item", None)
                    .expect("validation should succeed")
            );
        })
        .await;
    }

    #[tokio::test]
    async fn attachment_upload_key_signature_checks_accept_only_the_expected_tag() {
        const UPLOAD_ID: &str = "00000000-0000-0000-0000-000000000000";

        with_storage_env_async("https://storage.example.invalid", async {
            let now_ms = chrono::Utc::now().timestamp_millis();
            let expires_at_ms = now_ms + 60_000;
            let build_key = |signature: &str| {
                format!("attachments/user_123/item_456/{expires_at_ms}-{UPLOAD_ID}-{signature}-file.enc")
            };

            let valid_signature = sign_attachment_upload_intent(&format!(
                "user_123:item_456:{UPLOAD_ID}:{expires_at_ms}"
            ))
            .expect("signature should be created");
            assert!(is_valid_attachment_upload_key(
                &build_key(&valid_signature),
                "user_123",
                "item_456",
                Some(now_ms),
            )
            .expect("validation should succeed"));

            let foreign_signature = sign_attachment_upload_intent(&format!(
                "user_123:other_item:{UPLOAD_ID}:{expires_at_ms}"
            ))
            .expect("signature should be created");
            assert!(!is_valid_attachment_upload_key(
                &build_key(&foreign_signature),
                "user_123",
                "item_456",
                Some(now_ms),
            )
            .expect("validation should succeed"));

            // Set the discarded trailing bits of the final base64url symbol: the tag bytes would be
            // unchanged, so this only fails validation because decoding rejects it.
            const URL_SAFE_ALPHABET: &[u8] =
                b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            let last_symbol = valid_signature.as_bytes()[valid_signature.len() - 1];
            let last_index = URL_SAFE_ALPHABET
                .iter()
                .position(|symbol| *symbol == last_symbol)
                .expect("signature should be base64url");
            let malformed_signature = format!(
                "{}{}",
                &valid_signature[..valid_signature.len() - 1],
                URL_SAFE_ALPHABET[last_index + 1] as char,
            );
            assert!(!is_valid_attachment_upload_key(
                &build_key(&malformed_signature),
                "user_123",
                "item_456",
                Some(now_ms),
            )
            .expect("malformed signatures should not error"));
        })
        .await;
    }

    #[tokio::test]
    async fn head_object_reads_metadata_from_storage_response() {
        let (endpoint, request) = spawn_storage_response(
            "HTTP/1.1 200 OK\r\nContent-Length: 42\r\nContent-Type: image/png\r\n\r\n",
        );

        with_storage_env_async(&endpoint, async {
            let head = head_object("vaults/user/avatar.png")
                .await
                .expect("head request should succeed")
                .expect("object should exist");

            assert_eq!(head.size, 42);
            assert_eq!(head.content_type.as_deref(), Some("image/png"));
        })
        .await;

        let request = request.join().expect("mock server should finish");
        assert!(request.starts_with("HEAD /bittery-test/vaults/user/avatar.png "));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: aws4-hmac-sha256"));
    }

    #[tokio::test]
    async fn head_object_returns_none_for_not_found() {
        let (endpoint, _request) = spawn_storage_response("HTTP/1.1 404 Not Found\r\n\r\n");

        with_storage_env_async(&endpoint, async {
            let head = head_object("missing.txt")
                .await
                .expect("not found should not be an error");

            assert!(head.is_none());
        })
        .await;
    }

    #[tokio::test]
    async fn delete_object_sends_signed_delete_request() {
        let (endpoint, request) = spawn_storage_response("HTTP/1.1 204 No Content\r\n\r\n");

        with_storage_env_async(&endpoint, async {
            delete_object("attachments/user/item/file.enc")
                .await
                .expect("delete request should succeed");
        })
        .await;

        let request = request.join().expect("mock server should finish");
        assert!(request.starts_with("DELETE /bittery-test/attachments/user/item/file.enc "));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: aws4-hmac-sha256"));
    }

    async fn with_storage_env_async<T, F>(endpoint: &str, future: F) -> T
    where
        F: Future<Output = T>,
    {
        let _guard = acquire_env_lock_async().await;
        let previous = storage_env();

        set_env_var("BITTERY_STORAGE_ENDPOINT", Some(endpoint));
        set_env_var("BITTERY_STORAGE_BUCKET", Some("bittery-test"));
        set_env_var("BITTERY_STORAGE_ACCESS_KEY_ID", Some("test-access-key"));
        set_env_var("BITTERY_STORAGE_SECRET_ACCESS_KEY", Some("test-secret-key"));
        set_env_var("BITTERY_STORAGE_REGION", Some("auto"));
        set_env_var(
            "BITTERY_ATTACHMENT_UPLOAD_SECRET",
            Some("test-attachment-secret"),
        );

        let result = future.await;

        restore_storage_env(previous);

        result
    }

    async fn with_missing_storage_env_async<T, F>(future: F) -> T
    where
        F: Future<Output = T>,
    {
        let _guard = acquire_env_lock_async().await;
        let previous = storage_env();

        for key in STORAGE_ENV_KEYS {
            set_env_var(key, None);
        }

        let result = future.await;

        restore_storage_env(previous);

        result
    }

    fn spawn_storage_response(response: &'static str) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock storage should bind");
        let address = listener
            .local_addr()
            .expect("mock storage address should load");
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("request should connect");
            let mut buffer = [0_u8; 8192];
            let bytes_read = stream.read(&mut buffer).expect("request should read");
            stream
                .write_all(response.as_bytes())
                .expect("response should write");
            String::from_utf8_lossy(&buffer[..bytes_read]).into_owned()
        });

        (format!("http://{address}"), handle)
    }

    const STORAGE_ENV_KEYS: &[&str] = &[
        "BITTERY_STORAGE_ENDPOINT",
        "BITTERY_STORAGE_BUCKET",
        "BITTERY_STORAGE_ACCESS_KEY_ID",
        "BITTERY_STORAGE_SECRET_ACCESS_KEY",
        "BITTERY_STORAGE_REGION",
        "BITTERY_STORAGE_PUBLIC_URL",
        "BITTERY_STORAGE_CDN_URL",
        "BITTERY_ATTACHMENT_UPLOAD_SECRET",
        "JWT_SECRET",
    ];

    fn storage_env() -> Vec<(&'static str, Option<String>)> {
        STORAGE_ENV_KEYS
            .iter()
            .map(|key| (*key, std::env::var(key).ok()))
            .collect()
    }

    fn restore_storage_env(previous: Vec<(&'static str, Option<String>)>) {
        for (key, value) in previous {
            match value {
                Some(value) => set_env_var(key, Some(&value)),
                None => set_env_var(key, None),
            }
        }
    }

    fn set_env_var(key: &str, value: Option<&str>) {
        match value {
            Some(value) => unsafe { std::env::set_var(key, value) },
            None => unsafe { std::env::remove_var(key) },
        }
    }

    use url::Url;
}
