use crate::web_binary_transfer_control::TransferControlRequest;
use std::{future::Future, rc::Rc};

pub(crate) trait ControlStarter {
    fn start(&self, request: TransferControlRequest);
}

pub(crate) async fn invoke_armed<T, F, Fut>(
    starter: Rc<dyn ControlStarter>,
    transfer_id: String,
    invoke: F,
) -> (AbandonmentGuard, T)
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = T>,
{
    let guard = AbandonmentGuard::new(starter, transfer_id);
    let result = invoke().await;
    (guard, result)
}

pub(crate) struct AbandonmentGuard {
    starter: Rc<dyn ControlStarter>,
    transfer_id: String,
    complete: bool,
}

impl AbandonmentGuard {
    pub(crate) fn new(starter: Rc<dyn ControlStarter>, transfer_id: String) -> Self {
        Self {
            starter,
            transfer_id,
            complete: false,
        }
    }

    #[cfg(target_arch = "wasm32")]
    pub(crate) fn is_complete(&self) -> bool {
        self.complete
    }

    pub(crate) fn complete(&mut self) {
        self.complete = true;
    }

    pub(crate) fn cancel_now(&mut self) {
        if self.complete {
            return;
        }
        self.complete = true;
        self.starter.start(TransferControlRequest::CancelTransfer {
            transfer_id: self.transfer_id.clone(),
        });
    }
}

impl Drop for AbandonmentGuard {
    fn drop(&mut self) {
        self.cancel_now();
    }
}

#[cfg(test)]
mod tests {
    use super::{invoke_armed, AbandonmentGuard, ControlStarter};
    use crate::web_binary_transfer_control::TransferControlRequest;
    use std::{
        cell::{Cell, RefCell},
        future::{pending, Future},
        rc::Rc,
        task::{Context, Poll, Waker},
    };

    struct RecordingStarter(Rc<RefCell<Vec<String>>>);

    impl ControlStarter for RecordingStarter {
        fn start(&self, request: TransferControlRequest) {
            self.0.borrow_mut().push(
                serde_json::to_string(&request).expect("generated control request must serialize"),
            );
        }
    }

    #[test]
    fn abandoned_handle_starts_the_generated_cancel_control_exactly_once() {
        let recorded = Rc::new(RefCell::new(Vec::new()));
        drop(AbandonmentGuard::new(
            Rc::new(RecordingStarter(Rc::clone(&recorded))),
            "transfer-a".into(),
        ));
        assert_eq!(
            *recorded.borrow(),
            [r#"{"type":"cancelTransfer","transferId":"transfer-a"}"#]
        );
    }

    #[test]
    fn completed_handle_does_not_cancel() {
        let recorded = Rc::new(RefCell::new(Vec::new()));
        let mut guard = AbandonmentGuard::new(
            Rc::new(RecordingStarter(Rc::clone(&recorded))),
            "transfer-a".into(),
        );
        guard.complete();
        drop(guard);
        assert!(recorded.borrow().is_empty());
    }

    #[test]
    fn dropping_a_pending_open_after_invocation_starts_generated_cancel() {
        let recorded = Rc::new(RefCell::new(Vec::new()));
        let invoked = Rc::new(Cell::new(false));
        let invoked_by_future = Rc::clone(&invoked);
        let mut open = Box::pin(invoke_armed(
            Rc::new(RecordingStarter(Rc::clone(&recorded))),
            "transfer-pending".into(),
            move || {
                invoked_by_future.set(true);
                pending::<()>()
            },
        ));
        let mut context = Context::from_waker(Waker::noop());
        assert!(matches!(open.as_mut().poll(&mut context), Poll::Pending));
        assert!(invoked.get());

        drop(open);
        assert_eq!(
            *recorded.borrow(),
            [r#"{"type":"cancelTransfer","transferId":"transfer-pending"}"#]
        );
    }
}
