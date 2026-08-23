# Bittery

Bittery is a zero-knowledge, end-to-end-encrypted password manager that runs on the web, desktop, mobile and as a browser extension against a shared server. This file fixes the vocabulary those surfaces share, so that one concept has one name everywhere — in code, in UI copy and in conversation.

## Language

For storage *design* context — tiers, ports, and the invariants behind where a value lives — read `packages/storage/CONTEXT.md`. For the crypto seam, opaque key lifetime and adapter-conformance limits, read `packages/crypto/port/CONTEXT.md`. This file names things; those explain the machinery.

### Identity

**Account**:
One login as it exists on one device, identified by its accountId. Several accounts live side by side on a device, and the same person is a separate account on each of their devices.
_Avoid_: profile, local user, login

**User**:
The server-side identity behind an account, identified by its userId. One user, many accounts.
_Avoid_: person, owner (owner is a role)

**Email**:
A login address and a display label. It is never an identity — resolving one to an account can fail, and using one where an accountId belongs silently targets the wrong account's data.
_Avoid_: username, account name

**Active account**:
The single account whose vaults the UI is currently showing. It is a pointer, not a state: the active account may well be locked.
_Avoid_: current user, selected account, default account

**Session**:
A server-issued login for one account on one device, revocable from any other device.
_Avoid_: connection, token

**Device**:
A machine or browser profile holding accounts. In the UI, the device list is really the session list — revoking a device revokes its session.
_Avoid_: client, installation

**Verification code**:
A short code emailed to prove control of an address, used at signup, at account recovery, and by a recipient opening an email-restricted share link. Unrelated to TOTP.
_Avoid_: OTP, 2FA code, confirmation code

### Keys

**Master password**:
The password the user chooses at signup. It never leaves the device, not even as a hash.
_Avoid_: account password, passphrase, master key

**Secret Key**:
A high-entropy random string (`A3-…`) generated at signup and shown once, combined with the master password to derive everything else. It is the second factor that makes a stolen server database useless.
_Avoid_: account key, device secret

**Secret Key hint**:
The first segment of a Secret Key, the only part the server holds, kept purely so a user can tell their accounts apart.

**Master unlock key**:
The key derived from master password plus Secret Key that unwraps this account's vault keys and RSA private key. Its plaintext form exists only in memory and is never persisted. In normal web flows, main-thread JavaScript holds only an opaque identity while the material stays in the crypto worker; that is a convention, not a type-system guarantee, because the crypto seam can export any live key. Desktop, mobile and the extension use different in-memory representations. Mobile has one audited exception that exports a borrowed copy to Android's separate credential-provider process.
_Avoid_: MUK in user-facing copy, master key, unlock key

**Vault key**:
The symmetric key that encrypts every item in one vault, wrapped separately for each person who may open that vault.
_Avoid_: vault secret, collection key

**Attachment key**:
A random key that encrypts one Attachment's bytes, filename and content type. It is wrapped under the Vault key so Key rotation can revoke access by rewrapping the key without rewriting the Attachment blob.
_Avoid_: file key, upload key, attachment secret

**Device key**:
A per-device key that wraps the stored copy of the master unlock key so quick unlock can survive a restart. It is generated locally, tied to no credential, and never leaves the device.
_Avoid_: local key, machine key

**Recovery key**:
A separately generated key (`R1-…`) holding a second wrapping of the master key, so a forgotten master password can be reset without losing vault data. Optional, and invalidated whenever the password, Secret Key or email changes.
_Avoid_: recovery code, reset code, backup key

**Emergency Kit**:
The client-generated document holding a user's Secret Key and Recovery Key, shown once and never uploaded.
_Avoid_: Recovery Kit, backup file

**KDF profile**:
The password-stretching parameters (algorithm and iteration count) the server declares at login. The client pins them after first use so they can never be silently weakened.
_Avoid_: KDF params, iteration settings

**Key rotation**:
Replacing a vault key and re-encrypting the whole vault under the new one, so someone who lost access cannot read anything written afterwards.
_Avoid_: re-key, key refresh

**Rotation plan**:
A short-lived, server-recorded intention to perform Key rotation. It fixes the initiating User, reason, affected Vault, expected key version and Member set so the completed rotation can be rejected if its security assumptions have gone stale.
_Avoid_: rotation request, rotation draft, pending rotation

### Vault contents

**Vault**:
The container that owns a key and holds items. A vault is either personal or team-owned; membership and role are per vault.
_Avoid_: collection, folder, group

**Shared vault**:
A team-owned vault, as the UI names it. Making a personal vault shared hands it to the team and gives it a member list.
_Avoid_: team vault, group vault

**Item**:
One encrypted secret in a vault. The unit of sharing, syncing, trashing and search.
_Avoid_: entry, record, credential, secret

**Item category**:
Which shape an item has: Login, Secure Note, Credit Card, Identity, or Authenticator. A closed set — an item has exactly one.
_Avoid_: item type, kind, template

