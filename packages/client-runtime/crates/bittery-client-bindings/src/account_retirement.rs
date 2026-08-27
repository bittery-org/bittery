//! Suspends observation delivery across a request that retires an Account or destroys the Device.
//!
//! A retiring request runs asynchronously, so the Runtime keeps publishing while it runs. Without
//! this ledger a host callback can receive plaintext of the very Account being retired, after the
//! user asked for it to go away. The sink drops what it holds and stays silent until the request
//! finishes.
//!
//! The whole subtlety is balance. A sink panics if it is resumed more often than it was suspended,
//! so an observation admitted *during* a retirement must be caught up on the suspensions it missed
//! before it can be resumed with the rest. That is what [`RetirementLedger::admit`] is for, and
//! why the ledger counts scopes rather than trusting the observation table to stay still. Every
//! rule that decides whether a scope touches an observation lives in [`RetirementLedger::covers`],
//! so suspend, resume, and catch-up cannot drift apart.

use bittery_client_core as core;
use std::{collections::HashMap, sync::Arc, sync::Mutex};

/// What a request retires, when it retires anything at all.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RetirementScope {
    Account(core::AccountId),
    Device,
}

/// The scope a request retires while it runs.
///
/// Lock and Sign-out retire live access to one Account. Account removal destroys one Account, and
/// a Wipe destroys every Account on the Device — both are retirements too, and the strongest kind:
/// the Runtime closes those observations for good part-way through.
pub(crate) fn retirement_scope(request: &core::RuntimeRequest) -> Option<RetirementScope> {
    match request {
        core::RuntimeRequest::Lock { account_id }
        | core::RuntimeRequest::SignOut { account_id }
        | core::RuntimeRequest::RemoveAccount { account_id } => {
            Some(RetirementScope::Account(account_id.clone()))
        }
        core::RuntimeRequest::Wipe => Some(RetirementScope::Device),
        _ => None,
    }
}

/// One live observation, as the ledger sees it.
pub(crate) trait RetirableObservation {
    fn retired_account(&self) -> Option<&core::AccountId>;
    fn begin_retirement(&self);
    fn end_retirement(&self);
}

impl<T: RetirableObservation> RetirableObservation for Arc<T> {
    fn retired_account(&self) -> Option<&core::AccountId> {
        T::retired_account(self)
    }

    fn begin_retirement(&self) {
        T::begin_retirement(self);
    }

    fn end_retirement(&self) {
        T::end_retirement(self);
    }
}

#[derive(Default)]
struct Counts {
    device: u64,
    accounts: HashMap<core::AccountId, u64>,
}

#[derive(Default)]
pub(crate) struct RetirementLedger {
    counts: Mutex<Counts>,
}

impl RetirementLedger {
    /// Records one retirement and suspends every observation it covers.
    ///
    /// The guard spans the counter update *and* the iteration. Otherwise a concurrent
    /// [`Self::admit`] can read the counter between the two halves and either miss a suspension
    /// this call has not applied yet or repeat one it already applied. The guard makes the
    /// balance invariant local to this type instead of a property of the host executor. Calling
    /// a sink under the guard is safe because no sink re-enters the ledger.
    pub(crate) fn begin<O: RetirableObservation>(&self, scope: &RetirementScope, live: &[O]) {
        let mut counts = self.lock();
        match scope {
            RetirementScope::Device => counts.device += 1,
            RetirementScope::Account(account_id) => {
                *counts.accounts.entry(account_id.clone()).or_insert(0) += 1;
            }
        }
        for observation in live {
            if Self::covers(scope, observation.retired_account()) {
                observation.begin_retirement();
            }
        }
    }

    /// Resumes every observation the retirement covers and releases the record.
    ///
    /// The guard spans both halves for the same reason it does in [`Self::begin`].
    pub(crate) fn end<O: RetirableObservation>(&self, scope: &RetirementScope, live: &[O]) {
        let mut counts = self.lock();
        for observation in live {
            if Self::covers(scope, observation.retired_account()) {
                observation.end_retirement();
            }
        }
        match scope {
            RetirementScope::Device => {
                counts.device = counts
                    .device
                    .checked_sub(1)
                    .expect("Device retirement must be balanced");
            }
            RetirementScope::Account(account_id) => {
                let active = counts
                    .accounts
                    .get_mut(account_id)
                    .expect("Account retirement must be balanced");
                *active -= 1;
                if *active == 0 {
                    counts.accounts.remove(account_id);
                }
            }
        }
    }

