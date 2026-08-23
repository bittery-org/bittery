use crate::{AccountId, RuntimeError, RuntimeErrorCode};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const KEY_PREFIX: &str = "bittery:runtime:platform-storage";

mod required_option {
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
    where
        D: Deserializer<'de>,
        T: Deserialize<'de>,
    {
        Option::<T>::deserialize(deserializer)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "platform-storage-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
enum PlatformStorageArea {
    DevicePlain,
    DeviceSecret,
    SessionSecret,
}

/// The complete persistable value vocabulary for the first Runtime slice.
///
/// Documents remain opaque at the host seam. This type owns their lifetime, sensitivity, and
/// collision-safe key. Credentials that must never persist, including the master password and raw
/// master unlock key, deliberately have no variant.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PlatformStorageValue {
    DeviceCatalog,
    AccountMetadata(AccountId),
    DeviceKey,
    AccountQuickUnlock(AccountId),
    CurrentSessionCredentials(AccountId),
}

impl PlatformStorageValue {
    fn area(&self) -> PlatformStorageArea {
        match self {
            Self::DeviceCatalog | Self::AccountMetadata(_) => PlatformStorageArea::DevicePlain,
            Self::DeviceKey | Self::AccountQuickUnlock(_) => PlatformStorageArea::DeviceSecret,
            Self::CurrentSessionCredentials(_) => PlatformStorageArea::SessionSecret,
        }
    }

