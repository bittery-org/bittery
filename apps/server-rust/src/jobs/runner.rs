use std::{future::Future, pin::Pin, str::FromStr};

use chrono::Utc;
use cron::Schedule;
use sqlx::PgPool;
use tokio::{task::JoinHandle, time::sleep};
use tracing::{error, info};

use super::sql::{
	cleanup_expired_sessions, cleanup_pending_attachment_uploads, cleanup_tombstones,
	prune_sync_events,
};
use crate::favicon::{fetch_and_store_favicon, list_domains_to_refresh};

type JobError = Box<dyn std::error::Error + Send + Sync>;
type JobFuture = Pin<Box<dyn Future<Output = Result<(), JobError>> + Send>>;
type JobFn = fn(PgPool) -> JobFuture;
const FAVICON_REFRESH_STALE_AFTER_DAYS: i64 = 30;
const FAVICON_REFRESH_BATCH_SIZE: i64 = 200;

pub struct JobRunner {
	handles: Vec<JoinHandle<()>>,
}

impl JobRunner {
	pub fn start(pool: PgPool) -> Result<Self, JobError> {
		let handles = vec![
			spawn_job(
				"expired-session-cleanup",
				"0 */30 * * * * *",
				pool.clone(),
				run_expired_session_cleanup,
			)?,
			spawn_job(
				"pending-attachment-upload-cleanup",
				"0 */15 * * * * *",
				pool.clone(),
				run_pending_attachment_cleanup,
			)?,
			spawn_job(
				"sync-event-pruning",
				"0 0 3 * * * *",
				pool.clone(),
				run_sync_event_pruning,
			)?,
			spawn_job(
				"tombstone-cleanup",
				"0 15 3 * * * *",
				pool.clone(),
				run_tombstone_cleanup,
			)?,
			spawn_job(
				"favicon-refresh",
				"0 30 2 * * 1 *",
				pool,
				run_favicon_refresh,
			)?,
		];

		info!(job_count = handles.len(), "rust job runner started");
		Ok(Self { handles })
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
	pool: PgPool,
	job: JobFn,
) -> Result<JoinHandle<()>, JobError> {
	let schedule = Schedule::from_str(schedule_expression)?;

	Ok(tokio::spawn(async move {
		loop {
			let Some(next_run) = schedule.upcoming(Utc).next() else {
				error!(job = job_name, "job schedule has no future runs");
				return;
			};

			let now = Utc::now();
			let wait_duration = next_run.signed_duration_since(now);
			if let Ok(wait_duration) = wait_duration.to_std() {
				if !wait_duration.is_zero() {
					sleep(wait_duration).await;
				}
			}

			if let Err(error) = job(pool.clone()).await {
				error!(job = job_name, error = %error, "scheduled job failed");
			}
		}
	}))
}

fn run_expired_session_cleanup(pool: PgPool) -> JobFuture {
	Box::pin(async move {
		cleanup_expired_sessions(&pool).await?;
		Ok(())
	})
}

fn run_sync_event_pruning(pool: PgPool) -> JobFuture {
	Box::pin(async move {
		prune_sync_events(&pool).await?;
		Ok(())
	})
}

fn run_pending_attachment_cleanup(pool: PgPool) -> JobFuture {
	Box::pin(async move {
		cleanup_pending_attachment_uploads(&pool).await?;
		Ok(())
	})
}

fn run_tombstone_cleanup(pool: PgPool) -> JobFuture {
	Box::pin(async move {
		cleanup_tombstones(&pool).await?;
		Ok(())
	})
}

fn run_favicon_refresh(pool: PgPool) -> JobFuture {
	Box::pin(async move {
		let stale_before = time::OffsetDateTime::now_utc()
			- time::Duration::days(FAVICON_REFRESH_STALE_AFTER_DAYS);
		let domains = list_domains_to_refresh(&pool, FAVICON_REFRESH_BATCH_SIZE, stale_before)
			.await?;

		let mut refreshed = 0_u64;
		for domain in &domains {
			if fetch_and_store_favicon(&pool, domain).await? {
				refreshed += 1;
			}
		}

		if !domains.is_empty() {
			info!(processed = domains.len(), refreshed, "favicon-refresh completed");
		}

		Ok(())
	})
}