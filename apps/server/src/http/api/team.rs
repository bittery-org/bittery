use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::{IntoResponses, ToSchema};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::{
    db::enums::{
        InvitationStatus, ShareLinkAccessMode, ShareLinkStatus, TeamRole, TeamType, VaultRole,
        VaultType,
    },
    services::{
        access::{self, MemberAccessInput},
        team::{self, invitation_handlers, member_handlers},
    },
    shapes::{team_details_shape, team_summary_shape},
    AppState,
};

use super::{
    dto::{
        CursorPage, DecimalString, PageRequest, PatchField, PresignedUploadResponse,
        ProblemDetails, SuccessResponse,
    },
    error::ApiError,
    error_code::ErrorCode,
    extract::{ApiJson, ApiMergePatch, AuthenticatedRequest},
    idempotency,
    pagination::{page_values, ApiPageQuery},
    ORDINARY_API_BODY_LIMIT_BYTES,
};

macro_rules! request_dto {
    ($name:ident { $($(#[$meta:meta])* $field:ident: $type:ty),* $(,)? }) => {
        #[derive(Debug, Deserialize, ToSchema)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct $name {
            $($(#[$meta])* $field: $type),*
        }
    };
}

macro_rules! response_dto {
    ($name:ident from $source:ty { $($(#[$meta:meta])* $field:ident: $type:ty),* $(,)? }) => {
        #[derive(Debug, Serialize, ToSchema)]
        #[serde(rename_all = "camelCase")]
        struct $name {
            $($(#[$meta])* $field: $type),*
        }

        impl From<$source> for $name {
            fn from(value: $source) -> Self {
                Self { $($field: value.$field),* }
            }
        }
    };
}

request_dto!(CreateTeamRequest {
    name: String,
    team_type: Option<TeamType>,
});
request_dto!(UpdateTeamRequest {
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    name: PatchField<String>,
    #[serde(default)]
    #[schema(value_type = Option<String>)]
    image_key: PatchField<String>,
});
request_dto!(ImageUploadRequest {
    file_name: String,
    content_type: String,
});
request_dto!(PendingVaultKeyRequest {
    vault_id: String,
    #[schema(max_length = 65536)]
    encrypted_vault_key: String,
});
request_dto!(SendInvitationRequest {
    email: String,
    #[serde(default = "default_member_role")]
    role: TeamRole,
    #[schema(max_items = 100)]
    pending_vault_keys: Option<Vec<PendingVaultKeyRequest>>,
});
team_summary_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct TeamSummaryResponse
}, count = DecimalString);
team_summary_shape!(shape_from {
    team::TeamSummaryResponse => TeamSummaryResponse
}, count = DecimalString);

team_details_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct TeamDetailsResponse
}, count = DecimalString);
team_details_shape!(shape_from {
    team::TeamDetailsResponse => TeamDetailsResponse
}, count = DecimalString);
response_dto!(TeamVaultResponse from team::TeamVaultResponse {
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(max_length = 65536)]
    encrypted_vault_key: Option<String>,
});
response_dto!(TeamMemberResponse from team::TeamMemberResponse {
    user_id: String,
    name: String,
    email: String,
    role: TeamRole,
    joined_at: String,
});
response_dto!(InvitationDetailsResponse from team::TeamInvitationDetailsResponse {
    id: String,
    email: String,
    team_id: String,
    team_name: String,
    role: TeamRole,
    status: InvitationStatus,
    invited_by_name: String,
    expires_at: String,
    created_at: String,
});
response_dto!(PendingInvitationResponse from team::PendingTeamInvitationResponse {
    id: String,
    team_id: String,
    team_name: String,
    role: TeamRole,
    invited_by: String,
    expires_at: String,
});
response_dto!(InvitationListResponse from invitation_handlers::TeamInvitationListEntry {
    id: String,
    email: String,
    role: TeamRole,
    status: InvitationStatus,
    invited_by: String,
    created_at: String,
    expires_at: String,
});
response_dto!(SendInvitationResponse from team::SendInvitationResponse {
    invitation_id: String,
    token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    existing_user_public_key: Option<String>,
});
response_dto!(ResendInvitationResponse from team::ResendInvitationResponse {
    invitation_id: String,
    token: String,
});
response_dto!(AcceptInvitationResponse from team::AcceptInvitationResponse {
    team_id: String,
    team_name: String,
});

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct MemberVaultAccessResponse {
    id: String,
    name: String,
    vault_type: VaultType,
    role: VaultRole,
    granted_at: String,
    item_count: u32,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct MemberDeviceResponse {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    platform: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    browser_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    os_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    masked_ip: Option<String>,
    created_at: String,
    last_active_at: String,
    expires_at: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct MemberShareLinkResponse {
    id: String,
    item_id: String,
    status: ShareLinkStatus,
    access_mode: ShareLinkAccessMode,
    access_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_access_count: Option<u32>,
    expires_at: String,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_accessed_at: Option<String>,
    is_expired: bool,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct MemberAccessResponse {
    #[schema(max_items = 500)]
    vaults: Vec<MemberVaultAccessResponse>,
    #[schema(max_items = 500)]
    devices: Vec<MemberDeviceResponse>,
    #[schema(max_items = 100)]
    share_links: Vec<MemberShareLinkResponse>,
    share_link_total: u32,
    active_share_link_count: u32,
}

impl From<access::MemberAccessResponse> for MemberAccessResponse {
    fn from(value: access::MemberAccessResponse) -> Self {
        Self {
            vaults: value
                .vaults
                .into_iter()
                .map(|item| MemberVaultAccessResponse {
                    id: item.id,
                    name: item.name,
                    vault_type: item.vault_type,
                    role: item.role,
                    granted_at: item.granted_at,
                    item_count: item.item_count,
                })
                .collect(),
            devices: value
                .devices
                .into_iter()
                .map(|item| MemberDeviceResponse {
                    id: item.id,
                    device_name: item.device_name,
                    platform: item.platform,
                    browser_name: item.browser_name,
                    os_name: item.os_name,
                    masked_ip: item.masked_ip,
                    created_at: item.created_at,
                    last_active_at: item.last_active_at,
                    expires_at: item.expires_at,
                })
                .collect(),
            share_links: value
                .share_links
                .into_iter()
                .map(|item| MemberShareLinkResponse {
                    id: item.id,
                    item_id: item.item_id,
                    status: item.status,
                    access_mode: item.access_mode,
                    access_count: item.access_count,
                    max_access_count: item.max_access_count,
                    expires_at: item.expires_at,
                    created_at: item.created_at,
                    last_accessed_at: item.last_accessed_at,
                    is_expired: item.is_expired,
                })
                .collect(),
            share_link_total: value.share_link_total,
            active_share_link_count: value.active_share_link_count,
        }
    }
}

#[derive(IntoResponses)]
#[allow(dead_code)]
enum TeamErrorResponses {
    #[response(
        status = 400,
        description = "Bad request",
        content_type = "application/problem+json"
    )]
    BadRequest(ProblemDetails),
    #[response(
        status = 401,
        description = "Authentication required",
        content_type = "application/problem+json"
    )]
    Unauthorized(ProblemDetails),
    #[response(
        status = 403,
        description = "Forbidden",
        content_type = "application/problem+json"
    )]
    Forbidden(ProblemDetails),
    #[response(
        status = 404,
        description = "Not found",
        content_type = "application/problem+json"
    )]
    NotFound(ProblemDetails),
    #[response(
        status = 415,
        description = "Unsupported media type",
        content_type = "application/problem+json"
    )]
    UnsupportedMediaType(ProblemDetails),
    #[response(
        status = 409,
        description = "Conflict",
        content_type = "application/problem+json"
    )]
    Conflict(ProblemDetails),
    #[response(
        status = 429,
        description = "Rate limited",
        content_type = "application/problem+json",
        headers(("Retry-After" = String, description = "Seconds before retrying"))
    )]
    RateLimited(ProblemDetails),
    #[response(
        status = 500,
        description = "Internal error",
        content_type = "application/problem+json"
    )]
    Internal(ProblemDetails),
}

