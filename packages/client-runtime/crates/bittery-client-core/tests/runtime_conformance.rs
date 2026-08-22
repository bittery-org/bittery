use bittery_client_core::{
    AccountId, CustomFieldKind, GuardedCommitPlan, Incarnation, LoginCustomField, LoginItemDraft,
    ObservationRequest, ObservationSink, PlanMutation, PlanResult, ReplicaItemRecord,
    RequestCancellation, Runtime, RuntimeErrorCode, RuntimeProjection, RuntimeRequest,
};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct RecordingSink {
    values: Mutex<Vec<RuntimeProjection>>,
}

impl ObservationSink for RecordingSink {
    fn publish(&self, projection: RuntimeProjection) {
        self.values.lock().unwrap().push(projection);
    }
}

fn installed_runtime() -> (Arc<Runtime>, AccountId, Incarnation) {
    let runtime = Runtime::new();
    let account_id = AccountId::from("account-1");
    let incarnation = Incarnation::from("incarnation-1");
    runtime
        .install_account(account_id.clone(), "user-1".into(), incarnation.clone())
        .unwrap();
    (runtime, account_id, incarnation)
}

#[test]
fn guarded_plan_is_atomic_and_distinguishes_missing_from_stale() {
    let (runtime, account_id, incarnation) = installed_runtime();
    let replica = runtime.replica();

    let missing = replica
        .execute(GuardedCommitPlan::new(
            AccountId::from("missing"),
            incarnation.clone(),
            0,
            vec![],
        ))
        .unwrap();
    assert_eq!(missing, PlanResult::Missing);

    let stale = replica
        .execute(GuardedCommitPlan::new(
            account_id.clone(),
            incarnation.clone(),
            4,
            vec![],
        ))
        .unwrap();
    assert_eq!(stale, PlanResult::Stale { actual_revision: 0 });

    let invalid = GuardedCommitPlan::new(
        account_id.clone(),
        incarnation,
        0,
        vec![
            PlanMutation::PutOptimisticItem(ReplicaItemRecord::fixture(
                account_id.clone(),
                "item-1",
                "vault-1",
            )),
            PlanMutation::RemoveOperation {
                operation_id: "never-accepted".into(),
            },
        ],
    );
    assert!(replica.execute(invalid).is_err());
    let snapshot = replica.snapshot(&account_id).unwrap();
    assert_eq!(snapshot.revision, 0);
    assert!(snapshot.items.is_empty());
}

#[tokio::test]
async fn observations_are_full_monotonic_and_suppress_callbacks_after_close() {
    let (runtime, account_id, _incarnation) = installed_runtime();
    let sink = Arc::new(RecordingSink::default());
    let handle = runtime
        .observe(
            ObservationRequest::Items {
                account_id: account_id.clone(),
            },
            sink.clone(),
        )
        .unwrap();

    runtime
        .request(
            RuntimeRequest::fixture_create(account_id),
            RequestCancellation::new(),
        )
        .await
        .unwrap();

    handle.close();
    handle.close();
    runtime.publish_all();

    let values = sink.values.lock().unwrap();
    assert_eq!(values.len(), 2);
    assert_eq!(values[0].revision(), 0);
    assert_eq!(values[1].revision(), 1);
    assert_eq!(values[1].item_count(), 1);
}

#[tokio::test]
async fn plaintext_is_redacted_and_never_enters_replica_records() {
    let (runtime, account_id, _incarnation) = installed_runtime();
    let request = RuntimeRequest::fixture_create(account_id.clone());
    let debug = format!("{request:?}");
    assert!(!debug.contains("correct horse"));
    assert!(!debug.contains("person@example"));
    let sign_in = RuntimeRequest::SignIn {
        server_url: "https://server.test".into(),
        email: "person@example.test".into(),
        master_password: "UNIQUE_MASTER_PASSWORD".into(),
        secret_key: "UNIQUE_SECRET_KEY".into(),
    };
    let sign_in_debug = format!("{sign_in:?}");
    assert!(!sign_in_debug.contains("UNIQUE_MASTER_PASSWORD"));
    assert!(!sign_in_debug.contains("UNIQUE_SECRET_KEY"));

    runtime
        .request(request, RequestCancellation::new())
        .await
        .unwrap();
    let serialized =
        serde_json::to_string(&runtime.replica().snapshot(&account_id).unwrap().items).unwrap();
    assert!(!serialized.contains("correct horse"));
    assert!(!serialized.contains("person@example"));

    let sink = Arc::new(RecordingSink::default());
    let _handle = runtime
        .observe(ObservationRequest::Items { account_id }, sink.clone())
        .unwrap();
    let projection_debug = format!("{:?}", sink.values.lock().unwrap().last().unwrap());
    assert!(!projection_debug.contains("correct horse"));
    assert!(!projection_debug.contains("person@example"));
}