    /// Catches a newly admitted observation up on the retirements already in flight.
    ///
    /// The caller must publish the observation without awaiting in between. Otherwise a retirement
    /// could finish first, resume an observation it never suspended, and panic the sink.
    ///
    /// The guard spans the read *and* the catch-up, so a retirement cannot end between them and
    /// resume a suspension this call has not applied yet.
    pub(crate) fn admit<O: RetirableObservation>(&self, observation: &O) {
        let counts = self.lock();
        let account_id = observation.retired_account();
        let missed = counts.device
            + account_id
                .and_then(|account_id| counts.accounts.get(account_id))
                .copied()
                .unwrap_or(0);
        for _ in 0..missed {
            observation.begin_retirement();
        }
    }

    /// A Device scope covers every observation, including one that names no Account.
    fn covers(scope: &RetirementScope, account_id: Option<&core::AccountId>) -> bool {
        match scope {
            RetirementScope::Device => true,
            RetirementScope::Account(retired) => account_id == Some(retired),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Counts> {
        self.counts
            .lock()
            .expect("Account retirement lock poisoned")
    }

    /// How many active scopes cover this observation. Whenever no ledger call is in flight, the
    /// observation's suspension depth must equal this number. That is the whole invariant.
    #[cfg(test)]
    fn covering_scopes(&self, account_id: Option<&core::AccountId>) -> u64 {
        let counts = self.lock();
        counts.device
            + account_id
                .and_then(|account_id| counts.accounts.get(account_id))
                .copied()
                .unwrap_or(0)
    }

    /// True while any ledger call holds the counter guard, including this thread's own call:
    /// `try_lock` refuses a re-entrant attempt, which is exactly the question being asked.
    #[cfg(test)]
    fn counter_guard_is_held(&self) -> bool {
        self.counts.try_lock().is_err()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

    struct FakeObservation {
        account_id: Option<core::AccountId>,
        suspended: AtomicI64,
        suspensions: AtomicU64,
        /// Set only by the serialization test: the ledger whose guard must cover every change.
        ledger: Option<Arc<RetirementLedger>>,
        unguarded_changes: AtomicU64,
    }

    impl FakeObservation {
        fn new(account_id: Option<&str>) -> Arc<Self> {
            Arc::new(Self {
                account_id: account_id.map(core::AccountId::from),
                suspended: AtomicI64::new(0),
                suspensions: AtomicU64::new(0),
                ledger: None,
                unguarded_changes: AtomicU64::new(0),
            })
        }

        fn witnessing(ledger: &Arc<RetirementLedger>, account_id: Option<&str>) -> Arc<Self> {
            Arc::new(Self {
                account_id: account_id.map(core::AccountId::from),
                suspended: AtomicI64::new(0),
                suspensions: AtomicU64::new(0),
                ledger: Some(Arc::clone(ledger)),
                unguarded_changes: AtomicU64::new(0),
            })
        }

        fn suspended(&self) -> i64 {
            self.suspended.load(Ordering::SeqCst)
        }

        fn suspensions(&self) -> u64 {
            self.suspensions.load(Ordering::SeqCst)
        }

        fn is_suspended(&self) -> bool {
            self.suspended() > 0
        }

        fn unguarded_changes(&self) -> u64 {
            self.unguarded_changes.load(Ordering::SeqCst)
        }

        fn note_guard(&self) {
            if let Some(ledger) = &self.ledger {
                if !ledger.counter_guard_is_held() {
                    self.unguarded_changes.fetch_add(1, Ordering::SeqCst);
                }
            }
        }
    }

    impl RetirableObservation for FakeObservation {
        fn retired_account(&self) -> Option<&core::AccountId> {
            self.account_id.as_ref()
        }

        fn begin_retirement(&self) {
            self.note_guard();
            self.suspended.fetch_add(1, Ordering::SeqCst);
            self.suspensions.fetch_add(1, Ordering::SeqCst);
        }

        fn end_retirement(&self) {
            self.note_guard();
            // The real sink panics here instead of going negative. This is the same assertion.
            assert!(
                self.suspended() > 0,
                "an observation was resumed more often than it was suspended"
            );
            self.suspended.fetch_sub(1, Ordering::SeqCst);
        }
    }

    fn account(account_id: &str) -> RetirementScope {
        RetirementScope::Account(core::AccountId::from(account_id))
    }

    #[test]
    fn only_a_retiring_request_names_a_scope() {
        assert_eq!(
            retirement_scope(&core::RuntimeRequest::Lock {
                account_id: core::AccountId::from("account-1"),
            }),
            Some(account("account-1"))
        );
        assert_eq!(
            retirement_scope(&core::RuntimeRequest::SignOut {
                account_id: core::AccountId::from("account-1"),
            }),
            Some(account("account-1"))
        );
        assert_eq!(
            retirement_scope(&core::RuntimeRequest::RemoveAccount {
                account_id: core::AccountId::from("account-1"),
            }),
            Some(account("account-1"))
        );
        assert_eq!(
            retirement_scope(&core::RuntimeRequest::Wipe),
            Some(RetirementScope::Device)
        );
        assert_eq!(
            retirement_scope(&core::RuntimeRequest::QuickUnlock {
                account_id: core::AccountId::from("account-1"),
                master_password: "password".into(),
            }),
            None
        );
    }

    #[test]
    fn a_removal_suspends_only_the_named_account_and_resumes_it() {
        let ledger = RetirementLedger::default();
        let retired = FakeObservation::new(Some("account-1"));
        let other = FakeObservation::new(Some("account-2"));
        let device_wide = FakeObservation::new(None);
        let live = vec![
            Arc::clone(&retired),
            Arc::clone(&other),
            Arc::clone(&device_wide),
        ];

        ledger.begin(&account("account-1"), &live);
        assert!(retired.is_suspended());
        assert!(!other.is_suspended());
        assert!(!device_wide.is_suspended());

        ledger.end(&account("account-1"), &live);
        assert!(!retired.is_suspended());
        assert_eq!(other.suspensions(), 0);
        assert_eq!(device_wide.suspensions(), 0);
    }

    #[test]
    fn a_wipe_suspends_every_observation_including_the_device_wide_one() {
        let ledger = RetirementLedger::default();
        let named = FakeObservation::new(Some("account-1"));
        let device_wide = FakeObservation::new(None);
        let live = vec![Arc::clone(&named), Arc::clone(&device_wide)];

        ledger.begin(&RetirementScope::Device, &live);
        assert!(named.is_suspended());
        assert!(device_wide.is_suspended());

        ledger.end(&RetirementScope::Device, &live);
        assert!(!named.is_suspended());
        assert!(!device_wide.is_suspended());
    }

    #[test]
    fn an_observation_admitted_during_a_removal_is_caught_up_before_it_is_resumed() {
        let ledger = RetirementLedger::default();
        let live = vec![FakeObservation::new(Some("account-1"))];
        ledger.begin(&account("account-1"), &live);

        let late = FakeObservation::new(Some("account-1"));
        ledger.admit(&late);
        assert!(late.is_suspended());

        let mut live = live;
        live.push(Arc::clone(&late));
        // Without the catch-up this resume goes below zero, which panics the real sink.
        ledger.end(&account("account-1"), &live);
        assert!(!late.is_suspended());
    }

    #[test]
    fn an_observation_admitted_during_a_wipe_is_caught_up_whatever_it_names() {
        let ledger = RetirementLedger::default();
        ledger.begin(
            &RetirementScope::Device,
            &Vec::<Arc<FakeObservation>>::new(),
        );

        let named = FakeObservation::new(Some("account-1"));
        let device_wide = FakeObservation::new(None);
        ledger.admit(&named);
        ledger.admit(&device_wide);

        let live = vec![Arc::clone(&named), Arc::clone(&device_wide)];
        ledger.end(&RetirementScope::Device, &live);
        assert!(!named.is_suspended());
        assert!(!device_wide.is_suspended());
    }

    #[test]
    fn overlapping_scopes_stay_suspended_until_the_last_one_finishes() {
        let ledger = RetirementLedger::default();
        let observation = FakeObservation::new(Some("account-1"));
        let live = vec![Arc::clone(&observation)];

        ledger.begin(&RetirementScope::Device, &live);
        ledger.begin(&account("account-1"), &live);
        let late = FakeObservation::new(Some("account-1"));
        ledger.admit(&late);
        assert_eq!(late.suspended(), 2);

        let mut live = live;
        live.push(Arc::clone(&late));
        ledger.end(&RetirementScope::Device, &live);
        assert!(observation.is_suspended());
        assert!(late.is_suspended());

        ledger.end(&account("account-1"), &live);
        assert!(!observation.is_suspended());
        assert!(!late.is_suspended());
    }

    #[test]
    fn a_finished_retirement_leaves_a_later_observation_untouched() {
        let ledger = RetirementLedger::default();
        let live = Vec::<Arc<FakeObservation>>::new();
        ledger.begin(&account("account-1"), &live);
        ledger.end(&account("account-1"), &live);

        let later = FakeObservation::new(Some("account-1"));
        ledger.admit(&later);

        assert_eq!(later.suspensions(), 0);
        assert!(!later.is_suspended());
    }

    /// The invariant the ledger exists to hold: between calls, every observation is suspended
    /// exactly as often as there are active scopes covering it. Suspend, resume, and catch-up
    /// are three ways of restoring the same equality.
    #[test]
    fn suspension_depth_equals_the_covering_active_scopes_after_every_call() {
        let ledger = RetirementLedger::default();
        let named = FakeObservation::new(Some("account-1"));
        let other = FakeObservation::new(Some("account-2"));
        let device_wide = FakeObservation::new(None);
        let mut live = vec![
            Arc::clone(&named),
            Arc::clone(&other),
            Arc::clone(&device_wide),
        ];
        let balanced = |live: &[Arc<FakeObservation>]| {
            for observation in live {
                assert_eq!(
                    u64::try_from(observation.suspended()).expect("never resumed below zero"),
                    ledger.covering_scopes(observation.retired_account()),
                );
            }
        };

        balanced(&live);
        ledger.begin(&RetirementScope::Device, &live);
        balanced(&live);
        ledger.begin(&account("account-1"), &live);
        balanced(&live);

        let late = FakeObservation::new(Some("account-1"));
        ledger.admit(&late);
        live.push(Arc::clone(&late));
        balanced(&live);

        ledger.begin(&account("account-1"), &live);
        balanced(&live);
        ledger.end(&RetirementScope::Device, &live);
        balanced(&live);
        ledger.end(&account("account-1"), &live);
        balanced(&live);
        ledger.end(&account("account-1"), &live);
        balanced(&live);
    }

    /// What makes that invariant local to this type rather than a property of the executor.
    ///
    /// No behavioural test can reach the broken window today: the Web executor is
    /// single-threaded and `observe_json` never awaits, so nothing can run between a counter
    /// update and its iteration. This test asks the structural question instead. Every change of
    /// suspension depth must happen while the counter guard is held, because a reader that sees
    /// the counter without the guard sees a scope that is counted but not applied, or applied
    /// but not counted.
    #[test]
    fn every_suspension_change_happens_under_the_counter_guard() {
        let ledger = Arc::new(RetirementLedger::default());
        let named = FakeObservation::witnessing(&ledger, Some("account-1"));
        let device_wide = FakeObservation::witnessing(&ledger, None);
        let mut live = vec![Arc::clone(&named), Arc::clone(&device_wide)];

        ledger.begin(&RetirementScope::Device, &live);
        ledger.begin(&account("account-1"), &live);

        let late = FakeObservation::witnessing(&ledger, Some("account-1"));
        ledger.admit(&late);
        live.push(Arc::clone(&late));

        ledger.end(&account("account-1"), &live);
        ledger.end(&RetirementScope::Device, &live);

        for observation in &live {
            assert_eq!(
                observation.unguarded_changes(),
                0,
                "a suspension changed while the counter guard was free",
            );
            assert_eq!(observation.suspended(), 0);
        }
    }
}
