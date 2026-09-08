use crate::test_support::{
    assign_user_to_team, authenticated_json_headers, seed_team, seed_user, with_api_test_app,
};
use axum::http::{HeaderValue, Method};
use serde_json::json;

#[tokio::test]
async fn rotation_empty_voluntary_creation_retains_semantic_outcome() {
    with_api_test_app("rotation_empty_retained", |app| async move {
        seed_user(&app.pool, "rotation-owner", "Owner", "rotation-owner@test.invalid").await;
        seed_user(&app.pool, "rotation-member", "Member", "rotation-member@test.invalid").await;
        seed_team(&app.pool, "rotation-team", "Team", "rotation-owner", "organization", "team", "active").await;
        assign_user_to_team(&app.pool, "rotation-owner", "rotation-team", "owner").await;
        assign_user_to_team(&app.pool, "rotation-member", "rotation-team", "member").await;
        let session = app.issue_session("rotation-member").await;
        let mut headers = authenticated_json_headers(&session.token);
        headers.insert("idempotency-key", HeaderValue::from_static("rotation-empty-create"));
        let response = app.api_json(Method::POST, "/api/v1/teams/rotation-team/leave-rotation-plans", None, headers.clone()).await;
        assert_eq!(response.status, 200);
        assert_eq!(response.body, json!({"kind":"create_team_leave_rotation_plans", "operationId":"rotation-empty-create", "result":{"status":"applied","plans":[]}}));
        let replay = app.api_json(Method::POST, "/api/v1/teams/rotation-team/leave-rotation-plans", None, headers).await;
        assert_eq!(replay.body, response.body);
        let lookup = app.api_json(Method::GET, "/api/v1/operations/rotation-empty-create", None, authenticated_json_headers(&session.token)).await;
        assert_eq!(lookup.body, response.body);
    }).await;
}

use crate::{
    config::DeploymentMode,
    db::enums::VaultKeyRotationManifestKind,
    domains::{
        operations::{
            self,
            rotation::{RotationEffect, RotationOperationInput},
            OperationResolution,
        },
        vaults::rotation::plans::{self, StagedOutput},
    },
    test_support::{seed_vault, seed_vault_key, ApiTestApp},
};
use axum::http::HeaderMap;
use serde_json::Value;
use sqlx::{query, query_as, query_scalar, PgPool};

#[derive(Clone, Copy, Debug)]
enum Ceremony {
    Vault,
    Leave,
    Remove,
}
impl Ceremony {
    fn actor(self) -> &'static str {
        if matches!(self, Self::Leave) {
            "rotation-member"
        } else {
            "rotation-owner"
        }
    }
    fn path(self) -> &'static str {
        match self {
            Self::Vault => {
                "/api/v1/vaults/rotation-vault-a/members/rotation-member/removal-rotation-plans"
            }
            Self::Leave => "/api/v1/teams/rotation-team/leave-rotation-plans",
            Self::Remove => {
                "/api/v1/teams/rotation-team/members/rotation-member/removal-rotation-plans"
            }
        }
    }
    fn kind(self, finalize: bool) -> String {
        format!(
            "{}_{}_rotation_plans",
            if finalize { "finalize" } else { "create" },
            match self {
                Self::Vault => "vault_member_removal",
                Self::Leave => "team_leave",
                Self::Remove => "team_member_removal",
            }
        )
    }
    fn effect(self, finalize: bool, ids: &[String]) -> RotationEffect {
        match (self, finalize) {
            (Self::Vault, false) => RotationEffect::CreateVaultRemoval {
                vault_id: "rotation-vault-a".into(),
                target_id: "rotation-member".into(),
            },
            (Self::Vault, true) => RotationEffect::FinalizeVaultRemoval {
                vault_id: "rotation-vault-a".into(),
                target_id: "rotation-member".into(),
                plan_id: ids[0].clone(),
            },
            (Self::Leave, false) => RotationEffect::CreateTeamLeave {
                team_id: "rotation-team".into(),
            },
            (Self::Leave, true) => RotationEffect::FinalizeTeamLeave {
                team_id: "rotation-team".into(),
                plan_ids: ids.to_vec(),
            },
            (Self::Remove, false) => RotationEffect::CreateTeamRemoval {
                team_id: "rotation-team".into(),
                target_id: "rotation-member".into(),
            },
            (Self::Remove, true) => RotationEffect::FinalizeTeamRemoval {
                team_id: "rotation-team".into(),
                target_id: "rotation-member".into(),
                plan_ids: ids.to_vec(),
            },
        }
    }
}
fn headers(token: &str, id: &str) -> HeaderMap {
    let mut headers = authenticated_json_headers(token);
    headers.insert("idempotency-key", HeaderValue::from_str(id).unwrap());
    headers
}
async fn seed(pool: &PgPool) {
    for (id, name) in [
        ("rotation-owner", "Owner"),
        ("rotation-member", "Member"),
        ("rotation-outsider", "Outsider"),
    ] {
        seed_user(pool, id, name, &format!("{id}@test.invalid")).await;
    }
    seed_team(
        pool,
        "rotation-team",
        "Team",
        "rotation-owner",
        "organization",
        "team",
        "active",
    )
    .await;
    assign_user_to_team(pool, "rotation-owner", "rotation-team", "owner").await;
    assign_user_to_team(pool, "rotation-member", "rotation-team", "member").await;
    for suffix in ["a", "b"] {
        let vault = format!("rotation-vault-{suffix}");
        seed_vault(
            pool,
            &vault,
            "Vault",
            "team",
            "rotation-owner",
            Some("rotation-team"),
        )
        .await;
        for (user, role) in [("rotation-owner", "owner"), ("rotation-member", "member")] {
            seed_vault_key(
                pool,
                &format!("{user}-{suffix}"),
                &vault,
                user,
                "wrapped-key",
                role,
            )
            .await;
        }
    }
}
async fn prepare(app: &ApiTestApp, ceremony: Ceremony, stage: bool) -> Vec<String> {
    let session = app.issue_session(ceremony.actor()).await;
    let response = app
        .api_json(
            Method::POST,
            ceremony.path(),
            None,
            headers(&session.token, "prepare-operation"),
        )
        .await;
    assert_eq!(response.status, 200, "{}", response.body);
    let ids: Vec<String> = response.body["result"]["plans"]
        .as_array()
        .unwrap()
        .iter()
        .map(|plan| plan["id"].as_str().unwrap().into())
        .collect();
    if stage {
        stage_plans(&app.pool, ceremony.actor(), &ids).await;
    }
    ids
}
async fn stage_plans(pool: &PgPool, actor: &str, ids: &[String]) {
    for id in ids {
        let page = plans::read_preparation_page(
            pool,
            id,
            actor,
            VaultKeyRotationManifestKind::Member,
            None,
            100,
        )
        .await
        .unwrap();
        let outputs = page
            .records
            .into_iter()
            .map(|record| StagedOutput {
                id: record.id,
                payload: r#"{"encryptedVaultKey":"rotated-wrapped-key"}"#.into(),
            })
            .collect::<Vec<_>>();
        plans::stage_outputs(
            pool,
            id,
            actor,
            VaultKeyRotationManifestKind::Member,
            &outputs,
        )
        .await
        .unwrap();
    }
}
fn value(resolution: OperationResolution) -> (Value, bool) {
    match resolution {
        OperationResolution::Outcome {
            outcome,
            newly_committed,
        } => (serde_json::to_value(outcome).unwrap(), newly_committed),
        OperationResolution::IdReused => panic!("identical request changed identity"),
    }
}

