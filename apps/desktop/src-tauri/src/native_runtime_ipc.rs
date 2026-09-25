//! Source-only native transport. Core challenge/reply JSON remains opaque to the broker.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use zeroize::Zeroizing;

pub const RUNTIME_NATIVE_PROTOCOL_VERSION: u32 = 2;
pub const MAX_RUNTIME_NATIVE_REQUEST_BYTES: usize = 64 * 1024;
pub const MAX_RUNTIME_NATIVE_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "../../src/generated/native-runtime-ipc.ts")]
pub struct NativeRuntimeRequest {
    #[ts(type = "2")]
    pub protocol_version: u32,
    pub request_id: String,
    pub command: NativeRuntimeCommand,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[ts(export, export_to = "../../src/generated/native-runtime-ipc.ts")]
pub enum NativeRuntimeCommand {
    Connect {},
    Snapshot {},
    AcknowledgeRestrictions {
        acknowledgement: String,
    },
    Export {
        challenge: String,
    },
    RevalidateIndependentRestrictions {
        challenge: String,
    },
    ExportWithBiometric {
        challenge: String,
        prompt_message: String,
    },
    Cancel {
        call_id: String,
    },
}

/// Created by the authenticated native binary from its browser launch origin, never browser input.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRuntimeHandshake {
    pub protocol_version: u32,
    pub request_id: String,
    pub browser_origin: String,
}

/// The native binary derives this origin from its validated launch argument. Browser protocol 1
/// remains unchanged; this closed envelope exists only on the authenticated Desktop socket.
#[cfg_attr(not(feature = "native-runtime-legacy-source"), allow(dead_code))]
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyRuntimeHandshake {
    pub mode: LegacyRuntimeMode,
    pub browser_origin: String,
    pub request: crate::desktop_ipc::DesktopEnvelope<crate::desktop_ipc::DesktopRequest>,
}

#[cfg_attr(not(feature = "native-runtime-legacy-source"), allow(dead_code))]
#[derive(Debug, Serialize, Deserialize)]
pub enum LegacyRuntimeMode {
    #[serde(rename = "legacySource")]
    LegacySource,
}

#[derive(Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[ts(export, export_to = "../../src/generated/native-runtime-ipc.ts")]
pub enum NativeRuntimeMessage {
    /// Success is Core native-authority JSON; failure is the existing closed Core RuntimeError.
    Reply {
        request_id: String,
        failed: bool,
        #[ts(as = "String")]
        payload: Zeroizing<String>,
    },
    Authority {
        #[ts(as = "String")]
        payload: Zeroizing<String>,
    },
    Cancelled {
        request_id: String,
    },
}

#[cfg(test)]
mod tests {
    use super::{NativeRuntimeCommand, NativeRuntimeRequest};

    #[test]
    fn browser_wire_cannot_supply_origin_channel_or_destination_authority() {
        for raw in [
            r#"{"type":"connect","browserOrigin":"chrome-extension://other/"}"#,
            r#"{"type":"snapshot","channelId":"another-port"}"#,
            r#"{"type":"attachDesktop","source":{}}"#,
            r#"{"type":"completeImport","reply":{}}"#,
            r#"{"type":"applyAuthority","source":{}}"#,
            r#"{"type":"signIn","email":"ignored"}"#,
        ] {
            assert!(serde_json::from_str::<NativeRuntimeCommand>(raw).is_err());
        }
        let request: NativeRuntimeRequest = serde_json::from_str(
            r#"{"protocolVersion":2,"requestId":"call-1","command":{"type":"export","challenge":"core-challenge-json"}}"#,
        ).unwrap();
        assert!(matches!(
            request.command,
            NativeRuntimeCommand::Export { .. }
        ));
    }
}