**Custom field**:
A user-named extra field on an item, encrypted along with the rest of the item's data.
_Avoid_: extra field, attribute

**Password history**:
The previous passwords an item carried, kept inside its encrypted payload so a change can be undone.
_Avoid_: revisions, versions (a version is the item's sync counter)

**Attachment**:
A file bound to an item. Its bytes, filename and content type are encrypted under its Attachment key, which is wrapped under the Vault key.
_Avoid_: file, document, upload

**Tag**:
A free-text label the user puts on an item. Tags live inside the encrypted payload, so the server cannot read or index them.
_Avoid_: label, folder, category

**Favorite**:
A per-item mark that lifts it to the top of lists; the verb for setting it is "star". Unlike a tag it is unencrypted metadata.
_Avoid_: pinned, bookmark, shortcut

**Trash**:
Where a deleted item waits until it is restored or deleted forever. Deleting an item marks it, it does not remove it.
_Avoid_: archive, bin, soft delete

**Passkey**:
A WebAuthn credential that Bittery stores inside a login item and presents to sites on the user's behalf. It is something the vault holds, not a way to sign in to Bittery itself.
_Avoid_: WebAuthn credential, FIDO key, security key

**TOTP**:
The time-based one-time code stored on a login item, or on its own as an Authenticator item.
_Avoid_: OTP, MFA seed, 2FA secret

### Locking and unlocking

**Unlocked**:
The master unlock key for this account is in memory right now. Not "could be unlocked" — an account with quick-unlock material sitting on disk is locked until something actually restores it.
_Avoid_: authenticated, open, active

**Lock**:
Drop the keys from memory. The account, its encrypted cache and its quick-unlock material all survive, so getting back in needs only a password or a biometric prompt.
_Avoid_: sign out, close vault

**Auto-lock**:
Locking automatically after a period of inactivity, configured per device.
_Avoid_: idle timeout, session timeout

**Sign out**:
End the session and discard the quick-unlock material and the cached items. The account stays on the device, but getting back in needs a full sign-in.
_Avoid_: log out, disconnect, lock

**Remove**:
Take an account off this device entirely — its record, its keys and its cached items. Nothing on the server changes.
_Avoid_: delete account, forget, unlink

**Wipe**:
Remove every account on this device, plus the device-scoped material behind them.
_Avoid_: reset, clear data, factory reset

**Delete account**:
Destroy the account on the server, then remove it locally. The only one of these operations that cannot be undone from another device.
_Avoid_: close account, deactivate

**Full sign-in**:
Signing in with email, master password *and* Secret Key. This is what a sign-out, a removal, a Wipe, or missing or corrupt Quick Unlock material forces next time.
_Avoid_: full login, fresh login, re-login

**Quick unlock**:
Getting back into a locked account with the master password alone, using the stored Secret Key and pinned KDF profile to run a fresh complete online sign-in ceremony. It has no time-based expiry. It remains available until Sign out, Remove, or Wipe deletes its Device-bound material.
_Avoid_: fast unlock, resume, remember me

**Biometric unlock**:
A separate local unlock in which the operating system's biometric prompt releases retained Device-bound key material. It is the only unlock that does not create a fresh Server Session; without a usable Session, the account still needs Quick unlock or Full sign-in for Server work.
_Avoid_: Face ID, Touch ID, fingerprint login

**Master password re-entry**:
The periodic requirement to type the master password even where biometric unlock is enabled.
_Avoid_: reauth, password check

**Session-bound**:
A stored value that dies when the app session does. Contrast device-bound, which survives a restart. See `packages/storage/CONTEXT.md` for which values are which and why.
_Avoid_: ephemeral, temporary

**Device-bound**:
A stored value that survives an app or browser restart and lives until the account is removed or the device wiped.
_Avoid_: persistent, permanent

### Sharing and teams

**Share link**:
A URL that hands a single item to someone who need not have a Bittery account. The decryption key rides in the URL fragment and never reaches the server, so a link that is not copied at creation time is unrecoverable.
_Avoid_: secure link, public link, share URL

**Share key**:
The one-off key the shared item's snapshot is encrypted under. Distinct from the vault key, which the recipient never sees.
_Avoid_: link key, share secret

**Access mode**:
Who a share link lets in: anyone holding the link, or only listed email addresses, which must be verified by emailed code.
_Avoid_: visibility, audience, permission

**One-time use**:
A share link that stops working after its first successful access.
_Avoid_: single use, burn after reading

**Team**:
The group that owns shared vaults, members and a plan. Every user has one — a solo user's team is just a team of one — so "has a team" never means "is on a paid plan".
_Avoid_: organization, workspace, company, family

**Member**:
A user who belongs to a team, or a user granted access to a particular vault. Always qualified by a role, and always distinct from the vault's owner.
_Avoid_: collaborator, participant, user

**Member departure**:
A Member ceasing to belong to a Team, either by leaving voluntarily or by being removed by an authorised Member. Departure includes the required loss-of-access consequences for that Member.
_Avoid_: removal (when the departure is voluntary), leave (when the departure is administrative), membership change

**Role**:
The permission level a member holds. A team role is owner, admin or member; a vault role adds read-only. The two are separate — a team admin is not automatically in a vault.
_Avoid_: permission, access level, tier

**Invitation**:
A pending offer to join a team, delivered as an invite link, that stays open until it is accepted, declined, cancelled or expires.
_Avoid_: invite as a noun, request, join code

### Travel mode

**Travel mode**:
A server-held policy that hides chosen vaults on every one of the user's devices and erases their local data, until the user turns it off with their master password.
_Avoid_: border mode, panic mode, incognito

**Hidden vault**:
A vault travel mode is currently suppressing. Its keys and cached items are erased from the device, not merely filtered out of the UI.
_Avoid_: masked vault, disabled vault

### Sentinel

**Sentinel**:
The feature that reviews the vault's security posture and reports what to fix. It reads what is already decrypted on the device; nothing is sent anywhere to be checked.
_Avoid_: watchtower, security audit, password health check

**Sentinel score**:
The single graded rating Sentinel puts on a vault, from fortified down to critical.
_Avoid_: security rating, health score

**Issue**:
One flagged weakness Sentinel found in an item's password: weak, reused, or aging.
_Avoid_: finding, alert, vulnerability

### Sync

**Replica**:
The durable Account-scoped local state owned by the Client Runtime: encrypted authoritative entities,
accepted Operations and their optimistic effects, retained Operation outcomes already observed, and
the Sync cursor that makes those values one coherent commit history. A Replica is not merely a
disposable Item cache, and its invariants do not belong to a UI or platform adapter.
_Avoid_: cache, local database, offline store, client state

**Operation**:
One immutable Account-scoped request accepted durably by the Client Runtime under a stable Operation
ID. Acceptance commits the request and its optimistic Replica effect together. Losing a caller,
restarting, or exhausting a number of transport attempts does not end it.
_Avoid_: mutation, queue entry, command attempt, request

**Operation outcome**:
The Server's durable semantic result for one Operation: success or a proved terminal non-success. It
commits with the Domain effect or proved non-effect and lets every retry learn what happened after a
lost response. Transport errors and an in-progress response are not outcomes.
_Avoid_: cached HTTP response, acknowledgement, idempotency record, sync result

**Sync cursor**:
An opaque Server-minted position proving which visible Sync events a Replica has applied. It is
committed atomically with the resulting Replica changes and is neither a timestamp nor a Device-local
counter.
_Avoid_: timestamp, offset, sequence number, last sync time

**Sync event**:
A server record that one entity changed — an item, a vault, a membership, a key, or the travel-mode policy. Clients react to events instead of re-reading everything.
_Avoid_: change, update, notification, message

**Delta sync**:
Fetching only the entities that sync events named, rather than the whole vault.
_Avoid_: incremental sync, partial sync

**Catch-up**:
Replaying the sync events a client missed while it was offline, starting from the last one it saw. If the server can no longer supply them, the client refetches everything instead.
_Avoid_: backfill, replay, resync

### Import

**Import provider**:
An adapter for one other password manager's export format. Supporting a new competitor means adding a provider, never a special case elsewhere.
_Avoid_: importer, converter, migration source

**Import preview**:
The parsed but not-yet-saved result of reading an export file — its source vaults, items, warnings and errors — shown to the user before anything is written.
_Avoid_: dry run, staging, draft import

**Source vault**:
A folder, collection or group from the product being imported from, presented so the user can map it onto a Bittery vault.
_Avoid_: source folder, source collection

### Clients and deployment

**Client Runtime**:
The one process-wide Rust module that owns the Device's Account catalog and each Account's isolated
authentication, live keys, Replica, Operations, Sync, and failure state. Web, Compose, SwiftUI,
Desktop, and Extension hosts send typed requests and observe projections; they do not reimplement
Runtime policy. Active account remains UI state outside this ownership rule.
_Avoid_: core service, sync engine, worker, backend

**Autofill**:
Filling a saved login, card or identity into a form outside Bittery — the browser extension on a web page, or the operating system's autofill service on mobile.
_Avoid_: auto-type, form fill, auto-complete

**Native messaging host**:
The small binary the browser launches so the extension can reach the running desktop app. While that connection is up the desktop app owns the extension's lock state — the extension is locked and unlocked there, not on its own. In user-facing copy, call the far end "the desktop app".
_Avoid_: companion, bridge, agent, daemon

**Self-hosted**:
A Bittery server the user runs themselves. Signup there is invite-only and the first account created is the server administrator.
_Avoid_: on-premise, private instance

**Bittery Cloud**:
The hosted service Bittery operates. The alternative to self-hosting, not a separate product.
_Avoid_: SaaS, the cloud, hosted mode
