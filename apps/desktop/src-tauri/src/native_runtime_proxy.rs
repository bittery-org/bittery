//! Bounded source-only frame proxy; the Desktop Core owns all payload meaning and authority.

use crate::{
    desktop_ipc::{read_frame_bounded, write_frame_bounded},
    native_runtime_ipc::{
        NativeRuntimeCommand, NativeRuntimeHandshake, NativeRuntimeMessage, NativeRuntimeRequest,
        MAX_RUNTIME_NATIVE_REQUEST_BYTES, MAX_RUNTIME_NATIVE_RESPONSE_BYTES,
        RUNTIME_NATIVE_PROTOCOL_VERSION,
    },
};
use std::io;
use tokio::io::{AsyncRead, AsyncWrite};

pub async fn relay<B, O, D>(
    mut browser: B,
    mut output: O,
    mut desktop: D,
    connect: NativeRuntimeRequest,
    origin: String,
) -> io::Result<()>
where
    B: AsyncRead + Unpin,
    O: AsyncWrite + Unpin,
    D: AsyncRead + AsyncWrite + Unpin,
{
    if connect.protocol_version != RUNTIME_NATIVE_PROTOCOL_VERSION
        || !matches!(connect.command, NativeRuntimeCommand::Connect {})
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Source port must start with Connect",
        ));
    }
    write_frame_bounded(
        &mut desktop,
        &NativeRuntimeHandshake {
            protocol_version: RUNTIME_NATIVE_PROTOCOL_VERSION,
            request_id: connect.request_id,
            browser_origin: origin,
        },
        MAX_RUNTIME_NATIVE_REQUEST_BYTES,
    )
    .await?;
    let (mut desktop_read, mut desktop_write) = tokio::io::split(desktop);
    let incoming = async {
        loop {
            let request: NativeRuntimeRequest =
                read_frame_bounded(&mut browser, MAX_RUNTIME_NATIVE_REQUEST_BYTES).await?;
            if request.protocol_version != RUNTIME_NATIVE_PROTOCOL_VERSION
                || matches!(request.command, NativeRuntimeCommand::Connect {})
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Invalid source port request",
                ));
            }
            write_frame_bounded(
                &mut desktop_write,
                &request,
                MAX_RUNTIME_NATIVE_REQUEST_BYTES,
            )
            .await?;
        }
    };
    let outgoing = async {
        loop {
            let response: NativeRuntimeMessage =
                read_frame_bounded(&mut desktop_read, MAX_RUNTIME_NATIVE_RESPONSE_BYTES).await?;
            write_frame_bounded(&mut output, &response, MAX_RUNTIME_NATIVE_RESPONSE_BYTES).await?;
        }
    };
    // Retain each entire frame loop. Losing either peer drops the other pending read/write and
    // both Desktop halves; no detached task or queued plaintext survives this source port.
    tokio::select! {
        result = incoming => result,
        result = outgoing => result,
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::{
        desktop_ipc::{read_frame_bounded, write_frame},
        native_runtime_ipc::{NativeRuntimeCommand, NativeRuntimeHandshake, NativeRuntimeMessage},
    };
    use tokio::{
        net::UnixStream,
        time::{timeout, Duration},
    };
    use zeroize::Zeroizing;

    #[tokio::test]
    async fn source_proxy_preserves_opaque_frames_and_closes_on_desktop_loss() {
        let (browser, client) = UnixStream::pair().unwrap();
        let (desktop, mut server) = UnixStream::pair().unwrap();
        let (read, write) = browser.into_split();
        let task = tokio::spawn(relay(
            read,
            write,
            desktop,
            NativeRuntimeRequest {
                protocol_version: 2,
                request_id: "connect-1".into(),
                command: NativeRuntimeCommand::Connect {},
            },
            "chrome-extension://test-origin/".into(),
        ));
        let handshake: NativeRuntimeHandshake = timeout(
            Duration::from_secs(2),
            read_frame_bounded(&mut server, 65536),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(handshake.browser_origin, "chrome-extension://test-origin/");
        assert_eq!(handshake.request_id, "connect-1");
        let (mut input, mut output) = client.into_split();
        write_frame(
            &mut output,
            &NativeRuntimeRequest {
                protocol_version: 2,
                request_id: "export-2".into(),
                command: NativeRuntimeCommand::Export {
                    challenge: "opaque-challenge".into(),
                },
            },
        )
        .await
        .unwrap();
        let request: NativeRuntimeRequest = read_frame_bounded(&mut server, 65536).await.unwrap();
        assert!(
            matches!(request.command, NativeRuntimeCommand::Export { challenge } if challenge == "opaque-challenge")
        );
        write_frame(
            &mut server,
            &NativeRuntimeMessage::Reply {
                request_id: "export-2".into(),
                failed: false,
                payload: Zeroizing::new("opaque-core-result".into()),
            },
        )
        .await
        .unwrap();
        let response: NativeRuntimeMessage = read_frame_bounded(&mut input, 1048576).await.unwrap();
        assert!(
            matches!(response, NativeRuntimeMessage::Reply { request_id, payload, failed: false } if request_id == "export-2" && payload.as_str() == "opaque-core-result")
        );
        // Browser input is still open and silent. Desktop EOF must end both loops.
        drop(server);
        assert!(timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        use tokio::io::AsyncReadExt;
        assert_eq!(
            timeout(Duration::from_secs(2), input.read_u8())
                .await
                .unwrap()
                .unwrap_err()
                .kind(),
            io::ErrorKind::UnexpectedEof
        );
    }
    #[tokio::test]
    async fn source_proxy_rejects_oversized_headers_without_waiting_for_payload() {
        use tokio::io::AsyncWriteExt;
        for from_browser in [true, false] {
            let (browser, mut client) = UnixStream::pair().unwrap();
            let (desktop, mut server) = UnixStream::pair().unwrap();
            let (read, write) = browser.into_split();
            let task = tokio::spawn(relay(
                read,
                write,
                desktop,
                NativeRuntimeRequest {
                    protocol_version: 2,
                    request_id: "connect".into(),
                    command: NativeRuntimeCommand::Connect {},
                },
                "chrome-extension://origin/".into(),
            ));
            let _: NativeRuntimeHandshake =
                read_frame_bounded(&mut server, MAX_RUNTIME_NATIVE_REQUEST_BYTES)
                    .await
                    .unwrap();
            let writer = if from_browser {
                &mut client
            } else {
                &mut server
            };
            let limit = if from_browser {
                MAX_RUNTIME_NATIVE_REQUEST_BYTES
            } else {
                MAX_RUNTIME_NATIVE_RESPONSE_BYTES
            };
            writer
                .write_all(&((limit + 1) as u32).to_le_bytes())
                .await
                .unwrap();
            assert_eq!(
                timeout(Duration::from_secs(2), task)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::InvalidData
            );
        }
    }

    #[tokio::test]
    async fn source_proxy_partial_browser_frame_does_not_hide_desktop_eof() {
        use tokio::io::AsyncWriteExt;
        let (browser, mut client) = UnixStream::pair().unwrap();
        let (desktop, mut server) = UnixStream::pair().unwrap();
        let (read, write) = browser.into_split();
        let task = tokio::spawn(relay(
            read,
            write,
            desktop,
            NativeRuntimeRequest {
                protocol_version: 2,
                request_id: "connect".into(),
                command: NativeRuntimeCommand::Connect {},
            },
            "chrome-extension://origin/".into(),
        ));
        let _: NativeRuntimeHandshake =
            read_frame_bounded(&mut server, MAX_RUNTIME_NATIVE_REQUEST_BYTES)
                .await
                .unwrap();
        client.write_all(&[128, 0]).await.unwrap();
        drop(server);
        assert!(timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .is_err());
    }

    #[tokio::test]
    async fn source_proxy_browser_eof_retires_a_backpressured_output() {
        let (browser, client) = UnixStream::pair().unwrap();
        let (desktop, mut server) = UnixStream::pair().unwrap();
        let (read, write) = browser.into_split();
        let task = tokio::spawn(relay(
            read,
            write,
            desktop,
            NativeRuntimeRequest {
                protocol_version: 2,
                request_id: "connect".into(),
                command: NativeRuntimeCommand::Connect {},
            },
            "chrome-extension://origin/".into(),
        ));
        let _: NativeRuntimeHandshake =
            read_frame_bounded(&mut server, MAX_RUNTIME_NATIVE_REQUEST_BYTES)
                .await
                .unwrap();
        let (_unread_output, browser_input) = client.into_split();
        write_frame(
            &mut server,
            &NativeRuntimeMessage::Authority {
                payload: Zeroizing::new("x".repeat(MAX_RUNTIME_NATIVE_RESPONSE_BYTES - 128)),
            },
        )
        .await
        .unwrap();
        drop(browser_input);
        assert!(timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        use tokio::io::AsyncReadExt;
        // Linux may report reset when the retired peer had unread buffered input.
        assert!(matches!(
            timeout(Duration::from_secs(2), server.read_u8())
                .await
                .unwrap()
                .unwrap_err()
                .kind(),
            io::ErrorKind::UnexpectedEof | io::ErrorKind::ConnectionReset
        ));
    }
}
