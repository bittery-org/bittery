//! The buffer between a Runtime publication and the host callback that consumes it.
//!
//! A projection reaches the sink from inside the Runtime, which is holding its publication
//! ordering and a plaintext delivery lease while it calls. Calling the host from there would let
//! the callback re-enter the Runtime mid-mutation and would stall every Account waiting on that
//! lease for as long as host code runs. So the sink stores the projection and asks for a drain.
//!
//! Asking matters. `request_json` and `observe_json` are the only drains a host call can reach,
//! and Sync catch-up, an SSE hint, Session renewal, and lock all publish outside both. Without a
//! wake, those projections sit in this buffer until some unrelated request happens to flush
//! them, which makes a live subscription behave like a poll.

use bittery_client_core as core;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::Notify;

pub(crate) struct BufferedSink {
    queued: Mutex<VecDeque<core::RuntimeProjection>>,
    closed: AtomicBool,
    draining: AtomicBool,
    wake: Arc<Notify>,
}

impl core::ObservationSink for BufferedSink {
    fn publish(&self, projection: core::RuntimeProjection) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        self.queued
            .lock()
            .expect("Web observation buffer lock poisoned")
            .push_back(projection);
        self.wake.notify_one();
    }
}

impl BufferedSink {
    pub(crate) fn new(wake: Arc<Notify>) -> Self {
        Self {
            queued: Mutex::new(VecDeque::new()),
            closed: AtomicBool::new(false),
            draining: AtomicBool::new(false),
            wake,
        }
    }

    /// Drops what is queued and every later publication. A closed observation and a closed
    /// Runtime both end here, which is what makes closing idempotent and late callbacks silent.
    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.queued
            .lock()
            .expect("Web observation buffer lock poisoned")
            .clear();
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Hands queued projections to the host one at a time, oldest first.
    ///
    /// One projection is taken per step, so a publication that arrives while the host callback
    /// runs is delivered in turn by this same loop rather than by a second, interleaved drain.
    /// A drain that starts while another is already running therefore returns without touching
    /// the queue: the running drain owns it, and taking from it here would reorder delivery.
    pub(crate) fn drain<E>(
        &self,
        mut deliver: impl FnMut(core::RuntimeProjection) -> Result<(), E>,
    ) -> Result<(), E> {
        if self.draining.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let _draining = DrainGuard(&self.draining);
        loop {
            if self.closed.load(Ordering::SeqCst) {
                return Ok(());
            }
            let next = self
                .queued
                .lock()
                .expect("Web observation buffer lock poisoned")
                .pop_front();
            let Some(projection) = next else {
                return Ok(());
            };
            deliver(projection)?;
        }
    }
}

struct DrainGuard<'a>(&'a AtomicBool);

impl Drop for DrainGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bittery_client_core::ObservationSink;
    use std::{cell::RefCell, time::Duration};

    fn status(revision: u64) -> core::RuntimeProjection {
        core::RuntimeProjection::RuntimeStatus(core::RuntimeStatusProjection {
            account_id: None,
            revision,
            accounts: Vec::new(),
            closed: false,
        })
    }

    fn revision(projection: &core::RuntimeProjection) -> u64 {
        projection.revision()
    }

    fn sink() -> BufferedSink {
        BufferedSink::new(Arc::new(Notify::new()))
    }

    fn collect(sink: &BufferedSink) -> Vec<u64> {
        let delivered = RefCell::new(Vec::new());
        sink.drain::<()>(|projection| {
            delivered.borrow_mut().push(revision(&projection));
            Ok(())
        })
        .expect("delivery cannot fail");
        delivered.into_inner()
    }

    #[test]
    fn delivers_every_publication_once_in_order() {
        let sink = sink();
        sink.publish(status(1));
        sink.publish(status(2));

        assert_eq!(collect(&sink), vec![1, 2]);
        assert_eq!(collect(&sink), Vec::<u64>::new());
    }

    #[tokio::test]
    async fn a_publication_with_no_drain_in_flight_wakes_one() {
        let wake = Arc::new(Notify::new());
        let sink = BufferedSink::new(Arc::clone(&wake));

        sink.publish(status(1));

        tokio::time::timeout(Duration::from_millis(50), wake.notified())
            .await
            .expect("a background publication must wake a drain");
        assert_eq!(collect(&sink), vec![1]);
    }

    #[test]
    fn a_publication_made_while_delivering_follows_the_one_before_it() {
        let sink = sink();
        sink.publish(status(1));
        let delivered = RefCell::new(Vec::new());

        sink.drain::<()>(|projection| {
            if revision(&projection) == 1 {
                sink.publish(status(2));
            }
            delivered.borrow_mut().push(revision(&projection));
            Ok(())
        })
        .expect("delivery cannot fail");

        assert_eq!(delivered.into_inner(), vec![1, 2]);
    }

    #[test]
    fn a_drain_started_while_delivering_takes_nothing() {
        let sink = sink();
        sink.publish(status(1));
        sink.publish(status(2));
        let delivered = RefCell::new(Vec::new());

        sink.drain::<()>(|projection| {
            delivered.borrow_mut().push(revision(&projection));
            assert_eq!(collect(&sink), Vec::<u64>::new());
            Ok(())
        })
        .expect("delivery cannot fail");

        assert_eq!(delivered.into_inner(), vec![1, 2]);
    }

    #[test]
    fn closing_drops_the_queue_the_publication_after_it_and_the_rest_of_a_drain() {
        let sink = sink();
        sink.publish(status(1));
        sink.publish(status(2));
        sink.publish(status(3));
        let delivered = RefCell::new(Vec::new());

        sink.drain::<()>(|projection| {
            delivered.borrow_mut().push(revision(&projection));
            sink.close();
            Ok(())
        })
        .expect("delivery cannot fail");
        sink.publish(status(4));

        assert_eq!(delivered.into_inner(), vec![1]);
        assert!(sink.is_closed());
        assert_eq!(collect(&sink), Vec::<u64>::new());
    }

    #[test]
    fn a_failed_delivery_leaves_the_rest_drainable() {
        let sink = sink();
        sink.publish(status(1));
        sink.publish(status(2));

        let failed = sink.drain(|_| Err("host callback threw"));

        assert_eq!(failed, Err("host callback threw"));
        assert_eq!(collect(&sink), vec![2]);
    }
}
