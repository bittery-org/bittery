use std::{future::Future, pin::Pin, str::FromStr, sync::Arc};

use chrono::Utc;
use cron::Schedule;
use sqlx::PgPool;
use tokio::{
    sync::watch,
    task::{JoinHandle, JoinSet},
    time::{sleep, timeout, Duration, Instant},
};
use tracing::{error, info};

use super::sql::{
    cleanup_expired_sessions, cleanup_pending_attachment_uploads, cleanup_tombstones,
    prune_rate_limit_state, prune_sync_events,
};
use crate::integrations::{
    favicon::{fetch_and_store_favicon, list_domains_to_refresh, RemoteDocumentFetcher},
    storage::ObjectStorage,
};
use crate::services::vault_key_rotation::{cleanup_rotation_plans, MAX_CLEANUP_BATCH};

type JobError = Box<dyn std::error::Error + Send + Sync>;
type JobFuture = Pin<Box<dyn Future<Output = Result<(), JobError>> + Send>>;
type JobFactory = Arc<dyn Fn() -> JobFuture + Send + Sync>;
#[derive(Clone)]
struct JobContext {
    pool: PgPool,
    storage: Arc<dyn ObjectStorage>,
    remote_documents: Arc<dyn RemoteDocumentFetcher>,
}
type JobFn = fn(JobContext) -> JobFuture;
const FAVICON_REFRESH_STALE_AFTER_DAYS: i64 = 30;
const FAVICON_REFRESH_BATCH_SIZE: i64 = 200;

pub struct JobRunner {
    shutdown_tx: watch::Sender<bool>,
    handles: Vec<JoinHandle<()>>,
}

impl JobRunner {
    pub fn start(
        pool: PgPool,
        storage: Arc<dyn ObjectStorage>,
        remote_documents: Arc<dyn RemoteDocumentFetcher>,
    ) -> Result<Self, JobError> {
        let context = JobContext {
            pool,
            storage,
            remote_documents,
        };
        let (shutdown_tx, _) = watch::channel(false);
        let handles = vec![
            spawn_job(
                "expired-session-cleanup",
                "0 */30 * * * * *",
                context.clone(),
                run_expired_session_cleanup,
                shutdown_tx.subscribe(),
            )?,
            spawn_job(
                "pending-attachment-upload-cleanup",
                "0 */15 * * * * *",
                context.clone(),
                run_pending_attachment_cleanup,
                shutdown_tx.subscribe(),
            )?,
            spawn_job(
                "sync-event-pruning",
                "0 0 3 * * * *",
                context.clone(),
                run_sync_event_pruning,
                shutdown_tx.subscribe(),
            )?,
            spawn_job(
                "tombstone-cleanup",
                "0 15 3 * * * *",
                context.clone(),
                run_tombstone_cleanup,
                shutdown_tx.subscribe(),
            )?,
            spawn_job(
                "rate-limit-state-pruning",
                "0 30 3 * * * *",
                context.clone(),
                run_rate_limit_state_pruning,
                shutdown_tx.subscribe(),
            )?,
            spawn_job(
                "vault-key-rotation-plan-cleanup",
                "0 */15 * * * * *",
                context.clone(),
                run_rotation_plan_cleanup,
                shutdown_tx.subscribe(),
            )?,
            spawn_job(
                "favicon-refresh",
                "0 30 2 * * 1 *",
                context,
                run_favicon_refresh,
                shutdown_tx.subscribe(),
            )?,
        ];

        info!(job_count = handles.len(), "rust job runner started");
        Ok(Self {
            shutdown_tx,
            handles,
        })
    }

    #[cfg(test)]
    fn start_test_job(
        schedule_expression: &'static str,
        job: JobFactory,
    ) -> Result<Self, JobError> {
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let handle = spawn_scheduled_job("test-job", schedule_expression, job, shutdown_rx)?;
        Ok(Self {
            shutdown_tx,
            handles: vec![handle],
        })
    }

    #[cfg(test)]
    pub(crate) fn idle_for_test() -> Self {
        let (shutdown_tx, _) = watch::channel(false);
        Self {
            shutdown_tx,
            handles: Vec::new(),
        }
    }

    pub fn request_shutdown(&self) {
        self.shutdown_tx.send_replace(true);
    }

    pub(crate) fn shutdown_receiver(&self) -> watch::Receiver<bool> {
        self.shutdown_tx.subscribe()
    }

