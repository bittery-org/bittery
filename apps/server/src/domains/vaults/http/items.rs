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

#[utoipa::path(put, path = "/vaults/{vaultId}/items/{itemId}", operation_id = "createItem", tag = "items", params(("vaultId" = String, Path), ("itemId" = String, Path), ("Idempotency-Key" = String, Header, description = "Required stable Operation ID")), request_body = CreateItemBody, responses((status = 200, description = "Retained semantic outcome", body = crate::domains::operations::CreateItemOperationOutcome), CreateItemOperationErrorResponses))]
pub(super) async fn create_item(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path((vault_id, item_id)): Path<(String, String)>,
    ApiJsonBytes { value: body, bytes }: ApiJsonBytes<CreateItemBody, ITEM_BODY_LIMIT_BYTES>,
) -> Result<Json<crate::domains::operations::CreateItemOperationOutcome>, ApiError> {
    let operation_id = crate::domains::operations::http::required_operation_id(&headers)?;
    let client_id = auth.effective_client_id();
    let outcome = crate::domains::operations::execute_create_item(
        &state.db_pool,
        crate::domains::operations::CreateItemOperationInput {
            operation_id,
            user_id: auth.session.user_id,
            vault_id,
            item_id,
            category: body.category,
            encrypted_data: body.encrypted_data,
            encryption_iv: body.encryption_iv,
            encryption_algorithm: body.encryption_algorithm,
            client_id,
            raw_body: bytes,
            ciphertext_limit: ITEM_CIPHERTEXT_BYTES as usize,
        },
    )
    .await?;
    match outcome {
        crate::domains::operations::ExistingOutcome::Matching(outcome) => {
            state.notify_sync();
            Ok(Json(outcome))
        }
        crate::domains::operations::ExistingOutcome::Reused => Err(ApiError::unprocessable(
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

#[utoipa::path(patch, path = "/items/{itemId}", operation_id = "updateItem", tag = "items", params(("itemId" = String, Path), ("If-Match" = String, Header, description = "Strong item version ETag"), ("Idempotency-Key" = Option<String>, Header, description = "Replays the same outcome for 24 hours when request bytes and preconditions match")), request_body(content = UpdateItemBody, content_type = "application/merge-patch+json"), responses((status = 200, description = "Success", body = UpdateItemResponse, headers(("ETag" = String, description = "Updated strong item version validator"), ("Idempotency-Replayed" = String, description = "true when this is a stored replay"))), VaultErrorResponses))]
pub(super) async fn update_item(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path(item_id): Path<String>,
    ApiMergePatchBytes { value: body, bytes }: ApiMergePatchBytes<
        UpdateItemBody,
        ITEM_BODY_LIMIT_BYTES,
    >,
) -> Result<Response, ApiError> {
    let expected_version = required_item_version(&headers)?;
    let encrypted_data = optional_patch_value(body.encrypted_data, "/encryptedData")?;
    let encryption_iv = optional_patch_value(body.encryption_iv, "/encryptionIv")?;
    let encryption_algorithm =
        optional_patch_value(body.encryption_algorithm, "/encryptionAlgorithm")?;
    if let Some(value) = encrypted_data.as_deref() {
        check_ciphertext(value)?;
    }
    let pool = state.db_pool.clone();
    let client_id = auth.effective_client_id();
    let route_target = format!("/api/v1/items/{item_id}");
    idempotency::execute(
        pool,
        &headers,
        auth.session.user_id.clone(),
        "PATCH",
        &route_target,
        &bytes,
        |operation_pool, operation_principal_id| async move {
            let result = vault::update_vault_item(
                &operation_pool,
                &operation_principal_id,
                vault::UpdateItemInput {
                    item_id,
                    encrypted_data,
                    encryption_iv,
                    encryption_algorithm,
                    expected_version: Some(expected_version),
                    client_id,
                },
            )
            .await
            .notify_sync(&state)
            .map_err(item_mutation_error)?;
            let version = result.version;
            versioned_json(UpdateItemResponse::from(result), version)
        },
    )
    .await
}

#[utoipa::path(patch, path = "/items/{itemId}/favorite", operation_id = "setItemFavorite", tag = "items", params(("itemId" = String, Path), ("If-Match" = String, Header, description = "Strong item version ETag"), ("Idempotency-Key" = Option<String>, Header, description = "Replays the same outcome for 24 hours when request bytes and preconditions match")), request_body(content = FavoriteBody, content_type = "application/merge-patch+json"), responses((status = 200, description = "Success", body = SuccessResponse, headers(("ETag" = String, description = "Updated strong item version validator"), ("Idempotency-Replayed" = String, description = "true when this is a stored replay"))), VaultErrorResponses))]
pub(super) async fn set_favorite(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path(item_id): Path<String>,
    ApiMergePatchBytes { value: body, bytes }: ApiMergePatchBytes<
        FavoriteBody,
        ITEM_BODY_LIMIT_BYTES,
    >,
) -> Result<Response, ApiError> {
    let expected_version = required_item_version(&headers)?;
    let client_id = auth.effective_client_id();
    let pool = state.db_pool.clone();
    let route_target = format!("/api/v1/items/{item_id}/favorite");
    idempotency::execute(
        pool,
        &headers,
        auth.session.user_id.clone(),
        "PATCH",
        &route_target,
        &bytes,
        |operation_pool, operation_principal_id| async move {
            let result = vault::toggle_vault_favorite(
                &operation_pool,
                &operation_principal_id,
                vault::ToggleFavoriteInput {
                    item_id,
                    favorite: body.favorite,
                    expected_version: Some(expected_version),
                    client_id,
                },
            )
            .await
            .notify_sync(&state)
            .map_err(item_mutation_error)?;
            versioned_json(SuccessResponse::from(result), expected_version + 1)
        },
    )
    .await
}

#[utoipa::path(delete, path = "/items/{itemId}", operation_id = "trashItem", tag = "items", params(("itemId" = String, Path), ("If-Match" = String, Header, description = "Strong item version ETag"), ("Idempotency-Key" = Option<String>, Header, description = "Replays the same queued mutation outcome for 24 hours when preconditions match")), responses((status = 200, description = "Success", body = SuccessResponse, headers(("ETag" = String, description = "Updated strong item version validator"), ("Idempotency-Replayed" = String, description = "true when this is a stored replay"))), VaultErrorResponses))]
pub(super) async fn delete_item(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path(item_id): Path<String>,
) -> Result<Response, ApiError> {
    let expected_version = required_item_version(&headers)?;
    let pool = state.db_pool.clone();
    let client_id = auth.effective_client_id();
    let route_target = format!("/api/v1/items/{item_id}");
    idempotency::execute(
        pool,
        &headers,
        auth.session.user_id.clone(),
        "DELETE",
        &route_target,
        &[],
        |operation_pool, operation_principal_id| async move {
            let result = vault::delete_vault_item(
                &operation_pool,
                &operation_principal_id,
                vault::ItemClientInput {
                    item_id,
                    expected_version: Some(expected_version),
                    client_id,
                },
            )
            .await
            .notify_sync(&state)
            .map_err(item_mutation_error)?;
            versioned_json(SuccessResponse::from(result), expected_version + 1)
        },
    )
    .await
}

#[utoipa::path(post, path = "/items/{itemId}/restore", operation_id = "restoreItem", tag = "items", params(("itemId" = String, Path), ("If-Match" = String, Header, description = "Strong item version ETag"), ("Idempotency-Key" = Option<String>, Header, description = "Replays the same outcome for 24 hours when preconditions match")), responses((status = 200, description = "Success", body = SuccessResponse, headers(("ETag" = String, description = "Updated strong item version validator"), ("Idempotency-Replayed" = String, description = "true when this is a stored replay"))), VaultErrorResponses))]
pub(super) async fn restore_item(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path(item_id): Path<String>,
) -> Result<Response, ApiError> {
    let expected_version = required_item_version(&headers)?;
    let pool = state.db_pool.clone();
    let client_id = auth.effective_client_id();
    let route_target = format!("/api/v1/items/{item_id}/restore");
    idempotency::execute(
        pool,
        &headers,
        auth.session.user_id.clone(),
        "POST",
        &route_target,
        &[],
        |operation_pool, operation_principal_id| async move {
            let result = vault::restore_vault_item(
                &operation_pool,
                &operation_principal_id,
                vault::ItemClientInput {
                    item_id,
                    expected_version: Some(expected_version),
                    client_id,
                },
            )
            .await
            .notify_sync(&state)
            .map_err(item_mutation_error)?;
            versioned_json(SuccessResponse::from(result), expected_version + 1)
        },
    )
    .await
}

#[utoipa::path(post, path = "/items/{itemId}/moves", operation_id = "moveItem", tag = "items", params(("itemId" = String, Path), ("If-Match" = String, Header, description = "Strong item version ETag"), ("Idempotency-Key" = Option<String>, Header, description = "Replays the same outcome for 24 hours when request bytes and preconditions match")), request_body = MoveItemBody, responses((status = 200, description = "Success", body = UpdateItemResponse, headers(("ETag" = String, description = "Updated strong item version validator"), ("Idempotency-Replayed" = String, description = "true when this is a stored replay"))), VaultErrorResponses))]
pub(super) async fn move_item(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path(item_id): Path<String>,
    ApiJsonBytes { value: body, bytes }: ApiJsonBytes<MoveItemBody, ITEM_BODY_LIMIT_BYTES>,
) -> Result<Response, ApiError> {
    let expected_version = required_item_version(&headers)?;
    check_ciphertext(&body.encrypted_data)?;
    let pool = state.db_pool.clone();
    let client_id = auth.effective_client_id();
    let route_target = format!("/api/v1/items/{item_id}/moves");
    idempotency::execute(
        pool,
        &headers,
        auth.session.user_id.clone(),
        "POST",
        &route_target,
        &bytes,
        |operation_pool, operation_principal_id| async move {
            let result = vault::move_vault_item(
                &operation_pool,
                &operation_principal_id,
                vault::MoveItemInput {
                    item_id,
                    source_vault_id: body.source_vault_id,
                    target_vault_id: body.target_vault_id,
                    encrypted_data: body.encrypted_data,
                    encryption_iv: body.encryption_iv,
                    encryption_algorithm: body.encryption_algorithm,
                    expected_version: Some(expected_version),
                    client_id,
                },
            )
            .await
            .notify_sync(&state)
            .map_err(item_mutation_error)?;
            let version = result.version;
            versioned_json(UpdateItemResponse::from(result), version)
        },
    )
    .await
}

#[utoipa::path(delete, path = "/items/{itemId}/permanent", operation_id = "permanentlyDeleteItem", tag = "items", params(("itemId" = String, Path), ("If-Match" = String, Header, description = "Strong item version ETag"), ("Idempotency-Key" = Option<String>, Header, description = "Replays the same queued mutation outcome for 24 hours when preconditions match")), responses((status = 200, description = "Success", body = SuccessResponse, headers(("ETag" = String, description = "Final strong item version validator"), ("Idempotency-Replayed" = String, description = "true when this is a stored replay"))), VaultErrorResponses))]
pub(super) async fn permanently_delete_item(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path(item_id): Path<String>,
) -> Result<Response, ApiError> {
    let expected_version = required_item_version(&headers)?;
    let pool = state.db_pool.clone();
    let client_id = auth.effective_client_id();
    let route_target = format!("/api/v1/items/{item_id}/permanent");
    idempotency::execute(
        pool,
        &headers,
        auth.session.user_id.clone(),
        "DELETE",
        &route_target,
        &[],
        |operation_pool, operation_principal_id| async move {
            let result = vault::permanently_delete_vault_item(
                &operation_pool,
                &operation_principal_id,
                vault::ItemClientInput {
                    item_id,
                    expected_version: Some(expected_version),
                    client_id,
                },
            )
            .await
            .notify_sync(&state)
            .map_err(item_mutation_error)?;
            versioned_json(SuccessResponse::from(result), expected_version + 1)
        },
    )
    .await
}
