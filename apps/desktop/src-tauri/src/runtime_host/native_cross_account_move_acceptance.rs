//! Actual Server and process-owner loss, using only the installed native Runtime and file ports.
use super::super::file_capabilities::UploadSelection;
use super::{tests, NativeRuntime};
use bittery_client_core::{
    AccountAccessState, AccountId, AttachmentMoveAccountLeasePort, AuthClientConfig,
    ClientPlatform, ItemProjectionStatus, ObservationRequest, OperationResolution,
    ProvisionalAttachmentArtifactScope, ProvisionalAttachmentArtifactStore,
    ProvisionalAttachmentArtifactStoreRequest, ProvisionalAttachmentArtifactStoreResponse,
    ProvisionalAttachmentArtifactWriter, RuntimeProjection, RuntimeRequest, RuntimeResponse,
    SecretString, SqliteAttachmentArtifactStore,
};
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};
use zeroize::Zeroizing;

const TEST: &str = "runtime_host::native::cross_account_move_acceptance::real_server_attachment_move_survives_process_loss";
const PHASE: &str = "BITTERY_NATIVE_CROSS_MOVE_PHASE";
const EXIT: i32 = 90;
const BOUNDARY: &str =
    "Native cross-Account Move exits after real durable grant commit with original sealed artifact";
