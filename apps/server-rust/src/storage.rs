use std::{env, sync::OnceLock, time::Duration};

use aws_config::BehaviorVersion;
use aws_sdk_s3::{
    config::{Credentials, Region},
    operation::delete_object::DeleteObjectError,
    operation::get_object::GetObjectError,
    operation::head_object::HeadObjectError,
    presigning::PresigningConfig,
    Client,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use rand::random;
use regex::Regex;
use serde::Serialize;
use sha2::Sha256;
use ts_rs::TS;

type HmacSha256 = Hmac<Sha256>;

const ATTACHMENT_UPLOAD_KEY_TTL_MS: i64 = 15 * 60 * 1000;

static ATTACHMENT_UPLOAD_KEY_PATTERN: OnceLock<Regex> = OnceLock::new();

#[derive(Clone)]
pub struct StorageConfig {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

static STORAGE_CONFIG: OnceLock<StorageConfig> = OnceLock::new();
static STORAGE_CLIENT: OnceLock<Client> = OnceLock::new();

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

pub fn public_url(key: String) -> String {
    let endpoint = env::var("BITTERY_STORAGE_PUBLIC_URL")
        .or_else(|_| env::var("BITTERY_STORAGE_ENDPOINT"))
        .unwrap_or_default();
    if endpoint.trim().is_empty() {
        key
    } else {
        format!("{}/{}", endpoint.trim_end_matches('/'), key)
    }
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
    let pattern = ATTACHMENT_UPLOAD_KEY_PATTERN.get_or_init(|| {
		Regex::new(r"^attachments/([^/]+)/([^/]+)/(\d{13})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([A-Za-z0-9_-]{43})-([A-Za-z0-9._-]{1,120})$")
			.expect("attachment upload key regex should compile")
	});
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
    let expected_signature = sign_attachment_upload_intent(&format!(
        "{key_user_id}:{key_item_id}:{upload_id}:{expires_at_ms}"
    ))?;
    Ok(expected_signature == signature)
}

pub async fn create_presigned_upload(
    key: &str,
    content_type: &str,
    content_length: Option<i64>,
    expires_in_seconds: Option<u64>,
) -> Result<PresignedUploadResult, StorageError> {
    let config = get_config()?;
    let client = get_client()?.clone();
    let mut request = client
        .put_object()
        .bucket(&config.bucket)
        .key(key)
        .content_type(content_type);
    if let Some(content_length) = content_length {
        request = request.content_length(content_length);
    }

    let presigned_request = request
        .presigned(
            PresigningConfig::expires_in(Duration::from_secs(expires_in_seconds.unwrap_or(300)))
                .map_err(|error| StorageError::Presign(error.to_string()))?,
        )
        .await
        .map_err(|error| StorageError::Presign(error.to_string()))?;

    Ok(PresignedUploadResult {
        key: key.to_string(),
        upload_url: presigned_request.uri().to_string(),
        public_url: public_asset_url(key),
    })
}

pub async fn delete_object(key: &str) -> Result<(), StorageError> {
    let config = get_config()?;
    let client = get_client()?.clone();

    client
        .delete_object()
        .bucket(&config.bucket)
        .key(key)
        .send()
        .await
        .map_err(StorageError::DeleteObject)?;

    Ok(())
}

pub async fn create_presigned_download(
    key: &str,
    expires_in_seconds: Option<u64>,
) -> Result<String, StorageError> {
    let config = get_config()?;
    let client = get_client()?.clone();
    let presigned_request = client
        .get_object()
        .bucket(&config.bucket)
        .key(key)
        .presigned(
            PresigningConfig::expires_in(Duration::from_secs(expires_in_seconds.unwrap_or(300)))
                .map_err(|error| StorageError::Presign(error.to_string()))?,
        )
        .await
        .map_err(|error| StorageError::Presign(error.to_string()))?;
    Ok(presigned_request.uri().to_string())
}

pub async fn head_object(key: &str) -> Result<Option<StorageObjectHead>, StorageError> {
    let config = get_config()?;
    let client = get_client()?.clone();
    let response = client
        .head_object()
        .bucket(&config.bucket)
        .key(key)
        .send()
        .await;
    match response {
        Ok(head) => Ok(Some(StorageObjectHead {
            size: head.content_length().unwrap_or_default(),
            content_type: head.content_type().map(ToOwned::to_owned),
        })),
        Err(aws_sdk_s3::error::SdkError::ServiceError(service_error))
            if service_error.err().is_not_found() =>
        {
            Ok(None)
        }
        Err(error) => Err(StorageError::HeadObject(error)),
    }
}

fn get_client() -> Result<&'static Client, StorageError> {
    if let Some(client) = STORAGE_CLIENT.get() {
        return Ok(client);
    }

    let config = get_config()?.clone();
    let client = Client::from_conf(
        aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new(config.region))
            .endpoint_url(config.endpoint)
            .credentials_provider(Credentials::new(
                config.access_key_id,
                config.secret_access_key,
                None,
                None,
                "bittery-server-rust",
            ))
            .force_path_style(true)
            .build(),
    );

    let _ = STORAGE_CLIENT.set(client);
    Ok(STORAGE_CLIENT
        .get()
        .expect("storage client should be initialized"))
}

fn get_config() -> Result<&'static StorageConfig, StorageError> {
    if let Some(config) = STORAGE_CONFIG.get() {
        return Ok(config);
    }

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
            let _ = STORAGE_CONFIG.set(StorageConfig {
                endpoint,
                region,
                bucket,
                access_key_id,
                secret_access_key,
            });
            Ok(STORAGE_CONFIG
                .get()
                .expect("storage config should be initialized"))
        }
        _ => Err(StorageError::MissingConfig),
    }
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

fn sign_attachment_upload_intent(payload: &str) -> Result<String, StorageError> {
    let secret = get_attachment_upload_signing_secret()?;
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|error| StorageError::InvalidConfig(error.to_string()))?;
    mac.update(payload.as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
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
    DeleteObject(aws_sdk_s3::error::SdkError<DeleteObjectError>),
    GetObject(aws_sdk_s3::error::SdkError<GetObjectError>),
    HeadObject(aws_sdk_s3::error::SdkError<HeadObjectError>),
    Presign(String),
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
			Self::GetObject(error) => write!(f, "failed to load storage object: {error}"),
			Self::HeadObject(error) => write!(f, "failed to inspect storage object: {error}"),
			Self::Presign(error) => write!(f, "failed to create presigned upload: {error}"),
		}
    }
}

#[cfg(test)]
mod tests {
    use super::{create_team_image_key, create_vault_image_key, public_asset_url};

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
}

impl std::error::Error for StorageError {}
