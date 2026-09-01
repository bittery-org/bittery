use super::*;

fn binding(operation_id: String, body: VaultImageStagingBody) -> vault::VaultImageStagingBinding {
    vault::VaultImageStagingBinding {
        operation_id,
        vault_id: body.vault_id,
        raw_sha256: body.sha256,
        raw_length: body.byte_length,
        content_type: body.content_type.as_str().to_owned(),
    }
}

fn status_response(
    status: Option<vault::VaultImageStagingStatus>,
) -> VaultImageStagingStatusResponse {
    match status {
        None => VaultImageStagingStatusResponse::Absent {},
        Some(status) => {
            let object_key = status.object_key;
            let generation = status.generation;
            let lease_expires_at = crate::config::format_timestamp(status.lease_expires_at);
            match status.state {
                vault::VaultImageStagingState::Unconfirmed => {
                    VaultImageStagingStatusResponse::Unconfirmed {
                        object_key,
                        generation,
                        lease_expires_at,
                    }
                }
                vault::VaultImageStagingState::Confirmed => {
                    VaultImageStagingStatusResponse::Confirmed {
                        object_key,
                        generation,
                        lease_expires_at,
                    }
                }
                vault::VaultImageStagingState::CleanupPending => {
                    VaultImageStagingStatusResponse::CleanupPending {
                        object_key,
                        generation,
                        lease_expires_at,
                    }
                }
            }
        }
    }
}

#[utoipa::path(post, path = "/operations/{operationId}/vault-image-staging/grants", operation_id = "grantVaultImageStaging", tag = "vaults", params(("operationId" = String, Path)), request_body = VaultImageStagingBody, responses((status = 200, body = VaultImageStagingGrantResponse), VaultErrorResponses))]
pub(super) async fn grant(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(operation_id): Path<String>,
    ApiJson(body): ApiJson<VaultImageStagingBody>,
) -> Result<Json<VaultImageStagingGrantResponse>, ApiError> {
    let grant = vault::grant_vault_image_staging(
        &state.db_pool,
        state.object_storage.as_ref(),
        &auth.session.user_id,
        binding(operation_id, body),
    )
    .await?;
    Ok(Json(VaultImageStagingGrantResponse {
        object_key: grant.object_key,
        upload_url: grant.upload_url,
        generation: grant.generation,
        lease_expires_at: crate::config::format_timestamp(grant.lease_expires_at),
        upload_headers: grant
            .upload_headers
            .into_iter()
            .map(|header| VaultImageStagingUploadHeader {
                name: header.name,
                value: header.value,
            })
            .collect(),
    }))
}

#[utoipa::path(post, path = "/operations/{operationId}/vault-image-staging/status", operation_id = "getVaultImageStagingStatus", tag = "vaults", params(("operationId" = String, Path)), request_body = VaultImageStagingBody, responses((status = 200, body = VaultImageStagingStatusResponse), VaultErrorResponses))]
pub(super) async fn status(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(operation_id): Path<String>,
    ApiJson(body): ApiJson<VaultImageStagingBody>,
) -> Result<Json<VaultImageStagingStatusResponse>, ApiError> {
    let binding = binding(operation_id, body);
    Ok(Json(status_response(
        vault::status_vault_image_staging(&state.db_pool, &auth.session.user_id, &binding).await?,
    )))
}

#[utoipa::path(post, path = "/operations/{operationId}/vault-image-staging/confirmations", operation_id = "confirmVaultImageStaging", tag = "vaults", params(("operationId" = String, Path)), request_body = VaultImageStagingBody, responses((status = 200, body = VaultImageStagingStatusResponse), VaultErrorResponses))]
pub(super) async fn confirm(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(operation_id): Path<String>,
    ApiJson(body): ApiJson<VaultImageStagingBody>,
) -> Result<Json<VaultImageStagingStatusResponse>, ApiError> {
    let binding = binding(operation_id, body);
    let status = vault::confirm_vault_image_staging(
        &state.db_pool,
        state.object_storage.as_ref(),
        &auth.session.user_id,
        &binding,
    )
    .await?;
    Ok(Json(status_response(Some(status))))
}

#[utoipa::path(delete, path = "/operations/{operationId}/vault-image-staging", operation_id = "cleanupVaultImageStaging", tag = "vaults", params(("operationId" = String, Path)), request_body = VaultImageStagingBody, responses((status = 200, body = SuccessResponse), VaultErrorResponses))]
pub(super) async fn cleanup(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(operation_id): Path<String>,
    ApiJson(body): ApiJson<VaultImageStagingBody>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let binding = binding(operation_id, body);
    vault::request_vault_image_staging_cleanup(&state.db_pool, &auth.session.user_id, &binding)
        .await?;
    Ok(Json(SuccessResponse { success: true }))
}
