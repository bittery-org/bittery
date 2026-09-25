//! Primitive OS status/prompt adapter. Core owns eligibility, grace, keys, and Account lifecycle.
use async_trait::async_trait;
use bittery_client_core::{
    BiometricHardware, BiometricKind, BiometricPort, BiometricPromptResult, RequestCancellation,
    RuntimeError,
};
use std::sync::Arc;
use tauri::{AppHandle, Runtime};
use tauri_plugin_biometry::{AuthOptions, BiometryExt, BiometryType, PromptCancellation, Status};
use tokio::sync::Semaphore;

/// Adapts the installed plugin only; never reads or writes the plugin's biometric data store.
///
/// The patched plugin cancels the OS operation and drains its callback. The native job owns the
/// prompt permit until that callback finishes, including when the Core awaiting future is dropped.
/// Actual OS dismissal still requires macOS/Windows hardware acceptance.
pub(super) struct NativeBiometricPort<R: Runtime> {
    app: AppHandle<R>,
    prompt: Arc<Semaphore>,
}
impl<R: Runtime> NativeBiometricPort<R> {
    pub(super) fn new(app: AppHandle<R>) -> Self {
        Self {
            app,
            prompt: Arc::new(Semaphore::new(1)),
        }
    }
}
#[async_trait]
impl<R: Runtime> BiometricPort for NativeBiometricPort<R> {
    async fn hardware(&self) -> Result<BiometricHardware, RuntimeError> {
        let app = self.app.clone();
        Ok(
            match tokio::task::spawn_blocking(move || app.biometry().status()).await {
                Ok(Ok(status)) => hardware_status(status),
                _ => unavailable_hardware(),
            },
        )
    }
    async fn authenticate(
        &self,
        reason: &str,
        cancellation: RequestCancellation,
    ) -> BiometricPromptResult {
        let app = self.app.clone();
        let reason = reason.to_owned();
        run_prompt(self.prompt.clone(), cancellation, move |signal| {
            match app.biometry().authenticate_cancellable(
                reason,
                AuthOptions {
                    allow_device_credential: Some(false),
                    ..AuthOptions::default()
                },
                &signal,
            ) {
                Ok(()) => BiometricPromptResult::Authenticated,
                Err(error) => prompt_error(error.code()),
            }
        })
        .await
    }
}
struct CancelOnDrop(PromptCancellation);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

pub(super) async fn run_prompt(
    prompt: Arc<Semaphore>,
    cancellation: RequestCancellation,
    invoke: impl FnOnce(PromptCancellation) -> BiometricPromptResult + Send + 'static,
) -> BiometricPromptResult {
    let permit = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return BiometricPromptResult::Cancelled,
        permit = prompt.acquire_owned() => match permit {
            Ok(permit) => permit,
            Err(_) => return BiometricPromptResult::Unavailable,
        },
    };
    let signal = PromptCancellation::default();
    let _cancel_on_drop = CancelOnDrop(signal.clone());
    let native_signal = signal.clone();
    let pending = cancellation.clone();
    let mut operation = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if pending.is_cancelled() || native_signal.is_cancelled() {
            return BiometricPromptResult::Cancelled;
        }
        let result = invoke(native_signal.clone());
        if pending.is_cancelled() || native_signal.is_cancelled() {
            BiometricPromptResult::Cancelled
        } else {
            result
        }
    });
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => {
            signal.cancel();
            // Cancellation requests native termination; it does not itself prove termination.
            let _ = operation.await;
            BiometricPromptResult::Cancelled
        },
        result = &mut operation => result.unwrap_or(BiometricPromptResult::Failed),
    }
}

