use super::*;

#[utoipa::path(get, path = "/vaults/{vaultId}/items", operation_id = "listVaultItems", tag = "items", params(("vaultId" = String, Path), PageRequest), responses((status = 200, description = "Success", body = CursorPage<VaultItemDetailsResponse>), VaultErrorResponses))]
pub(super) async fn list_items(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(vault_id): Path<String>,
    ApiPageQuery(page): ApiPageQuery,
) -> Result<Json<CursorPage<VaultItemDetailsResponse>>, ApiError> {
    let pool = &state.db_pool;
    let cursor = decode_page_key(
        &page,
        CursorContext::new(
            &auth.session.user_id,
            "vault-items",
            &vault_id,
            &state.config.auth.jwt_secret,
        ),
    )?
    .map(|key| timestamp_cursor_key(&key))
    .transpose()?;
    let limit = query_limit(&page)?;
    let values = vault::list_vault_items_page(
        pool,
        state.config.server.mode,
        &auth.session.user_id,
        vault::VaultIdInput {
            vault_id: vault_id.clone(),
        },
        cursor,
        limit,
    )
    .await?;
    let source_has_more = values.has_more;
    let values: Vec<VaultItemDetailsResponse> = values.values.into_iter().map(Into::into).collect();
    Ok(Json(page_prefetched_with_more(
        values,
        source_has_more,
        &page,
        CursorContext::new(
            &auth.session.user_id,
            "vault-items",
            &vault_id,
            &state.config.auth.jwt_secret,
        ),
        |item| format!("{}\0{}", item.updated_at, item.id),
    )?))
}

#[utoipa::path(get, path = "/items", operation_id = "listAllItems", tag = "items", params(AllItemsQuery), responses((status = 200, description = "Accessible active or trashed items", body = AllItemsResponse), VaultErrorResponses))]
pub(super) async fn list_all_items(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    ApiQuery(query): ApiQuery<AllItemsQuery>,
) -> Result<Json<AllItemsResponse>, ApiError> {
    let pool = &state.db_pool;
    let state_filter = query.state.as_deref().unwrap_or("active");
    let page = PageRequest {
        cursor: query.cursor,
        limit: query.limit,
    };
    match state_filter {
        "active" => {
            let cursor = decode_page_key(
                &page,
                CursorContext::new(
                    &auth.session.user_id,
                    "items",
                    state_filter,
                    &state.config.auth.jwt_secret,
                ),
            )?
            .map(|key| timestamp_cursor_key(&key))
            .transpose()?;
            let values = vault::list_all_vault_items_page(
                pool,
                state.object_storage.as_ref(),
                state.config.server.mode,
                &auth.session.user_id,
                cursor,
                query_limit(&page)?,
            )
            .await?;
            let source_has_more = values.has_more;
            Ok(Json(
                page_prefetched_with_more(
                    values.values,
                    source_has_more,
                    &page,
                    CursorContext::new(
                        &auth.session.user_id,
                        "items",
                        state_filter,
                        &state.config.auth.jwt_secret,
                    ),
                    |item| format!("{}\0{}", item.updated_at, item.id),
                )?
                .into(),
            ))
        }
        "trashed" => {
            let cursor = decode_page_key(
                &page,
                CursorContext::new(
                    &auth.session.user_id,
                    "items",
                    state_filter,
                    &state.config.auth.jwt_secret,
                ),
            )?
            .map(|key| timestamp_cursor_key(&key))
            .transpose()?;
            let values = vault::list_all_deleted_vault_items_page(
                pool,
                state.object_storage.as_ref(),
                &auth.session.user_id,
                cursor,
                query_limit(&page)?,
            )
            .await?;
            let source_has_more = values.has_more;
            Ok(Json(
                page_prefetched_with_more(
                    values.values,
                    source_has_more,
                    &page,
                    CursorContext::new(
                        &auth.session.user_id,
                        "items",
                        state_filter,
                        &state.config.auth.jwt_secret,
                    ),
                    |item| {
                        format!(
                            "{}\0{}",
                            item.deleted_at.as_deref().unwrap_or_default(),
                            item.id
                        )
                    },
                )?
                .into(),
            ))
        }
        _ => Err(ApiError::bad_request(
            ErrorCode::InvalidItemState,
            "state must be either active or trashed.",
        )),
    }
}

