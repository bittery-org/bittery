use std::fmt;

use serde::{de, Deserialize, Deserializer, Serialize};
use utoipa::{IntoParams, ToSchema};

pub const API_MAJOR: u16 = 1;
pub const ITEM_CIPHERTEXT_BYTES: u64 = 1_048_576;
pub const BULK_IMPORT_BYTES: u64 = 16_777_216;
pub const BULK_IMPORT_ITEMS: u16 = 200;
pub const DEFAULT_PAGE_SIZE: u16 = 100;
pub const MAX_PAGE_SIZE: u16 = 500;

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
    pub code: String,
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

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::json;

    use super::{
        ApiMetadata, DecimalString, PageRequest, PatchField, ProblemDetails, ProblemFieldError,
        RegistrationMetadata,
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
            code: "VERSION_CONFLICT".to_string(),
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
