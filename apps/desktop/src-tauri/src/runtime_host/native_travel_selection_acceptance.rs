//! Real Save/Enable socket loss on both sides of the Server mutation boundary.
use super::*;

pub(super) async fn exercise(
    native: &NativeRuntime,
    account: &AccountId,
    credentials: &tests::AcceptanceCredentials,
    password: &SecretString,
    unrelated_title: &str,
    after_commit: bool,
) -> Result<(), String> {
    let selection = vec![credentials.target_vault_id.clone()];
    tests::acceptance_network(
        credentials,
        if after_commit {
            "travel-selection-after"
        } else {
            "travel-selection-before"
        },
    )
    .await?;
    for enable in [false, true] {
        let request = if enable {
            RuntimeRequest::EnableTravelMode {
                account_id: account.clone(),
                hidden_vault_ids: selection.clone(),
            }
        } else {
            RuntimeRequest::SetTravelModeHiddenVaults {
                account_id: account.clone(),
                hidden_vault_ids: selection.clone(),
            }
        };
        let response = tests::acceptance_request(&native.core, request).await?;
        let expected = if after_commit {
            matches!(response, RuntimeResponse::TravelMode {
                account_id, result: TravelModeCommandResult::Confirmed { policy, .. }
            } if account_id == *account && policy.enabled == enable && policy.hidden_vault_ids == selection)
        } else {
            matches!(response, RuntimeResponse::TravelMode {
                account_id, result: TravelModeCommandResult::RetryRequired { policy }
            } if account_id == *account && !policy.enabled && policy.hidden_vault_ids.is_empty())
        };
        if !expected {
            return Err(
                "Lost native Save/Enable did not reconcile exact current Server policy".into(),
            );
        }
        wait_for_visibility(
            native,
            account,
            &credentials.target_vault_id,
            unrelated_title,
            !(after_commit && enable),
        )
        .await?;
    }
    tests::acceptance_network(credentials, "online").await?;
    if !after_commit {
        // A separate explicit gesture may retry; reconciliation above never repeats a mutation.
        let response = tests::acceptance_request(
            &native.core,
            RuntimeRequest::EnableTravelMode {
                account_id: account.clone(),
                hidden_vault_ids: selection.clone(),
            },
        )
        .await?;
        if !matches!(response, RuntimeResponse::TravelMode {
            account_id, result: TravelModeCommandResult::Confirmed { policy, .. }
        } if account_id == *account && policy.enabled && policy.hidden_vault_ids == selection)
        {
            return Err("Explicit native Enable retry was not confirmed".into());
        }
    }
    let response = tests::acceptance_request(
        &native.core,
        RuntimeRequest::DisableTravelMode {
            account_id: account.clone(),
            master_password: password.as_ref().to_owned().into(),
        },
    )
    .await?;
    if !matches!(response, RuntimeResponse::TravelMode {
        account_id, result: TravelModeCommandResult::Confirmed { policy, .. }
    } if account_id == *account && !policy.enabled && policy.hidden_vault_ids == selection)
    {
        return Err("Native selection-loss history failed explicit Disable cleanup".into());
    }
    wait_for_visibility(
        native,
        account,
        &credentials.target_vault_id,
        unrelated_title,
        true,
    )
    .await?;
    eprintln!(
        "Actual native Core Save and Enable reconciled socket loss {} Server mutation without automatic mutation replay",
        if after_commit { "after" } else { "before" }
    );
    Ok(())
}
