//! The desktop↔extension wire format.
//!
//! Every type here is the *single* definition of its shape: ts-rs writes the
//! TypeScript mirror into `apps/desktop/src/generated/desktop-ipc.ts`, which the
//! browser extension imports. Nothing downstream may restate one of these shapes
//! (ADR 0012).
//!
//! `export_to` is resolved against ts-rs's default export directory,
//! `<crate root>/bindings`, so `../../src/generated/...` lands in
//! `apps/desktop/src/generated/` no matter which directory `cargo test` was
//! invoked from. That matters: `cargo test --manifest-path …` from the repo root
//! would not pick up a `.cargo/config.toml` living next to this crate.
//!
//! `i64` timestamps carry `#[ts(type = "number")]` because ts-rs maps 64-bit
//! integers to `bigint` by default, and these travel as JSON numbers.

use serde::{Deserialize, Serialize};
use tokio::io::{self, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use ts_rs::TS;

pub const DESKTOP_PROTOCOL_VERSION: u32 = 1;

/// The pinned version as a TypeScript literal, so the extension's constant is
/// checked against this one instead of restating it. The assertion is what keeps
/// the literal honest: bumping the constant fails the build here first.
#[allow(dead_code)]
#[derive(TS)]
#[ts(export, export_to = "../../src/generated/desktop-ipc.ts")]
pub struct DesktopProtocolVersion(#[ts(type = "1")] u32);

const _: () = assert!(DESKTOP_PROTOCOL_VERSION == 1);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/generated/desktop-ipc.ts")]
pub struct ProtocolEnvelope<T> {
    #[serde(
        rename = "protocolVersion",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub protocol_version: Option<u32>,
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "type")]
#[ts(export, export_to = "../../src/generated/desktop-ipc.ts")]
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
        #[ts(optional)]
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
        #[ts(optional)]
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
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "tolerant_option"
        )]
        #[ts(optional)]
        intent: Option<OpenDesktopAppIntent>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        url: Option<String>,
        #[serde(default, rename = "itemId", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        item_id: Option<String>,
        #[serde(default, rename = "vaultId", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        vault_id: Option<String>,
    },
}

/// Read a closed-set field without letting an unknown member fail the frame.
///
/// The desktop app, the native host and the extension are installed separately,
/// so a peer may name a variant this build has never heard of. Every closed set
/// on this wire used to be a `String` that the receiver matched loosely and
/// otherwise ignored; this keeps exactly that behaviour now that the sets are
/// enums, so naming them costs no forward compatibility.
fn tolerant_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let raw = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(raw.and_then(|value| serde_json::from_value(value).ok()))
}

/// What the extension wants the desktop app to do once it is in the foreground.
///
/// A closed set, so it is an enum rather than a `String`: the app matches on it
/// and an unknown value has no defined behaviour. Spelling the alternatives here
/// is also what lets the generated TypeScript keep the narrow union the
/// extension has always declared.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../src/generated/desktop-ipc.ts")]
pub enum OpenDesktopAppIntent {
    CreateItem,
    ViewItem,
}

/// The desktop app's appearance preference, as the extension mirrors it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/generated/desktop-ipc.ts")]
pub enum DesktopTheme {
    Light,
    Dark,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "type")]
