//! Real incoming Server policy inside the protected-image restart fixture; no policy fabrication.
use super::*;
use bittery_client_core::{
    RequestCancellation, RuntimeErrorCode, VaultIconPatch, VaultImageChange,
};

fn update_witness(directory: &Path) -> Result<Witness, String> {
    load(directory)?
        .into_iter()
        .find(|witness| witness.intent_field == "updateVault")
        .ok_or_else(|| "Missing accepted image Update for hidden policy".into())
}
fn retained(directory: &Path, account: &AccountId, witness: &Witness) -> Result<(), String> {
    let original = decode(&witness.operation)?;
    let actual = decode(&replica_row(directory, account, 1, &witness.operation_id)?)?;
    for field in [
        "operationId",
        "kind",
        "target",
        "request",
        "requestFingerprint",
        "updateVault",
    ] {
        if actual.get(field) != original.get(field) {
            return Err("Hidden policy changed the original pending image intent".into());
        }
    }
    let repaired: Vec<Value> = serde_json::from_slice(
        &std::fs::read(directory.join(REPAIRED))
            .map_err(|_| "Missing repaired image family witness")?,
    )
    .map_err(|_| "Invalid repaired image witness")?;
    let expected = repaired
        .iter()
        .find(|image| image["vaultId"] == witness.vault_id)
        .ok_or("Missing repaired Update image witness")?;
    if &artifact(directory, account, &witness.operation_id)? != expected {
        return Err("Hidden policy changed retained protected image metadata or ciphertext".into());
    }
    Ok(())
}
fn ready_without_authority(
    directory: &Path,
    account: &AccountId,
    vault: &str,
    require_ready: bool,
) -> Result<bool, String> {
    let db = database(directory, "replica.sqlite")?;
    let mut statement = db.prepare("SELECT store,payload_json FROM replica_rows WHERE account_id=?1 AND store IN (0,3,6,7,9)")
        .map_err(|_| "Cannot inspect hidden Vault physical generations")?;
    let rows = statement
        .query_map([account.as_str()], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| "Cannot read hidden Vault physical generations")?;
    let mut ready = false;
    for row in rows {
        let (store, payload) = row.map_err(|_| "Cannot read hidden authority row")?;
        let value = decode(&payload)?;
        if store == 3 && value["state"] == "ready" {
            ready = true;
        }
        if store == 3
            && value["vaultIds"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(vault)))
        {
            return Ok(false);
        }
        if matches!(store, 0 | 6 | 7 | 9)
            && (value["vaultId"].as_str() == Some(vault)
                || (store == 6 && value["id"].as_str() == Some(vault)))
        {
            return Ok(false);
        }
    }
    Ok(ready || !require_ready)
}
fn diagnose_hidden(
    native: &NativeRuntime,
    directory: &Path,
    account: &AccountId,
    vault: &str,
    unrelated: &str,
) {
    if let Ok(RuntimeProjection::Items(items)) = tests::snapshot(
        &native.core,
        ObservationRequest::Items {
            account_id: account.clone(),
        },
    ) {
        eprintln!(
            "Hidden predicate projection: selectedVisible={}, unrelatedVisible={}",
            items.vaults.iter().any(|entry| entry.vault_id == vault),
            items.vaults.iter().any(|entry| entry.vault_id == unrelated)
        );
    }
    let physical = (|| -> Result<(), String> {
        let db = database(directory, "replica.sqlite")?;
        let mut statement = db.prepare("SELECT store,payload_json FROM replica_rows WHERE account_id=?1 AND store IN (0,3,6,7,9)").map_err(|_| "diagnostic query")?;
        let rows = statement
            .query_map([account.as_str()], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|_| "diagnostic rows")?;
        let mut matched = [0_u64; 10];
        let mut journal = false;
        for row in rows {
            let (store, payload) = row.map_err(|_| "diagnostic row")?;
            let value = decode(&payload)?;
            if store == 3 {
                if value.get("state").is_some() {
                    eprintln!(
                        "Hidden predicate Bootstrap: state={}, activeCursor={}",
                        value["state"], value["activeCursor"]
                    );
                }
                journal |= value["vaultIds"]
                    .as_array()
                    .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(vault)));
            }
            if matches!(store, 0 | 6 | 7 | 9)
                && (value["vaultId"].as_str() == Some(vault)
                    || (store == 6 && value["id"].as_str() == Some(vault)))
            {
                matched[store as usize] += 1;
            }
        }
        eprintln!("Hidden predicate physical matches: optimistic={}, Vault={}, Item={}, share={}, retirementPending={}", matched[0], matched[6], matched[7], matched[9], journal);
        let platform = database(directory, "platform.sqlite")?;
        let mut metadata = platform
            .prepare("SELECT value FROM platform_records WHERE key LIKE '%:metadata'")
            .map_err(|_| "diagnostic metadata query")?;
        let rows = metadata
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| "diagnostic metadata rows")?;
        for row in rows {
            let payload = row.map_err(|_| "diagnostic metadata")?;
            let value = decode(&payload)?;
            if value["accountId"].as_str() == Some(account.as_str()) {
                let policy = &value["verifiedTravelMode"];
                eprintln!("Hidden predicate stored verified policy: present={}, enabled={}, containsSelected={}", !policy.is_null(), policy["enabled"] == true, policy["hiddenVaultIds"].as_array().is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(vault))));
            }
        }
        Ok(())
    })();
    if physical.is_err() {
        eprintln!("Hidden predicate physical diagnostics unavailable");
    }
}