    fn key(&self) -> String {
        match self {
            Self::DeviceCatalog => format!("{KEY_PREFIX}:device-catalog"),
            Self::DeviceKey => format!("{KEY_PREFIX}:device-key"),
            Self::AccountMetadata(account_id) => account_key(account_id, "metadata"),
            Self::AccountQuickUnlock(account_id) => account_key(account_id, "quick-unlock"),
            Self::CurrentSessionCredentials(account_id) => {
                account_key(account_id, "current-session")
            }
        }
    }
}

fn account_key(account_id: &AccountId, document: &str) -> String {
    let identity = account_id.as_str();
    format!(
        "{KEY_PREFIX}:account:{}:{identity}:{document}",
        identity.len()
    )
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "platform-storage-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum PlatformStorageRequest {
    Get {
        area: PlatformStorageArea,
        key: String,
    },
    Set {
        area: PlatformStorageArea,
        key: String,
        value: String,
    },
    Delete {
        area: PlatformStorageArea,
        key: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "platform-storage-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum PlatformStorageResponse {
    Value {
        #[serde(deserialize_with = "required_option::deserialize")]
        value: Option<String>,
    },
    Done,
}

#[cfg(feature = "platform-storage-contract-schema")]
#[derive(schemars::JsonSchema)]
#[allow(dead_code)]
struct PlatformStorageContract {
    request: PlatformStorageRequest,
    response: PlatformStorageResponse,
}

#[cfg(feature = "platform-storage-contract-schema")]
#[doc(hidden)]
pub fn platform_storage_contract_schema() -> schemars::Schema {
    let mut settings = schemars::generate::SchemaSettings::draft2020_12();
    settings.contract = schemars::generate::Contract::Serialize;
    settings
        .into_generator()
        .into_root_schema_for::<PlatformStorageContract>()
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
#[doc(hidden)]
pub trait SerializedPlatformStorageExecutor: Send + Sync {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError>;
}

#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
#[doc(hidden)]
pub trait SerializedPlatformStorageExecutor {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError>;
}

/// Rust-owned platform storage policy over one serialized primitive host seam.
pub struct PlatformStorage {
    executor: Arc<dyn SerializedPlatformStorageExecutor>,
}

impl PlatformStorage {
    pub fn new(executor: Arc<dyn SerializedPlatformStorageExecutor>) -> Self {
        Self { executor }
    }

    pub async fn get(&self, value: &PlatformStorageValue) -> Result<Option<String>, RuntimeError> {
        match self
            .invoke(PlatformStorageRequest::Get {
                area: value.area(),
                key: value.key(),
            })
            .await?
        {
            PlatformStorageResponse::Value { value } => Ok(value),
            PlatformStorageResponse::Done => Err(platform_storage_invariant(
                "platform storage returned Done for Get",
            )),
        }
    }

    pub async fn set(
        &self,
        target: &PlatformStorageValue,
        value: String,
    ) -> Result<(), RuntimeError> {
        self.expect_done(PlatformStorageRequest::Set {
            area: target.area(),
            key: target.key(),
            value,
        })
        .await
    }

    pub async fn delete(&self, value: &PlatformStorageValue) -> Result<(), RuntimeError> {
        self.expect_done(PlatformStorageRequest::Delete {
            area: value.area(),
            key: value.key(),
        })
        .await
    }

    async fn expect_done(&self, request: PlatformStorageRequest) -> Result<(), RuntimeError> {
        match self.invoke(request).await? {
            PlatformStorageResponse::Done => Ok(()),
            PlatformStorageResponse::Value { .. } => Err(platform_storage_invariant(
                "platform storage returned Value for a write",
            )),
        }
    }

    async fn invoke(
        &self,
        request: PlatformStorageRequest,
    ) -> Result<PlatformStorageResponse, RuntimeError> {
        let request_json = serde_json::to_string(&request).map_err(|_| {
            platform_storage_invariant("platform storage request could not be serialized")
        })?;
        let response_json = self.executor.invoke(request_json).await?;
        serde_json::from_str(&response_json).map_err(|_| {
            platform_storage_invariant("platform storage returned an invalid response")
        })
    }
}

fn platform_storage_invariant(message: impl Into<String>) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingExecutor {
        requests: Mutex<Vec<PlatformStorageRequest>>,
        responses: Mutex<Vec<PlatformStorageResponse>>,
    }

    #[async_trait]
    impl SerializedPlatformStorageExecutor for RecordingExecutor {
        async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
            let request = serde_json::from_str(&request_json)
                .map_err(|_| platform_storage_invariant("test request was invalid"))?;
            self.requests
                .lock()
                .expect("requests lock poisoned")
                .push(request);
            let response = self
                .responses
                .lock()
                .expect("responses lock poisoned")
                .remove(0);
            serde_json::to_string(&response)
                .map_err(|_| platform_storage_invariant("test response could not serialize"))
        }
    }

    fn account(value: &str) -> AccountId {
        AccountId::from(value)
    }

    #[test]
    fn classification_is_complete_and_keeps_authentication_inputs_unpersistable() {
        let values = [
            (
                PlatformStorageValue::DeviceCatalog,
                PlatformStorageArea::DevicePlain,
            ),
            (
                PlatformStorageValue::AccountMetadata(account("account")),
                PlatformStorageArea::DevicePlain,
            ),
            (
                PlatformStorageValue::DeviceKey,
                PlatformStorageArea::DeviceSecret,
            ),
            (
                PlatformStorageValue::AccountQuickUnlock(account("account")),
                PlatformStorageArea::DeviceSecret,
            ),
            (
                PlatformStorageValue::CurrentSessionCredentials(account("account")),
                PlatformStorageArea::SessionSecret,
            ),
        ];

        assert_eq!(values.len(), 5);
        for (value, expected_area) in values {
            assert_eq!(value.area(), expected_area);
            let key = value.key();
            assert!(!key.contains("master-password"));
            assert!(!key.contains("raw-master-unlock-key"));
        }
    }

    #[test]
    fn account_keys_are_stable_and_collision_safe() {
        let first = PlatformStorageValue::AccountMetadata(account("a:b"));
        let second = PlatformStorageValue::AccountMetadata(account("a"));
        let third = PlatformStorageValue::AccountQuickUnlock(account("a:b"));

        assert_eq!(first.key(), first.key());
        assert_ne!(first.key(), second.key());
        assert_ne!(first.key(), third.key());
        assert!(first.key().contains("account:3:a:b:metadata"));
    }

    #[test]
    fn wire_contract_rejects_unknown_or_missing_fields() {
        assert!(serde_json::from_str::<PlatformStorageRequest>(
            r#"{"type":"get","area":"devicePlain","key":"opaque","extra":true}"#
        )
        .is_err());
        assert!(serde_json::from_str::<PlatformStorageRequest>(
            r#"{"type":"get","area":"memory","key":"opaque"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<PlatformStorageResponse>(r#"{"type":"value"}"#).is_err());
    }

    #[tokio::test]
    async fn logical_operations_emit_only_the_three_primitive_requests() {
        let executor = Arc::new(RecordingExecutor::default());
        executor
            .responses
            .lock()
            .expect("responses lock poisoned")
            .extend([
                PlatformStorageResponse::Value { value: None },
                PlatformStorageResponse::Done,
                PlatformStorageResponse::Done,
            ]);
        let storage = PlatformStorage::new(executor.clone());
        let value = PlatformStorageValue::CurrentSessionCredentials(account("account"));

        assert_eq!(storage.get(&value).await.expect("get must succeed"), None);
        storage
            .set(&value, "opaque-document".into())
            .await
            .expect("set must succeed");
        storage.delete(&value).await.expect("delete must succeed");

        assert_eq!(
            *executor.requests.lock().expect("requests lock poisoned"),
            vec![
                PlatformStorageRequest::Get {
                    area: PlatformStorageArea::SessionSecret,
                    key: value.key(),
                },
                PlatformStorageRequest::Set {
                    area: PlatformStorageArea::SessionSecret,
                    key: value.key(),
                    value: "opaque-document".into(),
                },
                PlatformStorageRequest::Delete {
                    area: PlatformStorageArea::SessionSecret,
                    key: value.key(),
                },
            ]
        );
    }
}
