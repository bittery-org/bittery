//! Foreground loss after the real Server commits, before the native HTTP caller receives a reply.
use super::{tests, NativeRuntime};
use bittery_client_core::{
    AccountId, ObservationRequest, RequestCancellation, RuntimeProjection, RuntimeRequest,
    RuntimeResponse, SecretString, TravelModeCommandResult, TravelModeEnforcement,
};
use std::path::Path;
use tokio::task::JoinHandle;

pub(super) const PROCESS_EXIT: i32 = 71;
pub(super) const PROCESS_BOUNDARY: &str =
    "Native Travel process exits after acknowledged policy admission and actual Enable commit";

fn require_unverified(native: &NativeRuntime, account: &AccountId) -> Result<(), String> {
    if !matches!(tests::snapshot(&native.core, ObservationRequest::TravelMode {
        account_id: account.clone(),
    })?, RuntimeProjection::TravelMode(value)
        if matches!(value.enforcement, TravelModeEnforcement::Unverified)
        && value.last_verified_policy.as_ref().is_some_and(|policy| !policy.enabled))
    {
        return Err(
            "Held Enable must preserve prior disabled policy with unverified enforcement".into(),
        );
    }
    Ok(())
}

async fn dispatch_held(
    native: &NativeRuntime,
    account: &AccountId,
    credentials: &tests::AcceptanceCredentials,
) -> Result<JoinHandle<Result<RuntimeResponse, bittery_client_core::RuntimeError>>, String> {
    if !tests::sample_acceptance_items(native, account, "Before held Travel Enable")?.is_some_and(
        |items| {
            items
                .items
                .iter()
                .any(|item| item.vault_id == credentials.target_vault_id)
        },
    ) {
        return Err("Loss fixture must expose a selected Item before Enable".into());
    }
    tests::acceptance_network(credentials, "travel-loss-held").await?;
    let core = native.core.clone();
    let account_id = account.clone();
    let selected = credentials.target_vault_id.clone();
    let caller = tokio::spawn(async move {
        core.request(
            RuntimeRequest::EnableTravelMode {
                account_id,
                hidden_vault_ids: vec![selected],
            },
            RequestCancellation::new(),
        )
        .await
    });
    let committed = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            if caller.is_finished() {
                return Err("Native Enable settled before its held Server reply".to_owned());
            }
            if std::fs::read_to_string(&credentials.network_travel_committed)
                .is_ok_and(|value| value == "enable-committed")
            {
                return require_unverified(native, account);
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| "Actual Server Enable did not reach the held response boundary".to_owned())
    .and_then(|result| result);
    if let Err(error) = committed {
        caller.abort();
        let _ = caller.await;
        let _ = tests::acceptance_network(credentials, "online").await;
        return Err(error);
    }
    Ok(caller)
}

