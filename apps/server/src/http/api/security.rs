use std::collections::BTreeMap;

use utoipa::openapi::{
    path::Operation,
    security::{HttpAuthScheme, HttpBuilder, SecurityRequirement, SecurityScheme},
    OpenApi,
};

pub(super) const BEARER_AUTH_SCHEME: &str = "bearerAuth";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OperationSecurity {
    Public,
    Bearer,
}

// Contract generation fails until every new operation makes a deliberate public-or-bearer choice.
const OPERATION_SECURITY: &[(&str, OperationSecurity)] = &[
    ("abandonVaultKeyRotationPlan", OperationSecurity::Bearer),
    (
        "createVaultMemberRemovalRotationPlans",
        OperationSecurity::Bearer,
    ),
    (
        "finalizeVaultMemberRemovalRotationPlans",
        OperationSecurity::Bearer,
    ),
    ("createTeamLeaveRotationPlans", OperationSecurity::Bearer),
    ("finalizeTeamLeaveRotationPlans", OperationSecurity::Bearer),
    (
        "createTeamMemberRemovalRotationPlans",
        OperationSecurity::Bearer,
    ),
    (
        "finalizeTeamMemberRemovalRotationPlans",
        OperationSecurity::Bearer,
    ),
    (
        "getVaultKeyRotationPreparationPage",
        OperationSecurity::Bearer,
    ),
    ("stageVaultKeyRotationOutputs", OperationSecurity::Bearer),
    ("getApiMetadata", OperationSecurity::Public),
    ("deleteAttachment", OperationSecurity::Bearer),
    ("updateAttachment", OperationSecurity::Bearer),
    ("createAttachmentDownloadUrl", OperationSecurity::Bearer),
    ("listAuditEvents", OperationSecurity::Bearer),
    ("check_email", OperationSecurity::Public),
    ("start_login", OperationSecurity::Public),
    ("finish_login", OperationSecurity::Public),
    ("listCurrentUserVaultKeys", OperationSecurity::Bearer),
    ("recovery_data", OperationSecurity::Public),
    ("reset_password", OperationSecurity::Public),
    ("request_recovery_verification", OperationSecurity::Public),
    ("verify_recovery", OperationSecurity::Public),
    ("getRegistrationStatus", OperationSecurity::Public),
    ("request_signup_verification", OperationSecurity::Public),
    ("verify_signup_verification", OperationSecurity::Public),
    ("signup", OperationSecurity::Public),
    ("getAttachmentUsage", OperationSecurity::Bearer),
    ("createBillingCheckoutSession", OperationSecurity::Bearer),
    ("getBillingEntitlements", OperationSecurity::Bearer),
    ("createBillingPortalSession", OperationSecurity::Bearer),
    ("getBillingStatus", OperationSecurity::Bearer),
    ("previewAdditionalTeamSeat", OperationSecurity::Bearer),
    ("listAllItems", OperationSecurity::Bearer),
    ("listAllTrashedItems", OperationSecurity::Bearer),
    ("getItem", OperationSecurity::Bearer),
    ("trashItem", OperationSecurity::Bearer),
    ("updateItem", OperationSecurity::Bearer),
    ("createAttachmentUpload", OperationSecurity::Bearer),
    ("listAttachments", OperationSecurity::Bearer),
    ("createAttachment", OperationSecurity::Bearer),
    ("setItemFavorite", OperationSecurity::Bearer),
    ("moveItem", OperationSecurity::Bearer),
    ("permanentlyDeleteItem", OperationSecurity::Bearer),
    ("restoreItem", OperationSecurity::Bearer),
    ("listItemShareLinks", OperationSecurity::Bearer),
    ("createShareLink", OperationSecurity::Bearer),
    ("getPublicShareInfo", OperationSecurity::Public),
    ("accessPublicShare", OperationSecurity::Public),
    ("verifyShareEmailAndAccess", OperationSecurity::Public),
    ("requestShareEmailVerification", OperationSecurity::Public),
    ("getTeamInvitation", OperationSecurity::Public),
    ("acceptTeamInvitation", OperationSecurity::Bearer),
    ("declineTeamInvitation", OperationSecurity::Bearer),
    ("list_sessions", OperationSecurity::Bearer),
    ("refresh_session", OperationSecurity::Bearer),
    ("revoke_session", OperationSecurity::Bearer),
    ("rename_session", OperationSecurity::Bearer),
    ("revokeShareLink", OperationSecurity::Bearer),
    ("listShareAccessLogs", OperationSecurity::Bearer),
    ("bootstrapSync", OperationSecurity::Bearer),
    ("getSyncChanges", OperationSecurity::Bearer),
    ("streamSyncEvents", OperationSecurity::Bearer),
    ("createTeam", OperationSecurity::Bearer),
    ("getCurrentTeam", OperationSecurity::Bearer),
    ("getTeam", OperationSecurity::Bearer),
    ("deleteTeam", OperationSecurity::Bearer),
    ("updateTeam", OperationSecurity::Bearer),
    ("createTeamImageUpload", OperationSecurity::Bearer),
    ("listTeamInvitations", OperationSecurity::Bearer),
    ("sendTeamInvitation", OperationSecurity::Bearer),
    ("cancelTeamInvitation", OperationSecurity::Bearer),
    ("resendTeamInvitation", OperationSecurity::Bearer),
    ("listTeamMembers", OperationSecurity::Bearer),
    ("getTeamMemberAccess", OperationSecurity::Bearer),
    ("listTeamVaults", OperationSecurity::Bearer),
    ("getTravelMode", OperationSecurity::Bearer),
    ("disableTravelMode", OperationSecurity::Bearer),
    ("enableTravelMode", OperationSecurity::Bearer),
    ("setTravelModeHiddenVaults", OperationSecurity::Bearer),
    ("me", OperationSecurity::Bearer),
    ("delete_account", OperationSecurity::Bearer),
    ("update_email", OperationSecurity::Bearer),
    ("change_password", OperationSecurity::Bearer),
    ("store_recovery_key", OperationSecurity::Bearer),
    ("regenerate_secret_key", OperationSecurity::Bearer),
    ("listMyTeamInvitations", OperationSecurity::Bearer),
    ("acceptTeamInvitationById", OperationSecurity::Bearer),
    ("declineTeamInvitationById", OperationSecurity::Bearer),
    ("getVaultStats", OperationSecurity::Bearer),
    ("listVaults", OperationSecurity::Bearer),
    ("getVault", OperationSecurity::Bearer),
    ("createVault", OperationSecurity::Bearer),
    ("deleteVault", OperationSecurity::Bearer),
    ("updateVault", OperationSecurity::Bearer),
    ("listAvailableTeamMembers", OperationSecurity::Bearer),
    ("createVaultImageUpload", OperationSecurity::Bearer),
    ("bulkImportItems", OperationSecurity::Bearer),
    ("listVaultItems", OperationSecurity::Bearer),
    ("listTrashedVaultItems", OperationSecurity::Bearer),
    ("createItem", OperationSecurity::Bearer),
    ("listVaultMembers", OperationSecurity::Bearer),
    ("addVaultMember", OperationSecurity::Bearer),
    ("updateVaultMemberRole", OperationSecurity::Bearer),
    ("convertVaultType", OperationSecurity::Bearer),
];