fn default_member_role() -> TeamRole {
    TeamRole::Member
}

#[utoipa::path(get, path = "/teams/current", operation_id = "getCurrentTeam", tag = "teams", responses((status = 200, body = TeamSummaryResponse), TeamErrorResponses))]
async fn current_team(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
) -> Result<Json<TeamSummaryResponse>, ApiError> {
    Ok(Json(
        team::list_teams(&state.db_pool, &request.session.user_id)
            .await?
            .into(),
    ))
}

#[utoipa::path(get, path = "/teams/{teamId}", operation_id = "getTeam", tag = "teams", params(("teamId" = String, Path)), responses((status = 200, body = TeamDetailsResponse), TeamErrorResponses))]
async fn get_team(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    Path(team_id): Path<String>,
) -> Result<Json<TeamDetailsResponse>, ApiError> {
    Ok(Json(
        team::get_team(
            &state.db_pool,
            &request.session.user_id,
            team::TeamIdInput { team_id },
        )
        .await?
        .into(),
    ))
}

#[utoipa::path(get, path = "/teams/{teamId}/vaults", operation_id = "listTeamVaults", tag = "teams", params(("teamId" = String, Path), PageRequest), responses((status = 200, body = CursorPage<TeamVaultResponse>), TeamErrorResponses))]
async fn list_team_vaults(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    Path(team_id): Path<String>,
    ApiPageQuery(page): ApiPageQuery,
) -> Result<Json<CursorPage<TeamVaultResponse>>, ApiError> {
    let values: Vec<TeamVaultResponse> = team::get_team_vaults(
        &state.db_pool,
        &request.session.user_id,
        team::TeamIdInput {
            team_id: team_id.clone(),
        },
    )
    .await?
    .into_iter()
    .map(Into::into)
    .collect();
    Ok(Json(page_values(
        values,
        &page,
        &request.session.user_id,
        "team-vaults",
        &team_id,
        |vault| vault.id.clone(),
    )?))
}