#[utoipa::path(get, path = "/items/trashed", operation_id = "listAllTrashedItems", tag = "items", params(PageRequest), responses((status = 200, description = "All accessible trashed items", body = CursorPage<DeletedVaultItemWithVaultResponse>), VaultErrorResponses))]
pub(super) async fn list_all_trashed_items(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    ApiPageQuery(page): ApiPageQuery,
) -> Result<Json<CursorPage<DeletedVaultItemWithVaultResponse>>, ApiError> {
    let cursor = decode_page_key(
        &page,
        CursorContext::new(
            &auth.session.user_id,
            "items",
            "trashed",
            &state.config.auth.jwt_secret,
        ),
    )?
    .map(|key| timestamp_cursor_key(&key))
    .transpose()?;
    let values = vault::list_all_deleted_vault_items_page(
        &state.db_pool,
        state.object_storage.as_ref(),
        &auth.session.user_id,
        cursor,
        query_limit(&page)?,
    )
    .await?;
    let source_has_more = values.has_more;
    let values: Vec<DeletedVaultItemWithVaultResponse> =
        values.values.into_iter().map(Into::into).collect();
    Ok(Json(page_prefetched_with_more(
        values,
        source_has_more,
        &page,
        CursorContext::new(
            &auth.session.user_id,
            "items",
            "trashed",
            &state.config.auth.jwt_secret,
        ),
        |item| {
            format!(
                "{}\0{}",
                item.deleted_at.as_deref().unwrap_or_default(),
                item.id
            )
        },
    )?))
}

#[utoipa::path(get, path = "/vaults/{vaultId}/items/trashed", operation_id = "listTrashedVaultItems", tag = "items", params(("vaultId" = String, Path), PageRequest), responses((status = 200, description = "Success", body = CursorPage<VaultItemResponse>), VaultErrorResponses))]
pub(super) async fn list_deleted_items(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(vault_id): Path<String>,
    ApiPageQuery(page): ApiPageQuery,
) -> Result<Json<CursorPage<VaultItemResponse>>, ApiError> {
    let pool = &state.db_pool;
    let filter = format!("{vault_id}:trashed");
    let cursor = decode_page_key(
        &page,
        CursorContext::new(
            &auth.session.user_id,
            "vault-items",
            &filter,
            &state.config.auth.jwt_secret,
        ),
    )?
    .map(|key| timestamp_cursor_key(&key))
    .transpose()?;
    let values = vault::list_deleted_vault_items_page(
        pool,
        &auth.session.user_id,
        vault::VaultIdInput {
            vault_id: vault_id.clone(),
        },
        cursor,
        query_limit(&page)?,
    )
    .await?;
    let source_has_more = values.has_more;
    let values: Vec<VaultItemResponse> = values.values.into_iter().map(Into::into).collect();
    Ok(Json(page_prefetched_with_more(
        values,
        source_has_more,
        &page,
        CursorContext::new(
            &auth.session.user_id,
            "vault-items",
            &filter,
            &state.config.auth.jwt_secret,
        ),
        |item| {
            format!(
                "{}\0{}",
                item.deleted_at.as_deref().unwrap_or_default(),
                item.id
            )
        },
    )?))
}

#[utoipa::path(get, path = "/items/{itemId}", operation_id = "getItem", tag = "items", params(("itemId" = String, Path)), responses((status = 200, description = "Success", body = ItemResponseDto, headers(("ETag" = String, description = "Strong item version validator"))), VaultErrorResponses))]
pub(super) async fn get_item(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(item_id): Path<String>,
) -> Result<Response, ApiError> {
    let pool = &state.db_pool;
    let item: ItemResponseDto = vault::get_vault_item(
        pool,
        state.config.server.mode,
        &auth.session.user_id,
        vault::ItemIdInput { item_id },
    )
    .await?
    .into();
    let version = item.version;
    versioned_json(item, version)
}

