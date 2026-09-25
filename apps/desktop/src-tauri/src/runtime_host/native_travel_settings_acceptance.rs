//! Actual foreground settings use linked native Core, real password proofs and Server socket loss.
use super::{tests, NativeRuntime};
use bittery_client_core::{
    AccountId, ObservationRequest, RequestCancellation, RuntimeProjection, RuntimeRequest,
    RuntimeResponse, SecretString, TravelModeCommandResult, TravelModeEnforcement,
};

#[path = "native_travel_selection_acceptance.rs"]
mod selection_loss;

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Scenario {
    Before,
    After,
    Uncertain,
    WrongPassword,
    SelectionBefore,
    SelectionAfter,
    CallerDrop,
    RuntimeLoss,
}

pub(super) async fn exercise(
    native: &NativeRuntime,
    account: &AccountId,
    credentials: &tests::AcceptanceCredentials,
    password: &SecretString,
    unrelated_title: &str,
    scenario: Scenario,
) -> Result<(), String> {
    if matches!(
        scenario,
        Scenario::SelectionBefore | Scenario::SelectionAfter
    ) {
        return selection_loss::exercise(
            native,
            account,
            credentials,
            password,
            unrelated_title,
            matches!(scenario, Scenario::SelectionAfter),
        )
        .await;
    }
    if matches!(scenario, Scenario::WrongPassword) {
        exercise_selection_bounds(native, account).await?;
    }
    let selection = vec![credentials.target_vault_id.clone()];
    for (request, enabled) in [
        (
            RuntimeRequest::SetTravelModeHiddenVaults {
                account_id: account.clone(),
                hidden_vault_ids: selection.clone(),
            },
            false,
        ),
        (
            RuntimeRequest::EnableTravelMode {
                account_id: account.clone(),
                hidden_vault_ids: selection.clone(),
            },
            true,
        ),
    ] {
        let response = tests::acceptance_request(&native.core, request).await?;
        if !matches!(response, RuntimeResponse::TravelMode {
            account_id, result: TravelModeCommandResult::Confirmed { policy, .. }
        } if account_id == *account && policy.enabled == enabled && policy.hidden_vault_ids == selection)
        {
            return Err("Native foreground Travel selection was not confirmed exactly".into());
        }
    }
    wait_for_visibility(
        native,
        account,
        &credentials.target_vault_id,
        unrelated_title,
        false,
    )
    .await?;
    if matches!(scenario, Scenario::WrongPassword) {
        require_selection_refused(
            native,
            RuntimeRequest::SetTravelModeHiddenVaults {
                account_id: account.clone(),
                hidden_vault_ids: Vec::new(),
            },
        )
        .await?;
        let projection = tests::snapshot(
            &native.core,
            ObservationRequest::TravelMode {
                account_id: account.clone(),
            },
        )?;
        if !matches!(projection, RuntimeProjection::TravelMode(value)
            if value.last_verified_policy.as_ref().is_some_and(|policy|
                policy.enabled && policy.hidden_vault_ids == selection))
        {
            return Err("Refused enabled selection edit changed verified Travel policy".into());
        }
    }
    // The proxy forwards real proof rejection or loses a socket around a real Disable request.
    // Core resolves current policy without replaying the one-use password proof.
    tests::acceptance_network(
        credentials,
        match scenario {
            Scenario::Before => "travel-disable-before",
            Scenario::After => "travel-disable-after",
            Scenario::Uncertain => "travel-disable-uncertain",
            Scenario::WrongPassword => "travel-disable-wrong-password",
            Scenario::SelectionBefore
            | Scenario::SelectionAfter
            | Scenario::CallerDrop
            | Scenario::RuntimeLoss => {
                unreachable!("selection loss has its own history")
            }
        },
    )
    .await?;
    if matches!(scenario, Scenario::WrongPassword) {
        let rejected = native
            .core
            .request(
                RuntimeRequest::DisableTravelMode {
                    account_id: account.clone(),
                    master_password: "incorrect foreground password".into(),
                },
                RequestCancellation::new(),
            )
            .await;
        if !matches!(rejected, Ok(RuntimeResponse::TravelMode {
            account_id, result: TravelModeCommandResult::RetryRequired { policy }
        }) if account_id == *account && policy.enabled && policy.hidden_vault_ids == selection)
        {
            return Err("Native wrong Disable password did not reconcile unchanged policy and require fresh password retry".into());
        }
        wait_for_visibility(
            native,
            account,
            &credentials.target_vault_id,
            unrelated_title,
            false,
        )
        .await?;
        tests::acceptance_network(credentials, "travel-disable-password-retry").await?;
    }
    let mut response = tests::acceptance_request(
        &native.core,
        RuntimeRequest::DisableTravelMode {
            account_id: account.clone(),
            master_password: password.as_ref().to_owned().into(),
        },
    )
    .await?;
    if matches!(scenario, Scenario::Before) {
        if !matches!(response, RuntimeResponse::TravelMode {
            account_id, result: TravelModeCommandResult::RetryRequired { policy }
        } if account_id == *account && policy.enabled && policy.hidden_vault_ids == selection)
        {
            return Err("Native lost Disable request did not require fresh password retry".into());
        }
        wait_for_visibility(
            native,
            account,
            &credentials.target_vault_id,
            unrelated_title,
            false,
        )
        .await?;
        // A separate user gesture supplies password input again. The Runtime holds no retry proof.
        tests::acceptance_network(credentials, "travel-disable-retry").await?;
        response = tests::acceptance_request(
            &native.core,
            RuntimeRequest::DisableTravelMode {
                account_id: account.clone(),
                master_password: password.as_ref().to_owned().into(),
            },
        )
        .await?;
    }
    if matches!(scenario, Scenario::Uncertain) {
        if !matches!(response, RuntimeResponse::TravelMode {
            account_id, result: TravelModeCommandResult::Uncertain { last_verified_policy: Some(policy) }
        } if account_id == *account && policy.enabled && policy.hidden_vault_ids == selection)
        {
            return Err(
                "Native unavailable reconciliation did not preserve verified policy uncertainty"
                    .into(),
            );
        }
        let projection = tests::snapshot(
            &native.core,
            ObservationRequest::TravelMode {
                account_id: account.clone(),
            },
        )?;
        if !matches!(projection, RuntimeProjection::TravelMode(value)
            if value.account_id == *account && value.enforcement == TravelModeEnforcement::Unverified
                && value.last_verified_policy.as_ref().is_some_and(|policy| policy.enabled && policy.hidden_vault_ids == selection))
        {
            return Err(
                "Native uncertain Travel projection incorrectly confirmed current policy".into(),
            );
        }
        tests::acceptance_network(credentials, "travel-disable-reconcile").await?;
        response = tests::acceptance_request(
            &native.core,
            RuntimeRequest::RefreshTravelMode {
                account_id: account.clone(),
            },
        )
        .await?;
    }
    if !matches!(response, RuntimeResponse::TravelMode {
        account_id, result: TravelModeCommandResult::Confirmed { policy, .. }
    } if account_id == *account && !policy.enabled && policy.hidden_vault_ids == selection)
    {
        return Err("Native foreground Disable did not confirm the retained selection".into());
    }
    tests::acceptance_network(credentials, "online").await?;
    wait_for_visibility(
        native,
        account,
        &credentials.target_vault_id,
        unrelated_title,
        true,
    )
    .await?;
    match scenario {
        Scenario::Before => eprintln!("Actual native Core foreground Travel required fresh password retry after a lost Disable request, retained selection and restored fresh Vault authority"),
        Scenario::After => eprintln!("Actual native Core foreground Travel saved and enabled selection, reconciled a lost successful Disable reply, retained selection and restored fresh Vault authority"),
        Scenario::Uncertain => eprintln!("Actual native Core foreground Travel preserved uncertainty while policy reads were unavailable, then reconciled current policy without password or proof replay"),
        Scenario::WrongPassword => eprintln!("Actual native Core foreground Travel rejected a wrong password without changing policy, then accepted a separate correct password without finishing login"),
        Scenario::SelectionBefore | Scenario::SelectionAfter | Scenario::CallerDrop | Scenario::RuntimeLoss => unreachable!("selection loss has its own history"),
    }
    Ok(())
}

