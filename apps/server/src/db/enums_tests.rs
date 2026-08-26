//! Pins the wire strings of every closed set.
//!
//! These strings are simultaneously the PostgreSQL enum labels, the JSON the API emits and the
//! OpenAPI `enum` constraint. A change here is a breaking API change, so the expectations are
//! written out longhand instead of being derived from the types under test.

use std::{collections::BTreeSet, path::PathBuf, str::FromStr};

use super::*;

/// Asserts that the Rust set, the serde representation and `as_str` agree with the given labels.
macro_rules! assert_wire_labels {
    ($ty:ident, [$($label:literal),+ $(,)?]) => {{
        let expected: Vec<&str> = vec![$($label),+];
        let actual: Vec<&str> = $ty::ALL.iter().map(|value| value.as_str()).collect();
        assert_eq!(actual, expected, "{} labels drifted", stringify!($ty));

        for value in $ty::ALL {
            let label = value.as_str();
            assert_eq!(
                serde_json::to_value(value).unwrap(),
                serde_json::Value::String(label.to_owned()),
                "{}::{:?} must serialize as `{label}`",
                stringify!($ty),
                value,
            );
            assert_eq!(
                serde_json::from_value::<$ty>(serde_json::Value::String(label.to_owned())).unwrap(),
                *value,
            );
            assert_eq!($ty::from_str(label).unwrap(), *value);
            assert_eq!($ty::try_from(label.to_owned()).unwrap(), *value);
            assert_eq!(value.to_string(), label);
        }

        assert!($ty::from_str("definitely-not-a-label").is_err());
        expected
    }};
}

#[test]
fn closed_sets_keep_their_wire_strings() {
    assert_wire_labels!(VaultRole, ["owner", "admin", "member", "read-only"]);
    assert_wire_labels!(TeamRole, ["owner", "admin", "member"]);
    assert_wire_labels!(VaultType, ["personal", "team"]);
    assert_wire_labels!(TeamType, ["personal", "family", "organization"]);
    assert_wire_labels!(BillingPlan, ["free", "personal", "family", "team"]);
    assert_wire_labels!(
        BillingStatus,
        [
            "none",
            "incomplete",
            "trialing",
            "active",
            "past_due",
            "canceled",
            "unpaid",
        ]
    );
    assert_wire_labels!(
        InvitationStatus,
        ["pending", "accepted", "declined", "expired"]
    );
    assert_wire_labels!(
        ShareLinkStatus,
        ["active", "expired", "exhausted", "revoked"]
    );
    assert_wire_labels!(ShareLinkAccessMode, ["anyone", "email-restricted"]);
    assert_wire_labels!(
        SyncEventType,
        [
            "item_created",
            "item_updated",
            "item_deleted",
            "item_restored",
            "item_permanently_deleted",
            "item_moved",
            "vault_created",
            "vault_updated",
            "vault_deleted",
            "vault_access_revoked",
            "vault_member_added",
            "vault_member_removed",
            "vault_key_rotated",
            "travel_mode_updated",
            "operation_resolved",
        ]
    );
    assert_wire_labels!(
        SyncEntityType,
        [
            "item",
            "vault",
            "vault_member",
            "vault_key",
            "user",
            "operation"
        ]
    );
    assert_wire_labels!(
        ItemCategory,
        ["login", "secure-note", "credit-card", "identity", "totp"]
    );
    assert_wire_labels!(
        KeyRotationReason,
        ["member_removed", "scheduled", "security_breach", "manual"]
    );
    assert_wire_labels!(
        VaultKeyRotationPlanState,
        [
            "preparing",
            "ready",
            "completed",
            "stale",
            "failed",
            "abandoned",
            "expired"
        ]
    );
    assert_wire_labels!(
        VaultKeyRotationStaleReason,
        [
            "vault_version",
            "member_set",
            "item_state",
            "attachment_state"
        ]
    );
    assert_wire_labels!(
        VaultKeyRotationManifestKind,
        ["member", "item", "attachment"]
    );
    assert_wire_labels!(
        OperationKind,
        [
            "create_item",
            "update_item",
            "set_item_favorite",
            "trash_item",
            "restore_item",
            "move_item",
            "permanently_delete_item",
            "create_share"
        ]
    );
    assert_wire_labels!(OperationOutcomeStatus, ["applied", "rejected"]);
    assert_wire_labels!(
        OperationRejectionCode,
        [
            "invalid_ciphertext",
            "vault_access_denied",
            "vault_read_only",
            "item_id_conflict",
            "item_not_found",
            "item_version_conflict",
            "item_trashed",
            "item_not_trashed",
            "source_vault_mismatch",
            "target_vault_access_denied",
            "target_vault_read_only",
            "attachment_state_conflict",
            "share_entitlement_denied",
            "share_limit_reached"
        ]
    );
}