#[ts(export, export_to = "../../src/generated/desktop-ipc.ts")]
pub enum DesktopResponse {
    #[serde(rename = "PROTOCOL_MISMATCH")]
    ProtocolMismatch {
        #[serde(rename = "expectedVersion")]
        expected_version: u32,
        #[serde(rename = "receivedVersion", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
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
        #[ts(type = "number")]
        timestamp: i64,
        #[serde(rename = "autolockTimeoutMs")]
        #[ts(type = "number")]
        autolock_timeout_ms: i64,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "tolerant_option"
        )]
        #[ts(optional)]
        theme: Option<DesktopTheme>,
    },
    #[serde(rename = "DESKTOP_ACCOUNTS")]
    DesktopAccounts {
        accounts: Vec<DesktopAccountEntry>,
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
        #[ts(optional, type = "number")]
        expires_at: Option<i64>,
        #[serde(rename = "userId", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
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
    /// Each item is the account's decrypted item plaintext with a handful of
    /// metadata fields merged over it (`build_snapshot_item_payload` in
    /// `lib.rs`). The plaintext is a client-owned shape with no Rust definition —
    /// this process only ever passes it through — so it stays opaque here rather
    /// than growing a second, Rust-flavoured declaration of it. The extension
    /// validates the structural fields in `desktop-snapshot.ts`.
    #[serde(rename = "DESKTOP_ITEMS_SNAPSHOT")]
    DesktopItemsSnapshot {
        #[ts(type = "Array<Record<string, unknown>>")]
        items: Vec<serde_json::Value>,
        #[serde(rename = "generatedAt")]
        #[ts(type = "number")]
        generated_at: i64,
    },
    #[serde(rename = "DESKTOP_EVENT")]
    DesktopEvent(DesktopEvent),
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
        #[ts(optional)]
        auth_token: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
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
        #[ts(optional)]
        error: Option<String>,
    },
    #[serde(rename = "TRIGGER_DESKTOP_UNLOCK_RESULT")]
    TriggerDesktopUnlockResult {
        success: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        error: Option<String>,
    },
    #[serde(rename = "ERROR")]
    Error { message: String },
}

/// One account, exactly as `DESKTOP_ACCOUNTS` publishes it.
///
/// A pure republication of the native-host view's account entry: the extension
/// stores the result as its own `AccountMetadata`, so every field it needs is
/// published rather than defaulted or re-derived on either side.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/desktop-ipc.ts")]
pub struct DesktopAccountEntry {
    pub account_id: String,
    pub email: String,
    pub user_id: String,
    pub name: String,
    pub secret_key_hint: String,
    /// Omitted entirely when the view omitted it, so "no team" never arrives at
    /// the consumer as an empty string.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub team_name: Option<String>,
    /// Nullable rather than skipped: the consumer's field is `string | null`.
    pub team_avatar_url: Option<String>,
    #[ts(type = "number")]
    pub added_at: i64,
    #[ts(type = "number")]
    pub last_active_at: i64,
    pub biometric_enabled: bool,
}

