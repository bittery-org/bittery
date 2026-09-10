## Default Permission

Allows every bittery-credential-provider command. The set is the bridge the Expo
module used to expose to React Native: vault state, MUK escrow, vault sync, the
pending passkey mutation queue, the 30-day master password clock, and the
capability probes. The app is the only caller — the *system* reaches the
credential provider and autofill services by intent, not through this ACL — so
splitting the set would gate the app against itself and gate nothing else.

#### This default permission set includes the following:

- `allow-set-master-unlock-key`
- `allow-set-muk-auto-lock-timeout`
- `allow-clear-master-unlock-key`
- `allow-clear-all-master-unlock-keys`
- `allow-is-vault-unlocked`
- `allow-get-master-unlock-key-base64`
- `allow-borrow-live-master-unlock-key-base64`
- `allow-escrow-muk-with-biometric`
- `allow-retrieve-escrowed-muk`
- `allow-has-valid-escrow`
- `allow-has-valid-escrow-for-email`
- `allow-get-escrow-remaining-time`
- `allow-clear-escrow`
- `allow-clear-escrow-for-account`
- `allow-sync-vault-data`
- `allow-get-pending-passkey-mutations`
- `allow-mark-pending-passkey-mutations-applied`
- `allow-mark-pending-passkey-mutations-failed`
- `allow-is-master-password-reentry-required`
- `allow-can-use-biometric-unlock`
- `allow-update-last-master-password-entry`
- `allow-get-last-master-password-entry`
- `allow-is-available`
- `allow-is-biometric-available`
- `allow-authenticate`
- `allow-open-credential-provider-settings`
- `allow-is-supported`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`bittery-credential-provider:allow-authenticate`

</td>
<td>

Enables the authenticate command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-authenticate`

</td>
<td>

Denies the authenticate command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-borrow-live-master-unlock-key-base64`

</td>
<td>

Enables the borrow_live_master_unlock_key_base64 command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-borrow-live-master-unlock-key-base64`

</td>
<td>

Denies the borrow_live_master_unlock_key_base64 command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-can-use-biometric-unlock`

</td>
<td>

Enables the can_use_biometric_unlock command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-can-use-biometric-unlock`

</td>
<td>

Denies the can_use_biometric_unlock command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-clear-all-master-unlock-keys`

</td>
<td>

Enables the clear_all_master_unlock_keys command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-clear-all-master-unlock-keys`

</td>
<td>

Denies the clear_all_master_unlock_keys command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-clear-escrow`

</td>
<td>

Enables the clear_escrow command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-clear-escrow`

</td>
<td>

Denies the clear_escrow command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-clear-escrow-for-account`

</td>
<td>

Enables the clear_escrow_for_account command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-clear-escrow-for-account`

</td>
<td>

Denies the clear_escrow_for_account command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-clear-master-unlock-key`

</td>
<td>

Enables the clear_master_unlock_key command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-clear-master-unlock-key`

</td>
<td>

Denies the clear_master_unlock_key command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-escrow-muk-with-biometric`

</td>
<td>

Enables the escrow_muk_with_biometric command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-escrow-muk-with-biometric`

</td>
<td>

Denies the escrow_muk_with_biometric command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-get-escrow-remaining-time`

</td>
<td>

Enables the get_escrow_remaining_time command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-get-escrow-remaining-time`

</td>
<td>

Denies the get_escrow_remaining_time command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-get-last-master-password-entry`

</td>
<td>

Enables the get_last_master_password_entry command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-get-last-master-password-entry`

</td>
<td>

Denies the get_last_master_password_entry command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-get-master-unlock-key-base64`

</td>
<td>

Enables the get_master_unlock_key_base64 command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-get-master-unlock-key-base64`

</td>
<td>

Denies the get_master_unlock_key_base64 command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-get-pending-passkey-mutations`

</td>
<td>

Enables the get_pending_passkey_mutations command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-get-pending-passkey-mutations`

</td>
<td>

Denies the get_pending_passkey_mutations command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-has-valid-escrow`

</td>
<td>

Enables the has_valid_escrow command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-has-valid-escrow`

</td>
<td>

Denies the has_valid_escrow command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-has-valid-escrow-for-email`

</td>
<td>

Enables the has_valid_escrow_for_email command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-has-valid-escrow-for-email`

</td>
<td>

Denies the has_valid_escrow_for_email command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-is-available`

</td>
<td>

Enables the is_available command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-is-available`

</td>
<td>

Denies the is_available command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-is-biometric-available`

</td>
<td>

Enables the is_biometric_available command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-is-biometric-available`

</td>
<td>

Denies the is_biometric_available command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-is-master-password-reentry-required`

</td>
<td>

Enables the is_master_password_reentry_required command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-is-master-password-reentry-required`

</td>
<td>

Denies the is_master_password_reentry_required command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-is-supported`

</td>
<td>

Enables the is_supported command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-is-supported`

</td>
<td>

Denies the is_supported command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-is-vault-unlocked`

</td>
<td>

Enables the is_vault_unlocked command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-is-vault-unlocked`

</td>
<td>

Denies the is_vault_unlocked command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-mark-pending-passkey-mutations-applied`

</td>
<td>

Enables the mark_pending_passkey_mutations_applied command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-mark-pending-passkey-mutations-applied`

</td>
<td>

Denies the mark_pending_passkey_mutations_applied command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-mark-pending-passkey-mutations-failed`

</td>
<td>

Enables the mark_pending_passkey_mutations_failed command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-mark-pending-passkey-mutations-failed`

</td>
<td>

Denies the mark_pending_passkey_mutations_failed command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-open-credential-provider-settings`

</td>
<td>

Enables the open_credential_provider_settings command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-open-credential-provider-settings`

</td>
<td>

Denies the open_credential_provider_settings command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-retrieve-escrowed-muk`

</td>
<td>

Enables the retrieve_escrowed_muk command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-retrieve-escrowed-muk`

</td>
<td>

Denies the retrieve_escrowed_muk command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-set-master-unlock-key`

</td>
<td>

Enables the set_master_unlock_key command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-set-master-unlock-key`

</td>
<td>

Denies the set_master_unlock_key command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-set-muk-auto-lock-timeout`

</td>
<td>

Enables the set_muk_auto_lock_timeout command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-set-muk-auto-lock-timeout`

</td>
<td>

Denies the set_muk_auto_lock_timeout command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-sync-vault-data`

</td>
<td>

Enables the sync_vault_data command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-sync-vault-data`

</td>
<td>

Denies the sync_vault_data command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:allow-update-last-master-password-entry`

</td>
<td>

Enables the update_last_master_password_entry command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`bittery-credential-provider:deny-update-last-master-password-entry`

</td>
<td>

Denies the update_last_master_password_entry command without any pre-configured scope.

</td>
</tr>
</table>
