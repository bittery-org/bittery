use std::{
    error::Error,
    future::{Future, IntoFuture},
    net::SocketAddr,
    sync::Arc,
    time::Duration,
};

use axum::Router;

use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle, time::timeout};
use tracing::warn;

use crate::config::Config;
use crate::integrations::storage::object_storage_from_config;
use crate::integrations::stripe::StripeBillingGateway;
use crate::{
    build_rate_limiter, create_app, db, init_redis, validate_sync_fanout_requirement, AppState,
    EdgeHttpConfig, JobRunner, SyncPubSub,
};

type RuntimeError = Box<dyn Error + Send + Sync>;
const JOB_SHUTDOWN_GRACE: Duration = Duration::from_secs(30);
const HTTP_SHUTDOWN_GRACE: Duration = Duration::from_secs(30);
const REDIS_DISPATCH_SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// Owns the complete production server lifetime behind one startup interface.
pub struct ServerRuntime {
    app: Router,
    bind_address: String,
    http_shutdown_grace: Duration,
    job_runner: Option<JobRunner>,
    redis_dispatch: Option<JoinHandle<()>>,
}

impl ServerRuntime {
    pub async fn from_env() -> Result<Self, RuntimeError> {
        let config = Arc::new(Config::from_env()?);
        let edge_config =
            EdgeHttpConfig::from_server_config(&config.server).map_err(std::io::Error::other)?;
        let bind_address = config.server.bind_address();
        let pool = db::connect_with_config(&config.database).await?;
        db::run_migrations_with_config(&pool, &config.database).await?;

        let rate_limiter = build_rate_limiter(&pool, &config.rate_limit)
            .await
            .map_err(std::io::Error::other)?;
        let redis = init_redis(&config.redis).await;
        validate_sync_fanout_requirement(Some(&config.server.node_environment), redis.is_some())
            .map_err(std::io::Error::other)?;

        let object_storage = object_storage_from_config(&config.storage)?;
        let billing_gateway = StripeBillingGateway::from_config(&config.stripe)?;
        let mut state = AppState::from_pool_with_config(pool.clone(), Arc::clone(&config))
            .with_object_storage(object_storage)
            .with_rate_limiter(rate_limiter)
            .with_redis(redis.clone());
        if let Some(gateway) = billing_gateway {
            state = state.with_billing_gateway(Arc::new(gateway));
        }
        let mut redis_sync_pubsub = None;
        if let Some(redis) = redis {
            state.connection_registry.load_scripts().await?;
            let sync_pubsub = Arc::new(SyncPubSub::with_redis(redis).await);
            state = state.with_sync_pubsub((*sync_pubsub).clone());
            redis_sync_pubsub = Some(sync_pubsub);
        }

        let job_runner = JobRunner::start(
            pool,
            state.object_storage.clone(),
            state.remote_documents.clone(),
        )?;
        let redis_dispatch = redis_sync_pubsub
            .and_then(|sync_pubsub| sync_pubsub.start_dispatch(job_runner.shutdown_receiver()));
        let app = create_app(state, edge_config);

        Ok(Self {
            app,
            bind_address,
            http_shutdown_grace: HTTP_SHUTDOWN_GRACE,
            job_runner: Some(job_runner),
            redis_dispatch,
        })
    }

    pub fn app(&self) -> Router {
        self.app.clone()
    }

    pub fn bind_address(&self) -> &str {
        &self.bind_address
    }

    pub async fn serve<F>(
        mut self,
        listener: TcpListener,
        shutdown_signal: F,
    ) -> Result<(), std::io::Error>
    where
        F: Future<Output = ()> + Send,
    {
        let result = {
            let app = self.app();
            let (http_shutdown_tx, http_shutdown_rx) = oneshot::channel();
            let server = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async move {
                let _ = http_shutdown_rx.await;
            })
            .into_future();
            tokio::pin!(server);

            tokio::select! {
                result = &mut server => result,
                () = shutdown_signal => {
                    self.begin_shutdown();
                    let _ = http_shutdown_tx.send(());
                    match timeout(self.http_shutdown_grace, &mut server).await {
                        Ok(result) => result,
                        Err(_) => {
                            warn!(
                                grace_seconds = self.http_shutdown_grace.as_secs_f64(),
                                "HTTP connections exceeded the graceful shutdown period and were terminated"
                            );
                            Ok(())
                        }
                    }
                }
            }
        };