pub(super) fn apply_security_contract(openapi: &mut OpenApi) {
    openapi
        .components
        .get_or_insert_default()
        .add_security_scheme(
            BEARER_AUTH_SCHEME,
            SecurityScheme::Http(
                HttpBuilder::new()
                    .scheme(HttpAuthScheme::Bearer)
                    .bearer_format("opaque session token")
                    .description(Some(
                        "Device-session bearer token. Client metadata headers are not credentials."
                            .to_string(),
                    ))
                    .build(),
            ),
        );

    let mut classifications = BTreeMap::new();
    for (operation_id, security) in OPERATION_SECURITY {
        assert!(
            classifications.insert(*operation_id, *security).is_none(),
            "duplicate API security classification for {operation_id}"
        );
    }

    for path_item in openapi.paths.paths.values_mut() {
        for operation in [
            &mut path_item.get,
            &mut path_item.put,
            &mut path_item.post,
            &mut path_item.delete,
            &mut path_item.options,
            &mut path_item.head,
            &mut path_item.patch,
            &mut path_item.trace,
        ]
        .into_iter()
        .flatten()
        {
            classify_operation(operation, &mut classifications);
        }
    }

    assert!(
        classifications.is_empty(),
        "security classifications reference undocumented operations: {:?}",
        classifications.keys().collect::<Vec<_>>()
    );
}

fn classify_operation(
    operation: &mut Operation,
    classifications: &mut BTreeMap<&str, OperationSecurity>,
) {
    let operation_id = operation
        .operation_id
        .as_deref()
        .expect("every API operation must have an operationId");
    let security = classifications
        .remove(operation_id)
        .unwrap_or_else(|| panic!("API operation {operation_id} has no security classification"));
    operation.security = Some(vec![match security {
        OperationSecurity::Public => SecurityRequirement::default(),
        OperationSecurity::Bearer => {
            SecurityRequirement::new(BEARER_AUTH_SCHEME, std::iter::empty::<String>())
        }
    }]);
}
