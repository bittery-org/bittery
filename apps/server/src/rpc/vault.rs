use qubit::{handler, Router};

use crate::{
    config::db_pool,
    error::AppError,
    services::auth::RefreshSessionContext,
    services::vault::{self, member_handlers, *},
    AppState, NotifySyncExt,
};

#[handler(query)]
pub async fn list(ctx: RefreshSessionContext) -> Result<Vec<VaultListEntryResponse>, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::list_vaults(pool, &ctx.session.user_id).await
}

#[handler(query)]
pub async fn get(
    ctx: RefreshSessionContext,
    input: VaultIdInput,
) -> Result<VaultDetailsResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::get_vault(pool, &ctx.session.user_id, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn createImageUpload(
    ctx: RefreshSessionContext,
    input: CreateVaultImageUploadInput,
) -> Result<crate::integrations::storage::PresignedUploadResult, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::create_vault_image_upload(pool, &ctx.session.user_id, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn createAttachmentUpload(
    ctx: RefreshSessionContext,
    input: CreateAttachmentUploadInput,
) -> Result<crate::integrations::storage::PresignedUploadResult, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::create_vault_attachment_upload(pool, &ctx.session.user_id, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn createAttachment(
    ctx: RefreshSessionContext,
    input: CreateAttachmentInput,
) -> Result<CreateAttachmentResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::create_vault_attachment(
        pool,
        &ctx.session.user_id,
        ctx.request.client_id.as_deref(),
        input,
    )
    .await
    .notify_sync(&ctx.app_state)
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn listAttachments(
    ctx: RefreshSessionContext,
    input: ItemIdInput,
) -> Result<Vec<VaultAttachmentResponse>, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::list_vault_attachments(pool, &ctx.session.user_id, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn getAttachmentDownloadUrl(
    ctx: RefreshSessionContext,
    input: AttachmentIdInput,
) -> Result<AttachmentDownloadResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::get_attachment_download_url(pool, &ctx.session.user_id, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn updateAttachment(
    ctx: RefreshSessionContext,
    input: UpdateAttachmentInput,
) -> Result<SuccessResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::update_vault_attachment(
        pool,
        &ctx.session.user_id,
        ctx.request.client_id.as_deref(),
        input,
    )
    .await
    .notify_sync(&ctx.app_state)
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn deleteAttachment(
    ctx: RefreshSessionContext,
    input: AttachmentIdInput,
) -> Result<SuccessResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::delete_vault_attachment(
        pool,
        &ctx.session.user_id,
        ctx.request.client_id.as_deref(),
        input,
    )
    .await
    .notify_sync(&ctx.app_state)
}

#[handler(mutation)]
pub async fn create(
    ctx: RefreshSessionContext,
    input: CreateVaultInput,
) -> Result<CreateVaultResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::create_vault(
        pool,
        &ctx.session.user_id,
        ctx.request.client_id.as_deref(),
        input,
    )
    .await
    .notify_sync(&ctx.app_state)
}

#[handler(mutation)]
pub async fn update(
    ctx: RefreshSessionContext,
    input: UpdateVaultInput,
) -> Result<UpdateVaultResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::update_vault(
        pool,
        &ctx.session.user_id,
        ctx.request.client_id.as_deref(),
        input,
    )
    .await
    .notify_sync(&ctx.app_state)
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn convertType(
    ctx: RefreshSessionContext,
    input: ConvertVaultTypeInput,
) -> Result<ConvertVaultTypeResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::convert_vault_type(
        pool,
        &ctx.session.user_id,
        ctx.request.client_id.as_deref(),
        input,
    )
    .await
    .notify_sync(&ctx.app_state)
}

#[handler(mutation)]
pub async fn delete(
    ctx: RefreshSessionContext,
    input: VaultIdInput,
) -> Result<SuccessResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::delete_vault(
        pool,
        &ctx.session.user_id,
        ctx.request.client_id.as_deref(),
        input,
    )
    .await
    .notify_sync(&ctx.app_state)
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn listItems(
    ctx: RefreshSessionContext,
    input: VaultIdInput,
) -> Result<Vec<VaultItemDetailsResponse>, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::list_vault_items(pool, &ctx.session.user_id, input).await
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn listAllItems(
    ctx: RefreshSessionContext,
) -> Result<Vec<VaultItemWithVaultResponse>, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::list_all_vault_items(pool, &ctx.session.user_id).await
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn listAllDeletedItems(
    ctx: RefreshSessionContext,
) -> Result<Vec<DeletedVaultItemWithVaultResponse>, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::list_all_deleted_vault_items(pool, &ctx.session.user_id).await
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn getItem(
    ctx: RefreshSessionContext,
    input: ItemIdInput,
) -> Result<VaultItemDetailsResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::get_vault_item(pool, &ctx.session.user_id, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn createItem(
    ctx: RefreshSessionContext,
    input: CreateItemInput,
) -> Result<CreateItemResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::create_vault_item(pool, &ctx.session.user_id, input)
        .await
        .notify_sync(&ctx.app_state)
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn bulkImportItems(
    ctx: RefreshSessionContext,
    input: BulkImportItemsInput,
) -> Result<BulkImportItemsResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::bulk_import_vault_items(pool, &ctx.session.user_id, input)
        .await
        .notify_sync(&ctx.app_state)
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn updateItem(
    ctx: RefreshSessionContext,
    input: UpdateItemInput,
) -> Result<UpdateItemResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::update_vault_item(pool, &ctx.session.user_id, input)
        .await
        .notify_sync(&ctx.app_state)
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn toggleFavorite(
    ctx: RefreshSessionContext,
    input: ToggleFavoriteInput,
) -> Result<SuccessResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::toggle_vault_favorite(pool, &ctx.session.user_id, input)
        .await
        .notify_sync(&ctx.app_state)
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn deleteItem(
    ctx: RefreshSessionContext,
    input: ItemClientInput,
) -> Result<SuccessResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::delete_vault_item(pool, &ctx.session.user_id, input)
        .await
        .notify_sync(&ctx.app_state)
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn listDeletedItems(
    ctx: RefreshSessionContext,
    input: VaultIdInput,
) -> Result<Vec<VaultItemResponse>, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::list_deleted_vault_items(pool, &ctx.session.user_id, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn restoreItem(
    ctx: RefreshSessionContext,
    input: ItemClientInput,
) -> Result<SuccessResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::restore_vault_item(pool, &ctx.session.user_id, input)
        .await
        .notify_sync(&ctx.app_state)
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn moveItem(
    ctx: RefreshSessionContext,
    input: MoveItemInput,
) -> Result<UpdateItemResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::move_vault_item(pool, &ctx.session.user_id, input)
        .await
        .notify_sync(&ctx.app_state)
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn permanentlyDeleteItem(
    ctx: RefreshSessionContext,
    input: ItemClientInput,
) -> Result<SuccessResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::permanently_delete_vault_item(pool, &ctx.session.user_id, input)
        .await
        .notify_sync(&ctx.app_state)
}

#[handler(query)]
pub async fn stats(ctx: RefreshSessionContext) -> Result<VaultStatsResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    vault::get_vault_stats(pool, &ctx.session.user_id).await
}

// --- Member handlers ---

mod rpc_member_handlers {
    use super::*;

    #[handler(query)]
    pub async fn list(
        ctx: RefreshSessionContext,
        input: VaultIdInput,
    ) -> Result<Vec<VaultMemberResponse>, AppError> {
        let pool = db_pool(&ctx.app_state)?;
        member_handlers::list_vault_members(pool, &ctx.session.user_id, input).await
    }

    #[allow(non_snake_case)]
    #[handler(query)]
    pub async fn availableTeamMembers(
        ctx: RefreshSessionContext,
        input: VaultIdInput,
    ) -> Result<Vec<VaultAvailableMemberResponse>, AppError> {
        let pool = db_pool(&ctx.app_state)?;
        member_handlers::available_team_members(pool, &ctx.session.user_id, input).await
    }

    #[allow(non_snake_case)]
    #[handler(mutation)]
    pub async fn updateRole(
        ctx: RefreshSessionContext,
        input: UpdateVaultMemberRoleInput,
    ) -> Result<SuccessResponse, AppError> {
        let pool = db_pool(&ctx.app_state)?;
        member_handlers::update_vault_member_role(pool, &ctx.session.user_id, input)
            .await
            .notify_sync(&ctx.app_state)
    }

    #[allow(non_snake_case)]
    #[handler(query)]
    pub async fn lookupUser(
        ctx: RefreshSessionContext,
        input: LookupVaultUserInput,
    ) -> Result<VaultLookupUserResponse, AppError> {
        let pool = db_pool(&ctx.app_state)?;
        member_handlers::lookup_vault_user(pool, &ctx.session.user_id, input).await
    }

    #[allow(non_snake_case)]
    #[handler(mutation)]
    pub async fn add(
        ctx: RefreshSessionContext,
        input: AddVaultMemberInput,
    ) -> Result<SuccessResponse, AppError> {
        let pool = db_pool(&ctx.app_state)?;
        member_handlers::add_vault_member(
            pool,
            &ctx.session.user_id,
            ctx.request.client_id.as_deref(),
            input,
        )
        .await
        .notify_sync(&ctx.app_state)
    }

    #[allow(non_snake_case)]
    #[handler(query)]
    pub async fn getRotationData(
        ctx: RefreshSessionContext,
        input: GetVaultRotationDataInput,
    ) -> Result<VaultRotationDataResponse, AppError> {
        let pool = db_pool(&ctx.app_state)?;
        member_handlers::get_vault_rotation_data(pool, &ctx.session.user_id, input).await
    }

    #[allow(non_snake_case)]
    #[handler(mutation)]
    pub async fn remove(
        ctx: RefreshSessionContext,
        input: RemoveVaultMemberInput,
    ) -> Result<RemoveVaultMemberResponse, AppError> {
        let pool = db_pool(&ctx.app_state)?;
        member_handlers::remove_vault_member(
            pool,
            &ctx.session.user_id,
            ctx.request.client_id.as_deref(),
            input,
        )
        .await
        .notify_sync(&ctx.app_state)
    }
}

pub fn create_vault_router() -> Router<AppState> {
    Router::new()
        .handler(list)
        .handler(get)
        .handler(create)
        .handler(update)
        .handler(convertType)
        .handler(delete)
        .handler(listItems)
        .handler(listAllItems)
        .handler(listAllDeletedItems)
        .handler(listDeletedItems)
        .handler(getItem)
        .handler(createItem)
        .handler(bulkImportItems)
        .handler(updateItem)
        .handler(toggleFavorite)
        .handler(deleteItem)
        .handler(restoreItem)
        .handler(moveItem)
        .handler(permanentlyDeleteItem)
        .handler(stats)
        .handler(createImageUpload)
        .handler(createAttachmentUpload)
        .handler(createAttachment)
        .handler(listAttachments)
        .handler(getAttachmentDownloadUrl)
        .handler(updateAttachment)
        .handler(deleteAttachment)
        .nest("members", create_vault_members_router())
}

fn create_vault_members_router() -> Router<AppState> {
    Router::new()
        .handler(rpc_member_handlers::list)
        .handler(rpc_member_handlers::availableTeamMembers)
        .handler(rpc_member_handlers::updateRole)
        .handler(rpc_member_handlers::lookupUser)
        .handler(rpc_member_handlers::add)
        .handler(rpc_member_handlers::getRotationData)
        .handler(rpc_member_handlers::remove)
}