    pub async fn shutdown(mut self, grace: Duration) -> bool {
        self.request_shutdown();
        let deadline = Instant::now() + grace;
        let mut finished_within_grace = true;

        for handle in &mut self.handles {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                finished_within_grace = false;
                break;
            };
            match timeout(remaining, handle).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    error!(error = %error, "scheduled job loop exited unexpectedly during shutdown");
                    finished_within_grace = false;
                }
                Err(_) => {
                    finished_within_grace = false;
                    break;
                }
            }
        }

        for handle in &self.handles {
            if !handle.is_finished() {
                handle.abort();
            }
        }
        for handle in &mut self.handles {
            if !handle.is_finished() {
                let _ = handle.await;
            }
        }
        finished_within_grace
    }
}

impl Drop for JobRunner {
    fn drop(&mut self) {
        for handle in &self.handles {
            handle.abort();
        }
    }
}

fn spawn_job(
    job_name: &'static str,
    schedule_expression: &'static str,
    context: JobContext,
    job: JobFn,
    shutdown: watch::Receiver<bool>,
) -> Result<JoinHandle<()>, JobError> {
    let job = Arc::new(move || job(context.clone()));
    spawn_scheduled_job(job_name, schedule_expression, job, shutdown)
}

fn spawn_scheduled_job(
    job_name: &'static str,
    schedule_expression: &'static str,
    job: JobFactory,
    mut shutdown: watch::Receiver<bool>,
) -> Result<JoinHandle<()>, JobError> {
    let schedule = Schedule::from_str(schedule_expression)?;

    Ok(tokio::spawn(async move {
        loop {
            if *shutdown.borrow() {
                return;
            }
            let Some(next_run) = schedule.upcoming(Utc).next() else {
                error!(job = job_name, "job schedule has no future runs");
                return;
            };

            let now = Utc::now();
            let wait_duration = next_run.signed_duration_since(now);
            if let Ok(wait_duration) = wait_duration.to_std() {
                if !wait_duration.is_zero() {
                    tokio::select! {
                        _ = sleep(wait_duration) => {}
                        changed = shutdown.changed() => {
                            if changed.is_err() || *shutdown.borrow() {
                                return;
                            }
                        }
                    }
                }
            }

            if *shutdown.borrow() {
                return;
            }

            // Run each tick on its own task so a panic ends that tick instead
            // of this loop. Nothing ever awaits the loop's `JoinHandle`, so a
            // panic here would silently stop the job for the life of the
            // process. `rand` 0.10 turned `ThreadRng` reseed failure into a
            // panic (`could not reseed ThreadRng`) where 0.8 only warned, and
            // tombstone cleanup mints sync event IDs from `rand::rng()`.
            let mut run = JoinSet::new();
            run.spawn(job());
            match run.join_next().await {
                Some(Ok(Ok(()))) => {}
                Some(Ok(Err(error))) => {
                    error!(job = job_name, error = %error, "scheduled job failed");
                }
                Some(Err(join_error)) => {
                    error!(job = job_name, error = %join_error, "scheduled job panicked");
                }
                None => unreachable!("the scheduled run set contains one task"),
            }
        }
    }))
}

fn run_expired_session_cleanup(context: JobContext) -> JobFuture {
    let pool = context.pool;
    Box::pin(async move {
        cleanup_expired_sessions(&pool).await?;
        Ok(())
    })
}

fn run_sync_event_pruning(context: JobContext) -> JobFuture {
    let pool = context.pool;
    Box::pin(async move {
        prune_sync_events(&pool).await?;
        Ok(())
    })
}

fn run_pending_attachment_cleanup(context: JobContext) -> JobFuture {
    Box::pin(async move {
        cleanup_pending_attachment_uploads(&context.pool, context.storage.as_ref()).await?;
        Ok(())
    })
}

fn run_rate_limit_state_pruning(context: JobContext) -> JobFuture {
    let pool = context.pool;
    Box::pin(async move {
        prune_rate_limit_state(&pool).await?;
        Ok(())
    })
}

fn run_tombstone_cleanup(context: JobContext) -> JobFuture {
    let pool = context.pool;
    Box::pin(async move {
        cleanup_tombstones(&pool).await?;
        Ok(())
    })
}

fn run_rotation_plan_cleanup(context: JobContext) -> JobFuture {
    let pool = context.pool;
    Box::pin(async move {
        cleanup_rotation_plans(&pool, MAX_CLEANUP_BATCH).await?;
        Ok(())
    })
}

