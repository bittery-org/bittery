//! The table an external host's observation ids index into.
//!
//! An observation id belongs to the caller, and a repeat is a host defect rather than a
//! request to replace. Replacing would close the first consumer's handle while its id stays
//! live, so the second consumer's `unobserve` then cancels an observation it never opened
//! and both go silent. This table refuses instead, which turns that silent corruption into
//! an error the host sees at the call that caused it.

use std::{collections::HashMap, fmt, sync::Arc, sync::Mutex};

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct DuplicateObservation {
    pub observation_id: String,
}

impl fmt::Display for DuplicateObservation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "observation {} is already open",
            self.observation_id
        )
    }
}

pub(crate) struct ObservationSlots<T> {
    entries: Mutex<HashMap<String, Arc<T>>>,
}

impl<T> ObservationSlots<T> {
    pub(crate) fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Claims an unused id, or reports the collision without disturbing the live entry.
    pub(crate) fn insert_new(
        &self,
        observation_id: String,
        observation: Arc<T>,
    ) -> Result<(), DuplicateObservation> {
        let mut entries = self.lock();
        if entries.contains_key(&observation_id) {
            return Err(DuplicateObservation { observation_id });
        }
        entries.insert(observation_id, observation);
        Ok(())
    }

    pub(crate) fn get(&self, observation_id: &str) -> Option<Arc<T>> {
        self.lock().get(observation_id).cloned()
    }

    pub(crate) fn remove(&self, observation_id: &str) -> Option<Arc<T>> {
        self.lock().remove(observation_id)
    }

    pub(crate) fn ids(&self) -> Vec<String> {
        self.lock().keys().cloned().collect()
    }

    pub(crate) fn drain(&self) -> Vec<Arc<T>> {
        self.lock().drain().map(|(_, entry)| entry).collect()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<T>>> {
        self.entries.lock().expect("observation slot lock poisoned")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_an_unused_id() {
        let slots = ObservationSlots::new();
        assert_eq!(slots.insert_new("a".into(), Arc::new(1)), Ok(()));
        assert_eq!(slots.get("a").as_deref(), Some(&1));
    }

    #[test]
    fn refuses_a_duplicate_and_keeps_the_live_entry() {
        let slots = ObservationSlots::new();
        slots.insert_new("a".into(), Arc::new(1)).expect("first");

        let error = slots
            .insert_new("a".into(), Arc::new(2))
            .expect_err("a duplicate id must not be accepted");

        assert_eq!(
            error,
            DuplicateObservation {
                observation_id: "a".into()
            }
        );
        assert_eq!(error.to_string(), "observation a is already open");
        assert_eq!(slots.get("a").as_deref(), Some(&1));
    }

    #[test]
    fn frees_the_id_once_removed() {
        let slots = ObservationSlots::new();
        slots.insert_new("a".into(), Arc::new(1)).expect("first");
        assert_eq!(slots.remove("a").as_deref(), Some(&1));
        assert_eq!(slots.remove("a"), None);
        slots
            .insert_new("a".into(), Arc::new(2))
            .expect("the id is free again");
        assert_eq!(slots.get("a").as_deref(), Some(&2));
    }

    #[test]
    fn drains_every_entry_once() {
        let slots = ObservationSlots::new();
        slots.insert_new("a".into(), Arc::new(1)).expect("first");
        slots.insert_new("b".into(), Arc::new(2)).expect("second");

        let mut drained: Vec<i32> = slots.drain().iter().map(|entry| **entry).collect();
        drained.sort_unstable();

        assert_eq!(drained, vec![1, 2]);
        assert!(slots.ids().is_empty());
    }
}