#[utoipa::path(put, path = "/vaults/{vaultId}/items/{itemId}", operation_id = "createItem", tag = "items", params(("vaultId" = String, Path), ("itemId" = String, Path), ("Idempotency-Key" = String, Header, description = "Required stable Operation ID")), request_body = CreateItemBody, responses((status = 200, description = "Retained semantic outcome", body = crate::domains::operations::OperationOutcome), ItemOperationErrorResponses))]
pub(super) async fn create_item(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path((vault_id, item_id)): Path<(String, String)>,
    ApiJsonBytes { value: body, bytes }: ApiJsonBytes<CreateItemBody, ITEM_BODY_LIMIT_BYTES>,
) -> Result<Json<OperationOutcome>, ApiError> {
    let client_id = auth.effective_client_id();
    run_item_operation(
        &state,
        &headers,
        auth.session.user_id,
        bytes,
        ItemOperationEffect::Create(vault::CreateItemEffectInput {
            item_id,
            vault_id,
            category: body.category,
            encrypted_data: body.encrypted_data,
            encryption_iv: body.encryption_iv,
            encryption_algorithm: body.encryption_algorithm,
            client_id,
            ciphertext_limit: ITEM_CIPHERTEXT_BYTES as usize,
        }),
    )
    .await
}

/// Runs one Item Operation and answers with the outcome the Server retained for it.
///
/// Every Item mutation reaches the Server through this one door: the stable Operation ID is
/// required, the fingerprint is taken from the exact bytes and the canonical route, and the only
/// two answers are a retained outcome or the one structured refusal that says this ID already
/// belongs to different bytes.
async fn run_item_operation(
    state: &AppState,
    headers: &HeaderMap,
    user_id: String,
    raw_body: Vec<u8>,
    effect: ItemOperationEffect,
) -> Result<Json<OperationOutcome>, ApiError> {
    let operation_id = crate::domains::operations::http::required_operation_id(headers)?;
    let resolution = crate::domains::operations::execute_item_operation(
        &state.db_pool,
        ItemOperationInput {
            operation_id,
            user_id,
            effect,
            raw_body,
        },
    )
    .await?;
    match resolution {
        OperationResolution::Outcome {
            outcome,
            newly_committed,
        } => {
            if newly_committed {
                state.notify_sync();
            }
            Ok(Json(outcome))
        }
        OperationResolution::IdReused => Err(ApiError::unprocessable(
            ErrorCode::OperationIdReused,
            "The Operation ID was already used for different immutable request bytes.",
        )),
    }
}

#[utoipa::path(post, path = "/vaults/{vaultId}/item-imports", operation_id = "bulkImportItems", tag = "items", params(("vaultId" = String, Path)), request_body = BulkImportBody, responses((status = 200, description = "Success", body = BulkImportItemsResponse), VaultErrorResponses))]
pub(super) async fn bulk_import_items(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(vault_id): Path<String>,
    ApiJson(body): ApiJson<BulkImportBody>,
) -> Result<Json<BulkImportItemsResponse>, ApiError> {
    check_bulk_import(&body)?;
    let pool = &state.db_pool;
    let result = vault::bulk_import_vault_items(
        pool,
        &auth.session.user_id,
        vault::BulkImportItemsInput {
            vault_id,
            client_id: auth.effective_client_id(),
            items: body.items.into_iter().map(Into::into).collect(),
        },
    )
    .await
    .notify_sync(&state)?;
    Ok(Json(result.into()))
}

