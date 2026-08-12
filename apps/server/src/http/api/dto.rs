use std::fmt;

use serde::{de, Deserialize, Deserializer, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::{integrations::storage::PresignedUploadResult, services, shapes::success_shape};

use super::error_code::ErrorCode;

pub use super::limits::{
    BULK_IMPORT_BYTES, BULK_IMPORT_ITEMS, DEFAULT_AUDIT_EVENTS, DEFAULT_PAGE_SIZE,
    ENCRYPTED_VAULT_KEY_BYTES, ITEM_CIPHERTEXT_BYTES, MAX_AUDIT_EVENTS, MAX_AUDIT_SEARCH_BYTES,
    MAX_BATCH_ITEMS, MAX_CAPABILITIES, MAX_PAGE_SIZE, NAME_MAX_CHARS, SUPPORTED_MAJORS,
};

pub const API_MAJOR: u16 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApiMetadata {
    pub server_release: String,
    pub api: ApiVersionMetadata,
    #[schema(max_items = 32)]
    pub capabilities: Vec<String>,
    pub limits: ApiLimits,
    pub registration: RegistrationMetadata,
}

impl ApiMetadata {
    pub fn current(registration: RegistrationMetadata, insecure_http_enabled: bool) -> Self {
        let mut capabilities = vec![
            "attachments".to_string(),
            "sync-sse".to_string(),
            "travel-mode".to_string(),
        ];
        if insecure_http_enabled {
            capabilities.push("insecure-http".to_string());
        }
        Self {
            server_release: env!("CARGO_PKG_VERSION").to_string(),
            api: ApiVersionMetadata {
                supported_majors: vec![API_MAJOR],
                preferred_major: API_MAJOR,
            },
            capabilities,
            limits: ApiLimits {
                item_ciphertext_bytes: DecimalString::from(ITEM_CIPHERTEXT_BYTES),
                encrypted_vault_key_bytes: DecimalString::from(
                    super::limits::ENCRYPTED_VAULT_KEY_BYTES as u64,
                ),
                bulk_import_bytes: DecimalString::from(BULK_IMPORT_BYTES),
                bulk_import_items: BULK_IMPORT_ITEMS,
            },
            registration,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationMetadata {
    pub mode: String,
    pub billing_enabled: bool,
    pub allow_public_signup: bool,
    pub requires_email_verification: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApiVersionMetadata {
    #[schema(max_items = 1, min_items = 1)]
    pub supported_majors: Vec<u16>,
    pub preferred_major: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApiLimits {
    pub item_ciphertext_bytes: DecimalString,
    pub encrypted_vault_key_bytes: DecimalString,
    pub bulk_import_bytes: DecimalString,
    pub bulk_import_items: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[into_params(parameter_in = Query, rename_all = "camelCase")]
pub struct PageRequest {
    #[serde(default)]
    pub cursor: Option<PageCursor>,
    #[serde(default = "default_page_size")]
    #[schema(minimum = 1, maximum = 500, default = 100)]
    pub limit: u16,
}

fn default_page_size() -> u16 {
    DEFAULT_PAGE_SIZE
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CursorPage<T> {
    #[schema(max_items = 500)]
    pub items: Vec<T>,
    pub next_cursor: Option<PageCursor>,
    pub has_more: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(transparent)]
#[schema(value_type = String, pattern = r"^.+$")]
pub struct PageCursor(String);

impl PageCursor {
    pub(crate) fn new(value: String) -> Self {
        Self(value)
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(transparent)]
#[schema(value_type = String, pattern = r"^.+$")]
pub struct SyncCursor(String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(transparent)]
#[schema(value_type = String, pattern = r"^-?(0|[1-9][0-9]*)$")]
pub struct DecimalString(String);

impl DecimalString {
    pub fn new(value: impl Into<String>) -> Result<Self, DecimalStringError> {
        let value = value.into();
        let digits = value.strip_prefix('-').unwrap_or(&value);
        let valid = !digits.is_empty()
            && digits.bytes().all(|byte| byte.is_ascii_digit())
            && (digits == "0" || !digits.starts_with('0'))
            && value != "-0";

        if valid {
            Ok(Self(value))
        } else {
            Err(DecimalStringError)
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<u64> for DecimalString {
    fn from(value: u64) -> Self {
        Self(value.to_string())
    }
}

impl From<i64> for DecimalString {
    fn from(value: i64) -> Self {
        Self(value.to_string())
    }
}

impl<'de> Deserialize<'de> for DecimalString {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecimalStringError;

impl fmt::Display for DecimalStringError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("expected a canonical base-10 integer string")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum PatchField<T> {
    #[default]
    Missing,
    Null,
    Value(T),
}

impl<'de, T> Deserialize<'de> for PatchField<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<T>::deserialize(deserializer).map(|value| match value {
            Some(value) => Self::Value(value),
            None => Self::Null,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProblemDetails {
    #[serde(rename = "type")]
    pub problem_type: String,
    pub title: String,
    pub status: u16,
    pub code: ErrorCode,
    pub detail: String,
    pub instance: String,
    pub request_id: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    #[schema(max_items = 100)]
    pub errors: Vec<ProblemFieldError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProblemFieldError {
    pub pointer: String,
    pub code: String,
}

// The bare acknowledgement every "nothing else to report" endpoint returns. utoipa keys components
// by the type's short name, so the four per-module copies this replaces were one component, and the
// three that lost the merge were published as whichever copy happened to be merged last.
success_shape!(wire_struct {
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    pub struct SuccessResponse
});
success_shape!(shape_from { services::share::SuccessResponse => SuccessResponse });
success_shape!(shape_from { services::team::SuccessResponse => SuccessResponse });
success_shape!(shape_from { services::vault::SuccessResponse => SuccessResponse });

/// The authorization to upload one object to storage.
///
/// `publicUrl` is always present and is null whenever the uploaded object is not publicly
/// servable: attachments never are, and images only are when the deployment serves assets from
/// a CDN.
// One shape for team images, vault images and attachments, because all three resolve the same
// `storage::create_presigned_upload` result. The per-module copies this replaces disagreed about
// whether to skip a `None` public URL, and utoipa published only one of them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PresignedUploadResponse {
    pub key: String,
    pub upload_url: String,
    #[schema(required = true)]
    pub public_url: Option<String>,
}

impl From<PresignedUploadResult> for PresignedUploadResponse {
    fn from(value: PresignedUploadResult) -> Self {
        Self {
            key: value.key,
            upload_url: value.upload_url,
            public_url: value.public_url,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::json;

    use crate::integrations::storage::PresignedUploadResult;

    use super::{
        ApiMetadata, DecimalString, ErrorCode, PageRequest, PatchField, PresignedUploadResponse,
        ProblemDetails, ProblemFieldError, RegistrationMetadata,
    };

    fn registration_metadata() -> RegistrationMetadata {
        RegistrationMetadata {
            mode: "self-hosted".to_string(),
            billing_enabled: false,
            allow_public_signup: true,
            requires_email_verification: false,
            reason: None,
        }
    }

    #[test]
    fn insecure_http_capability_requires_operator_enablement() {
        let disabled = ApiMetadata::current(registration_metadata(), false);
        let enabled = ApiMetadata::current(registration_metadata(), true);

        assert!(!disabled
            .capabilities
            .iter()
            .any(|capability| capability == "insecure-http"));
        assert!(enabled
            .capabilities
            .iter()
            .any(|capability| capability == "insecure-http"));
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct PatchFixture {
        #[serde(default)]
        name: PatchField<String>,
    }

    #[test]
    fn problem_details_use_the_stable_wire_shape() {
        let problem = ProblemDetails {
            problem_type: "https://bittery.com/problems/version-conflict".to_string(),
            title: "Version conflict".to_string(),
            status: 412,
            code: ErrorCode::VersionConflict,
            detail: "The item changed after it was loaded.".to_string(),
            instance: "urn:bittery:request:request-1".to_string(),
            request_id: "request-1".to_string(),
            retryable: false,
            errors: vec![ProblemFieldError {
                pointer: "/expectedVersion".to_string(),
                code: "STALE_VERSION".to_string(),
            }],
        };

        assert_eq!(
            serde_json::to_value(problem).expect("problem details should serialize"),
            json!({
                "type": "https://bittery.com/problems/version-conflict",
                "title": "Version conflict",
                "status": 412,
                "code": "VERSION_CONFLICT",
                "detail": "The item changed after it was loaded.",
                "instance": "urn:bittery:request:request-1",
                "requestId": "request-1",
                "retryable": false,
                "errors": [{
                    "pointer": "/expectedVersion",
                    "code": "STALE_VERSION",
                }],
            })
        );
    }

    /// Every upload endpoint shares this shape, so a `None` public URL must reach the wire as
    /// `null` rather than as an absent field — the schema declares it required.
    #[test]
    fn presigned_uploads_always_serialize_a_public_url() {
        let private = PresignedUploadResponse::from(PresignedUploadResult {
            key: "attachments/user-1/item-1/file".to_string(),
            upload_url: "https://storage.invalid/upload".to_string(),
            public_url: None,
        });

        assert_eq!(
            serde_json::to_value(private).expect("presigned upload should serialize"),
            json!({
                "key": "attachments/user-1/item-1/file",
                "uploadUrl": "https://storage.invalid/upload",
                "publicUrl": null,
            })
        );
    }

    #[test]
    fn patch_field_distinguishes_missing_null_and_value() {
        assert!(matches!(
            serde_json::from_value::<PatchFixture>(json!({}))
                .unwrap()
                .name,
            PatchField::Missing
        ));
        assert!(matches!(
            serde_json::from_value::<PatchFixture>(json!({ "name": null }))
                .unwrap()
                .name,
            PatchField::Null
        ));
        assert_eq!(
            serde_json::from_value::<PatchFixture>(json!({ "name": "new" }))
                .unwrap()
                .name,
            PatchField::Value("new".to_string())
        );
    }

    #[test]
    fn request_dtos_reject_unknown_fields() {
        assert!(serde_json::from_value::<PageRequest>(json!({
            "limit": 100,
            "unexpected": true,
        }))
        .is_err());
    }

    #[test]
    fn decimal_strings_reject_numbers_and_noncanonical_values() {
        assert!(serde_json::from_value::<DecimalString>(json!(12)).is_err());
        assert!(serde_json::from_value::<DecimalString>(json!("01")).is_err());
        assert_eq!(
            serde_json::from_value::<DecimalString>(json!("-12"))
                .unwrap()
                .as_str(),
            "-12"
        );
    }
}
