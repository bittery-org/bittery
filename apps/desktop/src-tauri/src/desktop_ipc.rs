use serde::{Deserialize, Serialize};
use tokio::io::{self, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

// Kept at 1: additive fields remain compatible with older desktop peers.
pub const DESKTOP_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProtocolEnvelope<T> {
    #[serde(
        rename = "protocolVersion",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub protocol_version: Option<u32>,
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(flatten)]
    pub payload: T,
}

pub type DesktopEnvelope<T> = ProtocolEnvelope<T>;

impl<T> ProtocolEnvelope<T> {
    pub fn current(request_id: Option<String>, payload: T) -> Self {
        Self {
            protocol_version: Some(DESKTOP_PROTOCOL_VERSION),
            request_id,
            payload,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum DesktopRequest {
    #[serde(rename = "PING")]
    Ping,
    #[serde(rename = "GET_DESKTOP_STATUS")]
    GetDesktopStatus,
    #[serde(rename = "GET_DESKTOP_ACCOUNTS")]
    GetDesktopAccounts,
    #[serde(rename = "GET_DESKTOP_AUTH_TOKEN")]
    GetDesktopAuthToken {
        #[serde(rename = "accountId")]
        account_id: String,
    },
    #[serde(rename = "GET_DESKTOP_VAULT_KEYS")]
    GetDesktopVaultKeys {
        #[serde(rename = "accountId")]
        account_id: String,
    },
    #[serde(rename = "GET_DESKTOP_ITEMS_SNAPSHOT")]
    GetDesktopItemsSnapshot {
        #[serde(skip_serializing_if = "Option::is_none")]
        #[serde(rename = "accountIds")]
        account_ids: Option<Vec<String>>,
    },
    #[serde(rename = "SUBSCRIBE_DESKTOP_EVENTS")]
    SubscribeDesktopEvents,
    #[serde(rename = "UNSUBSCRIBE_DESKTOP_EVENTS")]
    UnsubscribeDesktopEvents,
    #[serde(rename = "CHECK_BIOMETRIC_AVAILABLE")]
    CheckBiometricAvailable,
    #[serde(rename = "BIOMETRIC_UNLOCK_REQUEST")]
    BiometricUnlockRequest {
        challenge: String,
        extension_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[serde(rename = "accountId")]
        account_id: Option<String>,
    },
    #[serde(rename = "BIOMETRIC_UNLOCK_ALL_REQUEST")]
    BiometricUnlockAllRequest {
        challenge: String,
        extension_id: String,
    },
    #[serde(rename = "TRIGGER_DESKTOP_UNLOCK")]
    TriggerDesktopUnlock,
    #[serde(rename = "OPEN_DESKTOP_APP")]
    OpenDesktopApp {
        // Additive, protocol v1: older peers omit these and older hosts
        // ignore them, simply opening the app without the intent.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        intent: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        #[serde(default, rename = "itemId", skip_serializing_if = "Option::is_none")]
        item_id: Option<String>,
        #[serde(default, rename = "vaultId", skip_serializing_if = "Option::is_none")]
        vault_id: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum DesktopResponse {
    #[serde(rename = "PROTOCOL_MISMATCH")]
    ProtocolMismatch {
        #[serde(rename = "expectedVersion")]
        expected_version: u32,
        #[serde(rename = "receivedVersion", skip_serializing_if = "Option::is_none")]
        received_version: Option<u32>,
    },
    #[serde(rename = "PONG")]
    Pong { version: String },
    #[serde(rename = "DESKTOP_STATUS")]
    DesktopStatus {
        available: bool,
        locked: bool,
        #[serde(rename = "unlockedAccounts")]
        unlocked_accounts: Vec<String>,
        timestamp: i64,
        #[serde(rename = "autolockTimeoutMs")]
        autolock_timeout_ms: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        theme: Option<String>,
    },
    #[serde(rename = "DESKTOP_ACCOUNTS")]
    DesktopAccounts {
        accounts: Vec<serde_json::Value>,
        #[serde(rename = "activeAccount")]
        active_account: Option<String>,
        #[serde(rename = "unlockedAccounts")]
        unlocked_accounts: Vec<String>,
    },
    #[serde(rename = "DESKTOP_AUTH_TOKEN")]
    DesktopAuthToken {
        #[serde(rename = "accountId")]
        account_id: String,
        email: String,
        #[serde(rename = "authToken")]
        auth_token: String,
        #[serde(rename = "expiresAt", skip_serializing_if = "Option::is_none")]
        expires_at: Option<i64>,
        #[serde(rename = "userId", skip_serializing_if = "Option::is_none")]
        user_id: Option<String>,
    },
    #[serde(rename = "DESKTOP_VAULT_KEYS")]
    DesktopVaultKeys {
        #[serde(rename = "accountId")]
        account_id: String,
        email: String,
        #[serde(rename = "vaultKeys")]
        vault_keys: String,
    },
    #[serde(rename = "DESKTOP_ITEMS_SNAPSHOT")]
    DesktopItemsSnapshot {
        items: Vec<serde_json::Value>,
        #[serde(rename = "generatedAt")]
        generated_at: i64,
    },
    #[serde(rename = "DESKTOP_EVENT")]
    DesktopEvent {
        event: DesktopEventKind,
        payload: serde_json::Value,
    },
    #[serde(rename = "DESKTOP_EVENT_SUBSCRIPTION")]
    DesktopEventSubscription { subscribed: bool },
    #[serde(rename = "BIOMETRIC_STATUS")]
    BiometricStatus {
        available: bool,
        enabled: bool,
        #[serde(rename = "appRunning")]
        app_running: bool,
    },
    #[serde(rename = "BIOMETRIC_UNLOCK_SUCCESS")]
    BiometricUnlockSuccess {
        #[serde(rename = "accountId")]
        account_id: String,
        email: String,
        encrypted_session: String,
        device_key: String,
        signature: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        auth_token: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        vault_keys: Option<String>,
    },
    #[serde(rename = "BIOMETRIC_UNLOCK_FAILED")]
    BiometricUnlockFailed { error: String },
    #[serde(rename = "BIOMETRIC_UNLOCK_ALL_SUCCESS")]
    BiometricUnlockAllSuccess {
        device_key: String,
        signature: String,
        accounts: Vec<AccountUnlockData>,
        unlocked: Vec<String>,
        failed: Vec<String>,
    },
    #[serde(rename = "BIOMETRIC_UNLOCK_ALL_FAILED")]
    BiometricUnlockAllFailed { error: String },
    #[serde(rename = "OPEN_DESKTOP_APP_RESULT")]
    OpenDesktopAppResult {
        success: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename = "TRIGGER_DESKTOP_UNLOCK_RESULT")]
    TriggerDesktopUnlockResult {
        success: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename = "ERROR")]
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AccountUnlockData {
    #[serde(rename = "accountId")]
    pub account_id: String,
    pub email: String,
    pub encrypted_session: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault_keys: Option<String>,
}

// The native host compiles this shared schema but never constructs desktop-side material.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BiometricUnlockMaterial {
    pub account: AccountUnlockData,
    pub device_key: String,
    pub signature: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BiometricUnlockAllMaterial {
    pub device_key: String,
    pub signature: String,
    pub accounts: Vec<AccountUnlockData>,
    pub unlocked: Vec<String>,
    pub failed: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DesktopEventKind {
    Lock,
    Unlock,
    DesktopClose,
    ActiveAccountChanged,
    ThemeChanged,
}

pub async fn read_frame<R, T>(reader: &mut R) -> io::Result<T>
where
    R: AsyncRead + Unpin,
    T: for<'de> Deserialize<'de>,
{
    let mut length_bytes = [0u8; 4];
    reader.read_exact(&mut length_bytes).await?;
    let length = u32::from_le_bytes(length_bytes) as usize;

    let mut buffer = vec![0u8; length];
    reader.read_exact(&mut buffer).await?;

    serde_json::from_slice(&buffer)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

pub async fn write_frame<W, T>(writer: &mut W, value: &T) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let payload = serde_json::to_vec(value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let length = payload.len() as u32;
    writer.write_all(&length.to_le_bytes()).await?;
    writer.write_all(&payload).await?;
    writer.flush().await?;
    Ok(())
}

// The endpoint's location used to live here. It moved to `ipc_security`
// because a socket path is only as private as the directory it sits in, so the
// path and its access controls have to be decided together. This module stays
// purely about the wire format.

#[cfg(test)]
mod tests {
    use super::{
        read_frame, write_frame, AccountUnlockData, DesktopEnvelope, DesktopEventKind,
        DesktopRequest, DesktopResponse, DESKTOP_PROTOCOL_VERSION,
    };
    use tokio::io::duplex;

    #[tokio::test]
    async fn frame_round_trip_preserves_payload() {
        let (mut writer, mut reader) = duplex(4096);
        let message = DesktopEnvelope {
            protocol_version: Some(DESKTOP_PROTOCOL_VERSION),
            request_id: Some("req-1".to_string()),
            payload: DesktopRequest::GetDesktopItemsSnapshot {
                account_ids: Some(vec!["account-1".to_string()]),
            },
        };

        write_frame(&mut writer, &message)
            .await
            .expect("frame write should succeed");

        let decoded: DesktopEnvelope<DesktopRequest> = read_frame(&mut reader)
            .await
            .expect("frame read should succeed");

        assert_eq!(decoded, message);
    }

    #[test]
    fn open_desktop_app_intent_survives_envelope_deserialization() {
        // Exact wire shape the extension sends for the "new item" handoff.
        let raw = r#"{"requestId":"desktop-1","protocolVersion":2,"type":"OPEN_DESKTOP_APP","intent":"create_item","url":"https://example.com/login"}"#;
        let decoded: DesktopEnvelope<DesktopRequest> =
            serde_json::from_str(raw).expect("envelope should deserialize");

        assert_eq!(
            decoded.payload,
            DesktopRequest::OpenDesktopApp {
                intent: Some("create_item".to_string()),
                url: Some("https://example.com/login".to_string()),
                item_id: None,
                vault_id: None,
            }
        );
    }

    #[test]
    fn open_desktop_app_view_item_intent_survives_envelope_deserialization() {
        // Exact wire shape the extension sends for the "open in app" handoff.
        let raw = r#"{"requestId":"desktop-2","protocolVersion":2,"type":"OPEN_DESKTOP_APP","intent":"view_item","itemId":"item-1","vaultId":"vault-1"}"#;
        let decoded: DesktopEnvelope<DesktopRequest> =
            serde_json::from_str(raw).expect("envelope should deserialize");

        assert_eq!(
            decoded.payload,
            DesktopRequest::OpenDesktopApp {
                intent: Some("view_item".to_string()),
                url: None,
                item_id: Some("item-1".to_string()),
                vault_id: Some("vault-1".to_string()),
            }
        );
    }

    #[test]
    fn open_desktop_app_without_intent_still_deserializes() {
        // Older extensions send the bare request; it must keep working.
        let raw = r#"{"protocolVersion":2,"type":"OPEN_DESKTOP_APP"}"#;
        let decoded: DesktopEnvelope<DesktopRequest> =
            serde_json::from_str(raw).expect("envelope should deserialize");

        assert_eq!(
            decoded.payload,
            DesktopRequest::OpenDesktopApp {
                intent: None,
                url: None,
                item_id: None,
                vault_id: None,
            }
        );
    }

    #[tokio::test]
    async fn auth_token_request_round_trip_preserves_account_id_and_protocol_version() {
        let (mut writer, mut reader) = duplex(4096);
        let message = DesktopEnvelope {
            protocol_version: Some(DESKTOP_PROTOCOL_VERSION),
            request_id: Some("req-auth".to_string()),
            payload: DesktopRequest::GetDesktopAuthToken {
                account_id: "account-1".to_string(),
            },
        };

        write_frame(&mut writer, &message)
            .await
            .expect("frame write should succeed");
        let decoded: DesktopEnvelope<DesktopRequest> = read_frame(&mut reader)
            .await
            .expect("frame read should succeed");

        assert_eq!(decoded, message);
    }

    #[tokio::test]
    async fn response_event_frame_round_trip_preserves_payload() {
        let (mut writer, mut reader) = duplex(4096);
        let message = DesktopEnvelope {
            protocol_version: Some(DESKTOP_PROTOCOL_VERSION),
            request_id: None,
            payload: DesktopResponse::DesktopEvent {
                event: DesktopEventKind::Unlock,
                payload: serde_json::json!({
                    "accounts": ["alice@example.com"],
                    "timestamp": 123,
                }),
            },
        };

        write_frame(&mut writer, &message)
            .await
            .expect("frame write should succeed");

        let decoded: DesktopEnvelope<DesktopResponse> = read_frame(&mut reader)
            .await
            .expect("frame read should succeed");

        assert_eq!(decoded, message);
        let serialized = serde_json::to_value(&decoded).expect("response should serialize");
        assert_eq!(serialized["protocolVersion"], DESKTOP_PROTOCOL_VERSION);
    }

    #[test]
    fn biometric_unlock_wire_fixture_uses_desktop_protocol_version_one() {
        let raw = r#"{"protocolVersion":1,"requestId":"unlock-1","type":"BIOMETRIC_UNLOCK_SUCCESS","accountId":"account-1","email":"person@example.com","encrypted_session":"encrypted-session","device_key":"device-key","signature":"signature","auth_token":"token","vault_keys":"[]"}"#;
        let decoded: DesktopEnvelope<DesktopResponse> =
            serde_json::from_str(raw).expect("the v1 biometric fixture should deserialize");

        assert_eq!(DESKTOP_PROTOCOL_VERSION, 1);
        assert_eq!(decoded.protocol_version, Some(1));
        assert_eq!(
            decoded.payload,
            DesktopResponse::BiometricUnlockSuccess {
                account_id: "account-1".to_string(),
                email: "person@example.com".to_string(),
                encrypted_session: "encrypted-session".to_string(),
                device_key: "device-key".to_string(),
                signature: "signature".to_string(),
                auth_token: Some("token".to_string()),
                vault_keys: Some("[]".to_string()),
            }
        );
    }

    #[test]
    fn biometric_unlock_wire_fixture_rejects_missing_material() {
        let raw = r#"{"protocolVersion":1,"type":"BIOMETRIC_UNLOCK_SUCCESS","accountId":"account-1","email":"person@example.com","device_key":"device-key","signature":"signature"}"#;

        assert!(serde_json::from_str::<DesktopEnvelope<DesktopResponse>>(raw).is_err());
    }

    #[test]
    fn all_account_biometric_unlock_wire_fixture_preserves_each_account() {
        let raw = r#"{"protocolVersion":1,"requestId":"unlock-all-1","type":"BIOMETRIC_UNLOCK_ALL_SUCCESS","device_key":"device-key","signature":"signature","accounts":[{"accountId":"account-1","email":"first@example.com","encrypted_session":"session-1"},{"accountId":"account-2","email":"second@example.com","encrypted_session":"session-2","auth_token":"token-2","vault_keys":"[]"}],"unlocked":["account-1","account-2"],"failed":[]}"#;
        let decoded: DesktopEnvelope<DesktopResponse> =
            serde_json::from_str(raw).expect("the v1 all-account fixture should deserialize");

        assert_eq!(
            decoded.payload,
            DesktopResponse::BiometricUnlockAllSuccess {
                device_key: "device-key".to_string(),
                signature: "signature".to_string(),
                accounts: vec![
                    AccountUnlockData {
                        account_id: "account-1".to_string(),
                        email: "first@example.com".to_string(),
                        encrypted_session: "session-1".to_string(),
                        auth_token: None,
                        vault_keys: None,
                    },
                    AccountUnlockData {
                        account_id: "account-2".to_string(),
                        email: "second@example.com".to_string(),
                        encrypted_session: "session-2".to_string(),
                        auth_token: Some("token-2".to_string()),
                        vault_keys: Some("[]".to_string()),
                    },
                ],
                unlocked: vec!["account-1".to_string(), "account-2".to_string()],
                failed: Vec::new(),
            }
        );
    }
}