#[utoipa::path(patch, path = "/items/{itemId}", operation_id = "updateItem", tag = "items", params(("itemId" = String, Path), ("If-Match" = String, Header, description = "Strong item version ETag"), ("Idempotency-Key" = String, Header, description = "Required stable Operation ID")), request_body(content = UpdateItemBody, content_type = "application/merge-patch+json"), responses((status = 200, description = "Retained semantic outcome", body = crate::domains::operations::OperationOutcome), ItemMutationOperationErrorResponses))]
pub(super) async fn update_item(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path(item_id): Path<String>,
    ApiMergePatchBytes { value: body, bytes }: ApiMergePatchBytes<
        UpdateItemBody,
        ITEM_BODY_LIMIT_BYTES,
    >,
) -> Result<Json<OperationOutcome>, ApiError> {
    let expected_version = required_item_version(&headers)?;
    let encrypted_data = optional_patch_value(body.encrypted_data, "/encryptedData")?;
    let encryption_iv = optional_patch_value(body.encryption_iv, "/encryptionIv")?;
    let encryption_algorithm =
        optional_patch_value(body.encryption_algorithm, "/encryptionAlgorithm")?;
    let client_id = auth.effective_client_id();
    run_item_operation(
        &state,
        &headers,
        auth.session.user_id,
        bytes,
        ItemOperationEffect::Update(vault::UpdateItemEffectInput {
            item_id,
            encrypted_data,
            encryption_iv,
            encryption_algorithm,
            expected_version,
            client_id,
            ciphertext_limit: ITEM_CIPHERTEXT_BYTES as usize,
        }),
    )
    .await
}

#[utoipa::path(patch, path = "/items/{itemId}/favorite", operation_id = "setItemFavorite", tag = "items", params(("itemId" = String, Path), ("If-Match" = String, Header, description = "Strong item version ETag"), ("Idempotency-Key" = String, Header, description = "Required stable Operation ID")), request_body(content = FavoriteBody, content_type = "application/merge-patch+json"), responses((status = 200, description = "Retained semantic outcome", body = crate::domains::operations::OperationOutcome), ItemMutationOperationErrorResponses))]
pub(super) async fn set_favorite(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path(item_id): Path<String>,
    ApiMergePatchBytes { value: body, bytes }: ApiMergePatchBytes<
        FavoriteBody,
        ITEM_BODY_LIMIT_BYTES,
    >,
) -> Result<Json<OperationOutcome>, ApiError> {
    let expected_version = required_item_version(&headers)?;
    let client_id = auth.effective_client_id();
    run_item_operation(
        &state,
        &headers,
        auth.session.user_id,
        bytes,
        ItemOperationEffect::SetFavorite(vault::FavoriteItemEffectInput {
            item_id,
            favorite: body.favorite,
            expected_version,
            client_id,
        }),
    )
    .await
}

#[utoipa::path(delete, path = "/items/{itemId}", operation_id = "trashItem", tag = "items", params(("itemId" = String, Path), ("If-Match" = String, Header, description = "Strong item version ETag"), ("Idempotency-Key" = String, Header, description = "Required stable Operation ID")), responses((status = 200, description = "Retained semantic outcome", body = crate::domains::operations::OperationOutcome), ItemMutationOperationErrorResponses))]
pub(super) async fn delete_item(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path(item_id): Path<String>,
) -> Result<Json<OperationOutcome>, ApiError> {
    let expected_version = required_item_version(&headers)?;
    let client_id = auth.effective_client_id();
    run_item_operation(
        &state,
        &headers,
        auth.session.user_id,
        Vec::new(),
        ItemOperationEffect::Trash(vault::ItemEffectInput {
            item_id,
            expected_version,
            client_id,
        }),
    )
    .await
}

#[utoipa::path(post, path = "/items/{itemId}/restore", operation_id = "restoreItem", tag = "items", params(("itemId" = String, Path), ("If-Match" = String, Header, description = "Strong item version ETag"), ("Idempotency-Key" = String, Header, description = "Required stable Operation ID")), responses((status = 200, description = "Retained semantic outcome", body = crate::domains::operations::OperationOutcome), ItemMutationOperationErrorResponses))]
pub(super) async fn restore_item(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path(item_id): Path<String>,
) -> Result<Json<OperationOutcome>, ApiError> {
    let expected_version = required_item_version(&headers)?;
    let client_id = auth.effective_client_id();
    run_item_operation(
        &state,
        &headers,
        auth.session.user_id,
        Vec::new(),
        ItemOperationEffect::Restore(vault::ItemEffectInput {
            item_id,
            expected_version,
            client_id,
        }),
    )
    .await
}