fn unavailable_hardware() -> BiometricHardware {
    BiometricHardware {
        has_hardware: false,
        is_enrolled: false,
        kind: None,
    }
}
fn hardware_status(status: Status) -> BiometricHardware {
    let has_hardware =
        status.is_available || status.error_code.as_deref() == Some("biometryNotEnrolled");
    let kind = if status.is_available {
        match status.biometry_type {
            BiometryType::None => None,
            BiometryType::TouchID => Some(BiometricKind::TouchId),
            BiometryType::FaceID => Some(BiometricKind::FaceId),
            BiometryType::Auto if cfg!(target_os = "windows") => Some(BiometricKind::WindowsHello),
            BiometryType::Auto => Some(BiometricKind::Other),
        }
    } else {
        None
    };
    BiometricHardware {
        has_hardware,
        is_enrolled: status.is_available,
        kind,
    }
}
fn prompt_error(code: Option<&str>) -> BiometricPromptResult {
    // Only the typed plugin code crosses this mapping; localized native text carries no authority.
    match code {
        Some("appCancel" | "systemCancel" | "userCancel") => BiometricPromptResult::Cancelled,
        Some("biometryLockout") => BiometricPromptResult::LockedOut,
        Some("biometryNotAvailable") => BiometricPromptResult::Unavailable,
        Some("biometryNotEnrolled") => BiometricPromptResult::NotEnrolled,
        _ => BiometricPromptResult::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hardware_status_preserves_plugin_enrollment_and_type_evidence() {
        let enrolled = hardware_status(Status {
            is_available: true,
            biometry_type: BiometryType::TouchID,
            error: None,
            error_code: None,
        });
        assert!(enrolled.has_hardware && enrolled.is_enrolled);
        assert_eq!(enrolled.kind, Some(BiometricKind::TouchId));
        let unconfigured = hardware_status(Status {
            is_available: false,
            biometry_type: BiometryType::None,
            error: None,
            error_code: Some("biometryNotEnrolled".into()),
        });
        assert!(unconfigured.has_hardware);
        assert!(!unconfigured.is_enrolled);
        let absent = hardware_status(Status {
            is_available: false,
            biometry_type: BiometryType::None,
            error: None,
            error_code: Some("biometryNotAvailable".into()),
        });
        assert!(!absent.has_hardware && !absent.is_enrolled);
    }
    #[test]
    fn prompt_failure_uses_only_closed_plugin_codes_and_discards_native_text() {
        for (code, expected) in [
            ("userCancel", BiometricPromptResult::Cancelled),
            ("systemCancel", BiometricPromptResult::Cancelled),
            ("appCancel", BiometricPromptResult::Cancelled),
            ("biometryLockout", BiometricPromptResult::LockedOut),
            ("biometryNotAvailable", BiometricPromptResult::Unavailable),
            ("biometryNotEnrolled", BiometricPromptResult::NotEnrolled),
            ("authenticationFailed", BiometricPromptResult::Failed),
        ] {
            assert_eq!(prompt_error(Some(code)), expected);
        }
        assert_eq!(prompt_error(None), BiometricPromptResult::Failed);
    }
    #[tokio::test]
    async fn dropped_awaiter_cancels_native_prompt_and_keeps_permit_until_it_finishes() {
        let prompt = Arc::new(Semaphore::new(1));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (cancelled_tx, cancelled_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let active = tokio::spawn(run_prompt(
            prompt.clone(),
            RequestCancellation::new(),
            move |signal| {
                started_tx.send(()).unwrap();
                while !signal.is_cancelled() {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                cancelled_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                BiometricPromptResult::Authenticated
            },
        ));
        tokio::time::timeout(std::time::Duration::from_secs(2), started_rx)
            .await
            .unwrap()
            .unwrap();
        active.abort();
        let _ = active.await;
        let cancelled = tokio::time::timeout(std::time::Duration::from_secs(2), cancelled_rx).await;
        let held = prompt.available_permits() == 0;
        release_tx.send(()).unwrap();
        cancelled.unwrap().unwrap();
        assert!(held);
        let permit = tokio::time::timeout(std::time::Duration::from_secs(2), prompt.acquire())
            .await
            .unwrap()
            .unwrap();
        drop(permit);
    }
    #[tokio::test]
    async fn explicit_cancellation_drains_callback_and_rejects_late_success() {
        let prompt = Arc::new(Semaphore::new(1));
        let cancellation = RequestCancellation::new();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (cancelled_tx, cancelled_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let task = tokio::spawn(run_prompt(
            prompt.clone(),
            cancellation.clone(),
            move |signal| {
                started_tx.send(()).unwrap();
                while !signal.is_cancelled() {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                cancelled_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                BiometricPromptResult::Authenticated
            },
        ));
        started_rx.await.unwrap();
        cancellation.cancel();
        let cancelled = tokio::time::timeout(std::time::Duration::from_secs(2), cancelled_rx).await;
        let waiting = !task.is_finished() && prompt.available_permits() == 0;
        release_tx.send(()).unwrap();
        cancelled.unwrap().unwrap();
        assert!(waiting);
        assert_eq!(task.await.unwrap(), BiometricPromptResult::Cancelled);
        let already_cancelled = RequestCancellation::new();
        already_cancelled.cancel();
        assert_eq!(
            run_prompt(prompt, already_cancelled, |_| panic!(
                "cancelled request opened native prompt"
            ))
            .await,
            BiometricPromptResult::Cancelled
        );
    }
}