#[utoipa::path(post, path = "/teams", operation_id = "createTeam", tag = "teams", request_body = CreateTeamRequest, responses((status = 200, body = SuccessResponse), TeamErrorResponses))]
async fn create_team(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    ApiJson(body): ApiJson<CreateTeamRequest>,
) -> Result<Json<SuccessResponse>, ApiError> {
    Ok(Json(
        team::create_team(
            &state.db_pool,
            &request.session.user_id,
            team::CreateTeamInput {
                name: body.name,
                team_type: body.team_type,
            },
        )
        .await?
        .into(),
    ))
}

#[utoipa::path(patch, path = "/teams/{teamId}", operation_id = "updateTeam", tag = "teams", params(("teamId" = String, Path)), request_body(content = UpdateTeamRequest, content_type = "application/merge-patch+json"), responses((status = 200, body = SuccessResponse), TeamErrorResponses))]
async fn update_team(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    Path(team_id): Path<String>,
    ApiMergePatch(body): ApiMergePatch<UpdateTeamRequest>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let name = match body.name {
        PatchField::Missing => None,
        PatchField::Value(value) => Some(value),
        PatchField::Null => {
            return Err(ApiError::bad_request(
                ErrorCode::FieldCannotBeCleared,
                "/name cannot be null.",
            ))
        }
    };
    let image_key = match body.image_key {
        PatchField::Missing => None,
        PatchField::Null => Some(None),
        PatchField::Value(value) => Some(Some(value)),
    };
    Ok(Json(
        team::update_team(
            &state.db_pool,
            &request.session.user_id,
            team::UpdateTeamInput {
                team_id,
                name,
                image_key,
            },
        )
        .await?
        .into(),
    ))
}

#[utoipa::path(post, path = "/teams/{teamId}/image-uploads", operation_id = "createTeamImageUpload", tag = "teams", params(("teamId" = String, Path)), request_body = ImageUploadRequest, responses((status = 200, body = PresignedUploadResponse), TeamErrorResponses))]
async fn create_image_upload(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    Path(team_id): Path<String>,
    ApiJson(body): ApiJson<ImageUploadRequest>,
) -> Result<Json<PresignedUploadResponse>, ApiError> {
    Ok(Json(
        team::create_team_image_upload(
            &state.db_pool,
            &request.session.user_id,
            team::CreateImageUploadInput {
                team_id,
                file_name: body.file_name,
                content_type: body.content_type,
            },
        )
        .await?
        .into(),
    ))
}