#[utoipa::path(post, path = "/items/{itemId}/moves", operation_id = "moveItem", tag = "items", params(("itemId" = String, Path), ("If-Match" = String, Header, description = "Strong item version ETag"), ("Idempotency-Key" = String, Header, description = "Required stable Operation ID")), request_body = MoveItemBody, responses((status = 200, description = "Retained semantic outcome", body = crate::domains::operations::OperationOutcome), ItemMutationOperationErrorResponses))]
pub(super) async fn move_item(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path(item_id): Path<String>,
    ApiJsonBytes { value: body, bytes }: ApiJsonBytes<MoveItemBody, ITEM_BODY_LIMIT_BYTES>,
) -> Result<Json<OperationOutcome>, ApiError> {
    let expected_version = required_item_version(&headers)?;
    let operation_id = crate::domains::operations::http::required_operation_id(&headers)?;
    let retained = crate::domains::operations::get_operation_outcome(
        &state.db_pool,
        &auth.session.user_id,
        &operation_id,
    )
    .await?
    .is_some();
    #[cfg(test)]
    crate::test_support::pause_attachment_move_preflight(&operation_id).await;
    let (source_vault_id, target_vault_id, finalization) = match body {
        MoveItemBody::Prepared {
            source_vault_id,
            target_vault_id,
            encrypted_data,
            encryption_iv,
            encryption_algorithm,
            attachments,
        } => {
            if !retained {
                let expected_attachments = attachments
                    .iter()
                    .map(|entry| (entry.attachment_id.clone(), entry.expected_envelope_version))
                    .collect::<Vec<_>>();
                match vault::verify_attachment_move_staging(
                    &state.db_pool,
                    state.object_storage.as_ref(),
                    &auth.session.user_id,
                    &operation_id,
                    vault::AttachmentMoveFinalizeIntent {
                        item_id: &item_id,
                        source_vault_id: &source_vault_id,
                        target_vault_id: &target_vault_id,
                        attachments: &expected_attachments,
                    },
                )
                .await?
                {
                    vault::AttachmentMoveStagingStatus::Ready => {}
                    vault::AttachmentMoveStagingStatus::Absent if attachments.is_empty() => {}
                    vault::AttachmentMoveStagingStatus::Absent
                    | vault::AttachmentMoveStagingStatus::Incomplete
                        if crate::domains::operations::get_operation_outcome(
                            &state.db_pool,
                            &auth.session.user_id,
                            &operation_id,
                        )
                        .await?
                        .is_some() => {}
                    vault::AttachmentMoveStagingStatus::Absent
                    | vault::AttachmentMoveStagingStatus::Incomplete => {
                        return Err(ApiError::conflict(
                            ErrorCode::AttachmentStagingIncomplete,
                            "Attachment Move staging is missing, expired, or incomplete.",
                        ));
                    }
                    vault::AttachmentMoveStagingStatus::Mismatch => {
                        return Err(ApiError::conflict(
                            ErrorCode::AttachmentStagingMismatch,
                            "Attachment Move Finalize intent does not match its manifest.",
                        ));
                    }
                }
            }
            (
                source_vault_id,
                target_vault_id,
                vault::MoveItemFinalizationInput::Prepared {
                    encrypted_data,
                    encryption_iv,
                    encryption_algorithm,
                    attachments: attachments
                        .into_iter()
                        .map(|entry| vault::MoveAttachmentEffectInput {
                            attachment_id: entry.attachment_id,
                            expected_envelope_version: entry.expected_envelope_version,
                            encrypted_attachment_key: entry.encrypted_attachment_key,
                            attachment_key_iv: entry.attachment_key_iv,
                            attachment_key_algorithm: entry.attachment_key_algorithm,
                            encrypted_name: entry.encrypted_name,
                            encrypted_content_type: entry.encrypted_content_type,
                            encryption_iv: entry.encryption_iv,
                            encrypted_content_type_iv: entry.encrypted_content_type_iv,
                            encryption_algorithm: entry.encryption_algorithm,
                        })
                        .collect(),
                },
            )
        }
        MoveItemBody::RejectStaleAuthority {
            source_vault_id,
            target_vault_id,
            attachments,
        } => (
            source_vault_id,
            target_vault_id,
            vault::MoveItemFinalizationInput::RejectStaleAuthority {
                attachments: attachments
                    .into_iter()
                    .map(|entry| vault::MoveAttachmentIntentInput {
                        attachment_id: entry.attachment_id,
                        expected_envelope_version: entry.expected_envelope_version,
                    })
                    .collect(),
            },
        ),
    };
    let client_id = auth.effective_client_id();
    run_item_operation(
        &state,
        &headers,
        auth.session.user_id,
        bytes,
        ItemOperationEffect::Move(vault::MoveItemEffectInput {
            operation_id,
            item_id,
            source_vault_id,
            target_vault_id,
            expected_version,
            client_id,
            ciphertext_limit: ITEM_CIPHERTEXT_BYTES as usize,
            finalization,
        }),
    )
    .await
}

