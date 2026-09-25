//! Actual Core/Server deletion racing all Item categories in the existing process-recovery fixture.
//! Network faults discard real replies; this module never supplies a semantic outcome.
use super::{tests, NativeRuntime};
use bittery_client_core::{
    AccountId, CreateVaultType, ItemDraft, ObservationRequest, OperationResolution,
    RuntimeProjection, RuntimeRequest, RuntimeResponse,
};
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{io::Write, path::Path, time::Duration};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const VAULT: &str = "acceptance-deleted-vault-id";
const WITNESS: &str = "acceptance-deleted-vault-work.json";
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
struct Accepted {
    id: String,
    payload: String,
}
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
struct Witness {
    vault_id: String,
    delete_id: String,
    accepted: Vec<Accepted>,
}
fn save(directory: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(directory.join(name))
        .and_then(|mut file| file.write_all(bytes))
        .map_err(|_| "Cannot save restricted Vault acceptance evidence".into())
}
fn database(directory: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(
        directory.join("replica.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|_| "Cannot open actual Vault acceptance Replica".into())
}
fn row(
    connection: &Connection,
    account: &AccountId,
    store: i64,
    id: &str,
) -> Result<String, String> {
    connection.query_row("SELECT payload_json FROM replica_rows WHERE account_id=?1 AND store=?2 AND record_id=?3",params![account.as_str(),store,id],|row|row.get(0)).map_err(|_|"Expected durable Vault acceptance record is missing".into())
}
fn load(directory: &Path) -> Result<Witness, String> {
    let bytes = Zeroizing::new(
        std::fs::read(directory.join(WITNESS))
            .map_err(|_| "Cannot read Vault accepted-work witness")?,
    );
    serde_json::from_slice(&bytes).map_err(|_| "Invalid Vault accepted-work witness".into())
}
fn decode(payload: &str) -> Result<Value, String> {
    serde_json::from_str(payload).map_err(|_| "Invalid physical Vault acceptance payload".into())
}

pub(super) async fn create(
    native: &NativeRuntime,
    account: &AccountId,
    directory: &Path,
) -> Result<(), String> {
    let RuntimeResponse::VaultCreationAccepted {
        vault_id,
        operation_id,
        ..
    } = tests::acceptance_request(
        &native.core,
        RuntimeRequest::CreateVault {
            account_id: account.clone(),
            name: "Native deletion race".into(),
            vault_type: CreateVaultType::Personal,
            icon: "folder".into(),
            image_source: None,
        },
    )
    .await?
    else {
        return Err("Native deletion fixture Vault was not accepted".into());
    };
    tokio::time::timeout(Duration::from_secs(50), async {
        loop {
            let Some(items) = tests::sample_acceptance_items(
                native,
                account,
                "Deletion fixture Vault creation wait",
            )?
            else {
                tokio::time::sleep(Duration::from_millis(20)).await;
                continue;
            };
            let RuntimeProjection::Operations(operations) = tests::snapshot(
                &native.core,
                ObservationRequest::Operations {
                    account_id: account.clone(),
                },
            )?
            else {
                return Err("Cannot observe deletion fixture creation".into());
            };
            if items.vaults.iter().any(|vault| vault.vault_id == vault_id)
                && operations.operations.iter().any(|operation| {
                    operation.operation_id == operation_id
                        && operation.resolution == OperationResolution::Applied
                })
            {
                return Ok::<_, String>(());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| "Native deletion fixture Vault did not hydrate".to_owned())??;
    save(directory, VAULT, vault_id.as_bytes())
}

pub(super) async fn accept(
    native: &NativeRuntime,
    account: &AccountId,
    directory: &Path,
    target_file: &Path,
) -> Result<(), String> {
    let vault_id = std::fs::read_to_string(directory.join(VAULT))
        .map_err(|_| "Missing deletion fixture Vault")?;
    let mut accepted = Vec::new();
    for (category, data) in [
        (
            "login",
            json!({"title":"Delete race Login","username":"queued","password":"fixture-only"}),
        ),
        (
            "secure-note",
            json!({"title":"Delete race Note","note":"accepted before Vault deletion"}),
        ),
        (
            "credit-card",
            json!({"title":"Delete race Card","cardNumber":"4111111111111111"}),
        ),
        (
            "identity",
            json!({"title":"Delete race Identity","firstName":"Fixture"}),
        ),
        (
            "authenticator",
            json!({"title":"Delete race Authenticator","totpSecret":"JBSWY3DPEHPK3PXP"}),
        ),
    ] {
        let draft: ItemDraft = serde_json::from_value(json!({"category":category,"data":data}))
            .map_err(|_| "Invalid native category fixture")?;
        let RuntimeResponse::Accepted { operation_id, .. } = tests::acceptance_request(
            &native.core,
            RuntimeRequest::CreateItem {
                account_id: account.clone(),
                vault_id: vault_id.clone(),
                draft,
            },
        )
        .await?
        else {
            return Err("Native offline Item Create was not accepted".into());
        };
        accepted.push(Accepted {
            id: operation_id.clone(),
            payload: row(&database(directory)?, account, 1, &operation_id)?,
        });
    }
    let RuntimeResponse::VaultDeletionAccepted {
        operation_id: delete_id,
        ..
    } = tests::acceptance_request(
        &native.core,
        RuntimeRequest::DeleteVault {
            account_id: account.clone(),
            vault_id: vault_id.clone(),
        },
    )
    .await?
    else {
        return Err("Native offline DeleteVault was not accepted".into());
    };
    accepted.push(Accepted {
        id: delete_id.clone(),
        payload: row(&database(directory)?, account, 1, &delete_id)?,
    });
    let witness = Witness {
        vault_id,
        delete_id: delete_id.clone(),
        accepted,
    };
    save(
        directory,
        WITNESS,
        &Zeroizing::new(serde_json::to_vec(&witness).map_err(|_| "Cannot encode Vault witness")?),
    )?;
    std::fs::write(
        target_file,
        serde_json::to_vec(&json!({"vaultId":witness.vault_id,"operationId":delete_id}))
            .map_err(|_| "Cannot encode exact deletion fault target")?,
    )
    .map_err(|_| "Cannot select exact deletion network fault")?;
    Ok(())
}

pub(super) async fn await_lost_reply(
    account: &AccountId,
    directory: &Path,
    reply_file: &Path,
) -> Result<(), String> {
    let witness = load(directory)?;
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if let Ok(bytes) = std::fs::read(reply_file) {
                if !bytes.is_empty() {
                    let reply: Value = serde_json::from_slice(&bytes)
                        .map_err(|_| "Invalid real deletion reply marker")?;
                    let expected = json!({
                        "kind": "delete_vault",
                        "operationId": witness.delete_id,
                        "result": {"status": "applied", "vaultId": witness.vault_id}
                    });
                    if reply != expected {
                        return Err(
                            "Fault proxy did not witness the exact real applied deletion".into(),
                        );
                    }
                    save(directory, "acceptance-lost-delete-reply.json", &bytes)?;
                    return Ok::<_, String>(());
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| "Proxy did not discard a real successful deletion reply".to_owned())??;
    verify_pending(account, directory)
}

pub(super) fn verify_pending(account: &AccountId, directory: &Path) -> Result<(), String> {
    let witness = load(directory)?;
    let connection = database(directory)?;
    if witness.accepted.len() != 6 {
        return Err("Vault deletion witness omitted an Item category".into());
    }
    for accepted in &witness.accepted {
        let original = decode(&accepted.payload)?;
        let current = decode(&row(&connection, account, 1, &accepted.id)?)?;
        for field in [
            "operationId",
            "kind",
            "target",
            "requestFingerprint",
            "request",
            "acceptedItemCategory",
        ] {
            if original.get(field) != current.get(field) {
                return Err("Accepted Vault race request changed before replay".into());
            }
        }
        let receipts:i64=connection.query_row("SELECT COUNT(*) FROM replica_rows WHERE account_id=?1 AND store=2 AND record_id=?2",params![account.as_str(),accepted.id],|row|row.get(0)).map_err(|_|"Cannot inspect pre-restart receipts")?;
        if receipts != 0 {
            return Err("Deletion outcome became known before actual process loss".into());
        }
    }
    Ok(())
}

pub(super) async fn converge(
    native: &NativeRuntime,
    account: &AccountId,
    directory: &Path,
) -> Result<(), String> {
    let witness = load(directory)?;
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let RuntimeProjection::Operations(operations) = tests::snapshot(
                &native.core,
                ObservationRequest::Operations {
                    account_id: account.clone(),
                },
            )?
            else {
                return Err("Cannot observe Vault race completion".into());
            };
            let complete = witness.accepted.iter().all(|accepted| {
                operations.operations.iter().any(|operation| {
                    operation.operation_id == accepted.id
                        && if accepted.id == witness.delete_id {
                            operation.resolution == OperationResolution::Applied
                        } else {
                            operation.resolution == OperationResolution::Rejected
                                && operation.rejection_code.as_deref()
                                    == Some("vault_access_denied")
                        }
                })
            });
            // A retained receipt and the following authoritative Bootstrap are separate duties.
            // Wait for actual physical purge/journal acknowledgement as well as original outcomes.
            if complete && verify_final(native, account, directory).is_ok() {
                return Ok::<_, String>(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| {
        if let Ok(RuntimeProjection::Operations(operations)) = tests::snapshot(
            &native.core,
            ObservationRequest::Operations { account_id: account.clone() },
        ) {
            for (index, accepted) in witness.accepted.iter().enumerate() {
                let current = operations.operations.iter().find(|operation| operation.operation_id == accepted.id);
                eprintln!("Vault race terminal diagnostic: index={index}, resolution={:?}, expected_rejection={}",
                    current.map(|operation| operation.resolution),
                    current.is_some_and(|operation| operation.rejection_code.as_deref() == Some("vault_access_denied")));
            }
        }
        let physical = verify_final(native, account, directory).err()
            .unwrap_or_else(|| "Physical Vault retirement completed".into());
        format!("Real Server Vault deletion race did not reconcile all five categories: {physical}")
    })??;
    verify_final(native, account, directory)?;
    eprintln!("Actual native lost DeleteVault reply reconciled after process restart; five exact accepted Item categories rejected by deleted Vault authority");
    Ok(())
}

pub(super) fn verify_final(
    native: &NativeRuntime,
    account: &AccountId,
    directory: &Path,
) -> Result<(), String> {
    let witness = load(directory)?;
    let connection = database(directory)?;
    for accepted in &witness.accepted {
        let original = decode(&accepted.payload)?;
        let receipt = decode(&row(&connection, account, 2, &accepted.id)?)?;
        for field in ["operationId", "kind", "target", "requestFingerprint"] {
            if original.get(field) != receipt.get(field) {
                return Err("Terminal Vault race receipt changed accepted identity".into());
            }
        }
        let expected = if accepted.id == witness.delete_id {
            json!({"type":"vaultApplied","vaultId":witness.vault_id})
        } else {
            json!({"type":"rejected","code":"vault_access_denied"})
        };
        if receipt.get("result") != Some(&expected) {
            return Err(
                "Actual retained Vault race result differs from required Server outcome".into(),
            );
        }
    }
    let mut statement=connection.prepare("SELECT store,payload_json FROM replica_rows WHERE account_id=?1 AND store IN (0,1,3,6,7,8,9)").map_err(|_|"Cannot inspect retired Vault authority")?;
    let records = statement
        .query_map([account.as_str()], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| "Cannot query retired Vault authority")?;
    for entry in records {
        let (store, payload) = entry.map_err(|_| "Cannot read retired Vault evidence")?;
        let value = decode(&payload)?;
        if matches!(store, 0 | 6 | 7 | 9)
            && (value.get("vaultId").and_then(Value::as_str) == Some(&witness.vault_id)
                || (store == 6
                    && value.get("id").and_then(Value::as_str) == Some(&witness.vault_id)))
        {
            return Err("Deleted Vault authority or optimistic/capability state survived".into());
        }
        if store == 1
            && witness.accepted.iter().any(|accepted| {
                value.get("operationId").and_then(Value::as_str) == Some(&accepted.id)
            })
        {
            return Err("Completed Vault race retained an Operation".into());
        }
        if store == 3
            && value
                .get("vaultIds")
                .and_then(Value::as_array)
                .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(&witness.vault_id)))
        {
            return Err("Deleted Vault cleanup journal remains pending".into());
        }
    }
    let RuntimeProjection::Items(items) = tests::snapshot(
        &native.core,
        ObservationRequest::Items {
            account_id: account.clone(),
        },
    )?
    else {
        return Err("Cannot inspect final Vault projection".into());
    };
    if items
        .vaults
        .iter()
        .any(|vault| vault.vault_id == witness.vault_id)
        || items
            .items
            .iter()
            .any(|item| item.vault_id == witness.vault_id)
    {
        return Err("Deleted Vault returned through a native projection".into());
    }
    Ok(())
}
