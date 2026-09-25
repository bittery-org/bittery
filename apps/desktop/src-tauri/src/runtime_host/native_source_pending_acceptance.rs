//! Actual consumer accepted work crossing native Travel frames; the proxy only loses Move sockets.
use super::{tests, Credentials, NativeRuntime};
use bittery_client_core::{
    AccountId, ObservationRequest, OperationResolution, RuntimeProjection, RuntimeRequest,
    RuntimeResponse,
};
use rusqlite::{params, Connection, OpenFlags};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use zeroize::Zeroizing;

pub(in crate::runtime_host) struct PendingMove {
    account: AccountId,
    operation: String,
    item: String,
    target: String,
    database: PathBuf,
    accepted: Zeroizing<String>,
    network_control: PathBuf,
    network_acknowledgement: PathBuf,
}

impl PendingMove {
    pub(super) async fn accept(
        native: &NativeRuntime,
        account: &AccountId,
        hidden: &str,
        directory: &Path,
        credentials: &Credentials,
    ) -> Result<Self, String> {
        let items =
            super::items(native, account)?.ok_or("Pending Move consumer is not readable")?;
        let item = items
            .items
            .iter()
            .find(|item| {
                item.vault_id == hidden
                    && item
                        .data
                        .title()
                        .starts_with("Restricted native pending Item ")
            })
            .ok_or("Pending native Move witness Item is missing")?;
        let target = items
            .items
            .iter()
            .find(|item| item.vault_id != hidden)
            .ok_or("Pending native Move target Vault is missing")?
            .vault_id
            .clone();
        network(
            &credentials.network_control,
            &credentials.network_acknowledgement,
            "prepare-only",
        )
        .await?;
        let RuntimeResponse::Accepted { operation_id, .. } = tests::acceptance_request(
            &native.core,
            RuntimeRequest::MoveItem {
                account_id: account.clone(),
                item_id: item.item_id.clone(),
                target_vault_id: target.clone(),
                target_account_id: None,
            },
        )
        .await?
        else {
            return Err("Consumer Move was not durably accepted".into());
        };
        // Wait for the existing proxy to discard this exact real HTTP attempt. It still
        // forwards policy, Bootstrap and other Account traffic, including Desktop Enable.
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                if std::fs::read_to_string(&credentials.network_blocked_move)
                    .ok()
                    .as_deref()
                    == Some(operation_id.as_str())
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .map_err(|_| "Proxy did not hold the exact consumer Move")?;
        let mut witness = Self {
            account: account.clone(),
            operation: operation_id,
            item: item.item_id.clone(),
            target,
            database: directory.join("destination/replica.sqlite"),
            accepted: Zeroizing::new(String::new()),
            network_control: credentials.network_control.clone(),
            network_acknowledgement: credentials.network_acknowledgement.clone(),
        };
        witness.accepted = witness.immutable_request()?;
        witness.require_pending(native)?;
        Ok(witness)
    }

    fn immutable_request(&self) -> Result<Zeroizing<String>, String> {
        let connection =
            Connection::open_with_flags(&self.database, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|_| "Cannot inspect native consumer accepted work")?;
        let row: String = connection.query_row(
            "SELECT payload_json FROM replica_rows WHERE account_id=?1 AND store=1 AND record_id=?2",
            params![self.account.as_str(), self.operation], |row| row.get(0),
        ).map_err(|_| "Original consumer Move Operation is missing")?;
        let row = Zeroizing::new(row);
        let value: Value =
            serde_json::from_str(&row).map_err(|_| "Invalid accepted Move record")?;
        let mut immutable = serde_json::Map::new();
        // Retry scheduling and the retained category witness may change. Every accepted
        // identity, route, header and encrypted request-body byte must remain identical.
        for field in [
            "operationId",
            "kind",
            "target",
            "requestFingerprint",
            "request",
        ] {
            immutable.insert(
                field.into(),
                value
                    .get(field)
                    .ok_or("Incomplete accepted Move record")?
                    .clone(),
            );
        }
        serde_json::to_string(&immutable)
            .map(Zeroizing::new)
            .map_err(|_| "Cannot capture accepted Move request".into())
    }

    fn require_pending(&self, native: &NativeRuntime) -> Result<(), String> {
        let RuntimeProjection::Operations(operations) = tests::snapshot(
            &native.core,
            ObservationRequest::Operations {
                account_id: self.account.clone(),
            },
        )?
        else {
            return Err("Missing consumer Move status".into());
        };
        if !operations.operations.iter().any(|operation| {
            operation.operation_id == self.operation
                && operation.resolution == OperationResolution::Pending
        }) {
            return Err("Held consumer Move resolved before fresh restoration".into());
        }
        Ok(())
    }

    pub(in crate::runtime_host) fn require_hidden_and_retained(
        &self,
        native: &NativeRuntime,
    ) -> Result<(), String> {
        if self.immutable_request()? != self.accepted {
            return Err("Native Travel rewrote the consumer's original accepted request".into());
        }
        self.require_pending(native)?;
        if super::items(native, &self.account)?
            .is_some_and(|items| items.items.iter().any(|item| item.item_id == self.item))
        {
            return Err("Native Travel exposed the retired pending Move projection".into());
        }
        Ok(())
    }

    pub(in crate::runtime_host) async fn converge(
        &self,
        native: &NativeRuntime,
    ) -> Result<(), String> {
        if self.immutable_request()? != self.accepted {
            return Err("Restoration rewrote the consumer's original accepted request".into());
        }
        network(
            &self.network_control,
            &self.network_acknowledgement,
            "online",
        )
        .await?;
        tokio::time::timeout(Duration::from_secs(90), async {
            loop {
                let RuntimeProjection::Operations(operations) = tests::snapshot(
                    &native.core,
                    ObservationRequest::Operations {
                        account_id: self.account.clone(),
                    },
                )?
                else {
                    return Err("Missing restored consumer Move status".into());
                };
                if operations.operations.iter().any(|operation| {
                    operation.operation_id == self.operation
                        && operation.resolution == OperationResolution::Applied
                }) && super::items(native, &self.account)?.is_some_and(|items| {
                    items
                        .items
                        .iter()
                        .any(|item| item.item_id == self.item && item.vault_id == self.target)
                }) {
                    return Ok::<(), String>(());
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .map_err(|_| {
            "Original native consumer Move did not converge after restoration".to_owned()
        })??;
        eprintln!("Actual native binary Travel preserved the consumer's pending Move request bytes through hide and ACK; original accepted operation converged after fresh restoration");
        Ok(())
    }
}

impl Drop for PendingMove {
    fn drop(&mut self) {
        // Release the fault even when an assertion ends the process history early.
        let _ = std::fs::write(&self.network_control, "online");
    }
}

async fn network(control: &Path, acknowledgement: &Path, mode: &str) -> Result<(), String> {
    std::fs::write(control, mode).map_err(|_| "Cannot control native Move network fixture")?;
    tokio::time::timeout(Duration::from_secs(10), async {
        while std::fs::read_to_string(acknowledgement).ok().as_deref() != Some(mode) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| "Native Move network mode was not acknowledged".into())
}
