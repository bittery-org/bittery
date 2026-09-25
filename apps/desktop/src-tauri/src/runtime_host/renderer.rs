//! Inactive until the Desktop cutover registers this plugin with its one native owner.

use super::{connection::RuntimeConnection, native::NativeRuntime};
use crate::tauri_api::{
    RuntimeBridgeAttachment, RuntimeBridgeCallArgs, RuntimeBridgeCancelArgs,
    RuntimeBridgeConnectionArgs, RuntimeBridgeMessage, RuntimeBridgeMessageKind,
};
use bittery_client_core::{
    ObservationSink, RuntimeError, RuntimeErrorCode, RuntimeOutcome, RuntimeProjection,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager, State, Webview};

struct Attached {
    descriptor: RuntimeBridgeAttachment,
    connection: Arc<RuntimeConnection>,
}

struct RendererBridge {
    owner: Arc<NativeRuntime>,
    callers: Mutex<HashMap<String, Attached>>,
}

impl RendererBridge {
    fn new(owner: Arc<NativeRuntime>) -> Self {
        Self {
            owner,
            callers: Mutex::new(HashMap::new()),
        }
    }

    fn attach(&self, caller: &str) -> RuntimeBridgeAttachment {
        let connection_id = bittery_crypto_core::generate_uuid();
        let descriptor = RuntimeBridgeAttachment {
            event_name: format!("runtime-message-{connection_id}"),
            connection_id,
        };
        let previous = self
            .callers
            .lock()
            .expect("Renderer registry poisoned")
            .insert(
                caller.into(),
                Attached {
                    descriptor: descriptor.clone(),
                    connection: Arc::new(self.owner.connection()),
                },
            );
        if let Some(previous) = previous {
            previous.connection.close();
        }
        descriptor
    }

    fn connection(&self, caller: &str, id: &str) -> Result<Arc<RuntimeConnection>, RuntimeError> {
        self.callers
            .lock()
            .expect("Renderer registry poisoned")
            .get(caller)
            .filter(|entry| entry.descriptor.connection_id == id)
            .map(|entry| entry.connection.clone())
            .ok_or_else(|| failure(RuntimeErrorCode::RuntimeClosed))
    }

    fn detach(&self, caller: &str, id: &str) -> Result<(), RuntimeError> {
        let entry = {
            let mut callers = self.callers.lock().expect("Renderer registry poisoned");
            if !callers
                .get(caller)
                .is_some_and(|entry| entry.descriptor.connection_id == id)
            {
                return Err(failure(RuntimeErrorCode::RuntimeClosed));
            }
            callers.remove(caller)
        };
        if let Some(entry) = entry {
            entry.connection.close();
        }
        Ok(())
    }

    fn retire_caller(&self, caller: &str) {
        let entry = self
            .callers
            .lock()
            .expect("Renderer registry poisoned")
            .remove(caller);
        if let Some(entry) = entry {
            entry.connection.close();
        }
    }
}

fn failure(code: RuntimeErrorCode) -> RuntimeError {
    RuntimeError {
        code,
        message: "Desktop renderer attachment is unavailable".into(),
        recovery_bound: None,
        team_page_problem: None,
    }
}

fn is_trusted_caller(label: &str, url: &tauri::Url, development_url: Option<&tauri::Url>) -> bool {
    if label != "main" || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let bundled = url.port().is_none()
        && matches!(
            (url.scheme(), url.host_str()),
            ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
        );
    bundled || development_url.is_some_and(|allowed| url.origin() == allowed.origin())
}

fn trusted_caller<R: tauri::Runtime>(webview: &Webview<R>) -> Result<String, RuntimeError> {
    let url = webview
        .url()
        .map_err(|_| failure(RuntimeErrorCode::AccessDenied))?;
    #[cfg(debug_assertions)]
    let development_url = webview.app_handle().config().build.dev_url.as_ref();
    #[cfg(not(debug_assertions))]
    let development_url = None;
    if !is_trusted_caller(webview.label(), &url, development_url) {
        return Err(failure(RuntimeErrorCode::AccessDenied));
    }
    Ok(webview.label().into())
}

