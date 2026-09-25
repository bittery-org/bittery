use super::*;

impl Replica {
    pub(crate) async fn delete_profile_admission_snapshot(
        &self,
        expected: &ReplicaSnapshot,
    ) -> Result<(), RuntimeError> {
        use persistence_contract::ReplicaAccountDeletionResult;
        let head = ReplicaHead {
            account_id: expected.account_id.clone(),
            user_id: expected.user_id.clone(),
            incarnation: expected.incarnation.clone(),
            replica_revision: expected.revision,
            lock_epoch: expected.lock_epoch,
            failure: expected.failure,
        };
        let rows = snapshot_rows(expected.clone())?;
        if reconstruct_snapshot(&expected.account_id, Some(head.clone()), rows.clone())?.as_ref()
            != Some(expected)
        {
            return Err(replica_invariant(
                "Abort Replica expected snapshot is invalid",
            ));
        }
        let issued = self
            .persistence
            .invoke(ReplicaPersistenceRequest::DeleteAccountIfUnchanged {
                account_id: expected.account_id.clone(),
                expected_head: head,
                expected_rows: rows,
            })
            .await;
        if matches!(
            issued,
            Ok(ReplicaPersistenceResponse::AccountDeletion {
                result: ReplicaAccountDeletionResult::Conflict {}
            })
        ) {
            return Err(replica_invariant(
                "Admission Replica changed before Abort deletion",
            ));
        }
        if matches!(issued, Ok(ref response) if !matches!(response, ReplicaPersistenceResponse::AccountDeletion { .. }))
        {
            return Err(replica_invariant(
                "Admission Replica deletion returned another response",
            ));
        }
        if self.load_uncached(&expected.account_id).await?.is_some() {
            return Err(issued.err().unwrap_or_else(|| {
                replica_invariant("Admission Replica deletion did not establish absence")
            }));
        }
        self.snapshots
            .lock()
            .expect("Replica cache lock poisoned")
            .remove(&expected.account_id);
        Ok(())
    }
    pub(crate) async fn stage_profile_admission_snapshot(
        &self,
        expected: &ReplicaSnapshot,
    ) -> Result<ReplicaSnapshot, RuntimeError> {
        if expected.account_id.as_str().is_empty()
            || expected.user_id.is_empty()
            || expected.incarnation.as_str().is_empty()
            || expected.revision != 0
            || expected.lock_epoch != 0
            || expected.failure.is_some()
        {
            return Err(replica_invariant(
                "Profile admission requires a new locked Replica generation",
            ));
        }
        let mut prepared = prepare_install(
            None,
            expected.account_id.clone(),
            expected.user_id.clone(),
            expected.incarnation.clone(),
        )?;
        let rows = snapshot_rows(expected.clone())?;
        if reconstruct_snapshot(
            &expected.account_id,
            Some(prepared.next_head.clone()),
            rows.clone(),
        )?
        .as_ref()
            != Some(expected)
        {
            return Err(replica_invariant(
                "Profile admission Replica plan is inconsistent",
            ));
        }
        if let Some(current) = self.load_uncached(&expected.account_id).await? {
            return if &current == expected {
                Ok(current)
            } else {
                Err(replica_invariant(
                    "Profile admission found a conflicting Replica generation",
                ))
            };
        }
        prepared.writes = rows
            .into_iter()
            .map(|row| persistence_contract::PreparedReplicaWrite::Put { row })
            .collect();
        // The existing guarded primitive expects absence. Never switch to replacement after a
        // stale result, and never publish staged rows into the normal Account cache.
        let issued = self
            .persistence
            .invoke(ReplicaPersistenceRequest::Install { prepared })
            .await;
        let actual = self.load_uncached(&expected.account_id).await?;
        if let Some(actual) = actual.filter(|actual| actual == expected) {
            return Ok(actual);
        }
        match issued {
            Err(error) => Err(error),
            Ok(_) => Err(replica_invariant(
                "Profile admission Replica write did not establish its exact plan",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn expected(incarnation: &str) -> ReplicaSnapshot {
        let install = prepare_install(
            None,
            "legacy-account".into(),
            "legacy-user".into(),
            incarnation.into(),
        )
        .unwrap();
        reconstruct_snapshot(
            &install.next_head.account_id.clone(),
            Some(install.next_head),
            vec![],
        )
        .unwrap()
        .unwrap()
    }

    #[tokio::test]
    async fn admission_never_replaces_an_unexpected_destination_incarnation() {
        let persistence = Arc::new(InMemoryReplica::default());
        persistence
            .install(
                "legacy-account".into(),
                "legacy-user".into(),
                "foreign-incarnation".into(),
            )
            .unwrap();
        let replica = Replica::new(persistence);
        let before = replica
            .load_uncached(&"legacy-account".into())
            .await
            .unwrap();
        let result = replica
            .stage_profile_admission_snapshot(&expected("reserved-incarnation"))
            .await;
        assert_eq!(
            replica
                .load_uncached(&"legacy-account".into())
                .await
                .unwrap(),
            before
        );
        assert!(result.is_err());
        assert!(replica.snapshots.lock().unwrap().is_empty());
    }

    struct LostReply {
        inner: InMemoryReplica,
        installs: AtomicUsize,
    }
    #[async_trait]
    impl ReplicaPersistence for LostReply {
        async fn invoke(
            &self,
            request: ReplicaPersistenceRequest,
        ) -> Result<ReplicaPersistenceResponse, RuntimeError> {
            let is_install = matches!(&request, ReplicaPersistenceRequest::Install { .. });
            let response = self.inner.invoke(request).await?;
            if is_install && self.installs.fetch_add(1, Ordering::SeqCst) == 0 {
                Err(replica_invariant("issued admission write lost its reply"))
            } else {
                Ok(response)
            }
        }
    }

    #[tokio::test]
    async fn admission_reconciles_a_lost_install_reply_without_rewriting_or_publishing() {
        let persistence = Arc::new(LostReply {
            inner: InMemoryReplica::default(),
            installs: AtomicUsize::new(0),
        });
        let replica = Replica::new(persistence.clone());
        let expected = expected("fixed-generation");
        for _ in 0..2 {
            assert_eq!(
                replica
                    .stage_profile_admission_snapshot(&expected)
                    .await
                    .unwrap(),
                expected
            );
        }
        assert_eq!(persistence.installs.load(Ordering::SeqCst), 1);
        assert!(replica.snapshots.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn admission_replay_requires_complete_matching_replica_evidence() {
        let persistence = Arc::new(InMemoryReplica::default());
        let replica = Replica::new(persistence.clone());
        let expected = expected("fixed-generation");
        replica
            .stage_profile_admission_snapshot(&expected)
            .await
            .unwrap();
        let mut altered = expected.clone();
        altered.bootstrap.policy_verification_pending = true;
        assert!(replica
            .stage_profile_admission_snapshot(&altered)
            .await
            .is_err());
        assert_eq!(
            replica.load_uncached(&expected.account_id).await.unwrap(),
            Some(expected)
        );
        assert!(replica.snapshots.lock().unwrap().is_empty());
    }
}
