//! Existing Share history and revoke behavior through the Runtime's private Session.
//!
//! These foreground calls do not enter the Operation queue or write Replica state. A revoke
//! succeeds only on an explicit Server success; an ambiguous response is never replayed here.
use super::*;
use crate::{
    auth_http::AuthenticatedOutcome,
    protocol::{ShareAccessLog, ShareAllowedEmail, ShareLinkStatus, ShareLinkSummary},
    server_contract,
};
use std::collections::HashSet;

impl Runtime {
    pub(super) async fn manage_share(
        &self,
        request: RuntimeRequest,
        cancellation: RequestCancellation,
        _teardown_admission: tokio::sync::RwLockReadGuard<'_, ()>,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let account_id = request
            .account_id()
            .expect("Share request is Account scoped")
            .clone();
        let execution = self.account_execution_lock(&account_id)?;
        let guard = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            guard = execution.lock() => guard,
        };
        self.ensure_open()?;
        let snapshot = self.require_snapshot(&account_id)?;
        self.ensure_share_admission(&account_id, &cancellation)?;
        if snapshot.failure.is_some() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AccountFailed,
                "Account is unavailable",
            ));
        }
        let item_id = match &request {
            RuntimeRequest::ListItemShareLinks { item_id, .. }
            | RuntimeRequest::ListShareAccessLogs { item_id, .. }
            | RuntimeRequest::RevokeShareLink { item_id, .. } => item_id.clone(),
            _ => unreachable!("only closed Share requests enter this service"),
        };
        let (_, vault) = super::attachment::item_and_vault(&snapshot, &item_id)?;
        self.require_vault_accepting_work(&snapshot, &vault.id)?;
        let foreground = self.foreground_attachments.register_target(
            &account_id,
            &snapshot.incarnation,
            super::foreground_attachment_lifecycle::ForegroundAttachmentTarget::Item {
                vault_id: vault.id.clone(),
                item_id: item_id.clone(),
            },
            cancellation.clone(),
        )?;
        drop(guard);
        let result = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            result = self.execute_share_management(&account_id, &snapshot.incarnation, &vault.id, request, cancellation.clone()) => result,
        }?;
        let _guard = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            guard = execution.lock() => guard,
        };
        self.ensure_share_admission(&account_id, &cancellation)?;
        let current = self.require_snapshot(&account_id)?;
        if current.incarnation != snapshot.incarnation || current.lock_epoch != snapshot.lock_epoch
        {
            return Err(cancelled());
        }
        let (_, current_vault) = super::attachment::item_and_vault(&current, &item_id)?;
        self.require_vault_accepting_work(&current, &current_vault.id)?;
        if current_vault.id != vault.id {
            return Err(cancelled());
        }
        // Linearize result delivery against a retirement that has announced its intent but is
        // still waiting for this request to release Account execution.
        if !self.foreground_attachments.publication(&foreground).begin() {
            return Err(cancelled());
        }
        Ok(result)
    }

    fn ensure_share_admission(
        &self,
        account_id: &AccountId,
        cancellation: &RequestCancellation,
    ) -> Result<(), RuntimeError> {
        self.ensure_open()?;
        if cancellation.is_cancelled() || self.account_access_retirement_is_pending(account_id) {
            return Err(cancelled());
        }
        if self
            .account_access
            .lock()
            .expect("Account access lock poisoned")
            .get(account_id)
            != Some(&AccountAccessState::Unlocked)
        {
            return Err(authentication_required());
        }
        Ok(())
    }

    async fn execute_share_management(
        &self,
        account_id: &AccountId,
        incarnation: &crate::Incarnation,
        expected_vault_id: &str,
        request: RuntimeRequest,
        cancellation: RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let metadata = self
            .platform_storage
            .load_account_metadata(account_id, incarnation)
            .await?
            .ok_or_else(authentication_required)?;
        let mut session = self
            .effective_session(account_id, incarnation)
            .await?
            .ok_or_else(authentication_required)?;
        let config = self
            .auth_client_config
            .clone()
            .ok_or_else(authentication_required)?;
        let http = AuthHttpClient::new(
            &self.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            config,
        )?;
        let required_parent = match &request {
            RuntimeRequest::ListShareAccessLogs {
                item_id, link_id, ..
            }
            | RuntimeRequest::RevokeShareLink {
                item_id, link_id, ..
            } => Some((item_id.clone(), link_id.clone())),
            _ => None,
        };
        let mut membership_proven = required_parent.is_none();
        let mut renewed = false;
        let mut logs = Vec::new();
        let mut cursor = None::<String>;
        let mut seen_cursors = HashSet::new();
        loop {
            self.ensure_share_admission(account_id, &cancellation)?;
            let current = self.require_snapshot(account_id)?;
            let item_id = match &request {
                RuntimeRequest::ListItemShareLinks { item_id, .. }
                | RuntimeRequest::ListShareAccessLogs { item_id, .. }
                | RuntimeRequest::RevokeShareLink { item_id, .. } => item_id,
                _ => unreachable!("only closed Share requests enter this service"),
            };
            let (_, current_vault) = super::attachment::item_and_vault(&current, item_id)?;
            self.require_vault_accepting_work(&current, &current_vault.id)?;
            if &current.incarnation != incarnation || current_vault.id != expected_vault_id {
                return Err(cancelled());
            }
            let response = if let Some((item_id, link_id)) =
                required_parent.as_ref().filter(|_| !membership_proven)
            {
                map_answer(
                    http.list_item_share_links(
                        session.token.as_ref(),
                        item_id,
                        cancellation.clone(),
                    )
                    .await?,
                    |answer| {
                        ShareAnswer::Membership(answer.links.iter().any(|link| &link.id == link_id))
                    },
                )
            } else {
                match &request {
                    RuntimeRequest::ListItemShareLinks { item_id, .. } => map_answer(
                        http.list_item_share_links(
                            session.token.as_ref(),
                            item_id,
                            cancellation.clone(),
                        )
                        .await?,
                        ShareAnswer::Links,
                    ),
                    RuntimeRequest::ListShareAccessLogs { link_id, .. } => map_answer(
                        http.share_access_log_page(
                            session.token.as_ref(),
                            link_id,
                            cursor.as_deref(),
                            cancellation.clone(),
                        )
                        .await?,
                        ShareAnswer::Page,
                    ),
                    RuntimeRequest::RevokeShareLink { link_id, .. } => map_answer(
                        http.revoke_share_link(
                            session.token.as_ref(),
                            link_id,
                            cancellation.clone(),
                        )
                        .await?,
                        ShareAnswer::Revoked,
                    ),
                    _ => unreachable!("only closed Share requests enter this service"),
                }
            };
            let answer = match response {
                AuthenticatedOutcome::Ok(answer) => answer,
                AuthenticatedOutcome::Transient => {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::RetryableTransport,
                        "Share management could not be confirmed",
                    ));
                }
                AuthenticatedOutcome::ReauthenticationRequired => {
                    if renewed {
                        self.mark_reauthentication_required(account_id);
                        return Err(authentication_required());
                    }
                    renewed = true;
                    session = self
                        .renew_session(account_id, &session, &http, cancellation.clone())
                        .await
                        .map_err(|error| {
                            if error.code == RuntimeErrorCode::AuthenticationRequired {
                                self.mark_reauthentication_required(account_id);
                                error
                            } else if (error.code == RuntimeErrorCode::AuthenticationUnavailable
                                && error.message == "Server request failed")
                                || (error.code == RuntimeErrorCode::InvariantViolation
                                    && error.message == "Session refresh failed")
                            {
                                RuntimeError::new(
                                    RuntimeErrorCode::RetryableTransport,
                                    "Session renewal failed",
                                )
                            } else {
                                error
                            }
                        })?;
                    continue;
                }
            };
            match answer {
                ShareAnswer::Membership(false) => {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AccessDenied,
                        "Share link does not belong to the verified Item",
                    ));
                }
                ShareAnswer::Membership(true) => {
                    membership_proven = true;
                    continue;
                }
                ShareAnswer::Links(answer) => {
                    let RuntimeRequest::ListItemShareLinks { item_id, .. } = request else {
                        unreachable!()
                    };
                    return Ok(RuntimeResponse::ItemShareLinks {
                        account_id: account_id.clone(),
                        item_id,
                        links: answer.links.into_iter().map(Into::into).collect(),
                        base_share_url: answer.base_share_url,
                    });
                }
                ShareAnswer::Page(page) => {
                    // Preserve the existing API drain: ordered pages, opaque cursor bytes, and
                    // rejection of missing/repeated cursors, including on the terminal page.
                    logs.extend(page.items.into_iter().map(ShareAccessLog::from));
                    let next = page.next_cursor.filter(|cursor| !cursor.is_empty());
                    if page.has_more && next.is_none() {
                        return Err(invalid_page(
                            "Share access logs returned hasMore without a nextCursor",
                        ));
                    }
                    if let Some(next) = &next {
                        if !seen_cursors.insert(next.clone()) {
                            return Err(invalid_page(
                                "Share access logs returned a repeated nextCursor",
                            ));
                        }
                    }
                    if page.has_more {
                        cursor = next;
                        continue;
                    }
                    let RuntimeRequest::ListShareAccessLogs { link_id, .. } = request else {
                        unreachable!()
                    };
                    return Ok(RuntimeResponse::ShareAccessLogs {
                        account_id: account_id.clone(),
                        link_id,
                        logs,
                    });
                }
                ShareAnswer::Revoked(answer) => {
                    if !answer.success {
                        return Err(invalid_page("Share revoke did not confirm success"));
                    }
                    let RuntimeRequest::RevokeShareLink { link_id, .. } = request else {
                        unreachable!()
                    };
                    return Ok(RuntimeResponse::ShareLinkRevoked {
                        account_id: account_id.clone(),
                        link_id,
                    });
                }
            }
        }
    }
}

