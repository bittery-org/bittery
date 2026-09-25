//! Protected image evidence inside the existing four-process real Server acceptance.
use super::{tests, NativeRuntime};
use bittery_client_core::{
    AccountId, CreateVaultType, ObservationRequest, OperationResolution, RuntimeProjection,
    RuntimeRequest, RuntimeResponse,
};
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{io::Write, path::Path, time::Duration};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

#[path = "native_hidden_image_acceptance.rs"]
mod hidden;
pub(super) use hidden::exercise_hidden;

const IMAGE: &[u8] = include_bytes!("../../icons/32x32.png");
const WITNESS: &str = "acceptance-protected-image.json";
const UPDATE_TARGET: &str = "acceptance-protected-update-vault";
const REPAIRED: &str = "acceptance-protected-image-repaired.json";
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
struct Witness {
    operation_id: String,
    intent_field: String,
    expected_name: String,
    vault_id: String,
    operation: String,
    artifact: String,
}
fn database(directory: &Path, name: &str) -> Result<Connection, String> {
    Connection::open_with_flags(directory.join(name), OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "Cannot read protected image acceptance database".into())
}
fn save(directory: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(directory.join(name))
        .map_err(|_| "Cannot create restricted image witness")?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| "Cannot persist image witness".into())
}
fn load(directory: &Path) -> Result<Vec<Witness>, String> {
    let bytes = Zeroizing::new(
        std::fs::read(directory.join(WITNESS)).map_err(|_| "Missing protected image witness")?,
    );
    serde_json::from_slice(&bytes).map_err(|_| "Invalid protected image witness".into())
}
fn decode(text: &str) -> Result<Value, String> {
    serde_json::from_str(text).map_err(|_| "Invalid protected image physical evidence".into())
}
fn replica_row(
    directory: &Path,
    account: &AccountId,
    store: i64,
    operation: &str,
) -> Result<String, String> {
    database(directory, "replica.sqlite")?.query_row(
        "SELECT payload_json FROM replica_rows WHERE account_id=?1 AND store=?2 AND record_id=?3",
        params![account.as_str(), store, operation], |row| row.get(0),
    ).map_err(|_| "Missing protected image Operation or receipt".into())
}
fn artifact(directory: &Path, account: &AccountId, operation: &str) -> Result<Value, String> {
    let db = database(directory, "vault-images.sqlite")?;
    let count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM vault_image_artifacts WHERE account_id=?1 AND operation_id=?2",
            params![account.as_str(), operation],
            |row| row.get(0),
        )
        .map_err(|_| "Cannot count image publications")?;
    if count != 1 {
        return Err("Expected exactly one protected publication and no raw sibling".into());
    }
    let (publication, vault, length, content_type, sha256, protection): (String,String,i64,String,String,String) = db.query_row(
        "SELECT publication_id,vault_id,byte_length,content_type,sha256,protection_json FROM vault_image_artifacts WHERE account_id=?1 AND operation_id=?2 AND published=1",
        params![account.as_str(), operation], |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
    ).map_err(|_| "Protected image publication metadata is missing")?;
    if publication.is_empty() || length != IMAGE.len() as i64 || content_type != "image/png" {
        return Err("Native image publication still has raw or unexpected metadata".into());
    }
    let chunks: Vec<(i64, Vec<u8>)> = db.prepare("SELECT chunk_index,plaintext FROM vault_image_artifact_chunks WHERE account_id=?1 AND operation_id=?2 AND publication_id=?3 ORDER BY chunk_index")
        .and_then(|mut statement|statement.query_map(params![account.as_str(), operation, publication], |row|Ok((row.get(0)?,row.get(1)?)))?.collect())
        .map_err(|_| "Cannot read protected image ciphertext chunks")?;
    if chunks.is_empty()
        || chunks.iter().enumerate().any(|(index, (actual, bytes))| {
            *actual != index as i64
                || bytes.is_empty()
                || bytes.len() > 256 * 1024
                || bytes.windows(IMAGE.len()).any(|part| part == IMAGE)
        })
    {
        return Err("Protected image ciphertext bounds or ordering failed".into());
    }
    for (_, bytes) in &chunks {
        let envelope: Value = serde_json::from_slice(bytes)
            .map_err(|_| "Image chunk is not an encrypted envelope")?;
        if envelope["algorithm"] != "AES-GCM-AAD-V1" || !envelope["ciphertext"].is_string() {
            return Err("Native image chunk is not protected".into());
        }
    }
    Ok(
        json!({"publicationId":publication,"vaultId":vault,"byteLength":length,"contentType":content_type,"sha256":sha256,"protection":decode(&protection)?,"chunks":chunks}),
    )
}
/// Bounded diagnostics only: no request, item plaintext, image bytes, or key material is logged.
pub(super) fn diagnose_pending(directory: &Path) -> Result<(), String> {
    let account = AccountId::from(
        std::fs::read_to_string(directory.join("acceptance-account-id"))
            .map_err(|_| "Cannot read diagnostic Account identity")?,
    );
    let db = database(directory, "replica.sqlite")?;
    let mut statement = db
        .prepare(
            "SELECT store,payload_json FROM replica_rows WHERE account_id=?1 AND store IN (1,3,6)",
        )
        .map_err(|_| "Cannot prepare bounded image diagnostics")?;
    let rows = statement
        .query_map([account.as_str()], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| "Cannot read bounded image diagnostics")?;
    for row in rows {
        let (store, payload) = row.map_err(|_| "Cannot read image diagnostic row")?;
        let value = decode(&payload)?;
        match store {
            1 => eprintln!(
                "Native pending checkpoint: kind={}, create={}, update={}, schedule={}",
                value["kind"],
                value["createVault"]["checkpoint"],
                value["updateVault"]["checkpoint"],
                value["scheduling"]
            ),
            3 if !value["state"].is_null() => eprintln!(
                "Native Bootstrap diagnostics: state={}, active={}, staging={}",
                value["state"],
                !value["activeGeneration"].is_null(),
                !value["stagingGeneration"].is_null()
            ),
            6 => eprintln!(
                "Native authority Vault diagnostic: wrapped key present={}",
                value["encryptedVaultKey"]
                    .as_str()
                    .is_some_and(|key| !key.is_empty())
            ),
            _ => (),
        }
    }
    Ok(())
}
async fn wait_for_vault(
    native: &NativeRuntime,
    account: &AccountId,
    vault_id: &str,
    name: &str,
    operation_id: &str,
    has_image: bool,
) -> Result<bittery_client_core::VaultProjection, String> {
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let RuntimeProjection::Operations(operations) = tests::snapshot(
                &native.core,
                ObservationRequest::Operations {
                    account_id: account.clone(),
                },
            )?
            else {
                return Err("Cannot observe protected image Operation".to_owned());
            };
            let Some(items) = tests::sample_acceptance_items(
                native,
                account,
                "Protected image Vault convergence wait",
            )?
            else {
                tokio::time::sleep(Duration::from_millis(30)).await;
                continue;
            };
            if operations.operations.iter().any(|op| {
                op.operation_id == operation_id && op.resolution == OperationResolution::Applied
            }) {
                if let Some(vault) = items.vaults.iter().find(|vault| {
                    vault.vault_id == vault_id
                        && vault.name == name
                        && vault.image_url.is_some() == has_image
                }) {
                    return Ok(vault.clone());
                }
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .map_err(|_| "Protected image did not converge through actual Server authority")?
}
pub(super) async fn create_update_target(
    native: &NativeRuntime,
    account: &AccountId,
    directory: &Path,
) -> Result<(), String> {
    let name = "Native protected Update target";
    let RuntimeResponse::VaultCreationAccepted {
        operation_id,
        vault_id,
        ..
    } = tests::acceptance_request(
        &native.core,
        RuntimeRequest::CreateVault {
            account_id: account.clone(),
            name: name.into(),
            vault_type: CreateVaultType::Personal,
            icon: "image".into(),
            image_source: None,
        },
    )
    .await?
    else {
        return Err("Native protected Update target was not accepted".into());
    };
    wait_for_vault(native, account, &vault_id, name, &operation_id, false).await?;
    save(directory, UPDATE_TARGET, vault_id.as_bytes())
}
pub(super) async fn accept(
    native: &NativeRuntime,
    account: &AccountId,
    directory: &Path,
) -> Result<(), String> {
    let update_vault = std::fs::read_to_string(directory.join(UPDATE_TARGET))
        .map_err(|_| "Missing protected Update target")?;
    let mut witnesses = Vec::new();
    for (intent_field, target, name) in [
        ("createVault", None, "Native protected restart image"),
        (
            "updateVault",
            Some(update_vault.as_str()),
            "Native protected Update restored",
        ),
    ] {
        let (source, caller) = tests::acceptance_image_source(native, account, target, IMAGE)?;
        let request = match target {
            None => RuntimeRequest::CreateVault {
                account_id: account.clone(),
                name: name.into(),
                vault_type: CreateVaultType::Personal,
                icon: "image".into(),
                image_source: Some(source),
            },
            Some(vault) => RuntimeRequest::UpdateVault {
                account_id: account.clone(),
                vault_id: vault.into(),
                name: Some(name.into()),
                icon: bittery_client_core::VaultIconPatch::Unchanged,
                image: bittery_client_core::VaultImageChange::Source { source },
            },
        };
        let (operation_id, vault_id) =
            match (
                target,
                tests::acceptance_request(&native.core, request).await?,
            ) {
                (
                    None,
                    RuntimeResponse::VaultCreationAccepted {
                        operation_id,
                        vault_id,
                        ..
                    },
                ) => (operation_id, vault_id),
                (
                    Some(target),
                    RuntimeResponse::VaultUpdateAccepted {
                        operation_id,
                        vault_id,
                        ..
                    },
                ) if vault_id == target => (operation_id, vault_id),
                _ => return Err(
                    "Protected image was not accepted with its original kind and target offline"
                        .into(),
                ),
            };
        drop(caller);
        let operation = replica_row(directory, account, 1, &operation_id)?;
        let original = decode(&operation)?;
        let physical = artifact(directory, account, &operation_id)?;
        if original[intent_field]["checkpoint"] != "artifact_ready"
            || original[intent_field]["image"]["protectedWitness"]
                != physical["protection"]["witness"]
        {
            return Err("Accepted protected witness is not the original SQLite publication".into());
        }
        witnesses.push(Witness {
            operation_id,
            vault_id,
            intent_field: intent_field.into(),
            expected_name: name.into(),
            operation,
            artifact: physical.to_string(),
        });
    }
    let RuntimeProjection::Items(items) = tests::snapshot(
        &native.core,
        ObservationRequest::Items {
            account_id: account.clone(),
        },
    )?
    else {
        return Err("Cannot inspect pending image authority".into());
    };
    if !items.vaults.iter().any(|vault| {
        vault.vault_id == update_vault
            && vault.name == "Native protected Update target"
            && vault.image_url.is_none()
    }) {
        return Err("Offline protected Update published unconfirmed metadata".into());
    }
    save(
        directory,
        WITNESS,
        &Zeroizing::new(
            serde_json::to_vec(&witnesses).map_err(|_| "Cannot encode protected image witness")?,
        ),
    )?;
    verify_pending(account, directory)
}
pub(super) fn verify_pending(account: &AccountId, directory: &Path) -> Result<(), String> {
    let witnesses = load(directory)?;
    if witnesses.len() != 2 {
        return Err("Protected image witness omitted Create or Update".into());
    }
    for witness in witnesses {
        let original = decode(&witness.operation)?;
        let current = decode(&replica_row(directory, account, 1, &witness.operation_id)?)?;
        for field in [
            "operationId",
            "kind",
            "target",
            "request",
            "requestFingerprint",
            witness.intent_field.as_str(),
        ] {
            if original.get(field) != current.get(field) {
                return Err("Protected image accepted intent changed before upload".into());
            }
        }
    }
    Ok(())
}
/// Caller holds the existing exclusive recovery maintenance gate after the locked export.
pub(super) fn damage(account: &AccountId, directory: &Path) -> Result<(), String> {
    verify_pending(account, directory)?;
    let db = Connection::open(directory.join("vault-images.sqlite"))
        .map_err(|_| "Cannot open selected image fault")?;
    db.execute_batch("PRAGMA foreign_keys=ON")
        .map_err(|_| "Cannot enable exact image fault cascade")?;
    for witness in load(directory)? {
        if artifact(directory, account, &witness.operation_id)? != decode(&witness.artifact)? {
            return Err("Protected publication changed before process loss".into());
        }
        if db
            .execute(
                "DELETE FROM vault_image_artifacts WHERE account_id=?1 AND operation_id=?2",
                params![account.as_str(), witness.operation_id],
            )
            .map_err(|_| "Cannot remove witnessed protected image")?
            != 1
        {
            return Err("Image fault did not remove exactly one publication".into());
        }
    }
    Ok(())
}
pub(super) fn verify_repaired(account: &AccountId, directory: &Path) -> Result<(), String> {
    verify_pending(account, directory)?;
    let mut repaired = Vec::new();
    for witness in load(directory)? {
        let current = artifact(directory, account, &witness.operation_id)?;
        let mut before = decode(&witness.artifact)?;
        let mut after = current.clone();
        // A removed publication may be rewrapped; all other metadata and every chunk stay exact.
        for value in [&mut before, &mut after] {
            value["protection"]
                .as_object_mut()
                .ok_or("Missing protected metadata")?
                .remove("wrappedKey");
        }
        if before != after {
            return Err(
                "Native repair changed accepted protected image metadata or ciphertext".into(),
            );
        }
        repaired.push(current);
    }
    save(directory, REPAIRED, json!(repaired).to_string().as_bytes())?;
    eprintln!("Locked native archive restored original protected Create and Update witnesses and ciphertext in a fresh process");
    Ok(())
}
pub(super) fn verify_reopened(account: &AccountId, directory: &Path) -> Result<(), String> {
    verify_pending(account, directory)?;
    let repaired = std::fs::read_to_string(directory.join(REPAIRED))
        .map_err(|_| "Missing repaired image witness")?;
    let current = load(directory)?
        .iter()
        .map(|witness| artifact(directory, account, &witness.operation_id))
        .collect::<Result<Vec<_>, _>>()?;
    if json!(current) != decode(&repaired)? {
        return Err("Native process restart changed protected image wrappers or ciphertext".into());
    }
    Ok(())
}
pub(super) async fn converge(
    native: &NativeRuntime,
    account: &AccountId,
    directory: &Path,
) -> Result<(), String> {
    for witness in load(directory)? {
        let vault = wait_for_vault(
            native,
            account,
            &witness.vault_id,
            &witness.expected_name,
            &witness.operation_id,
            true,
        )
        .await?;
        let response = reqwest::Client::new()
            .get(
                vault
                    .image_url
                    .ok_or("Protected image current Vault has no image URL")?,
            )
            .send()
            .await
            .map_err(|_| "Cannot fetch actual published protected image")?;
        if !response.status().is_success()
            || response
                .bytes()
                .await
                .map_err(|_| "Cannot read published image")?
                .as_ref()
                != IMAGE
        {
            return Err("Actual protected image upload changed the original public bytes".into());
        }
        if witness.intent_field == "updateVault"
            && hidden::upload_attempts(&witness.operation_id).await? == 0
        {
            return Err(
                "Object fixture did not observe the restored original Update upload".into(),
            );
        }
    }
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if verify_final(account, directory).is_ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .map_err(|_| "Protected image terminal artifact cleanup did not finish")?;
    eprintln!("Actual native protected Create image survived locked recovery and process restart, uploaded original bytes, and completed exact terminal cleanup");
    eprintln!("Actual native offline protected Update preserved original intent through recovery and restart, uploaded exact PNG bytes, and reconciled current Vault authority");
    Ok(())
}
pub(super) fn verify_final(account: &AccountId, directory: &Path) -> Result<(), String> {
    let db = database(directory, "vault-images.sqlite")?;
    for witness in load(directory)? {
        let receipt = decode(&replica_row(directory, account, 2, &witness.operation_id)?)?;
        let original = decode(&witness.operation)?;
        for field in ["operationId", "kind", "target", "requestFingerprint"] {
            if receipt.get(field) != original.get(field) {
                return Err("Protected image terminal receipt changed accepted identity".into());
            }
        }
        if receipt["result"] != json!({"type":"vaultApplied","vaultId":witness.vault_id})
            || receipt.get("createVaultCleanup").is_some()
        {
            return Err("Protected image terminal receipt or cleanup is incomplete".into());
        }
        for table in ["vault_image_artifacts", "vault_image_artifact_chunks"] {
            let count: i64 = db
                .query_row(
                    &format!(
                        "SELECT COUNT(*) FROM {table} WHERE account_id=?1 AND operation_id=?2"
                    ),
                    params![account.as_str(), witness.operation_id],
                    |row| row.get(0),
                )
                .map_err(|_| "Cannot inspect terminal protected image cleanup")?;
            if count != 0 {
                return Err("Terminal protected image physical generation survived".into());
            }
        }
    }
    Ok(())
}
