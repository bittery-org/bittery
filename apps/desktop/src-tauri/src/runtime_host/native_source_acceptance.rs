//! Shared real-Server test setup: same protected reader, SignIn path and scoped local cleanup.
use super::{tests, NativeRuntime};
use bittery_client_core::{
    AccountId, NativeAuthorityFacade, RequestCancellation, RuntimeRequest, RuntimeResponse,
    SecretString, ServerAccountDeletionOutcome,
};

#[path = "native_source_pending_acceptance.rs"]
mod pending;
pub(in crate::runtime_host) use pending::PendingMove;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Credentials {
    server_url: String,
    accounts: Vec<AccountCredentials>,
    network_control: std::path::PathBuf,
    network_acknowledgement: std::path::PathBuf,
    network_blocked_move: std::path::PathBuf,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AccountCredentials {
    email: SecretString,
    password: SecretString,
    secret_key: SecretString,
    expected_item_title: String,
    hidden_vault_id: String,
}

pub(in crate::runtime_host) struct InstalledAccounts {
    credentials: Credentials,
    ids: Vec<AccountId>,
}
impl InstalledAccounts {
    pub(in crate::runtime_host) fn read() -> Result<Self, String> {
        let credentials: Credentials =
            tests::read_acceptance_credentials("BITTERY_NATIVE_SOURCE_CREDENTIALS")?;
        if credentials.accounts.len() != 2 {
            return Err(
                "Native source acceptance requires exactly two independently provisioned Accounts"
                    .into(),
            );
        }
        Ok(Self {
            credentials,
            ids: Vec::new(),
        })
    }

    pub(in crate::runtime_host) async fn install(
        &mut self,
        native: &NativeRuntime,
    ) -> Result<(), String> {
        for account in self.credentials.accounts.iter().skip(self.ids.len()) {
            let id = tests::sign_in_acceptance_account(
                native,
                &self.credentials.server_url,
                &account.email,
                &account.password,
                &account.secret_key,
            )
            .await?;
            if self.ids.contains(&id) {
                return Err("Native source acceptance Accounts were not independent".into());
            }
            // Retain the completed installation identity even if the following Sync read fails.
            self.ids.push(id);
        }
        self.wait_for_items(native).await
    }

    pub(in crate::runtime_host) fn ids(&self) -> &[AccountId] {
        &self.ids
    }

    pub(in crate::runtime_host) async fn accept_pending_move(
        &self,
        native: &NativeRuntime,
        account: &AccountId,
        directory: &std::path::Path,
    ) -> Result<PendingMove, String> {
        PendingMove::accept(
            native,
            account,
            self.hidden_vault_id(account)?,
            directory,
            &self.credentials,
        )
        .await
    }

    pub(in crate::runtime_host) fn hidden_vault_id(&self, id: &AccountId) -> Result<&str, String> {
        let index = self
            .ids
            .iter()
            .position(|candidate| candidate == id)
            .ok_or("Unknown acceptance Account")?;
        Ok(&self.credentials.accounts[index].hidden_vault_id)
    }

    pub(in crate::runtime_host) async fn set_travel(
        &self,
        native: &NativeRuntime,
        id: &AccountId,
        enabled: bool,
    ) -> Result<(), String> {
        let index = self
            .ids
            .iter()
            .position(|candidate| candidate == id)
            .ok_or("Unknown acceptance Account")?;
        let hidden_vault_ids = vec![self.credentials.accounts[index].hidden_vault_id.clone()];
        let request = if enabled {
            RuntimeRequest::EnableTravelMode {
                account_id: id.clone(),
                hidden_vault_ids: hidden_vault_ids.clone(),
            }
        } else {
            RuntimeRequest::DisableTravelMode {
                account_id: id.clone(),
                master_password: self.credentials.accounts[index]
                    .password
                    .as_ref()
                    .to_owned()
                    .into(),
            }
        };
        let response = tests::acceptance_request(&native.core, request).await?;
        if !matches!(response, RuntimeResponse::TravelMode {
            account_id, result: bittery_client_core::TravelModeCommandResult::Confirmed { policy, .. }
        } if account_id == *id && policy.enabled == enabled && policy.hidden_vault_ids == hidden_vault_ids)
        {
            return Err("Actual native source Travel command was not confirmed exactly".into());
        }
        // Disable confirms policy before ordinary Bootstrap has necessarily restored wrappers.
        // Complete this fixture control only after the source's own current read authority is ready.
        if !enabled {
            tokio::time::timeout(std::time::Duration::from_secs(60), async {
                loop {
                    if items(native, id)?.is_some_and(|projection| {
                        projection
                            .vaults
                            .iter()
                            .any(|vault| vault.vault_id == hidden_vault_ids[0])
                            && projection
                                .items
                                .iter()
                                .any(|item| item.vault_id == hidden_vault_ids[0])
                    }) {
                        return Ok::<(), String>(());
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            })
            .await
            .map_err(|_| {
                "Native source did not restore fresh authority after Disable".to_owned()
            })??;
        }
        Ok(())
    }

    pub(in crate::runtime_host) async fn lock(
        native: &NativeRuntime,
        id: AccountId,
    ) -> Result<(), String> {
        native
            .core
            .request(
                RuntimeRequest::Lock { account_id: id },
                RequestCancellation::new(),
            )
            .await
            .map_err(|error| format!("Native source Lock refused: {:?}", error.code))?;
        Ok(())
    }

    pub(in crate::runtime_host) async fn unlock(
        &self,
        native: &NativeRuntime,
        id: &AccountId,
    ) -> Result<(), String> {
        self.unlock_access(native, id).await?;
        let index = self
            .ids
            .iter()
            .position(|candidate| candidate == id)
            .ok_or("Unknown acceptance Account")?;
        tests::wait_for_acceptance_item(
            native,
            id,
            &self.credentials.accounts[index].expected_item_title,
        )
        .await
    }

    async fn unlock_access(&self, native: &NativeRuntime, id: &AccountId) -> Result<(), String> {
        let index = self
            .ids
            .iter()
            .position(|candidate| candidate == id)
            .ok_or("Unknown acceptance Account")?;
        native
            .core
            .request(
                RuntimeRequest::QuickUnlock {
                    account_id: id.clone(),
                    master_password: self.credentials.accounts[index]
                        .password
                        .as_ref()
                        .to_owned(),
                },
                RequestCancellation::new(),
            )
            .await
            .map_err(|error| format!("Native acceptance Quick Unlock refused: {:?}", error.code))?;
        Ok(())
    }

    pub(in crate::runtime_host) async fn wait_for_items(
        &self,
        native: &NativeRuntime,
    ) -> Result<(), String> {
        for (id, credentials) in self.ids.iter().zip(&self.credentials.accounts) {
            tests::wait_for_acceptance_item(native, id, &credentials.expected_item_title).await?;
        }
        Ok(())
    }

    pub(in crate::runtime_host) async fn delete_new_server_accounts(
        &self,
        native: &NativeRuntime,
    ) -> Result<(), String> {
        let mut failures = Vec::new();
        if self.ids.len() != self.credentials.accounts.len() {
            failures.push(
                "Some test-created Server Accounts were never installed for scoped cleanup"
                    .to_owned(),
            );
        }
        for (id, credentials) in self.ids.iter().zip(&self.credentials.accounts) {
            let deletion = async {
                // A preceding selective Lock is part of this acceptance path. The ordinary
                // standalone command restores this test-created Account before Server deletion.
                self.unlock_access(native, id).await?;
                let request_id = bittery_crypto_core::generate_uuid();
                let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
                loop {
                    let result = native
                        .core
                        .request(
                            RuntimeRequest::DeleteServerAccount {
                                account_id: id.clone(),
                                confirm_email: credentials.email.as_ref().to_owned(),
                                request_id: request_id.clone(),
                            },
                            RequestCancellation::new(),
                        )
                        .await;
                    match result {
                        Ok(RuntimeResponse::ServerAccountDeletion {
                            outcome: ServerAccountDeletionOutcome::Deleted,
                            ..
                        }) => return Ok(()),
                        Ok(_) => {
                            return Err(
                                "New acceptance Server Account deletion was refused".to_owned()
                            )
                        }
                        Err(error) if tokio::time::Instant::now() >= deadline => {
                            return Err(format!(
                                "New acceptance Server Account deletion incomplete: {:?}",
                                error.code
                            ))
                        }
                        Err(_) => tokio::time::sleep(std::time::Duration::from_millis(100)).await,
                    }
                }
            }
            .await;
            if let Err(error) = deletion {
                failures.push(error);
            }
        }
        if !failures.is_empty() {
            return Err(failures.join("; "));
        }
        Ok(())
    }
}

pub(in crate::runtime_host) fn destination_control(
    native: &NativeRuntime,
) -> NativeAuthorityFacade {
    native.core.native_authority()
}

pub(in crate::runtime_host) fn items(
    native: &NativeRuntime,
    account: &AccountId,
) -> Result<Option<bittery_client_core::ItemsProjection>, String> {
    tests::sample_acceptance_items(native, account, "Native executable Travel")
}

pub(in crate::runtime_host) async fn cleanup(native: &NativeRuntime) -> Result<(), String> {
    tests::cleanup_acceptance_account(native).await
}

pub(in crate::runtime_host) fn require_access(
    native: &NativeRuntime,
    id: &AccountId,
    expected: bittery_client_core::AccountAccessState,
    phase: &str,
) -> Result<(), String> {
    let bittery_client_core::RuntimeProjection::RuntimeStatus(status) = tests::snapshot(
        &native.core,
        bittery_client_core::ObservationRequest::RuntimeStatus { account_id: None },
    )?
    else {
        return Err("Missing native Account status".into());
    };
    match status.accounts.iter().find(|account| &account.account_id == id) {
        Some(account) if account.access == expected && account.failure.is_none() => Ok(()),
        Some(account) => Err(format!(
            "Native Account access at {phase}: expected {expected:?}, actual {:?}, failure_present={}",
            account.access,
            account.failure.is_some()
        )),
        None => Err(format!("Native Account missing at {phase}")),
    }
}
