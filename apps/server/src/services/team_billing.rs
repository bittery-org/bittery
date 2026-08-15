use sqlx::{query_as, PgPool};

use crate::{
    config::{bittery_mode, SELF_HOSTED_MODE},
    db::{
        enums::{BillingPlan, BillingStatus},
        models::DbTeamBillingEntitlementRow,
    },
    error::AppError,
};

const TEAM_BILLING_ENTITLEMENT_QUERY: &str =
    "SELECT u.team_id, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1";
const MB: i64 = 1024 * 1024;
const GB: i64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ShareLinksPolicy {
    pub enabled: bool,
    pub max_active_links: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct VaultSharingEntitlement {
    pub allowed: bool,
    pub shared_vault_limit: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AttachmentEntitlement {
    pub enabled: bool,
    pub max_file_size_bytes: Option<i64>,
    pub storage_bytes: Option<i64>,
}

pub(crate) async fn load_team_billing_entitlement(
    pool: &PgPool,
    user_id: &str,
    error_message: &'static str,
) -> Result<Option<DbTeamBillingEntitlementRow>, AppError> {
    query_as::<_, DbTeamBillingEntitlementRow>(TEAM_BILLING_ENTITLEMENT_QUERY)
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "{error_message}");
            AppError::internal(error_message)
        })
}

pub(crate) async fn attachments_enabled_for_user(
    pool: &PgPool,
    user_id: &str,
) -> Result<bool, AppError> {
    let mode = bittery_mode();
    if mode == SELF_HOSTED_MODE {
        return Ok(true);
    }

    let Some(actor) =
        load_team_billing_entitlement(pool, user_id, "Failed to load attachment entitlements")
            .await?
    else {
        return Ok(false);
    };
    if actor.team_id.is_none() {
        return Ok(false);
    }

    Ok(resolve_attachment_entitlement(mode, actor.billing_plan, actor.billing_status).enabled)
}

fn is_active(billing_status: Option<BillingStatus>) -> bool {
    billing_status.is_some_and(|status| status.is_active())
}

pub(crate) fn team_management_enabled(
    mode: &str,
    billing_plan: Option<BillingPlan>,
    billing_status: Option<BillingStatus>,
) -> bool {
    if mode == SELF_HOSTED_MODE {
        return true;
    }

    matches!(billing_plan, Some(BillingPlan::Family | BillingPlan::Team))
        && is_active(billing_status)
}

pub(crate) fn resolve_share_links_policy(
    mode: &str,
    billing_plan: Option<BillingPlan>,
    billing_status: Option<BillingStatus>,
) -> ShareLinksPolicy {
    if mode == SELF_HOSTED_MODE {
        return ShareLinksPolicy {
            enabled: true,
            max_active_links: None,
        };
    }

    ShareLinksPolicy {
        enabled: billing_plan.is_some_and(|plan| plan.is_paid()) && is_active(billing_status),
        max_active_links: match billing_plan {
            Some(BillingPlan::Personal) => Some(5),
            Some(BillingPlan::Family | BillingPlan::Team) => None,
            Some(BillingPlan::Free) | None => Some(0),
        },
    }
}

pub(crate) fn resolve_vault_sharing_entitlement(
    mode: &str,
    billing_plan: Option<BillingPlan>,
    billing_status: Option<BillingStatus>,
) -> VaultSharingEntitlement {
    if mode == SELF_HOSTED_MODE {
        return VaultSharingEntitlement {
            allowed: true,
            shared_vault_limit: None,
        };
    }

    let is_active = is_active(billing_status);

    match billing_plan {
        Some(BillingPlan::Family) if is_active => VaultSharingEntitlement {
            allowed: true,
            shared_vault_limit: Some(5),
        },
        Some(BillingPlan::Team) if is_active => VaultSharingEntitlement {
            allowed: true,
            shared_vault_limit: None,
        },
        _ => VaultSharingEntitlement {
            allowed: false,
            shared_vault_limit: Some(0),
        },
    }
}