/// HTTP reaches every kind, and authenticated concurrent executor calls pin exactly-once behavior
/// even when voluntary finalization revokes both already-authenticated callers' Sessions.
#[tokio::test]
async fn rotation_six_kinds_replay_concurrently_and_recover_under_renewed_sessions() {
    for ceremony in [Ceremony::Vault, Ceremony::Leave, Ceremony::Remove] {
        for finalize in [false, true] {
            with_api_test_app(&format!("rotation_replay_{ceremony:?}_{finalize}"), |app| async move {
                seed(&app.pool).await;
                let ids = if finalize {prepare(&app,ceremony,true).await} else {Vec::new()};
                let body = finalize.then(||json!({"planIds":ids}));
                let raw = body.as_ref().map(|body|serde_json::to_vec(body).unwrap()).unwrap_or_default();
                let make_input = || RotationOperationInput {operation_id:"rotation-replay".into(),user_id:ceremony.actor().into(),effect:ceremony.effect(finalize,&ids),raw_body:raw.clone(),deployment_mode:DeploymentMode::Cloud};
                let (first,second) = tokio::join!(operations::rotation::execute(&app.pool,None,make_input()),operations::rotation::execute(&app.pool,None,make_input()));
                let (answer,new_first) = value(first.unwrap());
                let (same,new_second) = value(second.unwrap());
                assert_eq!(answer,same);
                assert_ne!(new_first,new_second);
                assert_eq!(answer["kind"],ceremony.kind(finalize));
                assert_eq!(answer["result"]["status"],"applied");
                assert_eq!(answer["result"].get("personalTeamId").is_some(),finalize && !matches!(ceremony,Ceremony::Vault));
                // A fresh Session is mandatory after voluntary finalization and valid for every kind.
                let renewed = app.issue_session(ceremony.actor()).await;
                let path = format!("{}{}",ceremony.path(),if finalize {"/finalize"} else {""});
                let replay = app.api_json(Method::POST,&path,body.clone(),headers(&renewed.token,"rotation-replay")).await;
                assert_eq!(replay.status,200,"{}",replay.body);
                assert_eq!(replay.body,answer);
                assert!(!replay.headers.contains_key("idempotency-replayed"));
                let lookup = app.api_json(Method::GET,"/api/v1/operations/rotation-replay",None,authenticated_json_headers(&renewed.token)).await;
                assert_eq!(lookup.body,answer);
                let outsider = app.issue_session("rotation-outsider").await;
                let hidden = app.api_json(Method::GET,"/api/v1/operations/rotation-replay",None,authenticated_json_headers(&outsider.token)).await;
                assert_eq!(hidden.status,404);
                let rejected = app.api_json(Method::POST,&path,body.clone(),headers(&outsider.token,"rotation-replay")).await;
                assert_eq!(rejected.status,200,"{}",rejected.body);
                assert_eq!(rejected.body["result"]["status"],"rejected");
                let mut changed = make_input(); changed.raw_body.push(b' ');
                assert!(matches!(operations::rotation::execute(&app.pool,None,changed).await.unwrap(),OperationResolution::IdReused));
                let retained: i64 = query_scalar("SELECT COUNT(*) FROM operation_outcome WHERE user_id=$1 AND operation_id='rotation-replay'").bind(ceremony.actor()).fetch_one(&app.pool).await.unwrap();
                assert_eq!(retained,1);
                let events:i64=query_scalar("SELECT COUNT(*) FROM sync_event WHERE user_id=$1 AND entity_id='rotation-replay' AND event_type='operation_resolved'").bind(ceremony.actor()).fetch_one(&app.pool).await.unwrap();
                assert_eq!(events,1);
                if !finalize {
                    query("DELETE FROM vault_key_rotation_plan").execute(&app.pool).await.unwrap();
                    let replay = app.api_json(Method::POST,&path,None,headers(&renewed.token,"rotation-replay")).await;
                    assert_eq!(replay.body,answer,"creation snapshot survives physical plan cleanup");
                }
            }).await;
        }
    }
}

