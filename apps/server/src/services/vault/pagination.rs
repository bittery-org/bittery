use sqlx::FromRow;

use crate::error::AppError;

pub(super) const ITEM_PAGE_QUERY_BYTES: i64 = 4 * 1024 * 1024 - 16 * 1024;
pub(super) const VAULT_PAGE_QUERY_BYTES: i64 = ITEM_PAGE_QUERY_BYTES;

#[derive(Debug)]
pub(crate) struct ByteBoundedPage<T> {
    pub(crate) values: Vec<T>,
    pub(crate) has_more: bool,
}

#[derive(Debug, FromRow)]
pub(super) struct ItemPageWeight {
    pub(super) id: String,
    pub(super) position: i64,
    pub(super) candidate_count: i64,
    pub(super) cumulative_bytes: i64,
}

pub(super) fn bounded_page_ids(
    weights: Vec<ItemPageWeight>,
    budget: i64,
    oversized_message: &'static str,
) -> Result<(Vec<String>, bool), AppError> {
    let Some(first) = weights.first() else {
        return Ok((Vec::new(), false));
    };
    if first.cumulative_bytes > budget {
        return Err(AppError::payload_too_large(oversized_message));
    }
    let has_more = weights
        .last()
        .is_some_and(|last| last.position < last.candidate_count);
    Ok((
        weights.into_iter().map(|weight| weight.id).collect(),
        has_more,
    ))
}