pub(crate) fn resolve_attachment_entitlement(
    mode: &str,
    billing_plan: Option<BillingPlan>,
    billing_status: Option<BillingStatus>,
) -> AttachmentEntitlement {
    if mode == SELF_HOSTED_MODE {
        return AttachmentEntitlement {
            enabled: true,
            max_file_size_bytes: None,
            storage_bytes: None,
        };
    }

    let is_active = is_active(billing_status);

    match billing_plan {
        Some(BillingPlan::Personal) if is_active => AttachmentEntitlement {
            enabled: true,
            max_file_size_bytes: Some(10 * MB),
            storage_bytes: Some(250 * MB),
        },
        Some(BillingPlan::Family) if is_active => AttachmentEntitlement {
            enabled: true,
            max_file_size_bytes: Some(25 * MB),
            storage_bytes: Some(GB),
        },
        Some(BillingPlan::Team) if is_active => AttachmentEntitlement {
            enabled: true,
            max_file_size_bytes: Some(50 * MB),
            storage_bytes: Some(2 * GB),
        },
        _ => AttachmentEntitlement {
            enabled: false,
            max_file_size_bytes: Some(0),
            storage_bytes: Some(0),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::SELF_HOSTED_MODE,
        test_support::{acquire_env_lock_async, seed_user, with_api_test_app, EnvVarGuard},
    };
    use sqlx::postgres::PgPoolOptions;

    #[test]
    fn team_management_enabled_respects_mode_and_plan() {
        assert!(team_management_enabled(SELF_HOSTED_MODE, None, None));
        assert!(team_management_enabled(
            "cloud",
            Some(BillingPlan::Team),
            Some(BillingStatus::Active)
        ));
        assert!(team_management_enabled(
            "cloud",
            Some(BillingPlan::Family),
            Some(BillingStatus::Trialing)
        ));
        assert!(!team_management_enabled(
            "cloud",
            Some(BillingPlan::Personal),
            Some(BillingStatus::Active)
        ));
        assert!(!team_management_enabled(
            "cloud",
            Some(BillingPlan::Team),
            Some(BillingStatus::PastDue)
        ));
    }

    #[test]
    fn share_links_policy_keeps_personal_limit_when_inactive() {
        let active = resolve_share_links_policy(
            "cloud",
            Some(BillingPlan::Personal),
            Some(BillingStatus::Active),
        );
        assert!(active.enabled);
        assert_eq!(active.max_active_links, Some(5));

        let inactive = resolve_share_links_policy(
            "cloud",
            Some(BillingPlan::Personal),
            Some(BillingStatus::PastDue),
        );
        assert!(!inactive.enabled);
        assert_eq!(inactive.max_active_links, Some(5));

        let self_hosted = resolve_share_links_policy(SELF_HOSTED_MODE, None, None);
        assert!(self_hosted.enabled);
        assert_eq!(self_hosted.max_active_links, None);
    }

    #[test]
    fn vault_sharing_entitlement_matches_existing_plan_rules() {
        let family = resolve_vault_sharing_entitlement(
            "cloud",
            Some(BillingPlan::Family),
            Some(BillingStatus::Active),
        );
        assert!(family.allowed);
        assert_eq!(family.shared_vault_limit, Some(5));

        let team = resolve_vault_sharing_entitlement(
            "cloud",
            Some(BillingPlan::Team),
            Some(BillingStatus::Trialing),
        );
        assert!(team.allowed);
        assert_eq!(team.shared_vault_limit, None);

        let free = resolve_vault_sharing_entitlement(
            "cloud",
            Some(BillingPlan::Free),
            Some(BillingStatus::Active),
        );
        assert!(!free.allowed);
        assert_eq!(free.shared_vault_limit, Some(0));
    }

    #[test]
    fn attachment_entitlement_returns_expected_quotas() {
        let personal = resolve_attachment_entitlement(
            "cloud",
            Some(BillingPlan::Personal),
            Some(BillingStatus::Active),
        );
        assert!(personal.enabled);
        assert_eq!(personal.max_file_size_bytes, Some(10 * MB));
        assert_eq!(personal.storage_bytes, Some(250 * MB));

        let inactive = resolve_attachment_entitlement(
            "cloud",
            Some(BillingPlan::Team),
            Some(BillingStatus::PastDue),
        );
        assert!(!inactive.enabled);
        assert_eq!(inactive.max_file_size_bytes, Some(0));
        assert_eq!(inactive.storage_bytes, Some(0));

        let self_hosted = resolve_attachment_entitlement(SELF_HOSTED_MODE, None, None);
        assert!(self_hosted.enabled);
        assert_eq!(self_hosted.max_file_size_bytes, None);
        assert_eq!(self_hosted.storage_bytes, None);
    }

    #[tokio::test]
    async fn attachment_access_is_enabled_without_a_database_in_self_hosted_mode() {
        let _env_lock = acquire_env_lock_async().await;
        let _env = EnvVarGuard::set(&[("BITTERY_MODE", SELF_HOSTED_MODE)]);
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .expect("lazy test pool should be valid");

        assert!(attachments_enabled_for_user(&pool, "missing_user")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn attachment_access_is_disabled_for_a_user_without_a_team() {
        let _env_lock = acquire_env_lock_async().await;
        let _env = EnvVarGuard::set(&[("BITTERY_MODE", "cloud")]);
        with_api_test_app("attachment_access_without_team", |app| async move {
            seed_user(
                &app.pool,
                "user_without_team",
                "No Team",
                "no-team@example.com",
            )
            .await;

            assert!(
                !attachments_enabled_for_user(&app.pool, "user_without_team")
                    .await
                    .unwrap()
            );
        })
        .await;
    }
}
