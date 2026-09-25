//! Cancellation signal for a single OS prompt, independent of any application's Runtime policy.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[derive(Clone, Default)]
pub struct PromptCancellation(Arc<AtomicBool>);
impl PromptCancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    #[cfg(any(target_os = "macos", target_os = "windows", test))]
    pub(crate) fn wait<T>(
        &self,
        receiver: &std::sync::mpsc::Receiver<T>,
        cancel_native: impl FnOnce(),
    ) -> Result<Option<T>, std::sync::mpsc::RecvError> {
        loop {
            if self.is_cancelled() {
                cancel_native();
                // Cancel only requests termination. Keep the context/operation alive until its
                // completion callback runs, including a late successful callback after cancel.
                return receiver.recv().map(|_| None);
            }
            match receiver.recv_timeout(std::time::Duration::from_millis(10)) {
                Ok(result) => {
                    return Ok(if self.is_cancelled() {
                        None
                    } else {
                        Some(result)
                    })
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(std::sync::mpsc::RecvError)
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, time::Duration};
    #[test]
    fn cancellation_requests_native_stop_and_drains_completion_before_returning() {
        let cancellation = PromptCancellation::default();
        let (result_tx, result_rx) = mpsc::channel();
        let (cancel_tx, cancel_rx) = mpsc::channel();
        let signal = cancellation.clone();
        let worker = std::thread::spawn(move || {
            signal.wait(&result_rx, || {
                cancel_tx.send(()).unwrap();
            })
        });
        cancellation.cancel();
        let native_cancelled = cancel_rx.recv_timeout(Duration::from_secs(1)).is_ok();
        let still_draining = !worker.is_finished();
        result_tx.send("late success").unwrap();
        let result = worker.join().unwrap().unwrap();
        assert!(native_cancelled);
        assert!(still_draining);
        assert_eq!(result, None);
    }
    #[test]
    fn ordinary_completion_and_disconnected_callback_remain_distinct() {
        let cancellation = PromptCancellation::default();
        let (tx, rx) = mpsc::channel();
        tx.send(7).unwrap();
        assert_eq!(
            cancellation
                .wait(&rx, || panic!("unrequested cancellation"))
                .unwrap(),
            Some(7)
        );
        let (tx, rx) = mpsc::channel::<()>();
        drop(tx);
        assert!(cancellation
            .wait(&rx, || panic!("unrequested cancellation"))
            .is_err());
    }
}
