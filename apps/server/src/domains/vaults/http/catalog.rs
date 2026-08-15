use super::*;

#[utoipa::path(get, path = "/vaults", operation_id = "listVaults", tag = "vaults", params(PageRequest), responses((status = 200, description = "Success", body = CursorPage<VaultListEntryResponse>), VaultErrorResponses))]
pub(super) async fn list_vaults(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    ApiPageQuery(page): ApiPageQuery,
) -> Result<Json<CursorPage<VaultListEntryResponse>>, ApiError> {
    let pool = &state.db_pool;
    let cursor = decode_page_key(
        &page,
        CursorContext::new(
            &auth.session.user_id,
            "vaults",
            "",
            &state.config.auth.jwt_secret,
        ),
    )?;
    let values = vault::list_vaults_page(
        pool,
        state.object_storage.as_ref(),
        &auth.session.user_id,
        cursor.as_deref(),
        query_limit(&page)?,
    )
    .await?;
    let source_has_more = values.has_more;
    let values: Vec<VaultListEntryResponse> = values.values.into_iter().map(Into::into).collect();
    Ok(Json(page_prefetched_with_more(
        values,
        source_has_more,
        &page,
        CursorContext::new(
            &auth.session.user_id,
            "vaults",
            "",
            &state.config.auth.jwt_secret,
        ),
        |vault| vault.id.clone(),
    )?))
}

#[utoipa::path(get, path = "/vaults/{vaultId}", operation_id = "getVault", tag = "vaults", params(("vaultId" = String, Path)), responses((status = 200, description = "Success", body = VaultDetailsResponseDto), VaultErrorResponses))]
pub(super) async fn get_vault(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(vault_id): Path<String>,
) -> Result<Json<VaultDetailsResponseDto>, ApiError> {
    let pool = &state.db_pool;
    Ok(Json(
        vault::get_vault(
            pool,
            state.object_storage.as_ref(),
            &auth.session.user_id,
            vault::VaultIdInput { vault_id },
        )
        .await?
        .into(),
    ))
}

#[utoipa::path(put, path = "/vaults/{vaultId}", operation_id = "createVault", tag = "vaults", params(("vaultId" = String, Path)), request_body = CreateVaultBody, responses((status = 200, description = "Success", body = CreateVaultResponse), VaultErrorResponses))]
pub(super) async fn create_vault(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(vault_id): Path<String>,
    ApiJson(body): ApiJson<CreateVaultBody>,
) -> Result<Json<CreateVaultResponse>, ApiError> {
    let pool = &state.db_pool;
    let result = vault::create_vault(
        pool,
        state.config.server.mode,
        &auth.session.user_id,
        auth.effective_client_id().as_deref(),
        vault::CreateVaultInput {
            vault_id: Some(vault_id),
            name: body.name,
            vault_type: body.vault_type,
            encrypted_vault_key: body.encrypted_vault_key,
            icon: body.icon,
            image_key: body.image_key,
            client_id: auth.effective_client_id(),
        },
    )
    .await
    .notify_sync(&state)?;
    Ok(Json(result.into()))
}

#[utoipa::path(patch, path = "/vaults/{vaultId}", operation_id = "updateVault", tag = "vaults", params(("vaultId" = String, Path)), request_body(content = UpdateVaultBody, content_type = "application/merge-patch+json"), responses((status = 200, description = "Success", body = UpdateVaultResponse), VaultErrorResponses))]
pub(super) async fn update_vault(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(vault_id): Path<String>,
    ApiMergePatch(body): ApiMergePatch<UpdateVaultBody>,
) -> Result<Json<UpdateVaultResponse>, ApiError> {
    let name = optional_patch_value(body.name, "/name")?;
    let icon = nullable_patch_value(body.icon);
    let image_key = nullable_patch_value(body.image_key);
    let pool = &state.db_pool;
    let result = vault::update_vault(
        pool,
        state.object_storage.as_ref(),
        &auth.session.user_id,
        auth.effective_client_id().as_deref(),
        vault::UpdateVaultInput {
            vault_id,
            name,
            icon,
            image_key,
            client_id: auth.effective_client_id(),
        },
    )
    .await
    .notify_sync(&state)?;
    Ok(Json(result.into()))
}

#[utoipa::path(post, path = "/vaults/{vaultId}/type-conversions", operation_id = "convertVaultType", tag = "vaults", params(("vaultId" = String, Path)), request_body = ConvertVaultBody, responses((status = 200, description = "Success", body = ConvertVaultTypeResponse), VaultErrorResponses))]
pub(super) async fn convert_vault(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(vault_id): Path<String>,
    ApiJson(body): ApiJson<ConvertVaultBody>,
) -> Result<Json<ConvertVaultTypeResponse>, ApiError> {
    let pool = &state.db_pool;
    let result = vault::convert_vault_type(
        pool,
        state.config.server.mode,
        &auth.session.user_id,
        auth.effective_client_id().as_deref(),
        vault::ConvertVaultTypeInput {
            vault_id,
            target_type: body.target_type,
            personal_encrypted_vault_key: body.personal_encrypted_vault_key,
            client_id: auth.effective_client_id(),
        },
    )
    .await
    .notify_sync(&state)?;
    Ok(Json(result.into()))
}

#[utoipa::path(delete, path = "/vaults/{vaultId}", operation_id = "deleteVault", tag = "vaults", params(("vaultId" = String, Path)), responses((status = 200, description = "Success", body = SuccessResponse), VaultErrorResponses))]
pub(super) async fn delete_vault(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(vault_id): Path<String>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let pool = &state.db_pool;
    let result = vault::delete_vault(
        pool,
        state.object_storage.as_ref(),
        &auth.session.user_id,
        auth.effective_client_id().as_deref(),
        vault::VaultIdInput { vault_id },
    )
    .await
    .notify_sync(&state)?;
    Ok(Json(result.into()))
}

#[utoipa::path(post, path = "/vaults/{vaultId}/image-uploads", operation_id = "createVaultImageUpload", tag = "vaults", params(("vaultId" = String, Path)), request_body = ImageUploadBody, responses((status = 200, description = "Success", body = PresignedUploadResponse), VaultErrorResponses))]
pub(super) async fn create_image_upload(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(vault_id): Path<String>,
    ApiJson(body): ApiJson<ImageUploadBody>,
) -> Result<Json<PresignedUploadResponse>, ApiError> {
    let pool = &state.db_pool;
    Ok(Json(
        vault::create_vault_image_upload(
            pool,
            state.object_storage.as_ref(),
            &auth.session.user_id,
            vault::CreateVaultImageUploadInput {
                vault_id: Some(vault_id),
                file_name: body.file_name,
                content_type: body.content_type,
            },
        )
        .await?
        .into(),
    ))
}

#[utoipa::path(get, path = "/vault-stats", operation_id = "getVaultStats", tag = "vaults", responses((status = 200, description = "Success", body = VaultStatsResponseDto), VaultErrorResponses))]
pub(super) async fn stats(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
) -> Result<Json<VaultStatsResponseDto>, ApiError> {
    let pool = &state.db_pool;
    Ok(Json(
        vault::get_vault_stats(pool, &auth.session.user_id)
            .await?
            .into(),
    ))
}