#[utoipa::path(put, path = "/operations/{operationId}/attachment-move-manifest", operation_id = "createAttachmentMoveManifest", tag = "attachments", params(("operationId" = String, Path)), request_body = AttachmentMoveManifestBody, responses((status = 200, description = "Stable staging identities and renewed upload credentials", body = AttachmentMoveManifestResponse), VaultErrorResponses))]
pub(super) async fn create_attachment_move_manifest(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(operation_id): Path<String>,
    ApiJsonBytes { value: body, bytes }: ApiJsonBytes<
        AttachmentMoveManifestBody,
        ITEM_BODY_LIMIT_BYTES,
    >,
) -> Result<Json<AttachmentMoveManifestResponse>, ApiError> {
    let operation_id = crate::domains::operations::http::validate_operation_id_str(&operation_id)?;
    let response = vault::create_attachment_move_manifest(
        &state.db_pool,
        state.object_storage.as_ref(),
        state.config.server.mode,
        &auth.session.user_id,
        vault::AttachmentMoveManifestInput {
            operation_id,
            item_id: body.item_id,
            source_vault_id: body.source_vault_id,
            target_vault_id: body.target_vault_id,
            attachments: body
                .attachments
                .into_iter()
                .map(|entry| vault::AttachmentMoveManifestEntryInput {
                    attachment_id: entry.attachment_id,
                    envelope_version: entry.envelope_version,
                    ciphertext_sha256: entry.ciphertext_sha256,
                })
                .collect(),
            request_bytes: bytes,
        },
    )
    .await?;
    Ok(Json(AttachmentMoveManifestResponse {
        operation_id: response.operation_id,
        expires_at: response.expires_at,
        attachments: response
            .attachments
            .into_iter()
            .map(|entry| AttachmentMoveUploadResponse {
                attachment_id: entry.attachment_id,
                storage_key: entry.storage_key,
                upload_url: entry.upload_url,
            })
            .collect(),
    }))
}

#[utoipa::path(delete, path = "/items/{itemId}/permanent", operation_id = "permanentlyDeleteItem", tag = "items", params(("itemId" = String, Path), ("If-Match" = String, Header, description = "Strong item version ETag"), ("Idempotency-Key" = String, Header, description = "Required stable Operation ID")), responses((status = 200, description = "Retained semantic outcome", body = crate::domains::operations::OperationOutcome), ItemMutationOperationErrorResponses))]
pub(super) async fn permanently_delete_item(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path(item_id): Path<String>,
) -> Result<Json<OperationOutcome>, ApiError> {
    let expected_version = required_item_version(&headers)?;
    let client_id = auth.effective_client_id();
    run_item_operation(
        &state,
        &headers,
        auth.session.user_id,
        Vec::new(),
        ItemOperationEffect::PermanentlyDelete(vault::ItemEffectInput {
            item_id,
            expected_version,
            client_id,
        }),
    )
    .await
}
