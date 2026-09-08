//! Runtime-owned live Sync. Stream frames are hints; only bounded authority reads move Replica.
use super::*;
use crate::{auth_http::AuthenticatedOutcome, platform_storage::CurrentSessionDocument};
use std::{future::Future, pin::Pin, task::Poll};

const MAX_FRAME_BYTES: usize = 64 * 1024;
const MAX_RECONNECT_MS: u64 = 60_000;

#[derive(Default, Debug, PartialEq, Eq)]
struct Hints {
    connected: bool,
    changed: bool,
    revoked: bool,
}

#[derive(Default)]
struct HintDecoder {
    line: Vec<u8>,
    event: Vec<u8>,
    data: bool,
    skip_lf: bool,
    frame_bytes: usize,
}

impl HintDecoder {
    fn push(&mut self, bytes: &[u8]) -> Result<Hints, ()> {
        let mut hints = Hints::default();
        for &byte in bytes {
            if byte == b'\n' && self.skip_lf {
                self.skip_lf = false;
                continue;
            }
            self.skip_lf = byte == b'\r';
            self.frame_bytes += 1;
            if self.frame_bytes > MAX_FRAME_BYTES {
                return Err(());
            }
            if byte != b'\r' && byte != b'\n' {
                self.line.push(byte);
                continue;
            }
            if self.line.is_empty() {
                if self.data {
                    match self.event.as_slice() {
                        b"connected" => hints.connected = true,
                        b"session_revoked" => hints.revoked = true,
                        b"sync" | b"message" | b"" => hints.changed = true,
                        _ => {}
                    }
                }
                self.data = false;
                self.event.clear();
                self.frame_bytes = 0;
            } else if self.line == b"data" || self.line.starts_with(b"data:") {
                self.data = true;
            } else if let Some(event) = self.line.strip_prefix(b"event:") {
                self.event = event.strip_prefix(b" ").unwrap_or(event).to_vec();
            }
            self.line.clear();
        }
        Ok(hints)
    }
}

#[derive(Clone, PartialEq, Eq)]
struct SyncIdentity {
    account_id: AccountId,
    incarnation: crate::Incarnation,
    lock_epoch: u64,
}

#[cfg(not(target_arch = "wasm32"))]
type SyncFuture = Pin<Box<dyn Future<Output = ()> + Send>>;
#[cfg(target_arch = "wasm32")]
type SyncFuture = Pin<Box<dyn Future<Output = ()>>>;

struct SyncTask {
    identity: SyncIdentity,
    cancellation: RequestCancellation,
    future: SyncFuture,
}

impl Drop for SyncTask {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

struct RunnerLease(Arc<Runtime>);
impl Drop for RunnerLease {
    fn drop(&mut self) {
        self.0.live_sync_active.store(false, Ordering::SeqCst);
    }
}

impl Runtime {
    /// The host only polls this future. Account eligibility, reconnects and cancellation stay here.
    #[doc(hidden)]
    pub async fn run_live_sync(self: Arc<Self>) {
        if self.live_sync_active.swap(true, Ordering::SeqCst) {
            return;
        }
        let _lease = RunnerLease(Arc::clone(&self));
        let mut tasks: Vec<SyncTask> = Vec::new();
        loop {
            let mut wake = std::pin::pin!(self.live_sync_wake.notified());
            wake.as_mut().enable();
            if self.is_closed() {
                return;
            }
            let eligible: Vec<_> = self
                .replica
                .snapshots()
                .into_iter()
                .filter_map(|snapshot| {
                    let identity = SyncIdentity {
                        account_id: snapshot.account_id,
                        incarnation: snapshot.incarnation,
                        lock_epoch: snapshot.lock_epoch,
                    };
                    self.sync_eligible(&identity).then_some(identity)
                })
                .collect();
            for task in &tasks {
                if !eligible.contains(&task.identity) {
                    task.cancellation.cancel();
                }
            }
            for identity in eligible {
                if tasks.iter().any(|task| task.identity == identity) {
                    continue;
                }
                let cancellation = RequestCancellation::new();
                let runtime = Arc::clone(&self);
                let task_identity = identity.clone();
                let task_cancellation = cancellation.clone();
                tasks.push(SyncTask {
                    identity,
                    cancellation,
                    future: Box::pin(async move {
                        runtime
                            .run_account_sync(task_identity, task_cancellation)
                            .await;
                    }),
                });
            }
            tokio::select! {
                () = wake => {},
                index = std::future::poll_fn(|context| {
                    for (index, task) in tasks.iter_mut().enumerate() {
                        if task.future.as_mut().poll(context).is_ready() {
                            return Poll::Ready(index);
                        }
                    }
                    Poll::Pending
                }) => { tasks.swap_remove(index); }
            }
        }
    }