/// A pushed desktop event and its payload, as one adjacently tagged pair.
///
/// The tag rides in `event` and the body in `payload`, which is the shape this
/// protocol has always had; expressing it as an enum is what lets the generated
/// TypeScript correlate the two instead of handing the consumer an opaque
/// payload next to a free-standing tag.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(tag = "event", content = "payload", rename_all = "snake_case")]
#[ts(export, export_to = "../../src/generated/desktop-ipc.ts")]
pub enum DesktopEvent {
    Lock {
        reason: String,
        #[ts(type = "number")]
        timestamp: i64,
    },
    Unlock {
        accounts: Vec<String>,
        #[ts(type = "number")]
        timestamp: i64,
    },
    DesktopClose {
        #[ts(type = "number")]
        timestamp: i64,
    },
    #[serde(rename_all = "camelCase")]
    ActiveAccountChanged {
        account_id: String,
        #[ts(type = "number")]
        timestamp: i64,
    },
    ThemeChanged {
        theme: DesktopTheme,
        #[ts(type = "number")]
        timestamp: i64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/generated/desktop-ipc.ts")]
pub struct AccountUnlockData {
    #[serde(rename = "accountId")]
    pub account_id: String,
    pub email: String,
    pub encrypted_session: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub auth_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub vault_keys: Option<String>,
}

// The native host compiles this shared schema but never constructs desktop-side material.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/generated/desktop-ipc.ts")]
pub struct BiometricUnlockMaterial {
    pub account: AccountUnlockData,
    pub device_key: String,
    pub signature: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/generated/desktop-ipc.ts")]
pub struct BiometricUnlockAllMaterial {
    pub device_key: String,
    pub signature: String,
    pub accounts: Vec<AccountUnlockData>,
    pub unlocked: Vec<String>,
    pub failed: Vec<String>,
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
        read_frame, write_frame, AccountUnlockData, DesktopAccountEntry, DesktopEnvelope,
        DesktopEvent, DesktopRequest, DesktopResponse, DesktopTheme, OpenDesktopAppIntent,
        DESKTOP_PROTOCOL_VERSION,
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
                intent: Some(OpenDesktopAppIntent::CreateItem),
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
                intent: Some(OpenDesktopAppIntent::ViewItem),
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
            payload: DesktopResponse::DesktopEvent(DesktopEvent::Unlock {
                accounts: vec!["alice@example.com".to_string()],
                timestamp: 123,
            }),
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

    /// The exact bytes an extension subscriber has always seen for a pushed
    /// event: the tag beside its payload, both inside the response envelope.
    #[test]
    fn desktop_event_wire_shape_is_tag_beside_payload() {
        let envelope = DesktopEnvelope::current(
            None,
            DesktopResponse::DesktopEvent(DesktopEvent::ActiveAccountChanged {
                account_id: "account-1".to_string(),
                timestamp: 17,
            }),
        );

        assert_eq!(
            serde_json::to_value(&envelope).expect("event should serialize"),
            serde_json::json!({
                "protocolVersion": 1,
                "type": "DESKTOP_EVENT",
                "event": "active_account_changed",
                "payload": { "accountId": "account-1", "timestamp": 17 },
            })
        );
    }

    #[test]
    fn theme_changed_event_wire_shape_is_unchanged() {
        let envelope = DesktopEnvelope::current(
            None,
            DesktopResponse::DesktopEvent(DesktopEvent::ThemeChanged {
                theme: DesktopTheme::System,
                timestamp: 17,
            }),
        );

        assert_eq!(
            serde_json::to_value(&envelope).expect("event should serialize"),
            serde_json::json!({
                "protocolVersion": 1,
                "type": "DESKTOP_EVENT",
                "event": "theme_changed",
                "payload": { "theme": "system", "timestamp": 17 },
            })
        );
    }

    /// A newer peer may name an intent or a theme this build has never heard of.
    /// The field drops out; the rest of the message still has to be usable.
    #[test]
    fn unknown_closed_set_members_are_dropped_not_fatal() {
        let raw = r#"{"protocolVersion":1,"type":"OPEN_DESKTOP_APP","intent":"share_item","url":"https://example.com"}"#;
        let decoded: DesktopEnvelope<DesktopRequest> =
            serde_json::from_str(raw).expect("an unknown intent must not fail the frame");
        assert_eq!(
            decoded.payload,
            DesktopRequest::OpenDesktopApp {
                intent: None,
                url: Some("https://example.com".to_string()),
                item_id: None,
                vault_id: None,
            }
        );

        let raw = r#"{"protocolVersion":1,"type":"DESKTOP_STATUS","available":true,"locked":false,"unlockedAccounts":[],"timestamp":1,"autolockTimeoutMs":2,"theme":"sepia"}"#;
        let decoded: DesktopEnvelope<DesktopResponse> =
            serde_json::from_str(raw).expect("an unknown theme must not fail the frame");
        assert_eq!(
            decoded.payload,
            DesktopResponse::DesktopStatus {
                available: true,
                locked: false,
                unlocked_accounts: Vec::new(),
                timestamp: 1,
                autolock_timeout_ms: 2,
                theme: None,
            }
        );
    }

    /// `DESKTOP_ACCOUNTS` entries are typed now; the bytes are not allowed to
    /// move. `teamName` is omitted when absent, `teamAvatarUrl` is sent as null.
    #[test]
    fn desktop_account_entry_wire_shape_is_unchanged() {
        let entry = DesktopAccountEntry {
            account_id: "account-1".to_string(),
            email: "person@example.com".to_string(),
            user_id: "user-1".to_string(),
            name: "Person".to_string(),
            secret_key_hint: "AB-CD".to_string(),
            team_name: None,
            team_avatar_url: None,
            added_at: 1,
            last_active_at: 2,
            biometric_enabled: true,
        };

        assert_eq!(
            serde_json::to_value(&entry).expect("entry should serialize"),
            serde_json::json!({
                "accountId": "account-1",
                "email": "person@example.com",
                "userId": "user-1",
                "name": "Person",
                "secretKeyHint": "AB-CD",
                "teamAvatarUrl": serde_json::Value::Null,
                "addedAt": 1,
                "lastActiveAt": 2,
                "biometricEnabled": true,
            })
        );
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