async fn policy(
    credentials: &tests::AcceptanceCredentials,
    witness: &Witness,
    action: &str,
) -> Result<(), String> {
    let request =
        json!({"action":action, "vaultId":witness.vault_id, "operationId":witness.operation_id});
    let pending = credentials.policy_request.with_extension("pending");
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(&pending)
        .and_then(|mut file| file.write_all(request.to_string().as_bytes()))
        .map_err(|_| "Cannot stage second-device policy request")?;
    std::fs::rename(&pending, &credentials.policy_request)
        .map_err(|_| "Cannot publish second-device policy request")?;
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if let Ok(bytes) = std::fs::read(&credentials.policy_acknowledgement) {
                if let Ok(ack) = serde_json::from_slice::<Value>(&bytes) {
                    if ["action", "vaultId", "operationId"]
                        .iter()
                        .all(|field| ack.get(field) == request.get(field))
                    {
                        return if ack["ok"] == true {
                            Ok(())
                        } else {
                            Err("Actual second-device Server policy request failed".to_owned())
                        };
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(|_| "Second-device Server policy did not acknowledge")?
}
pub(super) async fn upload_attempts(operation: &str) -> Result<u64, String> {
    let bytes = reqwest::get(format!(
        "http://127.0.0.1:3030/__acceptance/image-upload-attempts?operationId={operation}"
    ))
    .await
    .map_err(|_| "Cannot read actual object fixture upload count")?
    .error_for_status()
    .map_err(|_| "Object fixture refused upload count")?
    .bytes()
    .await
    .map_err(|_| "Invalid object fixture upload count")?;
    let response: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid object fixture upload count")?;
    response["attempts"]
        .as_u64()
        .ok_or_else(|| "Missing object fixture upload count".into())
}
pub async fn exercise_hidden(
    native: &NativeRuntime,
    account: &AccountId,
    directory: &Path,
    credentials: &tests::AcceptanceCredentials,
) -> Result<(), String> {
    let witness = update_witness(directory)?;
    // Start with real unlocked authority visible before the other device hides it. The API
    // proxy currently holds mutations so this original Update cannot finish first.
    tokio::time::timeout(Duration::from_secs(45), async {
        loop {
            if let Some(items) = tests::sample_acceptance_items(
                native,
                account,
                "Incoming Travel pre-policy visible Vault wait",
            )? {
                if items.vaults.iter().any(|vault| {
                    vault.vault_id == witness.vault_id
                        && vault.name == "Native protected Update target"
                        && vault.image_url.is_none()
                }) {
                    break Ok::<_, String>(());
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(|_| "Original Update Vault was not visible before incoming policy")??;
    retained(directory, account, &witness)?;
    if upload_attempts(&witness.operation_id).await? != 0 {
        return Err("Pending Update uploaded before hidden policy".into());
    }
    let sources = native
        .image_sources
        .as_ref()
        .ok_or("Native image sources unavailable")?;
    let caller = sources
        .caller()
        .map_err(|_| "Cannot open image policy caller")?;
    let prior_scope = sources
        .scope_for_vault(&caller, account.clone(), &witness.vault_id)
        .map_err(|_| "Visible Update Vault did not allow a bound image picker")?;
    policy(credentials, &witness, "enable").await?;
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if let Some(items) = tests::sample_acceptance_items(
                native,
                account,
                "Incoming Travel selected Vault erasure wait",
            )? {
                if !items
                    .vaults
                    .iter()
                    .any(|vault| vault.vault_id == witness.vault_id)
                    && items
                        .vaults
                        .iter()
                        .any(|vault| vault.vault_id == credentials.target_vault_id)
                    && ready_without_authority(directory, account, &witness.vault_id, true)?
                {
                    break Ok::<_, String>(());
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(|_| {
        diagnose_hidden(
            native,
            directory,
            account,
            &witness.vault_id,
            &credentials.target_vault_id,
        );
        "Incoming hidden policy did not erase all physical Vault authority generations"
    })??;
    if sources
        .scope_for_vault(&caller, account.clone(), &witness.vault_id)
        .is_ok()
    {
        return Err("Hidden Vault admitted a new bound image picker".into());
    }
    let mut selected =
        tempfile::tempfile_in(directory).map_err(|_| "Cannot prepare retired picker test")?;
    selected
        .write_all(IMAGE)
        .map_err(|_| "Cannot write retired picker test")?;
    if sources
        .grant(prior_scope, "image/png".into(), selected)
        .is_ok()
    {
        return Err("Hidden Vault accepted a previously opened image picker".into());
    }
    let refusal = native
        .core
        .request(
            RuntimeRequest::UpdateVault {
                account_id: account.clone(),
                vault_id: witness.vault_id.clone(),
                name: Some("Forbidden hidden edit".into()),
                icon: VaultIconPatch::Unchanged,
                image: VaultImageChange::Unchanged,
            },
            RequestCancellation::new(),
        )
        .await;
    if !matches!(refusal, Err(error) if matches!(error.code, RuntimeErrorCode::Cancelled | RuntimeErrorCode::AccessDenied | RuntimeErrorCode::AuthorityMissing))
    {
        return Err("Hidden Vault accepted a new native Update".into());
    }
    retained(directory, account, &witness)?;
    let RuntimeProjection::Operations(operations) = tests::snapshot(
        &native.core,
        ObservationRequest::Operations {
            account_id: account.clone(),
        },
    )?
    else {
        return Err("Cannot observe the pending hidden image schedule".into());
    };
    let due = operations
        .operations
        .iter()
        .find(|operation| operation.operation_id == witness.operation_id)
        .filter(|operation| operation.resolution == OperationResolution::Pending)
        .and_then(|operation| operation.next_attempt_at_ms.as_ref())
        .and_then(|time| time.parse::<u64>().ok())
        .ok_or("Hidden image has no pending retry schedule")?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "Cannot read native acceptance wall clock")?
        .as_millis() as u64;
    let observe_ms = due.saturating_add(1_000).saturating_sub(now).max(5_000);
    if observe_ms > 45_000 {
        return Err("Hidden image retry falls outside bounded acceptance interval".into());
    }
    tests::acceptance_network(credentials, "online").await?;
    // Transport remains available through this accepted Operation's actual retry deadline.
    // Merely observing zero uploads while its earlier offline backoff has not elapsed is insufficient.
    let observe_until = tokio::time::Instant::now() + Duration::from_millis(observe_ms);
    while tokio::time::Instant::now() < observe_until {
        if !ready_without_authority(directory, account, &witness.vault_id, false)?
            || upload_attempts(&witness.operation_id).await? != 0
        {
            return Err(
                "Hidden Update regained authority or attempted a signed image upload".into(),
            );
        }
        retained(directory, account, &witness)?;
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    // The hidden image must not prevent unrelated accepted work from finishing. Complete the
    // existing deletion proof before its unrelated foreground Move Attachment download.
    super::super::vault_acceptance::converge(native, account, directory).await?;
    tests::acceptance_converged_move(native, account, credentials, directory).await?;
    if upload_attempts(&witness.operation_id).await? != 0
        || !ready_without_authority(directory, account, &witness.vault_id, false)?
    {
        return Err(
            "Unrelated Move restored hidden authority or uploaded the pending image".into(),
        );
    }
    retained(directory, account, &witness)?;
    eprintln!("Actual native incoming Travel erasure passed before Disable: all authority generations absent, old/new image pickers and new Update refused, exact accepted ciphertext retained, zero uploads through retry deadline, unrelated accepted Move and Attachment readable");
    policy(credentials, &witness, "disable").await?;
    eprintln!("Actual native incoming hidden Vault policy erased authority, fenced image access, and retained exact ciphertext with zero signed uploads before proof-backed restoration");
    Ok(())
}
