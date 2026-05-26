use sqlx::{query_as, PgPool};

use crate::{
    db::models::DbTeamBillingEntitlementRow, error::AppError, config::SELF_HOSTED_MODE,
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

pub(crate) fn billing_is_active(billing_status: &str) -> bool {
    matches!(billing_status, "active" | "trialing")
}

pub(crate) fn team_management_enabled(
    mode: &str,
    billing_plan: Option<&str>,
    billing_status: Option<&str>,
) -> bool {
    if mode == SELF_HOSTED_MODE {
        return true;
    }

    let is_active = billing_status.map(billing_is_active).unwrap_or(false);
    matches!(billing_plan, Some("family") | Some("team")) && is_active
}

pub(crate) fn resolve_share_links_policy(
    mode: &str,
    billing_plan: Option<&str>,
    billing_status: Option<&str>,
) -> ShareLinksPolicy {
    if mode == SELF_HOSTED_MODE {
        return ShareLinksPolicy {
            enabled: true,
            max_active_links: None,
        };
    }

    let is_active = billing_status.map(billing_is_active).unwrap_or(false);

    ShareLinksPolicy {
        enabled: matches!(billing_plan, Some("personal") | Some("family") | Some("team"))
            && is_active,
        max_active_links: match billing_plan {
            Some("personal") => Some(5),
            Some("family") | Some("team") => None,
            _ => Some(0),
        },
    }
}

pub(crate) fn resolve_vault_sharing_entitlement(
    mode: &str,
    billing_plan: Option<&str>,
    billing_status: Option<&str>,
) -> VaultSharingEntitlement {
    if mode == SELF_HOSTED_MODE {
        return VaultSharingEntitlement {
            allowed: true,
            shared_vault_limit: None,
        };
    }

    let is_active = billing_status.map(billing_is_active).unwrap_or(false);

    match billing_plan {
        Some("family") if is_active => VaultSharingEntitlement {
            allowed: true,
            shared_vault_limit: Some(5),
        },
        Some("team") if is_active => VaultSharingEntitlement {
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
    billing_plan: Option<&str>,
    billing_status: Option<&str>,
) -> AttachmentEntitlement {
    if mode == SELF_HOSTED_MODE {
        return AttachmentEntitlement {
            enabled: true,
            max_file_size_bytes: None,
            storage_bytes: None,
        };
    }

    let is_active = billing_status.map(billing_is_active).unwrap_or(false);

    match billing_plan {
        Some("personal") if is_active => AttachmentEntitlement {
            enabled: true,
            max_file_size_bytes: Some(10 * MB),
            storage_bytes: Some(250 * MB),
        },
        Some("family") if is_active => AttachmentEntitlement {
            enabled: true,
            max_file_size_bytes: Some(25 * MB),
            storage_bytes: Some(GB),
        },
        Some("team") if is_active => AttachmentEntitlement {
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
    use crate::config::SELF_HOSTED_MODE;

    #[test]
    fn team_management_enabled_respects_mode_and_plan() {
        assert!(team_management_enabled(SELF_HOSTED_MODE, None, None));
        assert!(team_management_enabled("cloud", Some("team"), Some("active")));
        assert!(team_management_enabled("cloud", Some("family"), Some("trialing")));
        assert!(!team_management_enabled("cloud", Some("personal"), Some("active")));
        assert!(!team_management_enabled("cloud", Some("team"), Some("past_due")));
    }

    #[test]
    fn share_links_policy_keeps_personal_limit_when_inactive() {
        let active = resolve_share_links_policy("cloud", Some("personal"), Some("active"));
        assert!(active.enabled);
        assert_eq!(active.max_active_links, Some(5));

        let inactive =
            resolve_share_links_policy("cloud", Some("personal"), Some("past_due"));
        assert!(!inactive.enabled);
        assert_eq!(inactive.max_active_links, Some(5));

        let self_hosted = resolve_share_links_policy(SELF_HOSTED_MODE, None, None);
        assert!(self_hosted.enabled);
        assert_eq!(self_hosted.max_active_links, None);
    }

    #[test]
    fn vault_sharing_entitlement_matches_existing_plan_rules() {
        let family = resolve_vault_sharing_entitlement("cloud", Some("family"), Some("active"));
        assert!(family.allowed);
        assert_eq!(family.shared_vault_limit, Some(5));

        let team = resolve_vault_sharing_entitlement("cloud", Some("team"), Some("trialing"));
        assert!(team.allowed);
        assert_eq!(team.shared_vault_limit, None);

        let free = resolve_vault_sharing_entitlement("cloud", Some("free"), Some("active"));
        assert!(!free.allowed);
        assert_eq!(free.shared_vault_limit, Some(0));
    }

    #[test]
    fn attachment_entitlement_returns_expected_quotas() {
        let personal = resolve_attachment_entitlement("cloud", Some("personal"), Some("active"));
        assert!(personal.enabled);
        assert_eq!(personal.max_file_size_bytes, Some(10 * MB));
        assert_eq!(personal.storage_bytes, Some(250 * MB));

        let inactive = resolve_attachment_entitlement("cloud", Some("team"), Some("past_due"));
        assert!(!inactive.enabled);
        assert_eq!(inactive.max_file_size_bytes, Some(0));
        assert_eq!(inactive.storage_bytes, Some(0));

        let self_hosted = resolve_attachment_entitlement(SELF_HOSTED_MODE, None, None);
        assert!(self_hosted.enabled);
        assert_eq!(self_hosted.max_file_size_bytes, None);
        assert_eq!(self_hosted.storage_bytes, None);
    }
}