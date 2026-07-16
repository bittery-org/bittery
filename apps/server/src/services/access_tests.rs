use std::future::Future;

use sqlx::{query, PgPool};
use time::{Duration, OffsetDateTime};

use super::*;
use crate::error::AppErrorCode;
use crate::test_support::{
    acquire_env_lock_async, assign_user_to_team, seed_item, seed_team, seed_user, seed_vault,
    seed_vault_key, with_rpc_test_app,
};

const ADMIN_ID: &str = "access-admin";
const MEMBER_ID: &str = "access-member";
const TEAM_ID: &str = "access-team";

async fn with_bittery_mode_async<T, F>(value: Option<&str>, future: F) -> T
where
    F: Future<Output = T>,
{
    let _guard = acquire_env_lock_async().await;
    let previous = std::env::var("BITTERY_MODE").ok();
    match value {
        Some(value) => unsafe { std::env::set_var("BITTERY_MODE", value) },
        None => unsafe { std::env::remove_var("BITTERY_MODE") },
    }

    let result = future.await;

    match previous.as_deref() {
        Some(value) => unsafe { std::env::set_var("BITTERY_MODE", value) },
        None => unsafe { std::env::remove_var("BITTERY_MODE") },
    }

    result
}

/// A team on an active Team plan: an owner/admin plus one ordinary member.
async fn seed_team_fixture(pool: &PgPool) {
    seed_user(pool, ADMIN_ID, "Admin", "admin@example.com").await;
    seed_user(pool, MEMBER_ID, "Member", "member@example.com").await;
    seed_team(
        pool,
        TEAM_ID,
        "Access Team",
        ADMIN_ID,
        "organization",
        "team",
        "active",
    )
    .await;
    assign_user_to_team(pool, ADMIN_ID, TEAM_ID, "admin").await;
    assign_user_to_team(pool, MEMBER_ID, TEAM_ID, "member").await;
}

async fn seed_share_link(
    pool: &PgPool,
    link_id: &str,
    item_id: &str,
    created_by_id: &str,
    status: &str,
    expires_at: OffsetDateTime,
) {
    query(
		"INSERT INTO share_link (id, item_id, created_by_id, token, status, access_mode, encrypted_item_data, encryption_iv, encrypted_share_key, share_key_iv, expires_at) VALUES ($1, $2, $3, $4, $5::share_link_status, 'anyone'::share_link_access_mode, 'data', 'iv', 'key', 'key-iv', $6)",
	)
	.bind(link_id)
	.bind(item_id)
	.bind(created_by_id)
	.bind(format!("token-{link_id}"))
	.bind(status)
	.bind(expires_at)
	.execute(pool)
	.await
	.expect("share link should seed");
}

#[tokio::test]
async fn member_access_reports_team_vaults_and_excludes_personal_ones() {
    with_rpc_test_app("access_member_vaults", |app| async move {
        with_bittery_mode_async(Some("cloud"), async {
            seed_team_fixture(&app.pool).await;

            seed_vault(
                &app.pool,
                "team-vault",
                "Engineering",
                "team",
                ADMIN_ID,
                Some(TEAM_ID),
            )
            .await;
            seed_vault_key(
                &app.pool,
                "team-key",
                "team-vault",
                MEMBER_ID,
                "wrapped",
                "member",
            )
            .await;
            seed_item(
                &app.pool,
                "item-1",
                "team-vault",
                "login",
                "data",
                "iv",
                MEMBER_ID,
            )
            .await;
            seed_item(
                &app.pool,
                "item-2",
                "team-vault",
                "login",
                "data",
                "iv",
                MEMBER_ID,
            )
            .await;

            // A personal vault the member also holds a key for: must stay invisible.
            seed_vault(
                &app.pool,
                "personal-vault",
                "Private",
                "personal",
                MEMBER_ID,
                None,
            )
            .await;
            seed_vault_key(
                &app.pool,
                "personal-key",
                "personal-vault",
                MEMBER_ID,
                "wrapped",
                "owner",
            )
            .await;

            let access = get_member_access(
                &app.pool,
                ADMIN_ID,
                MemberAccessInput {
                    user_id: MEMBER_ID.to_string(),
                },
            )
            .await
            .expect("admin should read member access");

            assert_eq!(access.vaults.len(), 1);
            let vault = &access.vaults[0];
            assert_eq!(vault.id, "team-vault");
            assert_eq!(vault.name, "Engineering");
            assert_eq!(vault.role, "member");
            assert_eq!(vault.item_count, 2);
        })
        .await;
    })
    .await;
}