fn run_favicon_refresh(context: JobContext) -> JobFuture {
    let pool = context.pool;
    Box::pin(async move {
        let stale_before = time::OffsetDateTime::now_utc()
            - time::Duration::days(FAVICON_REFRESH_STALE_AFTER_DAYS);
        let domains =
            list_domains_to_refresh(&pool, FAVICON_REFRESH_BATCH_SIZE, stale_before).await?;

        let mut refreshed = 0_u64;
        for domain in &domains {
            if fetch_and_store_favicon(&pool, context.remote_documents.as_ref(), domain).await? {
                refreshed += 1;
            }
        }

        if !domains.is_empty() {
            info!(
                processed = domains.len(),
                refreshed, "favicon-refresh completed"
            );
        }

        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };

    use tokio::{sync::Notify, time::Duration};

    use super::{JobError, JobFuture, JobRunner};

    struct CancellationProbe(Arc<AtomicBool>);

    impl Drop for CancellationProbe {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn shutdown_stops_future_scheduled_runs() -> Result<(), JobError> {
        let run_count = Arc::new(AtomicUsize::new(0));
        let first_run = Arc::new(Notify::new());
        let job = {
            let run_count = Arc::clone(&run_count);
            let first_run = Arc::clone(&first_run);
            Arc::new(move || -> JobFuture {
                let run_count = Arc::clone(&run_count);
                let first_run = Arc::clone(&first_run);
                Box::pin(async move {
                    run_count.fetch_add(1, Ordering::SeqCst);
                    first_run.notify_one();
                    Ok(())
                })
            })
        };
        let runner = JobRunner::start_test_job("*/1 * * * * * *", job)?;

        tokio::time::timeout(Duration::from_secs(2), first_run.notified())
            .await
            .expect("the first scheduled run should start");
        let _ = runner.shutdown(Duration::from_secs(1)).await;
        let count_after_shutdown = run_count.load(Ordering::SeqCst);

        tokio::time::sleep(Duration::from_millis(1_100)).await;
        assert_eq!(run_count.load(Ordering::SeqCst), count_after_shutdown);
        Ok(())
    }

    #[tokio::test]
    async fn shutdown_allows_an_in_flight_run_to_finish() -> Result<(), JobError> {
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let completed = Arc::new(AtomicUsize::new(0));
        let job = {
            let started = Arc::clone(&started);
            let release = Arc::clone(&release);
            let completed = Arc::clone(&completed);
            Arc::new(move || -> JobFuture {
                let started = Arc::clone(&started);
                let release = Arc::clone(&release);
                let completed = Arc::clone(&completed);
                Box::pin(async move {
                    started.notify_one();
                    release.notified().await;
                    completed.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
            })
        };
        let runner = JobRunner::start_test_job("*/1 * * * * * *", job)?;
        tokio::time::timeout(Duration::from_secs(2), started.notified())
            .await
            .expect("the scheduled run should start");

        let shutdown = tokio::spawn(runner.shutdown(Duration::from_secs(1)));
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert!(!shutdown.is_finished(), "shutdown cancelled the active run");
        release.notify_one();

        let finished_within_grace = tokio::time::timeout(Duration::from_secs(1), shutdown)
            .await
            .expect("shutdown should finish after the active run")
            .expect("shutdown task should not panic");
        assert!(finished_within_grace);
        assert_eq!(completed.load(Ordering::SeqCst), 1);
        Ok(())
    }

    #[tokio::test]
    async fn shutdown_aborts_an_in_flight_run_after_the_grace_period() -> Result<(), JobError> {
        let started = Arc::new(Notify::new());
        let cancelled = Arc::new(AtomicBool::new(false));
        let job = {
            let started = Arc::clone(&started);
            let cancelled = Arc::clone(&cancelled);
            Arc::new(move || -> JobFuture {
                let started = Arc::clone(&started);
                let probe = CancellationProbe(Arc::clone(&cancelled));
                Box::pin(async move {
                    let _probe = probe;
                    started.notify_one();
                    std::future::pending::<()>().await;
                    Ok(())
                })
            })
        };
        let runner = JobRunner::start_test_job("*/1 * * * * * *", job)?;
        tokio::time::timeout(Duration::from_secs(2), started.notified())
            .await
            .expect("the scheduled run should start");

        let finished_within_grace = runner.shutdown(Duration::from_millis(20)).await;

        assert!(!finished_within_grace);
        assert!(
            cancelled.load(Ordering::SeqCst),
            "shutdown returned before the timed-out run was cancelled"
        );
        Ok(())
    }
}