struct ProjectionDelivery<R: tauri::Runtime> {
    webview: Webview<R>,
    connection_id: String,
    observation_id: String,
}

impl<R: tauri::Runtime> ObservationSink for ProjectionDelivery<R> {
    fn publish(&self, projection: RuntimeProjection) {
        let Ok(projection_json) = serde_json::to_string(&projection) else {
            return;
        };
        let event = RuntimeBridgeMessage {
            connection_id: self.connection_id.clone(),
            call_id: self.observation_id.clone(),
            payload_json: projection_json,
            kind: RuntimeBridgeMessageKind::Projection,
        };
        // Never broadcast plaintext projections to other Webviews or the application event target.
        let _ = self.webview.emit_to(
            tauri::EventTarget::Webview {
                label: self.webview.label().into(),
            },
            &format!("runtime-message-{}", self.connection_id),
            event,
        );
    }
}

#[tauri::command]
fn runtime_attach<R: tauri::Runtime>(
    webview: Webview<R>,
    state: State<'_, RendererBridge>,
) -> Result<RuntimeBridgeAttachment, RuntimeError> {
    Ok(state.attach(&trusted_caller(&webview)?))
}

#[tauri::command]
fn runtime_request<R: tauri::Runtime>(
    webview: Webview<R>,
    state: State<'_, RendererBridge>,
    connection_id: String,
    call_id: String,
    payload_json: String,
) -> Result<(), RuntimeError> {
    let args = RuntimeBridgeCallArgs {
        connection_id,
        call_id,
        payload_json,
    };
    let connection = state.connection(&trusted_caller(&webview)?, &args.connection_id)?;
    let pending = connection.begin_request(args.call_id.clone(), &args.payload_json)?;
    tauri::async_runtime::spawn(async move {
        let payload_json = match pending.await {
            Ok(payload) => payload,
            Err(error) => match serde_json::to_string(&RuntimeOutcome::Failed(error)) {
                Ok(payload) => payload,
                Err(_) => return,
            },
        };
        let _ = webview.emit_to(
            tauri::EventTarget::Webview {
                label: webview.label().into(),
            },
            &format!("runtime-message-{}", args.connection_id),
            RuntimeBridgeMessage {
                connection_id: args.connection_id,
                call_id: args.call_id,
                payload_json,
                kind: RuntimeBridgeMessageKind::Response,
            },
        );
    });
    Ok(())
}

#[tauri::command]
fn runtime_observe<R: tauri::Runtime>(
    webview: Webview<R>,
    state: State<'_, RendererBridge>,
    connection_id: String,
    call_id: String,
    payload_json: String,
) -> Result<(), RuntimeError> {
    let args = RuntimeBridgeCallArgs {
        connection_id,
        call_id,
        payload_json,
    };
    let connection = state.connection(&trusted_caller(&webview)?, &args.connection_id)?;
    connection.observe(
        args.call_id.clone(),
        &args.payload_json,
        Arc::new(ProjectionDelivery {
            webview,
            connection_id: args.connection_id,
            observation_id: args.call_id,
        }),
    )
}

#[tauri::command]
fn runtime_unobserve<R: tauri::Runtime>(
    webview: Webview<R>,
    state: State<'_, RendererBridge>,
    connection_id: String,
    call_id: String,
) -> Result<(), RuntimeError> {
    let args = RuntimeBridgeCancelArgs {
        connection_id,
        call_id,
    };
    state
        .connection(&trusted_caller(&webview)?, &args.connection_id)?
        .unobserve(&args.call_id);
    Ok(())
}

#[tauri::command]
fn runtime_cancel<R: tauri::Runtime>(
    webview: Webview<R>,
    state: State<'_, RendererBridge>,
    connection_id: String,
    call_id: String,
) -> Result<(), RuntimeError> {
    let args = RuntimeBridgeCancelArgs {
        connection_id,
        call_id,
    };
    state
        .connection(&trusted_caller(&webview)?, &args.connection_id)?
        .cancel(&args.call_id);
    Ok(())
}

