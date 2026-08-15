use super::*;

#[utoipa::path(post, path = "/items/{itemId}/attachment-uploads", operation_id = "createAttachmentUpload", tag = "attachments", params(("itemId" = String, Path)), request_body = AttachmentUploadBody, responses((status = 200, description = "Success", body = AttachmentUploadResponse), VaultErrorResponses))]
pub(super) async fn create_attachment_upload(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(item_id): Path<String>,
    ApiJson(body): ApiJson<AttachmentUploadBody>,
) -> Result<Json<AttachmentUploadResponse>, ApiError> {
    let pool = &state.db_pool;
    let result = vault::create_vault_attachment_upload(
        pool,
        state.object_storage.as_ref(),
        &state.config.storage.attachment_upload_secret,
        state.config.server.mode,
        &auth.session.user_id,
        vault::CreateAttachmentUploadInput {
            item_id,
            file_name: body.file_name,
            content_type: body.content_type,
            file_size: body.file_size,
        },
    )
    .await?;
    Ok(Json(AttachmentUploadResponse {
        attachment_id: result.attachment_id,
        key: result.storage_key,
        upload_url: result.upload_url,
    }))
}

#[utoipa::path(post, path = "/items/{itemId}/attachments", operation_id = "createAttachment", tag = "attachments", params(("itemId" = String, Path)), request_body = CreateAttachmentBody, responses((status = 200, description = "Success", body = CreateAttachmentResponse), VaultErrorResponses))]
pub(super) async fn create_attachment(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(item_id): Path<String>,
    ApiJson(body): ApiJson<CreateAttachmentBody>,
) -> Result<Json<CreateAttachmentResponse>, ApiError> {
    let pool = &state.db_pool;
    let result = vault::create_vault_attachment(
        pool,
        state.object_storage.as_ref(),
        &state.config.storage.attachment_upload_secret,
        state.config.server.mode,
        &auth.session.user_id,
        auth.effective_client_id().as_deref(),
        vault::CreateAttachmentInput {
            item_id,
            attachment_id: body.attachment_id,
            storage_key: body.storage_key,
            encrypted_attachment_key: body.encrypted_attachment_key,
            attachment_key_iv: body.attachment_key_iv,
            attachment_key_algorithm: body.attachment_key_algorithm,
            envelope_version: body.envelope_version,
            encrypted_name: body.encrypted_name,
            encrypted_content_type: body.encrypted_content_type,
            encryption_iv: body.encryption_iv,
            encrypted_content_type_iv: body.encrypted_content_type_iv,
            encryption_algorithm: body.encryption_algorithm,
            file_size: body.file_size,
        },
    )
    .await
    .notify_sync(&state)?;
    Ok(Json(result.into()))
}

#[utoipa::path(get, path = "/items/{itemId}/attachments", operation_id = "listAttachments", tag = "attachments", params(("itemId" = String, Path), PageRequest), responses((status = 200, description = "Success", body = CursorPage<VaultAttachmentResponse>), VaultErrorResponses))]
pub(super) async fn list_attachments(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(item_id): Path<String>,
    ApiPageQuery(page): ApiPageQuery,
) -> Result<Json<CursorPage<VaultAttachmentResponse>>, ApiError> {
    let pool = &state.db_pool;
    let cursor = decode_page_key(
        &page,
        CursorContext::new(
            &auth.session.user_id,
            "attachments",
            &item_id,
            &state.config.auth.jwt_secret,
        ),
    )?
    .map(|key| timestamp_cursor_key(&key))
    .transpose()?;
    let values = vault::list_vault_attachments_page(
        pool,
        state.config.server.mode,
        &auth.session.user_id,
        vault::ItemIdInput {
            item_id: item_id.clone(),
        },
        cursor,
        query_limit(&page)?,
    )
    .await?;
    let values: Vec<VaultAttachmentResponse> = values.into_iter().map(Into::into).collect();
    Ok(Json(page_prefetched(
        values,
        &page,
        CursorContext::new(
            &auth.session.user_id,
            "attachments",
            &item_id,
            &state.config.auth.jwt_secret,
        ),
        |attachment| format!("{}\0{}", attachment.created_at, attachment.id),
    )?))
}

#[utoipa::path(post, path = "/attachments/{attachmentId}/download-urls", operation_id = "createAttachmentDownloadUrl", tag = "attachments", params(("attachmentId" = String, Path)), responses((status = 200, description = "Success", body = AttachmentDownloadResponse), VaultErrorResponses))]
pub(super) async fn create_attachment_download_url(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(attachment_id): Path<String>,
) -> Result<Json<AttachmentDownloadResponse>, ApiError> {
    let pool = &state.db_pool;
    Ok(Json(
        vault::get_attachment_download_url(
            pool,
            state.object_storage.as_ref(),
            state.config.server.mode,
            &auth.session.user_id,
            vault::AttachmentIdInput { attachment_id },
        )
        .await?
        .into(),
    ))
}

#[utoipa::path(patch, path = "/attachments/{attachmentId}", operation_id = "updateAttachment", tag = "attachments", params(("attachmentId" = String, Path)), request_body(content = UpdateAttachmentBody, content_type = "application/merge-patch+json"), responses((status = 200, description = "Success", body = SuccessResponse), VaultErrorResponses))]
pub(super) async fn update_attachment(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(attachment_id): Path<String>,
    ApiMergePatch(body): ApiMergePatch<UpdateAttachmentBody>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let pool = &state.db_pool;
    let result = vault::update_vault_attachment(
        pool,
        state.config.server.mode,
        &auth.session.user_id,
        auth.effective_client_id().as_deref(),
        vault::UpdateAttachmentInput {
            attachment_id,
            encrypted_name: body.encrypted_name,
            encryption_iv: body.encryption_iv,
            encryption_algorithm: body.encryption_algorithm,
        },
    )
    .await
    .notify_sync(&state)?;
    Ok(Json(result.into()))
}

#[utoipa::path(delete, path = "/attachments/{attachmentId}", operation_id = "deleteAttachment", tag = "attachments", params(("attachmentId" = String, Path)), responses((status = 200, description = "Success", body = SuccessResponse), VaultErrorResponses))]
pub(super) async fn delete_attachment(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(attachment_id): Path<String>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let pool = &state.db_pool;
    let result = vault::delete_vault_attachment(
        pool,
        state.object_storage.as_ref(),
        state.config.server.mode,
        &auth.session.user_id,
        auth.effective_client_id().as_deref(),
        vault::AttachmentIdInput { attachment_id },
    )
    .await
    .notify_sync(&state)?;
    Ok(Json(result.into()))
}