/// Reads every `CREATE TYPE ... AS ENUM (...)` and `ALTER TYPE ... ADD VALUE` label.
fn postgres_enum_labels(type_name: &str) -> BTreeSet<String> {
    let migrations = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut labels = BTreeSet::new();
    let mut files: Vec<PathBuf> = std::fs::read_dir(&migrations)
        .expect("migrations directory should exist")
        .map(|entry| entry.expect("migration entry should be readable").path())
        .collect();
    files.sort();

    for file in files {
        let sql = std::fs::read_to_string(&file).expect("migration should be readable");
        for statement in sql.split(';') {
            let normalized = statement.replace('"', "");
            let Some(rest) = normalized
                .split_once(&format!("CREATE TYPE public.{type_name} AS ENUM"))
                .map(|(_, rest)| rest)
                .or_else(|| {
                    normalized
                        .split_once(&format!("ALTER TYPE public.{type_name} ADD VALUE"))
                        .map(|(_, rest)| rest)
                })
            else {
                continue;
            };
            labels.extend(
                rest.split('\'')
                    .skip(1)
                    .step_by(2)
                    .map(|label| label.to_owned()),
            );
        }
    }

    labels
}

/// The Rust sets must be exactly the PostgreSQL sets — no missing and no invented labels.
#[test]
fn closed_sets_match_the_postgres_enums() {
    macro_rules! assert_matches_postgres {
        ($ty:ident) => {{
            let rust: BTreeSet<String> = $ty::ALL
                .iter()
                .map(|value| value.as_str().to_owned())
                .collect();
            let postgres = postgres_enum_labels($ty::pg_type_name());
            assert!(
                !postgres.is_empty(),
                "no migration declares `{}`",
                $ty::pg_type_name()
            );
            assert_eq!(
                rust,
                postgres,
                "{} drifted from PostgreSQL",
                stringify!($ty)
            );
        }};
    }

    assert_matches_postgres!(VaultRole);
    assert_matches_postgres!(TeamRole);
    assert_matches_postgres!(VaultType);
    assert_matches_postgres!(TeamType);
    assert_matches_postgres!(BillingPlan);
    assert_matches_postgres!(BillingStatus);
    assert_matches_postgres!(InvitationStatus);
    assert_matches_postgres!(ShareLinkStatus);
    assert_matches_postgres!(ShareLinkAccessMode);
    assert_matches_postgres!(SyncEventType);
    assert_matches_postgres!(SyncEntityType);
    assert_matches_postgres!(ItemCategory);
    assert_matches_postgres!(KeyRotationReason);
    assert_matches_postgres!(VaultKeyRotationPlanState);
    assert_matches_postgres!(VaultKeyRotationStaleReason);
    assert_matches_postgres!(VaultKeyRotationManifestKind);
    assert_matches_postgres!(OperationKind);
    assert_matches_postgres!(OperationOutcomeStatus);
    assert_matches_postgres!(OperationRejectionCode);
}

#[test]
fn role_predicates_describe_the_authorization_ladder() {
    assert!(VaultRole::Owner.can_manage() && VaultRole::Admin.can_manage());
    assert!(!VaultRole::Member.can_manage() && !VaultRole::ReadOnly.can_manage());
    assert!(VaultRole::Member.can_write() && !VaultRole::ReadOnly.can_write());

    assert!(TeamRole::Owner.can_manage() && TeamRole::Admin.can_manage());
    assert!(!TeamRole::Member.can_manage());
    assert_eq!(TeamRole::Owner.vault_role(), VaultRole::Admin);
    assert_eq!(TeamRole::Admin.vault_role(), VaultRole::Admin);
    assert_eq!(TeamRole::Member.vault_role(), VaultRole::Member);

    assert!(BillingStatus::Active.is_active() && BillingStatus::Trialing.is_active());
    assert!(!BillingStatus::PastDue.is_active());
    assert!(BillingPlan::Team.is_paid() && !BillingPlan::Free.is_paid());
}