#[tokio::test]
async fn rotation_six_kinds_retain_policy_rejections_and_require_a_new_identity_after_policy_changes(
) {
    for ceremony in [Ceremony::Vault, Ceremony::Leave, Ceremony::Remove] {
        for finalize in [false, true] {
            with_api_test_app(
                &format!("rotation_rejection_{ceremony:?}_{finalize}"),
                |app| async move {
                    seed(&app.pool).await;
                    let ids = if finalize {
                        prepare(&app, ceremony, true).await
                    } else {
                        Vec::new()
                    };
                    let expected = if matches!(ceremony, Ceremony::Vault) {
                        query("UPDATE vault_key SET role='owner' WHERE user_id='rotation-member'")
                            .execute(&app.pool)
                            .await
                            .unwrap();
                        "vault_owner_protected"
                    } else {
                        query("UPDATE \"user\" SET role='owner' WHERE id='rotation-member'")
                            .execute(&app.pool)
                            .await
                            .unwrap();
                        if matches!(ceremony, Ceremony::Leave) {
                            "team_owner_leave_forbidden"
                        } else {
                            "team_owner_protected"
                        }
                    };
                    let body = finalize.then(|| json!({"planIds":ids}));
                    let raw = body
                        .as_ref()
                        .map(|body| serde_json::to_vec(body).unwrap())
                        .unwrap_or_default();
                    let make_input = || RotationOperationInput {
                        operation_id: "rotation-rejection".into(),
                        user_id: ceremony.actor().into(),
                        effect: ceremony.effect(finalize, &ids),
                        raw_body: raw.clone(),
                        deployment_mode: DeploymentMode::Cloud,
                    };
                    let (first, second) = tokio::join!(
                        operations::rotation::execute(&app.pool, None, make_input()),
                        operations::rotation::execute(&app.pool, None, make_input())
                    );
                    let (answer, new_first) = value(first.unwrap());
                    let (same, new_second) = value(second.unwrap());
                    assert_eq!(answer, same);
                    assert_ne!(new_first, new_second);
                    assert_eq!(
                        answer["result"],
                        json!({"status":"rejected","code":expected})
                    );
                    query("UPDATE vault_key SET role='member' WHERE user_id='rotation-member'")
                        .execute(&app.pool)
                        .await
                        .unwrap();
                    query("UPDATE \"user\" SET role='member' WHERE id='rotation-member'")
                        .execute(&app.pool)
                        .await
                        .unwrap();
                    let renewed = app.issue_session(ceremony.actor()).await;
                    let path = format!(
                        "{}{}",
                        ceremony.path(),
                        if finalize { "/finalize" } else { "" }
                    );
                    let replay = app
                        .api_json(
                            Method::POST,
                            &path,
                            body,
                            headers(&renewed.token, "rotation-rejection"),
                        )
                        .await;
                    assert_eq!(replay.status, 200);
                    assert_eq!(replay.body, answer);
                    let lookup = app
                        .api_json(
                            Method::GET,
                            "/api/v1/operations/rotation-rejection",
                            None,
                            authenticated_json_headers(&renewed.token),
                        )
                        .await;
                    assert_eq!(lookup.body, answer);
                    let mut changed = make_input();
                    changed.raw_body.push(b' ');
                    assert!(matches!(
                        operations::rotation::execute(&app.pool, None, changed)
                            .await
                            .unwrap(),
                        OperationResolution::IdReused
                    ));
                    let mut replacement = make_input();
                    replacement.operation_id = "replacement-operation".into();
                    assert_eq!(
                        value(
                            operations::rotation::execute(&app.pool, None, replacement)
                                .await
                                .unwrap()
                        )
                        .0["result"]["status"],
                        "applied"
                    );
                },
            )
            .await;
        }
    }
}