const BYTES: usize = 524_317;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Account {
    email: SecretString,
    password: SecretString,
    secret_key: SecretString,
    expected_item_title: String,
    vault_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credentials {
    server_url: String,
    accounts: Vec<Account>,
    network_control: PathBuf,
    network_committed: PathBuf,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Witness {
    source: AccountId,
    target: AccountId,
    operation_id: String,
    record: Value,
    artifact: Value,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Orphan {
    operation_id: String,
    attachment_id: String,
    generation: String,
}

fn require(condition: bool, message: &str) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}
fn save(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .and_then(|mut file| file.write_all(bytes))
        .map_err(|_| "Cannot save protected cross-Account acceptance evidence".into())
}
fn read<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let bytes = Zeroizing::new(
        std::fs::read(path).map_err(|_| "Cannot read protected cross-Account fixture")?,
    );
    serde_json::from_slice(&bytes).map_err(|_| "Invalid protected cross-Account fixture".into())
}
async fn wait_file(path: &Path, seconds: u64) -> Result<String, String> {
    tokio::time::timeout(Duration::from_secs(seconds), async {
        loop {
            if let Ok(value) = std::fs::read_to_string(path) {
                if !value.is_empty() {
                    return value;
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(|_| "Cross-Account fixture boundary was not reached".into())
}
fn database(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "Cannot read native cross-Account database".into())
}
fn record(directory: &Path, source: &AccountId, operation: &str) -> Result<Value, String> {
    let encoded: String = database(&directory.join("replica.sqlite"))?.query_row(
        "SELECT payload_json FROM replica_rows WHERE account_id=?1 AND store=10 AND record_id=?2",
        params![source.as_str(), operation], |row| row.get(0),
    ).map_err(|_| "Accepted cross-Account Move row is missing")?;
    serde_json::from_str(&encoded).map_err(|_| "Invalid accepted cross-Account row".into())
}
fn artifact(directory: &Path, source: &AccountId, operation: &str) -> Result<Value, String> {
    let db = database(&directory.join("attachments.sqlite"))?;
    let (id, attachment, digest, length, count, generation): (String,String,String,i64,i64,String) = db.query_row(
        "SELECT artifact_id,attachment_id,ciphertext_sha256,byte_length,chunk_count,physical_generation FROM attachment_move_artifacts WHERE account_id=?1 AND operation_id=?2 AND publication_state=2",
        params![source.as_str(),operation], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)),
    ).map_err(|_| "Published cross-Account artifact is missing")?;
    let chunks: Vec<Value> = db.prepare(
        "SELECT chunk_index,ciphertext_sha256,ciphertext FROM attachment_move_provisional_chunks WHERE account_id=?1 AND operation_id=?2 AND attachment_id=?3 AND generation=?4 ORDER BY chunk_index",
    ).and_then(|mut statement| statement.query_map(params![source.as_str(),operation,&attachment,&generation], |row| {
        let index: i64 = row.get(0)?;
        let digest: String = row.get(1)?;
        let bytes: Vec<u8> = row.get(2)?;
        Ok(json!({"index":index,"sha256":digest,"ciphertext":bytes}))
    })?.collect()).map_err(|_| "Cannot read original cross-Account ciphertext chunks")?;
    require(
        count > 2 && chunks.len() == count as usize && !generation.is_empty(),
        "Cross-Account artifact is not a complete bounded publication",
    )?;
    Ok(
        json!({"artifactId":id,"attachmentId":attachment,"sha256":digest,"byteLength":length,"chunkCount":count,"generation":generation,"chunks":chunks}),
    )
}

fn orphan_rows(
    directory: &Path,
    source: &AccountId,
    orphan: &Orphan,
) -> Result<(i64, i64), String> {
    database(&directory.join("attachments.sqlite"))?
        .query_row(
            "SELECT
             (SELECT COUNT(*) FROM attachment_move_provisional_artifacts
              WHERE account_id=?1 AND operation_id=?2 AND attachment_id=?3 AND generation=?4),
             (SELECT COUNT(*) FROM attachment_move_provisional_chunks
              WHERE account_id=?1 AND operation_id=?2 AND attachment_id=?3 AND generation=?4)",
            params![
                source.as_str(),
                orphan.operation_id,
                orphan.attachment_id,
                orphan.generation
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "Cannot inspect exact orphan generation".into())
}

/// Runs only in the fresh restore process, before it creates a Runtime or starts any runner.
async fn seed_unowned_generation(directory: &Path) -> Result<(), String> {
    let witness: Witness = read(&directory.join("cross-move-witness.json"))?;
    let scope = ProvisionalAttachmentArtifactScope::new(
        witness.source.clone(),
        bittery_crypto_core::generate_uuid(),
        bittery_crypto_core::generate_uuid(),
    )
    .map_err(|_| "Cannot create unowned artifact scope")?;
    require(
        scope.operation_id() != witness.operation_id,
        "Orphan witness must not claim the accepted Move",
    )?;
    let store = SqliteAttachmentArtifactStore::open(directory.join("attachments.sqlite"))
        .map_err(|_| "Cannot open ownerless physical artifact store")?;
    let ProvisionalAttachmentArtifactStoreResponse::Begun(writer) = store
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Begin {
            writer: ProvisionalAttachmentArtifactWriter::new(scope),
        })
        .await
        .map_err(|_| "Cannot begin unowned artifact generation")?
    else {
        return Err("Unowned artifact generation was not begun".into());
    };
    let orphan = Orphan {
        operation_id: writer.operation_id().into(),
        attachment_id: writer.attachment_id().into(),
        generation: writer.generation().into(),
    };
    require(
        matches!(
            store
                .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::WriteChunk {
                    writer,
                    chunk_index: 0,
                    bytes: vec![0x71; 32],
                })
                .await
                .map_err(|_| "Cannot write unowned artifact bytes")?,
            ProvisionalAttachmentArtifactStoreResponse::ChunkWritten(_)
        ),
        "Unowned artifact bytes were not retained",
    )?;
    drop(store);
    require(
        orphan_rows(directory, &witness.source, &orphan)? == (1, 1),
        "Full-sweep witness must physically exist before Runtime startup",
    )?;
    save(
        &directory.join("cross-move-orphan.json"),
        &serde_json::to_vec(&orphan).map_err(|_| "Cannot encode orphan witness")?,
    )
}
fn items(
    native: &NativeRuntime,
    account: &AccountId,
) -> Result<bittery_client_core::ItemsProjection, String> {
    tests::sample_acceptance_items(native, account, "Cross-Account Move")?
        .ok_or_else(|| "Cross-Account authority is not verified".into())
}

async fn prepare(
    native: &NativeRuntime,
    credentials: &Credentials,
    directory: &Path,
) -> Result<(), String> {
    require(
        credentials.accounts.len() == 2,
        "Cross-Account fixture requires exactly two Users",
    )?;
    let mut accounts = Vec::new();
    for credential in &credentials.accounts {
        let account = tests::sign_in_acceptance_account(
            native,
            &credentials.server_url,
            &credential.email,
            &credential.password,
            &credential.secret_key,
        )
        .await?;
        tests::wait_for_acceptance_item(native, &account, &credential.expected_item_title).await?;
        accounts.push(account);
    }
    let source = accounts[0].clone();
    let target = accounts[1].clone();
    require(source != target, "Two Users must install distinct Accounts")?;
    let source_items = items(native, &source)?;
    let source_item = source_items
        .items
        .iter()
        .find(|item| item.data.title() == credentials.accounts[0].expected_item_title)
        .ok_or("Source Item is missing")?;
    require(
        source_item.vault_id == credentials.accounts[0].vault_id,
        "Source Item has foreign Vault authority",
    )?;
    let selection = UploadSelection {
        account_id: source.clone(),
        item_id: source_item.item_id.clone(),
        name: "cross-account-original.bin".into(),
        content_type: "application/octet-stream".into(),
        expected_bytes: BYTES as u64,
    };
    let path = directory.join("selected-cross-account.bin");
    save(&path, &vec![0x31; BYTES])?;
    let caller = native
        .file_capabilities
        .caller()
        .map_err(|_| "Cannot open selected-file caller")?;
    let scope = native
        .file_capabilities
        .scope(&caller, source.clone(), &source_item.vault_id)
        .map_err(|_| "Cannot scope source file")?;
    let source_capability_id = native
        .file_capabilities
        .grant_upload(
            scope,
            selection.clone(),
            std::fs::File::open(&path).map_err(|_| "Cannot open selected source file")?,
        )
        .map_err(|_| "Cannot grant source file")?;
    let upload = tests::acceptance_request(
        &native.core,
        RuntimeRequest::UploadAttachment {
            account_id: source.clone(),
            item_id: selection.item_id.clone(),
            name: selection.name,
            content_type: selection.content_type,
            file_size: selection.expected_bytes,
            source_capability_id,
        },
    )
    .await?;
    require(
        matches!(upload, RuntimeResponse::AttachmentUploaded { .. }),
        "Source public Upload did not complete",
    )?;
    let response = tests::acceptance_request(
        &native.core,
        RuntimeRequest::MoveItem {
            account_id: source.clone(),
            item_id: source_item.item_id.clone(),
            target_account_id: Some(target.clone()),
            target_vault_id: credentials.accounts[1].vault_id.clone(),
        },
    )
    .await?;
    let RuntimeResponse::Accepted { operation_id, .. } = response else {
        return Err("Cross-Account Move was not accepted".into());
    };
    let committed = wait_file(&credentials.network_committed, 100).await?;
    let committed: Value =
        serde_json::from_str(&committed).map_err(|_| "Invalid actual grant boundary")?;
    let accepted = record(directory, &source, &operation_id)?;
    require(
        accepted["stage"] == json!({"type":"attachments","nextIndex":0})
            && accepted["children"]
                .as_array()
                .is_some_and(|children| children.len() == 1),
        "Lost grant must precede registration and source destruction",
    )?;
    let checkpoint = &accepted["attachments"][0];
    require(
        checkpoint["targetAttachmentId"] == committed["attachmentId"]
            && checkpoint["progress"]["type"] == "encrypted",
        "Lost grant has no exact sealed checkpoint",
    )?;
    let request_bytes: Vec<u8> =
        serde_json::from_value(checkpoint["progress"]["grantRequest"]["body"].clone())
            .map_err(|_| "Invalid fixed grant body")?;
    let grant: Value =
        serde_json::from_slice(&request_bytes).map_err(|_| "Invalid durable grant request")?;
    require(
        grant == committed["request"],
        "Actual Server grant request differs from durable intent",
    )?;
    let source_now = items(native, &source)?;
    require(
        source_now.items.iter().any(|item| {
            item.item_id == source_item.item_id && item.status == ItemProjectionStatus::Pending
        }),
        "Source disappeared before cross-Account completion",
    )?;
    let witness = Witness {
        source,
        target,
        operation_id: operation_id.clone(),
        artifact: artifact(directory, &accounts[0], &operation_id)?,
        record: accepted,
    };
    save(
        &directory.join("cross-move-witness.json"),
        &serde_json::to_vec(&witness).map_err(|_| "Cannot encode cross-Account witness")?,
    )?;
    eprintln!("{BOUNDARY}");
    std::process::exit(EXIT);
}

async fn restore(
    native: &NativeRuntime,
    credentials: &Credentials,
    directory: &Path,
) -> Result<(), String> {
    let witness: Witness = read(&directory.join("cross-move-witness.json"))?;
    let RuntimeProjection::RuntimeStatus(status) = tests::snapshot(
        &native.core,
        ObservationRequest::RuntimeStatus { account_id: None },
    )?
    else {
        return Err("Missing restarted Runtime status".into());
    };
    require(
        status.accounts.len() == 2
            && status
                .accounts
                .iter()
                .all(|account| account.access == AccountAccessState::Locked),
        "A fresh process must reopen both Accounts locked",
    )?;
    require(
        artifact(directory, &witness.source, &witness.operation_id)? == witness.artifact,
        "Process restart changed artifact generation, digest, length or bytes",
    )?;
    let reopened = record(directory, &witness.source, &witness.operation_id)?;
    for field in ["source", "target", "attachments", "children"] {
        require(
            reopened[field] == witness.record[field],
            "Restart changed accepted cross-Account evidence",
        )?;
    }
    std::fs::write(&credentials.network_control, "unlock")
        .map_err(|_| "Cannot allow explicit native unlock")?;
    for (account, credential) in [&witness.source, &witness.target]
        .into_iter()
        .zip(&credentials.accounts)
    {
        tests::acceptance_request(
            &native.core,
            RuntimeRequest::QuickUnlock {
                account_id: account.clone(),
                master_password: credential.password.as_ref().to_owned(),
            },
        )
        .await?;
    }
    let orphan: Orphan = read(&directory.join("cross-move-orphan.json"))?;
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if orphan_rows(directory, &witness.source, &orphan)? == (0, 0) {
                return Ok::<_, String>(());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(|_| "Startup sweep did not reclaim the exact unowned generation")??;
    let leases = native
        .leases
        .as_ref()
        .ok_or("Native artifact Account lease is unavailable")?;
    let inspection = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if let Some(lease) = leases
                .acquire(&witness.source)
                .await
                .map_err(|_| "Cannot acquire post-sweep inspection lease")?
            {
                return Ok::<_, String>(lease);
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(|_| "Prior source artifact lifecycle pass did not drain")??;
    // The unowned generation's deletion establishes sweep entry; reacquiring this same lease
    // establishes that its whole lifecycle pass finished before inspecting the accepted bytes.
    require(
        inspection.is_live()
            && artifact(directory, &witness.source, &witness.operation_id)? == witness.artifact,
        "Unlock or the observed startup sweep changed the accepted artifact",
    )?;
    drop(inspection);
    eprintln!("Native cross-Account startup sweep reclaimed an exact unowned generation while retaining original accepted ciphertext");
    std::fs::write(&credentials.network_control, "resume")
        .map_err(|_| "Cannot release exact durable grant retry")?;
    tokio::time::timeout(Duration::from_secs(100), async {
        loop {
            if let RuntimeProjection::Operations(value) = tests::snapshot(
                &native.core,
                ObservationRequest::Operations {
                    account_id: witness.source.clone(),
                },
            )? {
                if value.operations.iter().any(|operation| {
                    operation.operation_id == witness.operation_id
                        && operation.resolution == OperationResolution::Applied
                }) {
                    return Ok::<_, String>(());
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| "Cross-Account Move did not converge after process restart")??;
    let completed = record(directory, &witness.source, &witness.operation_id)?;
    for field in ["source", "target", "attachments"] {
        require(
            completed[field] == witness.record[field],
            "Completion rewrote accepted cross-Account intent",
        )?;
    }
    let children = completed["children"]
        .as_array()
        .ok_or("Missing cross-Account child evidence")?;
    require(
        children.len() == 4
            && children
                .iter()
                .filter(|child| {
                    child["type"] == "itemOperation"
                        && child["result"]["result"]["type"] == "applied"
                })
                .count()
                == 3,
        "Completion requires exactly three retained Item outcomes",
    )?;
    require(
        children[1]["type"] == "attachmentRegistration"
            && children[1].get("operationId").is_none()
            && children[1]["result"]["type"] == "acknowledged",
        "Registration must retain its own actual acknowledgement",
    )?;
    require(
        children[0] == witness.record["children"][0],
        "Restart rewrote the original retained target Create request or proof",
    )?;
    require(
        completed["stage"]["type"] == "completed",
        "Move durable stage is incomplete",
    )?;
    let target_items = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let target_items = items(native, &witness.target)?;
            let target_ready = target_items.items.iter().any(|item| {
                Some(item.item_id.as_str()) == completed["target"]["id"].as_str()
                    && item.status == ItemProjectionStatus::Authoritative
                    && item.attachments.len() == 1
            });
            let source_absent = !items(native, &witness.source)?
                .items
                .iter()
                .any(|item| Some(item.item_id.as_str()) == completed["source"]["id"].as_str());
            if target_ready && source_absent {
                return Ok::<_, String>(target_items);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| "Live Sync did not converge to the target Attachment and source absence")??;
    let target = target_items
        .items
        .iter()
        .find(|item| Some(item.item_id.as_str()) == completed["target"]["id"].as_str())
        .ok_or("Target Item was not authoritatively restored")?;
    require(
        target.status == ItemProjectionStatus::Authoritative
            && target.data.title() == credentials.accounts[0].expected_item_title
            && target.attachments.len() == 1,
        "Target Item or Attachment plaintext differs",
    )?;
    let attachment = &target.attachments[0];
    require(
        attachment.name == "cross-account-original.bin"
            && attachment.content_type == "application/octet-stream"
            && attachment.file_size == BYTES as i32
            && Some(attachment.attachment_id.as_str())
                == completed["attachments"][0]["targetAttachmentId"].as_str(),
        "Target Attachment metadata is not original plaintext under its new identity",
    )?;
    let caller = native
        .file_capabilities
        .caller()
        .map_err(|_| "Cannot open target download caller")?;
    let scope = native
        .file_capabilities
        .scope(&caller, witness.target.clone(), &target.vault_id)
        .map_err(|_| "Cannot scope target download")?;
    let output = directory.join("verified-cross-account.bin");
    let sink_capability_id = native
        .file_capabilities
        .grant_download(
            scope,
            attachment.attachment_id.clone(),
            tempfile::tempfile_in(directory).map_err(|_| "Cannot stage target download")?,
            output.clone(),
        )
        .map_err(|_| "Cannot grant target output")?;
    let response = tests::acceptance_request(
        &native.core,
        RuntimeRequest::DownloadAttachment {
            account_id: witness.target.clone(),
            attachment_id: attachment.attachment_id.clone(),
            sink_capability_id,
        },
    )
    .await?;
    require(
        matches!(response, RuntimeResponse::AttachmentDownloaded { .. })
            && std::fs::read(output).map_err(|_| "Cannot read verified target plaintext")?
                == vec![0x31; BYTES],
        "Public target Download did not authenticate exact original plaintext",
    )?;
    save(
        &directory.join("cross-move-completed.json"),
        &serde_json::to_vec(&completed)
            .map_err(|_| "Cannot retain completed cross-Account evidence")?,
    )?;
    eprintln!("Actual native cross-Account Attachment Move restored original sealed bytes after process loss and completed public verified Download with three retained Item outcomes");
    Ok(())
}

#[tokio::test]
#[ignore = "Requires two isolated real Server Users, native keychain and loopback object store; run alone"]
async fn real_server_attachment_move_survives_process_loss() -> Result<(), String> {
    let credentials_path = PathBuf::from(
        std::env::var_os("BITTERY_NATIVE_CROSS_MOVE_CREDENTIALS")
            .ok_or("Missing protected cross-Account credentials")?,
    );
    let root = credentials_path
        .parent()
        .ok_or("Missing cross-Account fixture directory")?;
    let directory = root.join("runtime");
    let credentials: Credentials =
        tests::read_acceptance_credentials("BITTERY_NATIVE_CROSS_MOVE_CREDENTIALS")?;
    let phase = std::env::var(PHASE).ok();
    if phase.is_none() {
        let executable = std::env::current_exe()
            .map_err(|_| "Cannot locate native cross-Account test executable")?;
        let run = |phase: &'static str| {
            let executable = executable.clone();
            async move {
                let output = tokio::time::timeout(
                    Duration::from_secs(if phase == "cleanup" { 30 } else { 210 }),
                    tokio::process::Command::new(executable)
                        .args([TEST, "--ignored", "--exact", "--nocapture"])
                        .env(PHASE, phase)
                        .kill_on_drop(true)
                        .output(),
                )
                .await
                .map_err(|_| "Native cross-Account child exceeded its bound")?
                .map_err(|_| "Cannot start native cross-Account child")?;
                eprint!("{}", String::from_utf8_lossy(&output.stderr));
                require(
                    if phase == "prepare" {
                        output.status.code() == Some(EXIT)
                            && String::from_utf8_lossy(&output.stderr).contains(BOUNDARY)
                    } else {
                        output.status.success()
                            && String::from_utf8_lossy(&output.stdout)
                                .contains("1 passed; 0 failed")
                    },
                    "Native cross-Account child failed",
                )
            }
        };
        let flow = match run("prepare").await {
            Ok(()) => run("restore").await,
            Err(error) => Err(error),
        };
        save(
            &root.join("native-cross-move-outcome"),
            if flow.is_ok() { b"complete" } else { b"failed" },
        )?;
        require(
            wait_file(&root.join("native-cross-move-users-deleted"), 120).await?
                == "both-public-deletions-proved",
            "Public User deletion was not proved before native cleanup",
        )?;
        let cleanup = run("cleanup").await;
        if cleanup.is_ok() {
            save(
                &root.join("native-cross-move-cleaned"),
                b"native-accounts-removed",
            )?;
        }
        return flow.and(cleanup);
    }
    let config = AuthClientConfig::new(
        "native-cross-account-acceptance".into(),
        ClientPlatform::Desktop,
        "test".into(),
    )
    .map_err(|_| "Cannot configure native cross-Account Runtime")?;
    if phase.as_deref() == Some("restore") {
        seed_unowned_generation(&directory).await?;
    }
    let native = NativeRuntime::open(&directory, config)
        .await
        .map_err(|error| format!("Native cross-Account open failed: {:?}", error.code))?;
    let result = match phase.as_deref() {
        Some("prepare") => prepare(&native, &credentials, &directory).await,
        Some("restore") => restore(&native, &credentials, &directory).await,
        Some("cleanup") => tests::cleanup_acceptance_account(&native).await,
        _ => Err("Unknown native cross-Account phase".into()),
    };
    let shutdown = native
        .shutdown()
        .await
        .map_err(|error| format!("Native cross-Account shutdown failed: {:?}", error.code));
    result.and(shutdown)
}