    fn sync_eligible(&self, identity: &SyncIdentity) -> bool {
        !self.is_closed()
            && self.auth_client_config.is_some()
            && !self.account_access_retirement_is_pending(&identity.account_id)
            && !self.account_teardown_is_pending(&identity.account_id)
            && !self
                .foreground_attachments
                .is_retiring(&identity.account_id)
            && self
                .account_access
                .lock()
                .expect("Account access lock poisoned")
                .get(&identity.account_id)
                == Some(&AccountAccessState::Unlocked)
            && self
                .waiting_reasons
                .lock()
                .expect("waiting reasons lock poisoned")
                .get(&identity.account_id)
                != Some(&AccountWaitingReason::ReauthenticationRequired)
            && self
                .replica
                .snapshot(&identity.account_id)
                .is_some_and(|snapshot| {
                    snapshot.failure.is_none()
                        && snapshot.incarnation == identity.incarnation
                        && snapshot.lock_epoch == identity.lock_epoch
                })
    }

    async fn run_account_sync(&self, identity: SyncIdentity, cancellation: RequestCancellation) {
        // The existing registry cancels and drains this task before retiring live Account authority.
        let Ok(_lifetime) = self.foreground_attachments.register(
            &identity.account_id,
            &identity.incarnation,
            cancellation.clone(),
        ) else {
            return;
        };
        let mut failures = 0_u32;
        loop {
            if cancellation.is_cancelled() || !self.sync_eligible(&identity) {
                return;
            }
            let result = tokio::select! {
                biased;
                () = cancellation.cancelled() => return,
                result = self.sync_connection(&identity, cancellation.clone()) => result,
            };
            if cancellation.is_cancelled() || !self.sync_eligible(&identity) {
                return;
            }
            if matches!(&result, Err(error) if error.code == RuntimeErrorCode::AuthenticationRequired)
            {
                self.mark_reauthentication_required(&identity.account_id);
                return;
            }
            // Even an HTTP-200 stream that immediately ends is a failed connection. In particular,
            // repeated connected frames and comments cannot reset this budget into a hot loop.
            failures = failures.saturating_add(1);
            let delay = (1_000_u64 << failures.saturating_sub(1).min(6)).min(MAX_RECONNECT_MS);
            tokio::select! {
                biased;
                () = cancellation.cancelled() => return,
                () = self.device_timer.sleep_ms(delay) => {},
            }
        }
    }

    async fn sync_connection(
        &self,
        identity: &SyncIdentity,
        cancellation: RequestCancellation,
    ) -> Result<(), RuntimeError> {
        let metadata = self
            .platform_storage
            .load_account_metadata(&identity.account_id, &identity.incarnation)
            .await?
            .ok_or_else(sync_auth_required)?;
        let http = AuthHttpClient::new(
            &self.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            self.auth_client_config
                .clone()
                .ok_or_else(sync_auth_required)?,
        )?;
        let mut renewed = false;
        let mut session = self.sync_session(identity).await?;
        let mut stream = loop {
            match http
                .open_sync_events(session.token.as_ref(), cancellation.clone())
                .await?
            {
                AuthenticatedOutcome::Ok(stream) => break stream,
                AuthenticatedOutcome::Transient => return Err(sync_retry()),
                AuthenticatedOutcome::ReauthenticationRequired if !renewed => {
                    session = self
                        .renew_sync_session(identity, &http, session, cancellation.clone())
                        .await?;
                    renewed = true;
                }
                AuthenticatedOutcome::ReauthenticationRequired => return Err(sync_auth_required()),
            }
        };
        self.sync_authority(identity, &http, cancellation.clone())
            .await?;
        let mut connected = false;
        let mut decoder = HintDecoder::default();
        loop {
            let Some(bytes) = stream.next_chunk(cancellation.clone()).await? else {
                return Err(sync_retry());
            };
            let hints = decoder.push(&bytes).map_err(|_| sync_retry())?;
            if hints.revoked {
                // The Server's control frame is an auth hint. Renewal still uses the private,
                // currently installed Session, and serializes with all other renewal owners.
                self.renew_sync_session(identity, &http, session, cancellation.clone())
                    .await?;
                return Err(sync_retry());
            }
            if hints.changed || (hints.connected && !connected) {
                self.sync_authority(identity, &http, cancellation.clone())
                    .await?;
                if hints.connected {
                    connected = true;
                }
                let current = self.sync_session(identity).await?;
                if current.token.as_ref() != session.token.as_ref() {
                    return Err(sync_retry());
                }
            }
        }
    }