#[tokio::test]
async fn member_access_counts_only_unexpired_active_share_links() {
    with_rpc_test_app("access_member_share_links", |app| async move {
        with_bittery_mode_async(Some("cloud"), async {
            seed_team_fixture(&app.pool).await;
            seed_vault(
                &app.pool,
                "team-vault",
                "Engineering",
                "team",
                ADMIN_ID,
                Some(TEAM_ID),
            )
            .await;
            seed_item(
                &app.pool,
                "item-1",
                "team-vault",
                "login",
                "data",
                "iv",
                MEMBER_ID,
            )
            .await;

            let now = OffsetDateTime::now_utc();
            seed_share_link(
                &app.pool,
                "live",
                "item-1",
                MEMBER_ID,
                "active",
                now + Duration::days(7),
            )
            .await;
            seed_share_link(
                &app.pool,
                "stale",
                "item-1",
                MEMBER_ID,
                "active",
                now - Duration::days(1),
            )
            .await;
            seed_share_link(
                &app.pool,
                "revoked",
                "item-1",
                MEMBER_ID,
                "revoked",
                now + Duration::days(7),
            )
            .await;
            // Created by the admin, so it must not appear under the member.
            seed_share_link(
                &app.pool,
                "other",
                "item-1",
                ADMIN_ID,
                "active",
                now + Duration::days(7),
            )
            .await;

            let access = get_member_access(
                &app.pool,
                ADMIN_ID,
                MemberAccessInput {
                    user_id: MEMBER_ID.to_string(),
                },
            )
            .await
            .expect("admin should read member access");

            assert_eq!(access.share_link_total, 3);
            assert_eq!(access.share_links.len(), 3);
            assert_eq!(access.active_share_link_count, 1);

            let stale = access
                .share_links
                .iter()
                .find(|link| link.id == "stale")
                .expect("stale link");
            assert!(
                stale.is_expired,
                "past-expiry active links should read as expired"
            );

            let revoked = access
                .share_links
                .iter()
                .find(|link| link.id == "revoked")
                .expect("revoked link");
            assert!(!revoked.is_expired, "revoked links are not also expired");
        })
        .await;
    })
    .await;
}

#[tokio::test]
async fn member_access_reports_unexpired_sessions_with_masked_ip() {
    with_rpc_test_app("access_member_sessions", |app| async move {
        with_bittery_mode_async(Some("cloud"), async {
            seed_team_fixture(&app.pool).await;
            let session = app.issue_session(MEMBER_ID).await;
            query("UPDATE session SET ip_address = '203.0.113.42' WHERE id = $1")
                .bind(&session.session_id)
                .execute(&app.pool)
                .await
                .expect("session ip should update");

            let access = get_member_access(
                &app.pool,
                ADMIN_ID,
                MemberAccessInput {
                    user_id: MEMBER_ID.to_string(),
                },
            )
            .await
            .expect("admin should read member access");

            assert_eq!(access.devices.len(), 1);
            assert_eq!(
                access.devices[0].masked_ip.as_deref(),
                Some("203.0.x.x"),
                "admins must not see a member's full IP here"
            );
        })
        .await;
    })
    .await;
}

#[tokio::test]
async fn member_access_rejects_non_admin_callers() {
    with_rpc_test_app("access_member_forbidden", |app| async move {
        with_bittery_mode_async(Some("cloud"), async {
            seed_team_fixture(&app.pool).await;

            let error = get_member_access(
                &app.pool,
                MEMBER_ID,
                MemberAccessInput {
                    user_id: ADMIN_ID.to_string(),
                },
            )
            .await
            .expect_err("a plain member must not read another member's access");

            assert_eq!(error.code, AppErrorCode::Forbidden);
        })
        .await;
    })
    .await;
}

#[tokio::test]
async fn member_access_returns_empty_for_users_outside_the_team() {
    with_rpc_test_app("access_member_cross_team", |app| async move {
        with_bittery_mode_async(Some("cloud"), async {
            seed_team_fixture(&app.pool).await;
            seed_user(&app.pool, "outsider", "Outsider", "outsider@example.com").await;
            seed_vault(
                &app.pool,
                "other-vault",
                "Other",
                "personal",
                "outsider",
                None,
            )
            .await;
            seed_vault_key(
                &app.pool,
                "other-key",
                "other-vault",
                "outsider",
                "wrapped",
                "owner",
            )
            .await;

            let access = get_member_access(
                &app.pool,
                ADMIN_ID,
                MemberAccessInput {
                    user_id: "outsider".to_string(),
                },
            )
            .await
            .expect("cross-team lookups resolve to an empty footprint, not an error");

            assert!(access.vaults.is_empty());
            assert!(access.devices.is_empty());
            assert!(access.share_links.is_empty());
            assert_eq!(access.share_link_total, 0);
        })
        .await;
    })
    .await;
}