        self.shutdown_background_tasks().await;
        result
    }

    fn begin_shutdown(&self) {
        if let Some(job_runner) = &self.job_runner {
            job_runner.request_shutdown();
        }
    }

    async fn shutdown_background_tasks(&mut self) {
        self.begin_shutdown();
        let job_runner = self.job_runner.take();
        let redis_dispatch = self.redis_dispatch.take();

        let jobs = async move {
            if let Some(job_runner) = job_runner {
                if !job_runner.shutdown(JOB_SHUTDOWN_GRACE).await {
                    warn!(
                        grace_seconds = JOB_SHUTDOWN_GRACE.as_secs(),
                        "scheduled jobs exceeded the graceful shutdown period and were cancelled"
                    );
                }
            }
        };
        let redis = async move {
            if let Some(mut dispatch) = redis_dispatch {
                if timeout(REDIS_DISPATCH_SHUTDOWN_GRACE, &mut dispatch)
                    .await
                    .is_err()
                {
                    warn!("Redis pub/sub dispatch did not stop in time; aborting it");
                    dispatch.abort();
                    let _ = dispatch.await;
                }
            }
        };
        tokio::join!(jobs, redis);
    }
}

impl Drop for ServerRuntime {
    fn drop(&mut self) {
        self.begin_shutdown();
        if let Some(dispatch) = &self.redis_dispatch {
            dispatch.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    use axum::{
        response::sse::{Event, Sse},
        routing::get,
        Router,
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        sync::oneshot,
        time::Duration,
    };

    use super::ServerRuntime;
    use crate::JobRunner;

    #[tokio::test]
    async fn server_shutdown_stops_background_dispatch() {
        let job_runner = JobRunner::idle_for_test();
        let mut shutdown = job_runner.shutdown_receiver();
        let dispatch_stopped = Arc::new(AtomicBool::new(false));
        let stopped = Arc::clone(&dispatch_stopped);
        let redis_dispatch = tokio::spawn(async move {
            let _ = shutdown.changed().await;
            stopped.store(true, Ordering::SeqCst);
        });
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener should bind");
        let runtime = ServerRuntime {
            app: Router::new().route("/", get(|| async { "OK" })),
            bind_address: listener.local_addr().unwrap().to_string(),
            http_shutdown_grace: Duration::from_secs(1),
            job_runner: Some(job_runner),
            redis_dispatch: Some(redis_dispatch),
        };
        let (shutdown_tx, shutdown_rx) = oneshot::channel();

        let server = tokio::spawn(runtime.serve(listener, async move {
            let _ = shutdown_rx.await;
        }));
        shutdown_tx.send(()).expect("shutdown should signal");

        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .expect("server should stop within the grace period")
            .expect("server task should not panic")
            .expect("server should shut down cleanly");
        assert!(dispatch_stopped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn server_shutdown_bounds_an_open_stream_and_still_stops_background_tasks() {
        let job_runner = JobRunner::idle_for_test();
        let mut background_shutdown = job_runner.shutdown_receiver();
        let dispatch_stopped = Arc::new(AtomicBool::new(false));
        let stopped = Arc::clone(&dispatch_stopped);
        let redis_dispatch = tokio::spawn(async move {
            let _ = background_shutdown.changed().await;
            stopped.store(true, Ordering::SeqCst);
        });
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener should bind");
        let address = listener.local_addr().unwrap();
        let runtime = ServerRuntime {
            app: Router::new().route(
                "/events",
                get(|| async {
                    Sse::new(async_stream::stream! {
                        yield Ok::<_, std::convert::Infallible>(Event::default().data("open"));
                        std::future::pending::<()>().await;
                    })
                }),
            ),
            bind_address: address.to_string(),
            http_shutdown_grace: Duration::from_millis(20),
            job_runner: Some(job_runner),
            redis_dispatch: Some(redis_dispatch),
        };
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let server = tokio::spawn(runtime.serve(listener, async move {
            let _ = shutdown_rx.await;
        }));

        let mut connection = TcpStream::connect(address)
            .await
            .expect("stream client should connect");
        connection
            .write_all(b"GET /events HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .expect("stream request should write");
        let mut response = [0_u8; 256];
        let bytes_read =
            tokio::time::timeout(Duration::from_secs(1), connection.read(&mut response))
                .await
                .expect("stream should respond")
                .expect("stream response should read");
        assert!(String::from_utf8_lossy(&response[..bytes_read]).contains("200 OK"));

        shutdown_tx.send(()).expect("shutdown should signal");
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .expect("bounded HTTP shutdown should terminate the server")
            .expect("server task should not panic")
            .expect("server should shut down cleanly");
        assert!(dispatch_stopped.load(Ordering::SeqCst));
    }
}