enum ShareAnswer {
    Membership(bool),
    Links(server_contract::ShareLinkListResponse),
    Page(server_contract::CursorPageShareAccessLogResponse),
    Revoked(server_contract::SuccessResponse),
}
fn map_answer<T>(
    answer: AuthenticatedOutcome<T>,
    map: impl FnOnce(T) -> ShareAnswer,
) -> AuthenticatedOutcome<ShareAnswer> {
    match answer {
        AuthenticatedOutcome::Ok(value) => AuthenticatedOutcome::Ok(map(value)),
        AuthenticatedOutcome::Transient => AuthenticatedOutcome::Transient,
        AuthenticatedOutcome::ReauthenticationRequired => {
            AuthenticatedOutcome::ReauthenticationRequired
        }
    }
}
fn cancelled() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::Cancelled,
        "Share management was cancelled by its caller or Account lifecycle",
    )
}
fn authentication_required() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthenticationRequired,
        "Share management requires an unlocked Account and Session",
    )
}
fn invalid_page(message: &str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

impl From<server_contract::ShareAccessLogResponse> for ShareAccessLog {
    fn from(value: server_contract::ShareAccessLogResponse) -> Self {
        Self {
            id: value.id,
            accessed_by_email: value.accessed_by_email,
            ip_address: value.ip_address,
            user_agent: value.user_agent,
            success: value.success,
            failure_reason: value.failure_reason,
            accessed_at: value.accessed_at,
        }
    }
}
impl From<server_contract::ShareLinkListEntryResponse> for ShareLinkSummary {
    fn from(value: server_contract::ShareLinkListEntryResponse) -> Self {
        Self {
            id: value.id,
            status: match value.status {
                server_contract::ShareLinkStatus::Active => ShareLinkStatus::Active,
                server_contract::ShareLinkStatus::Expired => ShareLinkStatus::Expired,
                server_contract::ShareLinkStatus::Exhausted => ShareLinkStatus::Exhausted,
                server_contract::ShareLinkStatus::Revoked => ShareLinkStatus::Revoked,
            },
            access_mode: match value.access_mode {
                server_contract::ShareLinkAccessMode::Anyone => crate::ShareAccessMode::Anyone,
                server_contract::ShareLinkAccessMode::EmailRestricted => {
                    crate::ShareAccessMode::EmailRestricted
                }
            },
            is_one_time_use: value.is_one_time_use,
            access_count: value.access_count,
            max_access_count: value.max_access_count,
            allowed_emails: value
                .allowed_emails
                .into_iter()
                .map(|email| ShareAllowedEmail {
                    email: email.email,
                    verified: email.verified,
                })
                .collect(),
            expires_at: value.expires_at,
            created_at: value.created_at,
            last_accessed_at: value.last_accessed_at,
        }
    }
}
