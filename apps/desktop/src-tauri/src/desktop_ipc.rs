use serde::{Deserialize, Serialize};
use tokio::io::{self, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

#[cfg(windows)]
pub const DESKTOP_IPC_PIPE_NAME: &str = r"\\.\pipe\bittery-desktop-ipc";
pub const DESKTOP_IPC_SOCKET_NAME: &str = "bittery-desktop-ipc.sock";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProtocolEnvelope<T> {
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(flatten)]
    pub payload: T,
}

pub type DesktopEnvelope<T> = ProtocolEnvelope<T>;

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
    OpenDesktopApp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum DesktopResponse {
    #[serde(rename = "PONG")]
    Pong {
        version: String,
    },
    #[serde(rename = "DESKTOP_STATUS")]
    DesktopStatus {
        available: bool,
        locked: bool,
        #[serde(rename = "unlockedAccounts")]
        unlocked_accounts: Vec<String>,
        timestamp: i64,
        #[serde(rename = "autolockTimeoutMs")]
        autolock_timeout_ms: i64,
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
    DesktopEventSubscription {
        subscribed: bool,
    },
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
    BiometricUnlockFailed {
        error: String,
    },
    #[serde(rename = "BIOMETRIC_UNLOCK_ALL_SUCCESS")]
    BiometricUnlockAllSuccess {
        device_key: String,
        signature: String,
        accounts: Vec<AccountUnlockData>,
        unlocked: Vec<String>,
        failed: Vec<String>,
    },
    #[serde(rename = "BIOMETRIC_UNLOCK_ALL_FAILED")]
    BiometricUnlockAllFailed {
        error: String,
    },
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
    Error {
        message: String,
    },
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DesktopEventKind {
    Lock,
    Unlock,
    DesktopClose,
    ActiveAccountChanged,
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

    serde_json::from_slice(&buffer).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
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

#[cfg(unix)]
pub fn desktop_ipc_socket_path() -> std::path::PathBuf {
    std::env::temp_dir().join(DESKTOP_IPC_SOCKET_NAME)
}

#[cfg(windows)]
pub fn desktop_ipc_socket_path() -> std::path::PathBuf {
    std::path::PathBuf::from(DESKTOP_IPC_PIPE_NAME)
}

#[cfg(test)]
mod tests {
    use super::{
        read_frame, write_frame, DesktopEnvelope, DesktopEventKind, DesktopRequest,
        DesktopResponse,
    };
    use tokio::io::duplex;

    #[tokio::test]
    async fn frame_round_trip_preserves_payload() {
        let (mut writer, mut reader) = duplex(4096);
        let message = DesktopEnvelope {
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

    #[tokio::test]
    async fn response_event_frame_round_trip_preserves_payload() {
        let (mut writer, mut reader) = duplex(4096);
        let message = DesktopEnvelope {
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
    }
}