#[tokio::test]
async fn accepted_work_survives_caller_cancellation_and_accounts_fail_in_isolation() {
    let (runtime, account_id, _incarnation) = installed_runtime();
    runtime
        .install_account(
            AccountId::from("account-2"),
            "user-2".into(),
            Incarnation::from("incarnation-2"),
        )
        .unwrap();
    let cancellation = RequestCancellation::new();

    let result = runtime
        .request_with_acceptance_hook(
            RuntimeRequest::fixture_create(account_id.clone()),
            cancellation.clone(),
            || cancellation.cancel(),
        )
        .await;
    assert!(result.is_ok());
    assert_eq!(
        runtime
            .replica()
            .snapshot(&account_id)
            .unwrap()
            .operations
            .len(),
        1
    );

    runtime
        .fail_account(&account_id, RuntimeErrorCode::InvariantViolation)
        .unwrap();
    assert!(runtime
        .request(
            RuntimeRequest::fixture_create(account_id),
            RequestCancellation::new()
        )
        .await
        .is_err());
    assert!(runtime
        .request(
            RuntimeRequest::fixture_create(AccountId::from("account-2")),
            RequestCancellation::new(),
        )
        .await
        .is_ok());
}

#[test]
fn account_scope_is_explicit_in_every_post_sign_in_request_and_observation() {
    let request = RuntimeRequest::fixture_create(AccountId::from("account-1"));
    assert_eq!(request.account_id().unwrap().as_str(), "account-1");
    let observation = ObservationRequest::RuntimeStatus {
        account_id: Some(AccountId::from("account-2")),
    };
    assert_eq!(observation.account_id().unwrap().as_str(), "account-2");
}

#[test]
fn login_draft_is_the_existing_decrypted_item_subset_without_empty_sentinels() {
    let draft: LoginItemDraft = serde_json::from_value(serde_json::json!({
        "title": "Example",
        "customFields": [{
            "id": "field-1",
            "label": "PIN",
            "value": "1234",
            "type": "password"
        }]
    }))
    .unwrap();
    assert_eq!(draft.url, None);
    assert_eq!(draft.username, None);
    assert_eq!(draft.password, None);
    assert_eq!(draft.custom_fields[0].field_type, CustomFieldKind::Password);

    let wire = serde_json::to_value(draft).unwrap();
    assert!(wire.get("url").is_none());
    assert!(wire.get("username").is_none());
    assert_eq!(wire["customFields"][0]["type"], "password");
}

#[test]
fn runtime_wire_protocol_uses_camel_case_for_tagged_variant_fields() {
    let mut request = RuntimeRequest::fixture_create(AccountId::from("account-1"));
    let RuntimeRequest::CreateLoginItem { draft, .. } = &mut request else {
        unreachable!("fixture is a CreateLoginItem request");
    };
    draft.custom_fields.push(LoginCustomField {
        id: "field-1".into(),
        label: "PIN".into(),
        value: "1234".into(),
        field_type: CustomFieldKind::Password,
    });
    let wire = serde_json::to_value(request).unwrap();
    assert_eq!(wire["type"], "createLoginItem");
    assert_eq!(wire["accountId"], "account-1");
    assert_eq!(wire["vaultId"], "vault-1");
    assert_eq!(wire["draft"]["customFields"][0]["type"], "password");
    assert!(wire.get("account_id").is_none());

    let observation = serde_json::to_value(ObservationRequest::RuntimeStatus {
        account_id: Some(AccountId::from("account-2")),
    })
    .unwrap();
    assert_eq!(
        observation,
        serde_json::json!({
            "type": "runtimeStatus",
            "accountId": "account-2"
        })
    );
}