#[tauri::command]
fn runtime_detach<R: tauri::Runtime>(
    webview: Webview<R>,
    state: State<'_, RendererBridge>,
    connection_id: String,
) -> Result<(), RuntimeError> {
    let args = RuntimeBridgeConnectionArgs { connection_id };
    state.detach(&trusted_caller(&webview)?, &args.connection_id)
}

/// Ticket 66 registers this once beside the existing plugins, after retiring the legacy owner.
/// The app must await the same NativeRuntime's shutdown on application exit.
pub(super) fn plugin<R: tauri::Runtime>(
    owner: Arc<NativeRuntime>,
) -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("client-runtime")
        .setup(move |app, _| {
            if !app.manage(RendererBridge::new(owner)) {
                return Err("Renderer Runtime bridge already installed".into());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime_attach,
            runtime_request,
            runtime_observe,
            runtime_unobserve,
            runtime_cancel,
            runtime_detach
        ])
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                if let Some(state) = webview.try_state::<RendererBridge>() {
                    state.retire_caller(webview.label());
                }
            }
        })
        .on_event(|app, event| {
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } = event
            {
                if let Some(state) = app.try_state::<RendererBridge>() {
                    state.retire_caller(label);
                }
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use bittery_client_core::{AuthClientConfig, ClientPlatform};

    #[tokio::test]
    async fn generated_plugin_commands_use_the_main_webview_capability() {
        use tauri::Listener;
        let directory = tempfile::tempdir().unwrap();
        let owner = Arc::new(
            NativeRuntime::open(
                directory.path(),
                AuthClientConfig::new(
                    "bridge-command-test".into(),
                    ClientPlatform::Desktop,
                    "test".into(),
                )
                .unwrap(),
            )
            .await
            .unwrap(),
        );
        let app = tauri::test::mock_builder()
            .plugin(plugin(owner.clone()))
            .build(tauri::generate_context!())
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        let invoke = |command: &str, body: serde_json::Value| {
            tauri::test::get_ipc_response(
                &webview,
                tauri::webview::InvokeRequest {
                    cmd: format!("plugin:client-runtime|{command}"),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: webview.url().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(body),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            )
        };
        let attachment = invoke("runtime_attach", serde_json::json!({}))
            .unwrap()
            .deserialize::<RuntimeBridgeAttachment>()
            .unwrap();
        let (events_tx, events_rx) = std::sync::mpsc::channel();
        let event_webview: &Webview<tauri::test::MockRuntime> = webview.as_ref();
        event_webview.listen(&attachment.event_name, move |event| {
            events_tx
                .send(serde_json::from_str::<RuntimeBridgeMessage>(event.payload()).unwrap())
                .unwrap();
        });
        let args = RuntimeBridgeCallArgs {
            connection_id: attachment.connection_id.clone(),
            call_id: "status".into(),
            payload_json: r#"{"type":"runtimeStatus","accountId":null}"#.into(),
        };
        invoke("runtime_observe", serde_json::to_value(args).unwrap()).unwrap();
        let projection = events_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap();
        assert!(projection.kind == RuntimeBridgeMessageKind::Projection);
        assert_eq!(projection.call_id, "status");
        let args = RuntimeBridgeCallArgs {
            connection_id: attachment.connection_id.clone(),
            call_id: "request".into(),
            payload_json: r#"{"type":"lock","accountId":"missing"}"#.into(),
        };
        invoke("runtime_request", serde_json::to_value(args).unwrap()).unwrap();
        let response = events_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap();
        assert!(response.kind == RuntimeBridgeMessageKind::Response);
        assert_eq!(response.call_id, "request");
        assert!(matches!(
            serde_json::from_str::<RuntimeOutcome>(&response.payload_json).unwrap(),
            RuntimeOutcome::Succeeded(_)
        ));
        for command in ["runtime_cancel", "runtime_unobserve"] {
            invoke(
                command,
                serde_json::to_value(RuntimeBridgeCancelArgs {
                    connection_id: attachment.connection_id.clone(),
                    call_id: "status".into(),
                })
                .unwrap(),
            )
            .unwrap();
        }
        invoke(
            "runtime_detach",
            serde_json::to_value(RuntimeBridgeConnectionArgs {
                connection_id: attachment.connection_id.clone(),
            })
            .unwrap(),
        )
        .unwrap();
        let error = invoke(
            "runtime_cancel",
            serde_json::to_value(RuntimeBridgeCancelArgs {
                connection_id: attachment.connection_id,
                call_id: "request".into(),
            })
            .unwrap(),
        )
        .err()
        .unwrap();
        assert_eq!(
            serde_json::from_value::<RuntimeError>(error).unwrap().code,
            RuntimeErrorCode::RuntimeClosed
        );
        let other = tauri::WebviewWindowBuilder::new(
            &app,
            "other",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        let rejected = tauri::test::get_ipc_response(
            &other,
            tauri::webview::InvokeRequest {
                cmd: "plugin:client-runtime|runtime_attach".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: other.url().unwrap(),
                body: tauri::ipc::InvokeBody::Json(serde_json::json!({})),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        );
        assert!(rejected.is_err());
        owner.shutdown().await.unwrap();
    }

    #[test]
    fn only_the_main_local_webview_may_attach() {
        for address in [
            "tauri://localhost/",
            "http://tauri.localhost/",
            "https://tauri.localhost/path",
        ] {
            let url = tauri::Url::parse(address).unwrap();
            assert!(is_trusted_caller("main", &url, None));
            assert!(!is_trusted_caller("other", &url, None));
        }
        for address in [
            "https://example.com",
            "http://localhost:3002",
            "tauri://remote/",
            "https://tauri.localhost:8443/",
            "http://user@tauri.localhost/",
        ] {
            assert!(!is_trusted_caller(
                "main",
                &tauri::Url::parse(address).unwrap(),
                None
            ));
        }
        let development_url = tauri::Url::parse("http://localhost:3002").unwrap();
        assert!(is_trusted_caller(
            "main",
            &development_url.join("/app").unwrap(),
            Some(&development_url)
        ));
        assert!(!is_trusted_caller(
            "main",
            &tauri::Url::parse("http://localhost:3003").unwrap(),
            Some(&development_url)
        ));
        assert!(!is_trusted_caller(
            "main",
            &tauri::Url::parse("http://user@localhost:3002").unwrap(),
            Some(&development_url)
        ));
    }

    #[tokio::test]
    async fn attachment_ids_are_caller_scoped_and_navigation_retires_only_the_caller() {
        let directory = tempfile::tempdir().unwrap();
        let owner = Arc::new(
            NativeRuntime::open(
                directory.path(),
                AuthClientConfig::new("bridge-test".into(), ClientPlatform::Desktop, "test".into())
                    .unwrap(),
            )
            .await
            .unwrap(),
        );
        let bridge = RendererBridge::new(owner.clone());
        let first = bridge.attach("main");
        let other = bridge.attach("another");
        assert!(bridge.connection("main", &first.connection_id).is_ok());
        assert!(bridge.connection("another", &first.connection_id).is_err());
        assert!(bridge.detach("another", &first.connection_id).is_err());
        let old = bridge.connection("main", &first.connection_id).unwrap();
        let replacement = bridge.attach("main");
        assert!(bridge.connection("main", &first.connection_id).is_err());
        assert_eq!(
            old.request("request".into(), r#"{"type":"wipe"}"#)
                .await
                .unwrap_err()
                .code,
            RuntimeErrorCode::RuntimeClosed
        );
        bridge.retire_caller("main");
        assert!(bridge
            .connection("main", &replacement.connection_id)
            .is_err());
        assert!(bridge.connection("another", &other.connection_id).is_ok());
        bridge.detach("another", &other.connection_id).unwrap();
        owner.shutdown().await.unwrap();
    }
}