async fn exercise_selection_bounds(
    native: &NativeRuntime,
    account: &AccountId,
) -> Result<(), String> {
    // Release the plaintext snapshot before any settings request can suspend.
    let visible_vaults =
        tests::sample_acceptance_items(native, account, "Foreground Travel selection")?
            .ok_or("Native selection fixture has no current Items authority")?
            .vaults;
    if !visible_vaults
        .iter()
        .any(|vault| vault.vault_type == bittery_client_core::VaultProjectionType::Team)
    {
        return Err("Native selection fixture requires a current shared Vault choice".into());
    }
    if !visible_vaults
        .iter()
        .any(|vault| vault.role == bittery_client_core::VaultProjectionRole::ReadOnly)
    {
        return Err("Native selection fixture requires a current read-only Vault choice".into());
    }
    let mut visible_ids: Vec<_> = visible_vaults
        .into_iter()
        .map(|vault| vault.vault_id)
        .collect();
    visible_ids.sort();
    if visible_ids.len() < 2 {
        return Err("Native selection fixture requires multiple current Vaults".into());
    }
    for selection in [visible_ids, Vec::new()] {
        let response = tests::acceptance_request(
            &native.core,
            RuntimeRequest::SetTravelModeHiddenVaults {
                account_id: account.clone(),
                hidden_vault_ids: selection.clone(),
            },
        )
        .await?;
        if !matches!(response, RuntimeResponse::TravelMode {
            account_id, result: TravelModeCommandResult::Confirmed { policy, .. }
        } if account_id == *account && !policy.enabled && policy.hidden_vault_ids == selection)
        {
            return Err("Actual native Travel did not save all-visible or empty selection".into());
        }
    }
    require_selection_refused(
        native,
        RuntimeRequest::EnableTravelMode {
            account_id: account.clone(),
            hidden_vault_ids: Vec::new(),
        },
    )
    .await?;
    require_selection_refused(
        native,
        RuntimeRequest::SetTravelModeHiddenVaults {
            account_id: account.clone(),
            hidden_vault_ids: (0..101)
                .map(|_| bittery_crypto_core::generate_uuid())
                .collect(),
        },
    )
    .await?;
    eprintln!("Actual native Core and Server saved all-visible and empty Travel selections; empty enable and over100 selection were refused");
    Ok(())
}

async fn require_selection_refused(
    native: &NativeRuntime,
    request: RuntimeRequest,
) -> Result<(), String> {
    if !matches!(native.core.request(request, RequestCancellation::new()).await,
        Err(error) if error.code == bittery_client_core::RuntimeErrorCode::AccessDenied)
    {
        return Err("Invalid native foreground Travel selection was not refused".into());
    }
    Ok(())
}

async fn wait_for_visibility(
    native: &NativeRuntime,
    account: &AccountId,
    selected: &str,
    unrelated_title: &str,
    visible: bool,
) -> Result<(), String> {
    tokio::time::timeout(std::time::Duration::from_secs(60), async {
        loop {
            if tests::sample_acceptance_items(native, account, "Foreground Travel visibility")?
                .is_some_and(|items| {
                    items.vaults.iter().any(|vault| vault.vault_id == selected) == visible
                        && items
                            .items
                            .iter()
                            .any(|item| item.data.title() == unrelated_title)
                })
            {
                return Ok::<(), String>(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    })
    .await
    .map_err(|_| {
        "Native foreground Travel did not project exact selected and unrelated authority"
    })?
}
