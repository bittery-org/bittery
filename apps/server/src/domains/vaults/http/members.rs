use super::*;

#[utoipa::path(get, path = "/vaults/{vaultId}/members", operation_id = "listVaultMembers", tag = "vault-members", params(("vaultId" = String, Path), PageRequest), responses((status = 200, description = "Success", body = CursorPage<VaultMemberResponse>), VaultErrorResponses))]
pub(super) async fn list_members(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(vault_id): Path<String>,
    ApiPageQuery(page): ApiPageQuery,
) -> Result<Json<CursorPage<VaultMemberResponse>>, ApiError> {
    let pool = &state.db_pool;
    let values = vault::list_vault_members(
        pool,
        &auth.session.user_id,
        vault::VaultIdInput {
            vault_id: vault_id.clone(),
        },
    )
    .await?;
    let values: Vec<VaultMemberResponse> = values.into_iter().map(Into::into).collect();
    Ok(Json(page_values(
        values,
        &page,
        CursorContext::new(
            &auth.session.user_id,
            "vault-members",
            &vault_id,
            &state.config.auth.jwt_secret,
        ),
        |member| member.user_id.clone(),
    )?))
}

#[utoipa::path(get, path = "/vaults/{vaultId}/available-team-members", operation_id = "listAvailableTeamMembers", tag = "vault-members", params(("vaultId" = String, Path), PageRequest), responses((status = 200, description = "Success", body = CursorPage<VaultAvailableMemberResponse>), VaultErrorResponses))]
pub(super) async fn available_team_members(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(vault_id): Path<String>,
    ApiPageQuery(page): ApiPageQuery,
) -> Result<Json<CursorPage<VaultAvailableMemberResponse>>, ApiError> {
    let pool = &state.db_pool;
    let values = vault::available_team_members(
        pool,
        state.config.server.mode,
        &auth.session.user_id,
        vault::VaultIdInput {
            vault_id: vault_id.clone(),
        },
    )
    .await?;
    let values: Vec<VaultAvailableMemberResponse> = values.into_iter().map(Into::into).collect();
    Ok(Json(page_values(
        values,
        &page,
        CursorContext::new(
            &auth.session.user_id,
            "available-vault-members",
            &vault_id,
            &state.config.auth.jwt_secret,
        ),
        |member| member.user_id.clone(),
    )?))
}

#[utoipa::path(put, path = "/vaults/{vaultId}/members/{userId}", operation_id = "addVaultMember", tag = "vault-members", params(("vaultId" = String, Path), ("userId" = String, Path)), request_body = AddVaultMemberBody, responses((status = 200, description = "Success", body = SuccessResponse), VaultErrorResponses))]
pub(super) async fn add_member(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path((vault_id, user_id)): Path<(String, String)>,
    ApiJson(body): ApiJson<AddVaultMemberBody>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let pool = &state.db_pool;
    let result = vault::add_vault_member(
        pool,
        state.config.server.mode,
        &auth.session.user_id,
        auth.effective_client_id().as_deref(),
        vault::AddVaultMemberInput {
            vault_id,
            user_id,
            role: body.role,
            encrypted_vault_key: body.encrypted_vault_key,
            client_id: auth.effective_client_id(),
        },
    )
    .await
    .notify_sync(&state)?;
    Ok(Json(result.into()))
}

#[utoipa::path(patch, path = "/vaults/{vaultId}/members/{userId}", operation_id = "updateVaultMemberRole", tag = "vault-members", params(("vaultId" = String, Path), ("userId" = String, Path)), request_body(content = UpdateVaultMemberRoleBody, content_type = "application/merge-patch+json"), responses((status = 200, description = "Success", body = SuccessResponse), VaultErrorResponses))]
pub(super) async fn update_member_role(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path((vault_id, user_id)): Path<(String, String)>,
    ApiMergePatch(body): ApiMergePatch<UpdateVaultMemberRoleBody>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let pool = &state.db_pool;
    let result = vault::update_vault_member_role(
        pool,
        state.config.server.mode,
        &auth.session.user_id,
        vault::UpdateVaultMemberRoleInput {
            vault_id,
            user_id,
            role: body.role,
        },
    )
    .await
    .notify_sync(&state)?;
    Ok(Json(result.into()))
}