#[tokio::test]
async fn rotation_malformed_and_unauthenticated_requests_never_retain_an_outcome() {
    with_api_test_app("rotation_pre_domain_rejection", |app| async move {
        seed(&app.pool).await;
        let session = app.issue_session("rotation-owner").await;
        for ceremony in [Ceremony::Vault, Ceremony::Leave, Ceremony::Remove] {
            for finalize in [false, true] {
                let path = format!(
                    "{}{}",
                    ceremony.path(),
                    if finalize { "/finalize" } else { "" }
                );
                let body = finalize.then(|| json!({"planIds":[uuid::Uuid::new_v4().to_string()]}));
                let missing = app
                    .api_json(
                        Method::POST,
                        &path,
                        body.clone(),
                        authenticated_json_headers(&session.token),
                    )
                    .await;
                assert_eq!(missing.status, 400);
                let invalid = app
                    .api_json(
                        Method::POST,
                        &path,
                        body.clone(),
                        headers(&session.token, "has spaces"),
                    )
                    .await;
                assert_eq!(invalid.status, 400);
                let unauth = app
                    .api_json(
                        Method::POST,
                        &path,
                        body,
                        headers("unknown-session", "unauth-rotation"),
                    )
                    .await;
                assert_eq!(unauth.status, 401);
                let unknown = app
                    .api_json(
                        Method::POST,
                        &path,
                        Some(json!({"planIds":[],"unknown":true})),
                        headers(&session.token, "unknown-fields"),
                    )
                    .await;
                assert_eq!(unknown.status, if finalize { 422 } else { 400 });
                let oversized = app
                    .api_bytes(
                        Method::POST,
                        &path,
                        vec![b'x'; super::ORDINARY_API_BODY_LIMIT_BYTES + 1],
                        headers(&session.token, "oversized-operation"),
                    )
                    .await;
                assert_eq!(oversized.status, 413);
                assert_eq!(oversized.body["code"], "PAYLOAD_TOO_LARGE");
                if finalize {
                    let broken_json = app
                        .api_bytes(
                            Method::POST,
                            &path,
                            b"{".to_vec(),
                            headers(&session.token, "broken-json"),
                        )
                        .await;
                    assert_eq!(broken_json.status, 400);
                    if matches!(ceremony, Ceremony::Vault) {
                        let empty = app
                            .api_json(
                                Method::POST,
                                &path,
                                Some(json!({"planIds":[]})),
                                headers(&session.token, "empty-vault-plan-set"),
                            )
                            .await;
                        assert_eq!(empty.status, 400);
                    }
                    for invalid_ids in [
                        json!(["not-a-plan-id"]),
                        json!([
                            "00000000-0000-0000-0000-000000000001",
                            "00000000-0000-0000-0000-000000000001"
                        ]),
                    ] {
                        let invalid = app
                            .api_json(
                                Method::POST,
                                &path,
                                Some(json!({"planIds":invalid_ids})),
                                headers(&session.token, "malformed-plans"),
                            )
                            .await;
                        assert_eq!(invalid.status, 400);
                    }
                    let mut wrong_media = headers(&session.token, "wrong-media");
                    wrong_media.insert("content-type", HeaderValue::from_static("text/plain"));
                    let response = app
                        .api_json(
                            Method::POST,
                            &path,
                            Some(json!({"planIds":[]})),
                            wrong_media,
                        )
                        .await;
                    assert_eq!(response.status, 415);
                }
            }
        }
        let count: i64 = query_scalar("SELECT COUNT(*) FROM operation_outcome")
            .fetch_one(&app.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
        let count: i64 = query_scalar("SELECT COUNT(*) FROM vault_key_rotation_plan")
            .fetch_one(&app.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
        let missing_cache: Option<String> =
            query_scalar("SELECT to_regclass('public.idempotency_record')::text")
                .fetch_one(&app.pool)
                .await
                .unwrap();
        assert_eq!(missing_cache, None);
        let deletion: Option<String> =
            query_scalar("SELECT to_regclass('public.account_deletion_outcome')::text")
                .fetch_one(&app.pool)
                .await
                .unwrap();
        assert_eq!(deletion.as_deref(), Some("account_deletion_outcome"));
    })
    .await;
}

#[tokio::test]
async fn rotation_incomplete_is_terminal_and_voluntary_administrative_identities_cannot_replay() {
    with_api_test_app("rotation_intent_and_incomplete", |app| async move {
        seed(&app.pool).await;
        let ids = prepare(&app, Ceremony::Leave, false).await;
        let member = app.issue_session("rotation-member").await;
        let path = format!("{}/finalize", Ceremony::Leave.path());
        let body = Some(json!({"planIds":ids}));
        let incomplete = app
            .api_json(
                Method::POST,
                &path,
                body.clone(),
                headers(&member.token, "incomplete-operation"),
            )
            .await;
        assert_eq!(
            incomplete.body["result"],
            json!({"status":"rejected","code":"rotation_plan_incomplete"})
        );
        stage_plans(&app.pool, "rotation-member", &ids).await;
        let replay = app
            .api_json(
                Method::POST,
                &path,
                body.clone(),
                headers(&member.token, "incomplete-operation"),
            )
            .await;
        assert_eq!(replay.body, incomplete.body);
        let administrative = app
            .api_json(
                Method::POST,
                &format!("{}/finalize", Ceremony::Remove.path()),
                body.clone(),
                headers(&member.token, "incomplete-operation"),
            )
            .await;
        assert_eq!(administrative.status, 409);
        assert_eq!(administrative.body["code"], "OPERATION_ID_REUSED");
        let owner = app.issue_session("rotation-owner").await;
        // A foreign actor cannot learn whether these plans bind to voluntary departure.
        let foreign = app
            .api_json(
                Method::POST,
                &format!("{}/finalize", Ceremony::Remove.path()),
                body.clone(),
                headers(&owner.token, "foreign-plans"),
            )
            .await;
        assert_eq!(foreign.body["result"]["code"], "rotation_plan_unavailable");
        let replacement = app
            .api_json(
                Method::POST,
                &path,
                body,
                headers(&member.token, "replacement-finalization"),
            )
            .await;
        assert_eq!(replacement.body["result"]["status"], "applied");
        let old_session = app
            .api_json(
                Method::GET,
                "/api/v1/operations/replacement-finalization",
                None,
                authenticated_json_headers(&member.token),
            )
            .await;
        assert_eq!(old_session.status, 401);
        let renewed = app.issue_session("rotation-member").await;
        let lookup = app
            .api_json(
                Method::GET,
                "/api/v1/operations/replacement-finalization",
                None,
                authenticated_json_headers(&renewed.token),
            )
            .await;
        assert_eq!(lookup.body, replacement.body);
    })
    .await;
}

async fn domain_snapshot(pool: &PgPool) -> Value {
    let mut state = serde_json::Map::new();
    for table in [
        "vault",
        "vault_key",
        "item",
        "item_attachment",
        "vault_key_rotation",
        "vault_key_rotation_plan",
        "vault_key_rotation_plan_manifest",
        "vault_key_rotation_plan_staged_output",
        "team",
        "user",
        "session",
        "audit_log",
        "sync_event",
        "operation_outcome",
    ] {
        let sql=format!("SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM \"{table}\" t");
        let value: Value = query_scalar(&sql).fetch_one(pool).await.unwrap();
        state.insert(table.into(), value);
    }
    Value::Object(state)
}

#[tokio::test]
async fn rotation_effect_audit_sync_outcome_and_commit_faults_roll_back_for_every_kind() {
    for ceremony in [Ceremony::Vault, Ceremony::Leave, Ceremony::Remove] {
        for finalize in [false, true] {
            with_api_test_app(&format!("rotation_faults_{ceremony:?}_{finalize}"), |app| async move {
                seed(&app.pool).await;
                let ids=if finalize {prepare(&app,ceremony,true).await} else {Vec::new()};
                let baseline=domain_snapshot(&app.pool).await;
                query("CREATE SEQUENCE rotation_fault_hit").execute(&app.pool).await.unwrap();
                query("CREATE FUNCTION fail_rotation_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('rotation_fault_hit'); RAISE EXCEPTION 'injected Rotation prospective write failure'; END $$").execute(&app.pool).await.unwrap();
                let mut faults=vec![
                    ("operation_audit","audit_log","INSERT","NEW.action LIKE 'rotation_operation_%'",false),
                    ("outcome","operation_outcome","INSERT","NEW.operation_id='rotation-fault'",false),
                    ("resolved","sync_event","INSERT","NEW.event_type='operation_resolved'",false),
                    ("commit","operation_outcome","INSERT","NEW.operation_id='rotation-fault'",true),
                ];
                if finalize {
                    faults.extend([
                        ("remove_key","vault_key","DELETE","OLD.user_id='rotation-member'",false),
                        ("rotate_key","vault_key","UPDATE","NEW.vault_id='rotation-vault-a'",false),
                        ("rotation_record","vault_key_rotation","INSERT","true",false),
                        ("plan_completed","vault_key_rotation_plan","UPDATE","NEW.state='completed'",false),
                        ("entity_sync","sync_event","INSERT","NEW.event_type<>'operation_resolved'",false),
                    ]);
                    if !matches!(ceremony,Ceremony::Vault) {
                        faults.extend([
                            ("second_vault","vault_key","UPDATE","NEW.vault_id='rotation-vault-b'",false),
                            ("revoke_session","session","DELETE","OLD.user_id='rotation-member'",false),
                            ("personal_team","team","INSERT","NEW.type='personal'",false),
                            ("move_member","user","UPDATE","NEW.id='rotation-member'",false),
                            ("departure_audit","audit_log","INSERT","NEW.action='team_member_removed'",false),
                        ]);
                    } else { faults.push(("membership_audit","audit_log","INSERT","NEW.action='vault_member_removed'",false)); }
                } else {
                    faults.extend([
                        ("first_snapshot","vault_key_rotation_plan","INSERT","NEW.vault_id='rotation-vault-a'",false),
                        ("manifest","vault_key_rotation_plan_manifest","INSERT","true",false),
                    ]);
                    if !matches!(ceremony,Ceremony::Vault) {faults.push(("second_snapshot","vault_key_rotation_plan","INSERT","NEW.vault_id='rotation-vault-b'",false));}
                }
                // Administrative finalization must also have a Session to revoke in this fixture.
                if finalize && matches!(ceremony,Ceremony::Remove) {
                    // Baseline was captured before this test-only Session; keep comparison explicit.
                    app.issue_session("rotation-member").await;
                }
                let baseline=if finalize && matches!(ceremony,Ceremony::Remove) {domain_snapshot(&app.pool).await} else {baseline};
                for (case,table,event,predicate,deferred) in faults {
                    let sql=if deferred {format!("CREATE CONSTRAINT TRIGGER rotation_fault AFTER {event} ON \"{table}\" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ({predicate}) EXECUTE FUNCTION fail_rotation_write()")} else {format!("CREATE TRIGGER rotation_fault AFTER {event} ON \"{table}\" FOR EACH ROW WHEN ({predicate}) EXECUTE FUNCTION fail_rotation_write()")};
                    query(&sql).execute(&app.pool).await.unwrap();
                    let before: i64=query_scalar("SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM rotation_fault_hit").fetch_one(&app.pool).await.unwrap();
                    let input=RotationOperationInput {operation_id:"rotation-fault".into(),user_id:ceremony.actor().into(),effect:ceremony.effect(finalize,&ids),raw_body:if finalize {serde_json::to_vec(&json!({"planIds":ids})).unwrap()} else {vec![]},deployment_mode:DeploymentMode::Cloud};
                    let result=operations::rotation::execute(&app.pool,None,input).await;
                    assert!(result.is_err(),"{ceremony:?}/{finalize}/{case} must fail");
                    let after:i64=query_scalar("SELECT last_value FROM rotation_fault_hit").fetch_one(&app.pool).await.unwrap();
                    assert!(after>before,"{ceremony:?}/{finalize}/{case} boundary must fire");
                    query(&format!("DROP TRIGGER rotation_fault ON \"{table}\"")).execute(&app.pool).await.unwrap();
                    assert_eq!(domain_snapshot(&app.pool).await,baseline,"{ceremony:?}/{finalize}/{case} left partial effects");
                }
            }).await;
        }
    }
}

#[tokio::test]
async fn rotation_stale_savepoint_retains_only_diagnostic_and_rejection_atomically() {
    with_api_test_app("rotation_stale_retention_faults", |app| async move {
        seed(&app.pool).await;
        let ids=prepare(&app,Ceremony::Remove,true).await;
        query("UPDATE vault SET key_version=key_version+1 WHERE id='rotation-vault-b'").execute(&app.pool).await.unwrap();
        let baseline=domain_snapshot(&app.pool).await;
        query("CREATE SEQUENCE rotation_rejection_fault_hit").execute(&app.pool).await.unwrap();
        query("CREATE FUNCTION fail_rotation_rejection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('rotation_rejection_fault_hit'); RAISE EXCEPTION 'injected Rotation rejection failure'; END $$").execute(&app.pool).await.unwrap();
        query("CREATE FUNCTION fail_retained_stale_marker() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval('rotation_rejection_fault_hit') % 2 = 0 THEN RAISE EXCEPTION 'injected retained stale marker failure'; END IF; RETURN NEW; END $$").execute(&app.pool).await.unwrap();
        for (table,event,predicate,deferred) in [
            ("vault_key_rotation_plan","UPDATE","NEW.state='stale'",false),
            ("audit_log","INSERT","NEW.action='rotation_operation_rejected'",false),
            ("operation_outcome","INSERT","NEW.operation_id='stale-operation'",false),
            ("sync_event","INSERT","NEW.event_type='operation_resolved'",false),
            ("operation_outcome","INSERT","NEW.operation_id='stale-operation'",true),
        ] {
            let sql=if deferred {format!("CREATE CONSTRAINT TRIGGER rotation_rejection_fault AFTER {event} ON \"{table}\" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ({predicate}) EXECUTE FUNCTION fail_rotation_rejection()")} else {format!("CREATE TRIGGER rotation_rejection_fault AFTER {event} ON \"{table}\" FOR EACH ROW WHEN ({predicate}) EXECUTE FUNCTION fail_rotation_rejection()")};
            let sql = if table == "vault_key_rotation_plan" { sql.replace("fail_rotation_rejection()", "fail_retained_stale_marker()") } else { sql };
            query(&sql).execute(&app.pool).await.unwrap();
            let before: i64 = query_scalar("SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM rotation_rejection_fault_hit").fetch_one(&app.pool).await.unwrap();
            let input=RotationOperationInput{operation_id:"stale-operation".into(),user_id:"rotation-owner".into(),effect:Ceremony::Remove.effect(true,&ids),raw_body:serde_json::to_vec(&json!({"planIds":ids})).unwrap(),deployment_mode:DeploymentMode::Cloud};
            assert!(operations::rotation::execute(&app.pool,None,input).await.is_err());
            let after:i64=query_scalar("SELECT last_value FROM rotation_rejection_fault_hit").fetch_one(&app.pool).await.unwrap();
            assert_eq!(after-before, if table == "vault_key_rotation_plan" {2} else {1}, "selected retained rejection boundary must fire");
            query(&format!("DROP TRIGGER rotation_rejection_fault ON \"{table}\"")).execute(&app.pool).await.unwrap();
            assert_eq!(domain_snapshot(&app.pool).await,baseline,"failed {table} rejection write retained partial state");
        }
        let session=app.issue_session("rotation-owner").await;
        let path=format!("{}/finalize",Ceremony::Remove.path());
        let body=Some(json!({"planIds":ids}));
        let response=app.api_json(Method::POST,&path,body.clone(),headers(&session.token,"stale-operation")).await;
        assert_eq!(response.body["result"],json!({"status":"rejected","code":"rotation_plan_stale","details":{"planId":ids[1],"reason":"vault_version"}}));
        let versions:Vec<(String,i32)>=query_as("SELECT id,key_version FROM vault ORDER BY id").fetch_all(&app.pool).await.unwrap();
        assert_eq!(versions,vec![("rotation-vault-a".into(),1),("rotation-vault-b".into(),2)]);
        let completed:i64=query_scalar("SELECT COUNT(*) FROM vault_key_rotation").fetch_one(&app.pool).await.unwrap(); assert_eq!(completed,0);
        let retained=app.api_json(Method::POST,&path,body,headers(&session.token,"stale-operation")).await;
        assert_eq!(retained.body,response.body);
        let stale:Vec<(String,String)>=query_as("SELECT id,state::text FROM vault_key_rotation_plan WHERE state='stale'").fetch_all(&app.pool).await.unwrap();
        assert_eq!(stale,vec![(ids[1].clone(),"stale".into())]);
    }).await;
}

#[tokio::test]
async fn rotation_retained_schema_closes_every_kind_payload_and_rejection_set() {
    use crate::db::enums::OperationRejectionCode;
    with_api_test_app("rotation_closed_storage_contract", |app| async move {
        seed(&app.pool).await;
        let v=&["vault_access_denied","vault_member_not_found","self_removal_forbidden","vault_owner_protected","vault_admin_peer_protected","shared_vault_required","vault_sharing_entitlement_denied"];
        let l=&["team_member_not_found","personal_team_departure_forbidden","team_owner_leave_forbidden"];
        let a=&["team_member_not_found","personal_team_departure_forbidden","self_removal_forbidden","team_management_denied","team_owner_protected","team_management_entitlement_denied","vault_management_incomplete"];
        let f=&["rotation_plan_unavailable","rotation_plan_mismatch","rotation_plan_incomplete","rotation_plan_stale"];
        let mut sequence=0;
        for (ceremony,base) in [(Ceremony::Vault,v.as_slice()),(Ceremony::Leave,l.as_slice()),(Ceremony::Remove,a.as_slice())] {
            for finalize in [false,true] {
                let kind=ceremony.kind(finalize);
                let mut allowed=base.to_vec();
                if finalize {
                    allowed=allowed.into_iter().map(|code|match code {"vault_member_not_found"=>"vault_membership_changed","team_member_not_found"=>"team_membership_changed",other=>other}).collect();
                    allowed.extend(f);
                    if !matches!(ceremony,Ceremony::Vault) {allowed.push("rotation_plan_set_mismatch");}
                }
                for code in OperationRejectionCode::ALL {
                    sequence+=1;
                    let details=(code.as_str()=="rotation_plan_stale").then(||json!({"planId":"plan","reason":"vault_version"}));
                    let inserted=query("INSERT INTO operation_outcome (user_id,operation_id,operation_kind,request_fingerprint,result_status,rejection_code,rejection_details) VALUES ('rotation-owner',$1,$2::operation_kind,$3,'rejected',$4::operation_rejection_code,$5)")
                        .bind(format!("schema-{sequence}")).bind(&kind).bind([0_u8;32].as_slice()).bind(code).bind(details).execute(&app.pool).await;
                    assert_eq!(inserted.is_ok(),allowed.contains(&code.as_str()),"{kind}: {}",code.as_str());
                }
                let plan=json!({"id":"plan","vaultId":"vault","initiatorUserId":"user","expectedKeyVersion":1,"state":"preparing","idleExpiresAt":"2026-09-07T00:00:00Z","absoluteExpiresAt":"2026-09-08T00:00:00Z"});
                let rotation=json!({"planId":"plan","vaultId":"vault","keyVersion":2,"rotationId":"rotation"});
                let mut payload=if finalize {json!({"rotations":[rotation]})} else {json!({"plans":[plan]})};
                if finalize && !matches!(ceremony,Ceremony::Vault) {payload["personalTeamId"]=json!("personal-team");}
                let array=if finalize {"rotations"} else {"plans"};
                let mut variants=vec![(payload.clone(),true)];
                let mut empty=payload.clone(); empty[array]=json!([]); variants.push((empty,!matches!(ceremony,Ceremony::Vault)));
                let mut extra=payload.clone(); extra["ciphertext"]=json!("must-not-retain"); variants.push((extra,false));
                let mut nested=payload.clone(); nested[array][0]["encryptedVaultKey"]=json!("must-not-retain"); variants.push((nested,false));
                let mut missing=payload.clone(); missing[array][0].as_object_mut().unwrap().remove("vaultId"); variants.push((missing,false));
                let mut nullable=payload.clone(); nullable[array]=Value::Null; variants.push((nullable,false));
                if !finalize {let mut mutable=payload.clone(); mutable[array][0]["state"]=json!("ready"); variants.push((mutable,false));}
                if finalize && !matches!(ceremony,Ceremony::Vault) {let mut missing=payload.clone(); missing.as_object_mut().unwrap().remove("personalTeamId"); variants.push((missing,false));}
                let mut many=payload.clone(); many[array]=Value::Array(vec![payload[array][0].clone();100]); variants.push((many,!matches!(ceremony,Ceremony::Vault)));
                for (payload,valid) in variants {
                    sequence+=1;
                    let inserted=query("INSERT INTO operation_outcome (user_id,operation_id,operation_kind,request_fingerprint,result_status,applied_payload) VALUES ('rotation-owner',$1,$2::operation_kind,$3,'applied',$4)")
                        .bind(format!("schema-{sequence}")).bind(&kind).bind([0_u8;32].as_slice()).bind(payload).execute(&app.pool).await;
                    assert_eq!(inserted.is_ok(),valid,"payload shape for {kind}");
                }
                if finalize {
                    for (code,details) in [("rotation_plan_stale",None),("rotation_plan_stale",Some(json!({"planId":"plan","reason":"unknown"}))),("rotation_plan_stale",Some(json!({"planId":"plan","reason":"vault_version","extra":1}))),("rotation_plan_incomplete",Some(json!({"planId":"plan","reason":"vault_version"})))] {
                        sequence+=1;
                        let inserted=query("INSERT INTO operation_outcome (user_id,operation_id,operation_kind,request_fingerprint,result_status,rejection_code,rejection_details) VALUES ('rotation-owner',$1,$2::operation_kind,$3,'rejected',$4::operation_rejection_code,$5)")
                            .bind(format!("schema-{sequence}")).bind(&kind).bind([0_u8;32].as_slice()).bind(code).bind(details).execute(&app.pool).await;
                        assert!(inserted.is_err(),"invalid details for {kind}/{code}");
                    }
                }
            }
        }
        let foreign_item=query("INSERT INTO operation_outcome (user_id,operation_id,operation_kind,request_fingerprint,result_status,rejection_code) VALUES ('rotation-owner','foreign-item-code','create_item',$1,'rejected','vault_owner_protected')").bind([0_u8;32].as_slice()).execute(&app.pool).await;
        assert!(foreign_item.is_err(),"new Rotation codes must not widen the Item rejection set");
    }).await;
}

#[tokio::test]
async fn rotation_empty_voluntary_departure_preserves_unpaid_policy_and_secret_refusal() {
    with_api_test_app("rotation_empty_unpaid_departure", |app| async move {
        seed(&app.pool).await;
        query("DELETE FROM vault").execute(&app.pool).await.unwrap();
        query("UPDATE team SET billing_status='past_due' WHERE id='rotation-team'")
            .execute(&app.pool)
            .await
            .unwrap();
        let owner = app.issue_session("rotation-owner").await;
        let denied = app
            .api_json(
                Method::POST,
                Ceremony::Remove.path(),
                None,
                headers(&owner.token, "unpaid-administrative"),
            )
            .await;
        assert_eq!(
            denied.body["result"]["code"],
            "team_management_entitlement_denied"
        );
        for (path, body) in [
            (
                "/api/v1/teams/rotation-team/invitations",
                Some(json!({"email":"new@test.invalid","role":"member"})),
            ),
            (
                "/api/v1/teams/rotation-team/invitations/unknown/resend",
                None,
            ),
        ] {
            let refusal = app
                .api_json(
                    Method::POST,
                    path,
                    body,
                    headers(&owner.token, "one-time-secret"),
                )
                .await;
            assert_eq!(refusal.status, 422);
            assert_eq!(refusal.body["code"], "IDEMPOTENCY_NOT_ALLOWED");
        }
        let member = app.issue_session("rotation-member").await;
        let prepared = app
            .api_json(
                Method::POST,
                Ceremony::Leave.path(),
                None,
                headers(&member.token, "unpaid-voluntary"),
            )
            .await;
        assert_eq!(
            prepared.body["result"],
            json!({"status":"applied","plans":[]})
        );
        let finalization = app
            .api_json(
                Method::POST,
                &format!("{}/finalize", Ceremony::Leave.path()),
                Some(json!({"planIds":[]})),
                headers(&member.token, "unpaid-voluntary-final"),
            )
            .await;
        assert_eq!(finalization.body["result"]["status"], "applied");
        assert_eq!(finalization.body["result"]["rotations"], json!([]));
        assert!(finalization.body["result"]["personalTeamId"]
            .as_str()
            .is_some());
        let secrets: i64 = query_scalar(
            "SELECT COUNT(*) FROM operation_outcome WHERE operation_id='one-time-secret'",
        )
        .fetch_one(&app.pool)
        .await
        .unwrap();
        assert_eq!(secrets, 0);
    })
    .await;
}
