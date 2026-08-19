use std::collections::HashMap;
use std::sync::Arc;

use fred::clients::SubscriberClient;
use fred::prelude::*;
use serde::{Deserialize, Serialize};
use tokio::{
    sync::{broadcast, watch, RwLock},
    task::JoinHandle,
};
use tracing::{info, warn};

/// Channel capacity for local broadcast fanout.
const CHANNEL_CAPACITY: usize = 128;

/// Notification types sent over SSE.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SyncNotification {
    /// Something changed — client should call getEventsSince.
    Sync,
    /// A session was revoked — client should disconnect if it matches.
    SessionRevoked {
        session_id: String,
        reason: Option<String>,
    },
}

/// Unified pub/sub notification system.
///
/// Always provides in-memory broadcast for single-instance use.
/// Optionally backed by Redis for cross-instance fan-out.
#[derive(Clone)]
pub struct SyncPubSub {
    /// Global sync broadcast — all SSE connections listen to this.
    sync_sender: broadcast::Sender<()>,
    /// Per-user control channels for session revocation.
    control_channels: Arc<RwLock<HashMap<String, ControlEntry>>>,
    /// Optional Redis backend for cross-instance fan-out.
    redis: Option<RedisBackend>,
}

#[derive(Clone)]
struct RedisBackend {
    publish_pool: Pool,
    subscriber: SubscriberClient,
}

struct ControlEntry {
    sender: broadcast::Sender<SyncNotification>,
    ref_count: usize,
}

impl Default for SyncPubSub {
    fn default() -> Self {
        Self::new()
    }
}

impl SyncPubSub {
    /// Create an in-memory-only instance (no Redis).
    pub fn new() -> Self {
        let (sync_sender, _) = broadcast::channel(CHANNEL_CAPACITY);
        Self {
            sync_sender,
            control_channels: Arc::new(RwLock::new(HashMap::new())),
            redis: None,
        }
    }

    /// Create an instance backed by Redis for cross-instance fan-out.
    pub async fn with_redis(pool: Pool) -> Self {
        let config = pool.client_config();
        let subscriber =
            SubscriberClient::new(config, None, None, Some(ReconnectPolicy::default()));
        if let Err(error) = subscriber.init().await {
            warn!(error = %error, "failed to initialize Redis subscriber client");
        }

        let (sync_sender, _) = broadcast::channel(CHANNEL_CAPACITY);
        Self {
            sync_sender,
            control_channels: Arc::new(RwLock::new(HashMap::new())),
            redis: Some(RedisBackend {
                publish_pool: pool,
                subscriber,
            }),
        }
    }

    /// Notify all connected SSE clients that something changed.
    /// Clients should call `getEventsSince` to fetch actual data.
    pub fn notify_sync(&self) {
        // Local broadcast
        let _ = self.sync_sender.send(());

        // Cross-instance via Redis
        if let Some(ref redis) = self.redis {
            let pool = redis.publish_pool.clone();
            tokio::spawn(async move {
                if let Err(error) = pool.next().publish::<(), _, _>("sync:wake", "1").await {
                    warn!(error = %error, "failed to publish sync wake to Redis");
                }
            });
        }
    }

    /// Notify that a session was revoked.
    /// The SSE endpoint checks if the revoked session matches its own.
    pub fn notify_session_revoked(&self, user_id: &str, session_id: &str, reason: &str) {
        let notification = SyncNotification::SessionRevoked {
            session_id: session_id.to_string(),
            reason: Some(reason.to_string()),
        };

        // Local broadcast to user's channel
        let rt = tokio::runtime::Handle::current();
        let channels = self.control_channels.clone();
        let user_id_owned = user_id.to_string();
        let notification_clone = notification.clone();
        rt.spawn(async move {
            let channels = channels.read().await;
            if let Some(entry) = channels.get(&user_id_owned) {
                let _ = entry.sender.send(notification_clone);
            }
        });

        // Cross-instance via Redis
        if let Some(ref redis) = self.redis {
            if let Ok(bytes) = serde_json::to_vec(&notification) {
                let pool = redis.publish_pool.clone();
                let channel = control_channel(user_id);
                tokio::spawn(async move {
                    if let Err(error) = pool.next().publish::<(), _, _>(&channel, bytes).await {
                        warn!(error = %error, "failed to publish session revocation to Redis");
                    }
                });
            }
        }
    }