async fn wait_for_selection(
    native: &NativeRuntime,
    account: &AccountId,
    selected: &str,
    unrelated_title: &str,
    enabled: bool,
) -> Result<(), String> {
    tokio::time::timeout(std::time::Duration::from_secs(60), async {
        loop {
            let policy_ready = matches!(tests::snapshot(&native.core, ObservationRequest::TravelMode {
                account_id: account.clone(),
            })?, RuntimeProjection::TravelMode(value)
                if matches!(value.enforcement, TravelModeEnforcement::Ready)
                && value.last_verified_policy.as_ref().is_some_and(|policy|
                    policy.enabled == enabled && policy.hidden_vault_ids == [selected]));
            if policy_ready && tests::sample_acceptance_items(native, account, "Travel caller loss")?
                .is_some_and(|items|
                    items.vaults.iter().any(|vault| vault.vault_id == selected) != enabled
                    && (!enabled || items.items.iter().all(|item| item.vault_id != selected))
                    && items.items.iter().any(|item| item.data.title() == unrelated_title))
            {
                return Ok::<(), String>(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| "Native loss did not converge exact selected and unrelated authority".to_owned())?
}

async fn restore_visible_selection(
    native: &NativeRuntime,
    account: &AccountId,
    credentials: &tests::AcceptanceCredentials,
    password: &SecretString,
    unrelated_title: &str,
) -> Result<(), String> {
    // End the loss evidence window before the separate explicit password cleanup gesture.
    tests::acceptance_network(credentials, "online").await?;
    let response = tests::acceptance_request(
        &native.core,
        RuntimeRequest::DisableTravelMode {
            account_id: account.clone(),
            master_password: password.as_ref().to_owned().into(),
        },
    )
    .await?;
    if !matches!(response, RuntimeResponse::TravelMode {
        result: TravelModeCommandResult::Confirmed {policy, ..}, ..
    } if !policy.enabled && policy.hidden_vault_ids == [credentials.target_vault_id.clone()])
    {
        return Err("Explicit Disable did not restore the retained loss-test selection".into());
    }
    wait_for_selection(
        native,
        account,
        &credentials.target_vault_id,
        unrelated_title,
        false,
    )
    .await
}

pub(super) async fn caller_drop(
    native: &NativeRuntime,
    account: &AccountId,
    credentials: &tests::AcceptanceCredentials,
    password: &SecretString,
    unrelated_title: &str,
) -> Result<(), String> {
    let caller = dispatch_held(native, account, credentials).await?;
    caller.abort();
    if !matches!(caller.await, Err(error) if error.is_cancelled()) {
        return Err("Native settings caller was not dropped at the held response".into());
    }
    require_unverified(native, account)?;
    tests::acceptance_network(credentials, "travel-loss-reconcile").await?;
    wait_for_selection(
        native,
        account,
        &credentials.target_vault_id,
        unrelated_title,
        true,
    )
    .await?;
    restore_visible_selection(native, account, credentials, password, unrelated_title).await?;
    eprintln!("Actual native caller drop after committed Enable converged through existing policy verification without replay");
    Ok(())
}

pub(super) async fn dispatch_process_loss(
    native: &NativeRuntime,
    account: &AccountId,
    credentials: &tests::AcceptanceCredentials,
    directory: &Path,
) -> Result<(), String> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(directory.join("travel-loss-account-id"))
        .map_err(|_| "Cannot retain exact Travel loss Account identity")?;
    std::io::Write::write_all(&mut file, account.as_str().as_bytes())
        .map_err(|_| "Cannot write exact Travel loss Account identity")?;
    let _caller = dispatch_held(native, account, credentials).await?;
    eprintln!("{PROCESS_BOUNDARY}");
    // Deliberate actual process loss: no Runtime shutdown, caller cancellation or volatile cleanup.
    std::process::exit(PROCESS_EXIT);
}

pub(super) async fn restore_process_loss(
    native: &NativeRuntime,
    account: &AccountId,
    credentials: &tests::AcceptanceCredentials,
    password: &SecretString,
    unrelated_title: &str,
) -> Result<(), String> {
    require_unverified(native, account)?;
    // Password Quick Unlock is a distinct explicit authentication gesture in the existing
    // contract. Its one login exchange is counted separately from automatic reconciliation.
    tests::acceptance_network(credentials, "travel-loss-unlock").await?;
    tests::acceptance_request(
        &native.core,
        RuntimeRequest::QuickUnlock {
            account_id: account.clone(),
            master_password: password.as_ref().to_owned(),
        },
    )
    .await?;
    tests::acceptance_network(credentials, "travel-loss-reconcile").await?;
    wait_for_selection(
        native,
        account,
        &credentials.target_vault_id,
        unrelated_title,
        true,
    )
    .await?;
    restore_visible_selection(native, account, credentials, password, unrelated_title).await?;
    eprintln!("Actual native process loss after committed Enable reopened the same Account and retired selected authority without replay");
    Ok(())
}