#[utoipa::path(delete, path = "/teams/{teamId}", operation_id = "deleteTeam", tag = "teams", params(("teamId" = String, Path)), responses((status = 200, body = SuccessResponse), TeamErrorResponses))]
async fn delete_team(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    Path(team_id): Path<String>,
) -> Result<Json<SuccessResponse>, ApiError> {
    Ok(Json(
        team::delete_team(
            &state.db_pool,
            &request.session.user_id,
            team::TeamIdInput { team_id },
        )
        .await?
        .into(),
    ))
}

#[utoipa::path(get, path = "/public/team-invitations/{token}", operation_id = "getTeamInvitation", tag = "team-invitations", params(("token" = String, Path)), responses((status = 200, body = InvitationDetailsResponse), TeamErrorResponses))]
async fn invitation_by_token(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<InvitationDetailsResponse>, ApiError> {
    Ok(Json(
        team::get_invitation_by_token(&state.db_pool, team::TokenInput { token })
            .await?
            .into(),
    ))
}

#[utoipa::path(get, path = "/users/me/team-invitations", operation_id = "listMyTeamInvitations", tag = "team-invitations", params(PageRequest), responses((status = 200, body = CursorPage<PendingInvitationResponse>), TeamErrorResponses))]
async fn pending_invitations(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    ApiPageQuery(page): ApiPageQuery,
) -> Result<Json<CursorPage<PendingInvitationResponse>>, ApiError> {
    let values: Vec<PendingInvitationResponse> =
        team::get_pending_invitations(&state.db_pool, &request.session.user_id)
            .await?
            .into_iter()
            .map(Into::into)
            .collect();
    Ok(Json(page_values(
        values,
        &page,
        &request.session.user_id,
        "pending-invitations",
        "",
        |invitation| invitation.id.clone(),
    )?))
}

#[utoipa::path(get, path = "/teams/{teamId}/invitations", operation_id = "listTeamInvitations", tag = "team-invitations", params(("teamId" = String, Path), PageRequest), responses((status = 200, body = CursorPage<InvitationListResponse>), TeamErrorResponses))]
async fn list_invitations(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    Path(team_id): Path<String>,
    ApiPageQuery(page): ApiPageQuery,
) -> Result<Json<CursorPage<InvitationListResponse>>, ApiError> {
    let values: Vec<InvitationListResponse> = invitation_handlers::list_team_invitations(
        &state.db_pool,
        &request.session.user_id,
        team::TeamIdInput {
            team_id: team_id.clone(),
        },
    )
    .await?
    .into_iter()
    .map(Into::into)
    .collect();
    Ok(Json(page_values(
        values,
        &page,
        &request.session.user_id,
        "team-invitations",
        &team_id,
        |invitation| invitation.id.clone(),
    )?))
}

#[utoipa::path(post, path = "/teams/{teamId}/invitations", operation_id = "sendTeamInvitation", tag = "team-invitations", params(("teamId" = String, Path), ("Idempotency-Key" = Option<String>, Header, description = "Not accepted because this operation returns a one-time secret")), request_body = SendInvitationRequest, responses((status = 200, body = SendInvitationResponse), (status = 422, description = "Idempotency is not allowed for one-time-secret responses", body = ProblemDetails, content_type = "application/problem+json"), TeamErrorResponses))]
async fn send_invitation(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    headers: HeaderMap,
    Path(team_id): Path<String>,
    ApiJson(body): ApiJson<SendInvitationRequest>,
) -> Result<Json<SendInvitationResponse>, ApiError> {
    idempotency::reject_one_time_secret(&headers)?;
    let pending_vault_keys = body.pending_vault_keys.map(|entries| {
        entries
            .into_iter()
            .map(|entry| team::PendingVaultKeyEntry {
                vault_id: entry.vault_id,
                encrypted_vault_key: entry.encrypted_vault_key,
            })
            .collect()
    });
    Ok(Json(
        team::send_invitation(
            &state.db_pool,
            &request.session.user_id,
            team::SendInvitationInput {
                team_id,
                email: body.email,
                role: body.role,
                pending_vault_keys,
            },
        )
        .await?
        .into(),
    ))
}

#[utoipa::path(post, path = "/public/team-invitations/{token}/accept", operation_id = "acceptTeamInvitation", tag = "team-invitations", params(("token" = String, Path)), responses((status = 200, body = AcceptInvitationResponse), TeamErrorResponses))]
async fn accept_invitation(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    Path(token): Path<String>,
) -> Result<Json<AcceptInvitationResponse>, ApiError> {
    Ok(Json(
        team::accept_invitation(
            &state.db_pool,
            &request.session.user_id,
            team::TokenInput { token },
        )
        .await?
        .into(),
    ))
}

#[utoipa::path(post, path = "/users/me/team-invitations/{invitationId}/accept", operation_id = "acceptTeamInvitationById", tag = "team-invitations", params(("invitationId" = String, Path)), responses((status = 200, body = AcceptInvitationResponse), TeamErrorResponses))]
async fn accept_invitation_by_id(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    Path(invitation_id): Path<String>,
) -> Result<Json<AcceptInvitationResponse>, ApiError> {
    Ok(Json(
        team::accept_invitation_by_id(
            &state.db_pool,
            &request.session.user_id,
            team::InvitationIdInput { invitation_id },
        )
        .await?
        .into(),
    ))
}

#[utoipa::path(post, path = "/public/team-invitations/{token}/decline", operation_id = "declineTeamInvitation", tag = "team-invitations", params(("token" = String, Path)), responses((status = 200, body = SuccessResponse), TeamErrorResponses))]
async fn decline_invitation(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    Path(token): Path<String>,
) -> Result<Json<SuccessResponse>, ApiError> {
    Ok(Json(
        team::decline_invitation(
            &state.db_pool,
            &request.session.user_id,
            team::TokenInput { token },
        )
        .await?
        .into(),
    ))
}

#[utoipa::path(post, path = "/users/me/team-invitations/{invitationId}/decline", operation_id = "declineTeamInvitationById", tag = "team-invitations", params(("invitationId" = String, Path)), responses((status = 200, body = SuccessResponse), TeamErrorResponses))]
async fn decline_invitation_by_id(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    Path(invitation_id): Path<String>,
) -> Result<Json<SuccessResponse>, ApiError> {
    Ok(Json(
        team::decline_invitation_by_id(
            &state.db_pool,
            &request.session.user_id,
            team::InvitationIdInput { invitation_id },
        )
        .await?
        .into(),
    ))
}

#[utoipa::path(delete, path = "/teams/{teamId}/invitations/{invitationId}", operation_id = "cancelTeamInvitation", tag = "team-invitations", params(("teamId" = String, Path), ("invitationId" = String, Path)), responses((status = 200, body = SuccessResponse), TeamErrorResponses))]
async fn cancel_invitation(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    Path((_team_id, invitation_id)): Path<(String, String)>,
) -> Result<Json<SuccessResponse>, ApiError> {
    Ok(Json(
        team::cancel_invitation(
            &state.db_pool,
            &request.session.user_id,
            team::InvitationIdInput { invitation_id },
        )
        .await?
        .into(),
    ))
}

#[utoipa::path(post, path = "/teams/{teamId}/invitations/{invitationId}/resend", operation_id = "resendTeamInvitation", tag = "team-invitations", params(("teamId" = String, Path), ("invitationId" = String, Path), ("Idempotency-Key" = Option<String>, Header, description = "Not accepted because this operation returns a one-time secret")), responses((status = 200, body = ResendInvitationResponse), (status = 422, description = "Idempotency is not allowed for one-time-secret responses", body = ProblemDetails, content_type = "application/problem+json"), TeamErrorResponses))]
async fn resend_invitation(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    headers: HeaderMap,
    Path((_team_id, invitation_id)): Path<(String, String)>,
) -> Result<Json<ResendInvitationResponse>, ApiError> {
    idempotency::reject_one_time_secret(&headers)?;
    Ok(Json(
        team::resend_invitation(
            &state.db_pool,
            &request.session.user_id,
            team::InvitationIdInput { invitation_id },
        )
        .await?
        .into(),
    ))
}

#[utoipa::path(get, path = "/teams/{teamId}/members", operation_id = "listTeamMembers", tag = "team-members", params(("teamId" = String, Path), PageRequest), responses((status = 200, body = CursorPage<TeamMemberResponse>), TeamErrorResponses))]
async fn list_members(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    Path(team_id): Path<String>,
    ApiPageQuery(page): ApiPageQuery,
) -> Result<Json<CursorPage<TeamMemberResponse>>, ApiError> {
    let values: Vec<TeamMemberResponse> = member_handlers::list_team_members(
        &state.db_pool,
        &request.session.user_id,
        team::TeamIdInput {
            team_id: team_id.clone(),
        },
    )
    .await?
    .into_iter()
    .map(Into::into)
    .collect();
    Ok(Json(page_values(
        values,
        &page,
        &request.session.user_id,
        "team-members",
        &team_id,
        |member| member.user_id.clone(),
    )?))
}

#[utoipa::path(get, path = "/teams/{teamId}/members/{userId}/access", operation_id = "getTeamMemberAccess", tag = "team-members", params(("teamId" = String, Path), ("userId" = String, Path)), responses((status = 200, body = MemberAccessResponse), TeamErrorResponses))]
async fn member_access(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    Path((_team_id, user_id)): Path<(String, String)>,
) -> Result<Json<MemberAccessResponse>, ApiError> {
    Ok(Json(
        access::get_member_access(
            &state.db_pool,
            &request.session.user_id,
            MemberAccessInput { user_id },
        )
        .await?
        .into(),
    ))
}

pub(crate) fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(current_team))
        .routes(routes!(get_team))
        .routes(routes!(list_team_vaults))
        .routes(routes!(create_team))
        .routes(routes!(update_team))
        .routes(routes!(create_image_upload))
        .routes(routes!(delete_team))
        .routes(routes!(invitation_by_token))
        .routes(routes!(pending_invitations))
        .routes(routes!(list_invitations))
        .routes(routes!(send_invitation))
        .routes(routes!(accept_invitation))
        .routes(routes!(accept_invitation_by_id))
        .routes(routes!(decline_invitation))
        .routes(routes!(decline_invitation_by_id))
        .routes(routes!(cancel_invitation))
        .routes(routes!(resend_invitation))
        .routes(routes!(list_members))
        .routes(routes!(member_access))
        .route_layer(DefaultBodyLimit::max(ORDINARY_API_BODY_LIMIT_BYTES))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{router, UpdateTeamRequest};
    use crate::http::api::dto::PatchField;

    #[test]
    fn all_used_team_operations_are_registered() {
        let document = serde_json::to_value(router().split_for_parts().1).unwrap();
        let operation_count = document["paths"]
            .as_object()
            .unwrap()
            .values()
            .map(|path| path.as_object().unwrap().len())
            .sum::<usize>();
        assert_eq!(operation_count, 19);
        let serialized = document.to_string();
        assert!(!serialized.contains("deleteTeamAccount"));
        assert!(!serialized.contains("delete-account"));
    }

    #[test]
    fn update_team_preserves_patch_tristate_and_rejects_unknown_fields() {
        let missing: UpdateTeamRequest = serde_json::from_value(json!({})).unwrap();
        assert!(matches!(missing.image_key, PatchField::Missing));
        let null: UpdateTeamRequest = serde_json::from_value(json!({ "imageKey": null })).unwrap();
        assert!(matches!(null.image_key, PatchField::Null));
        let value: UpdateTeamRequest =
            serde_json::from_value(json!({ "imageKey": "team/key" })).unwrap();
        assert_eq!(value.image_key, PatchField::Value("team/key".to_string()));
        assert!(serde_json::from_value::<UpdateTeamRequest>(json!({ "unknown": true })).is_err());
    }
}