    async fn sync_session(
        &self,
        identity: &SyncIdentity,
    ) -> Result<CurrentSessionDocument, RuntimeError> {
        if !self.sync_eligible(identity) {
            return Err(sync_cancelled());
        }
        self.platform_storage
            .load_current_session(&identity.account_id, &identity.incarnation)
            .await?
            .ok_or_else(sync_auth_required)
    }

    async fn renew_sync_session(
        &self,
        identity: &SyncIdentity,
        http: &AuthHttpClient<'_>,
        previous: CurrentSessionDocument,
        cancellation: RequestCancellation,
    ) -> Result<CurrentSessionDocument, RuntimeError> {
        let execution = self.account_execution_lock(&identity.account_id)?;
        let _guard = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(sync_cancelled()),
            guard = execution.lock() => guard,
        };
        let current = self.sync_session(identity).await?;
        if current.token.as_ref() != previous.token.as_ref() {
            return Ok(current);
        }
        self.renew_session(&identity.account_id, &current, http, cancellation)
            .await
    }

    async fn sync_authority(
        &self,
        identity: &SyncIdentity,
        http: &AuthHttpClient<'_>,
        cancellation: RequestCancellation,
    ) -> Result<(), RuntimeError> {
        let execution = self.account_execution_lock(&identity.account_id)?;
        let _guard = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(sync_cancelled()),
            guard = execution.lock() => guard,
        };
        let session = self.sync_session(identity).await?;
        if self
            .run_bootstrap(&identity.account_id, http, session, cancellation)
            .await?
        {
            Ok(())
        } else {
            Err(sync_retry())
        }
    }
}

fn sync_retry() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::RetryableTransport,
        "Sync transport must reconnect",
    )
}
fn sync_auth_required() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthenticationRequired,
        "Sync requires a current Session",
    )
}
fn sync_cancelled() -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::Cancelled, "Sync Account lifetime ended")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragmented_sse_hint_needs_a_complete_data_frame() {
        let mut decoder = HintDecoder::default();
        assert_eq!(
            decoder.push(b": heartbeat\r\n\r\nevent: sync\r\n"),
            Ok(Hints::default())
        );
        assert_eq!(
            decoder.push(b"data: {\"untrustedCursor\":\"123\"}\r"),
            Ok(Hints::default())
        );
        assert_eq!(
            decoder.push(b"\n\r\n"),
            Ok(Hints {
                changed: true,
                ..Hints::default()
            })
        );
        assert_eq!(decoder.push(b": heartbeat\n\n"), Ok(Hints::default()));
    }

    #[test]
    fn sse_controls_are_distinct_and_incomplete_frames_are_bounded() {
        let mut decoder = HintDecoder::default();
        assert_eq!(
            decoder.push(b"event: connected\ndata: {}\n\nevent: session_revoked\ndata: {}\n\n"),
            Ok(Hints {
                connected: true,
                revoked: true,
                changed: false
            })
        );
        assert!(decoder.push(&vec![b'x'; MAX_FRAME_BYTES + 1]).is_err());
    }
}