    /// Subscribe to notifications for a user's SSE connection.
    /// Returns receivers for global sync pings and per-user control messages.
    pub async fn subscribe(
        &self,
        user_id: &str,
    ) -> (
        broadcast::Receiver<()>,
        broadcast::Receiver<SyncNotification>,
    ) {
        let sync_rx = self.sync_sender.subscribe();

        let mut channels = self.control_channels.write().await;
        let control_rx = if let Some(entry) = channels.get_mut(user_id) {
            entry.ref_count += 1;
            entry.sender.subscribe()
        } else {
            let (tx, rx) = broadcast::channel(CHANNEL_CAPACITY);
            channels.insert(
                user_id.to_string(),
                ControlEntry {
                    sender: tx,
                    ref_count: 1,
                },
            );
            drop(channels);

            // Subscribe in Redis for cross-instance control messages
            if let Some(ref redis) = self.redis {
                let ch = control_channel(user_id);
                if let Err(error) = redis.subscriber.subscribe(&ch).await {
                    warn!(channel = %ch, error = %error, "failed to subscribe to Redis channel");
                }
            }

            rx
        };

        (sync_rx, control_rx)
    }

    /// Unsubscribe from a user's notifications (ref-counted).
    pub async fn unsubscribe(&self, user_id: &str) {
        let mut channels = self.control_channels.write().await;
        if let Some(entry) = channels.get_mut(user_id) {
            entry.ref_count = entry.ref_count.saturating_sub(1);
            if entry.ref_count == 0 {
                channels.remove(user_id);

                // Unsubscribe from Redis
                if let Some(ref redis) = self.redis {
                    let subscriber = redis.subscriber.clone();
                    let ch = control_channel(user_id);
                    tokio::spawn(async move {
                        if let Err(error) = subscriber.unsubscribe(&ch).await {
                            warn!(channel = %ch, error = %error, "failed to unsubscribe from Redis");
                        }
                    });
                }
            }
        }
    }

    /// Start the Redis dispatch loop. Must be called once on startup.
    /// Listens for incoming Redis pub/sub messages and fans them out locally.
    /// Only needed when Redis is configured.
    pub fn start_dispatch(
        self: &Arc<Self>,
        mut shutdown: watch::Receiver<bool>,
    ) -> Option<JoinHandle<()>> {
        let redis = self.redis.as_ref()?;

        let pubsub = Arc::clone(self);

        // Subscribe to global sync wake channel
        let subscriber = redis.subscriber.clone();
        let mut message_rx = redis.subscriber.message_rx();
        Some(tokio::spawn(async move {
            if *shutdown.borrow() {
                info!("Redis pub/sub dispatch loop ended");
                return;
            }
            tokio::select! {
                result = subscriber.subscribe("sync:wake") => {
                    if let Err(error) = result {
                        warn!(error = %error, "failed to subscribe to sync:wake");
                    }
                }
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                        info!("Redis pub/sub dispatch loop ended");
                        return;
                    }
                }
            }
            loop {
                let message = tokio::select! {
                    message = message_rx.recv() => match message {
                        Ok(message) => message,
                        Err(_) => break,
                    },
                    changed = shutdown.changed() => {
                        if changed.is_err() || *shutdown.borrow() {
                            break;
                        }
                        continue;
                    }
                };
                let channel = message.channel.to_string();

                if channel == "sync:wake" {
                    // Wake all local SSE connections
                    let _ = pubsub.sync_sender.send(());
                    continue;
                }

                if let Some(user_id) = channel.strip_prefix("control:") {
                    // Decode and forward to per-user control channel
                    let payload: Vec<u8> = match message.value.convert() {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if let Ok(notification) = serde_json::from_slice::<SyncNotification>(&payload) {
                        let channels = pubsub.control_channels.read().await;
                        if let Some(entry) = channels.get(user_id) {
                            let _ = entry.sender.send(notification);
                        }
                    }
                }
            }

            info!("Redis pub/sub dispatch loop ended");
        }))
    }
}

fn control_channel(user_id: &str) -> String {
    format!("control:{user_id}")
}
