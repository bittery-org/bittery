# Mobile feature-gap analysis

Audit date: 2026-08-08. This synthesis compares the React Native mobile app with
the implemented web and desktop clients. It is based on static repository evidence,
not a physical-device acceptance run. “Confirmed” means the current source directly
shows a stub, rejection, or absent client workflow. “Needs runtime validation” means
the code strongly suggests a broken or incomplete journey, but server or OS behavior
could affect the result.

The detailed evidence streams are:

- [Mobile app implementation audit](mobile-app-audit.md)
- [Web and desktop parity review](mobile-vs-web-desktop.md)
- [Gap corroboration and test review](mobile-gap-corroboration.md)

## Executive conclusion

Mobile already covers the everyday vault-reading core: existing-account sign-in,
multi-account unlock, sync/offline cache, item create/read/update/trash, all five item
categories, search, tags, TOTP, password generation/history, attachments, biometric
unlock, and public share-link creation.

It is not yet a self-sufficient password-manager client. The clearest blockers are
system credential integration, vault management, mobile-only signup/recovery, and
security/account administration. Several item capabilities are read-only or narrower
than web/desktop, and the app has no React Native journey tests.

## What demonstrably does not work or is a placeholder

| Priority | Finding | Status and evidence |
| --- | --- | --- |
| P0 | **iOS system credential provider/autofill** | The Apple native module is still Expo starter code (`PI`, `hello`, `setValueAsync`, and a demo web view), not the production contract declared by TypeScript ([native module](../../apps/mobile/modules/credential-provider/ios/CredentialProviderModule.swift#L3), [declared contract](../../apps/mobile/modules/credential-provider/src/CredentialProviderModule.ts#L24)). App-wide credential sync is Android-only ([root layout](../../apps/mobile/app/_layout.tsx#L35)). |
| P0 | **Release updates are not configured** | EAS `projectId` and the OTA update URL contain the literal `your-project-id` placeholder ([app.json](../../apps/mobile/app.json#L79)). Production EAS Update cannot be trusted until real environment-specific values are wired and exercised. |
| P1 | **Create vault button** | The visible plus action only shows a toast ([Browse handler](../../apps/mobile/app/(tabs)/vaults.tsx#L126)); the translation explicitly says vault creation is coming soon and redirects users to web ([English messages](../../packages/i18n/messages/en.json#L2108)). Shared core already exports vault CRUD hooks. |
| P1 | **Android save from Autofill** | Filling existing credentials is implemented, but every Android Autofill save request logs “not implemented” and fails with `Save not supported` ([Autofill service](../../apps/mobile/modules/credential-provider/android/src/main/java/expo/modules/credentialprovider/service/BitteryAutofillService.kt#L207)). |
| P1 | **App version display** | The mobile app configuration is version `0.4.1` ([app.json](../../apps/mobile/app.json#L2)), while both locale catalogs hard-code “Version 0.1.0” ([English messages](../../packages/i18n/messages/en.json#L2221)). It is a stale placeholder rather than runtime build metadata. |
| P1 | **System credential-provider onboarding** | The native contract can open Android provider settings, but mobile Settings has no enable/setup/status/error surface. Users must discover OS setup themselves ([contract](../../apps/mobile/modules/credential-provider/src/CredentialProviderModule.ts#L170), [mobile Settings](../../apps/mobile/src/screens/settings-screen.tsx#L419)). |
| P2 | **Trash item tap** | Restore/delete swipe actions work, but tapping a trashed row is deliberately a no-op because there is no trash detail route ([Trash screen](../../apps/mobile/app/(tabs)/trash.tsx#L216)). This is incomplete interaction, not loss of restore/delete capability. |

## Confirmed missing or materially weaker mobile features

### Account, recovery, and device safety

- **Signup, account recovery, and invitation acceptance.** Mobile auth registers only
  login and unlock ([auth layout](../../apps/mobile/app/(auth)/_layout.tsx#L11)); web
  implements separate signup, recovery, and invitation routes
  ([web auth routes](../../apps/web/src/routes/_auth/signup.tsx#L10)). A phone-only user
  cannot create or recover an account.
- **Account-security maintenance.** Mobile cannot change email or master password,
  set/regenerate a Recovery Key, regenerate a Secret Key, or delete the server account.
  Web Settings implements all of these ([web Settings](../../apps/web/src/routes/_app/settings/index.tsx#L229)); mobile Settings stops at local/device controls
  ([mobile Settings](../../apps/mobile/src/screens/settings-screen.tsx#L373)).
- **Device/session management.** Mobile cannot list, rename, or remotely revoke devices
  (sessions), nor sign out all devices. Web has the complete management surface
  ([device management](../../apps/web/src/components/settings/device-management.tsx#L146)).
- **Sign out versus remove.** The mobile control labelled “Sign out” calls local
  `removeAccount` ([mobile Settings](../../apps/mobile/src/screens/settings-screen.tsx#L301)).
  Core has a distinct `signOutAccount` operation that keeps the account on the device
  ([account lifecycle](../../packages/core/src/services/account-lifecycle.ts#L380)).
  The current UI does explain that it removes the account, but proper sign out and the
  settled product vocabulary are not represented.
- **Set up another device from mobile.** Mobile can consume a setup QR, but cannot
  generate one for another device. Web/desktop can act as the setup source.
- **Passwordless device approval (Track B).** The planned request/approve flow is still
  unchecked; mobile setup still needs the master password after scanning
  ([device-setup plan](../plans/device-setup-polish.md#track-b-login-with-device)).

### Vaults, items, and permissions

- **Vault lifecycle.** Create is a placeholder; edit metadata/icon, delete, and convert
  personal/shared vault type are absent. Web and desktop use the shared vault mutations
  ([web vault route](../../apps/web/src/routes/_app/vaults/route.tsx#L48)).
- **Move item.** Mobile has no same-account or cross-account move workflow. Web and
  desktop expose `useMoveItem` through a target-vault dialog
  ([web move dialog](../../apps/web/src/components/vault/move-item-dialog.tsx#L60)).
- **Favorite management.** Mobile sorts and displays favorites, but has no
  `useToggleFavorite` action. Web/desktop can star and unstar from item detail
  ([web item detail](../../apps/web/src/components/vault/item-detail-pane.tsx#L84)).
- **Custom-field editing.** Mobile displays and preserves existing custom fields, but
  cannot create, edit, delete, or change their types
  ([mobile edit route](../../apps/mobile/app/(vault)/[vaultId]/edit/[itemId].tsx#L115)).
- **Full Identity editing.** Mobile displays rich identity values, but its form edits
  only first name, last name, and email
  ([mobile Identity form](../../apps/mobile/src/components/item-forms/identity-form.tsx#L7)).
  Addresses, phone numbers, middle name, date of birth, SSN, passport, and driver’s
  license require another client.
- **Multiple login URLs.** Mobile displays multiple URLs, but its edit form stores one
  URL and always returns `urls: [url]` ([mobile Login form](../../apps/mobile/src/components/item-forms/login-form.tsx#L25)). Editing such an imported/web-created
  item can overwrite its extra URLs. This should be treated as a data-preservation bug.
- **Open website action.** Mobile login detail only offers copy/reveal actions; web and
  desktop pass an `onOpenUrl` action into item detail
  ([mobile login fields](../../apps/mobile/src/components/item-details/login-fields.tsx#L10), [web item detail](../../apps/web/src/components/vault/item-detail-pane.tsx#L260)).
- **Passkey inspection/removal.** Android can create/sync passkeys through the OS
  provider, but mobile item detail does not display or remove them. Desktop does
  ([desktop item detail](../../apps/desktop/src/components/vault/item-detail-page.tsx#L121)).
- **Read-only shared-vault behavior needs correction and device testing.** Mobile knows
  each vault role but does not use it to hide/disable create, edit, delete, attachment,
  or share actions ([mobile vault detail](../../apps/mobile/app/(vault)/[vaultId]/index.tsx#L42), [mobile item detail](../../apps/mobile/app/(vault)/[vaultId]/[itemId].tsx#L122)).
  Web explicitly derives `canWriteItems` from the role and gates these controls
  ([web vault detail](../../apps/web/src/routes/_app/vaults/$vaultId/index.tsx#L102)).
  Static evidence proves the missing UI gate; runtime tests must confirm whether the
  server rejects cleanly or mobile temporarily creates unauthorized local state.

### Sharing, teams, and commercial administration

- **Email-restricted share links.** Mobile hard-codes access mode to `anyone`; it offers
  expiry and one-time-use only ([mobile share sheet](../../apps/mobile/src/components/share/share-item-sheet.tsx#L92)).
- **Share history and revocation.** Mobile can create a link but cannot list previous
  links, inspect access, or revoke them. Web exposes `ShareHistoryDialog`
  ([web item detail](../../apps/web/src/components/vault/item-detail-pane.tsx#L280)).
- **Shared-vault members and key rotation.** Mobile can browse shared vaults but cannot
  add/remove members, assign roles, or run the removal/key-rotation flow implemented on
  web ([web vault members](../../apps/web/src/components/vaults/vault-member-list.tsx#L51)).
- **Team management and invitations.** Member lists, invitations, role changes, team
  settings, leave/delete team, and pending-invitation handling are absent. Web has a
  role- and entitlement-gated Team area ([web Team route](../../apps/web/src/routes/_app/team/index.tsx#L41)).
- **Billing/subscription management.** Mobile has no plan, checkout, entitlement/usage,
  or billing-portal surface. A mobile implementation may intentionally hand off to web,
  but that product decision and handoff do not exist today
  ([web Billing route](../../apps/web/src/routes/_app/billing.tsx#L263)).
- **Team admin/audit console.** The web people/activity/audit-log console is absent.
  This is a lower-priority candidate unless administrators are expected to work from
  phones.

### Portability, security posture, and settings

- **Import and export.** Mobile Settings exposes only Trash under Data; web launches
  both import and export workflows ([mobile Settings](../../apps/mobile/src/screens/settings-screen.tsx#L504), [web Settings](../../apps/web/src/routes/_app/settings/index.tsx#L409)).
- **Sentinel.** Mobile has no security-posture score, weak/reused/aging-password views,
  or remediation path. Web runs the shared password analysis and renders the full
  dashboard ([Sentinel route](../../apps/web/src/routes/_app/security.lazy.tsx#L11)).
- **Travel mode control.** Mobile enforces synced Travel mode events but cannot select
  hidden vaults, enable, or disable it. Desktop exposes the shared control
  ([mobile sync](../../apps/mobile/src/hooks/use-mobile-sync.ts#L198), [desktop security settings](../../apps/desktop/src/components/settings/settings-security-panel.tsx#L92)).
- **Master-password re-entry policy.** Mobile displays the countdown but cannot select
  the period. Desktop offers 14/30/60/90 days.
- **Language and system-theme controls.** The mobile i18n runtime supports a persisted
  locale, but Settings exposes no language selector. Theme Settings is a dark-mode
  switch, so a user cannot return to the already-supported `system` preference after
  choosing light/dark ([mobile i18n provider](../../apps/mobile/src/providers/i18n-provider.tsx#L56), [theme Settings](../../apps/mobile/src/screens/settings-screen.tsx#L393)).
- **Local cache repair.** Desktop has a clear/rebuild cache action; mobile has no
  equivalent recovery tool.
- **Dashboard summaries.** Mobile opens directly to items and omits web’s security
  posture, recent activity, pending invitations, and device summary. These are useful
  enhancements, not core blockers.

## Test and confidence gap

`apps/mobile/package.json` has no test script, and there are no React Native
TypeScript/TSX tests. The Android native module has limited Kotlin tests, including
explicit placeholder vectors. This does not prove a user-visible defect, but it leaves
lock/unlock, multi-account behavior, local-first mutations, shared-vault permissions,
and native credential integration without journey-level regression protection
([mobile package](../../apps/mobile/package.json#L6), [placeholder vectors](../../apps/mobile/modules/credential-provider/android/src/test/java/expo/modules/credentialprovider/crypto/CryptoTestVectors.kt#L179)).

## Recommended implementation plan

### Phase 0 — make the shipped mobile boundary trustworthy

1. Build the iOS Credential Provider extension, app-group/Keychain storage, unlock
   handoff, sync, and security review; publish an explicit iOS/Android capability
   matrix.
2. Implement Android Autofill save/update and add a discoverable credential-provider
   setup/status screen on both platforms.
3. Fix read-only shared-vault gating and the multiple-URL edit overwrite before adding
   more mutation surfaces.
4. Replace EAS/OTA template identifiers with environment-owned configuration and use
   runtime build metadata for the displayed version.
5. Establish mobile unit/component tests plus Android/iOS native integration tests and
   end-to-end smoke journeys for cold start, sign-in, unlock, sync, Autofill, and item
   CRUD.

### Phase 1 — make mobile self-sufficient for an individual user

1. Replace the vault-create stub with personal-vault create/edit/delete, then add item
   move and favorite toggling.
2. Add native signup, invitation entry, recovery, and Emergency Kit save/share flows.
3. Add account/security settings: devices and session revocation, password/email,
   Recovery Key/Secret Key, proper sign out/remove separation, and server account
   deletion.
4. Complete item fidelity: multiple URLs, custom fields, full Identity fields, open URL,
   passkey inspection/removal, and trash detail.
5. Add import/export and a focused mobile Sentinel overview with actionable item links.

### Phase 2 — collaboration and advanced safety

1. Add email-restricted share creation, share history/revocation, and access status.
2. Add shared-vault member/role management and tested key rotation, followed by team
   invitations and settings.
3. Add Travel mode controls and master-password re-entry settings using the shared
   security services.
4. Finish passwordless existing-device approval with the planned ephemeral encrypted
   handoff.

### Phase 3 — product-scope parity

1. Decide whether billing and the team admin/audit console should be native or a secure
   authenticated web handoff; implement the chosen experience.
2. Add language/system-theme selection, dashboard summaries, setup-another-device, and
   cache repair.
3. Run an accessibility, offline/conflict, low-end Android, tablet, and physical-device
   release pass; turn the validated results into a maintained platform feature matrix.

## Acceptance rule for calling a feature complete

For each slice, require both mobile platforms where the OS supports the capability,
role/entitlement gating, offline and sync-retry behavior, strict i18n, accessibility,
and an automated happy-path plus failure-path test. Features that intentionally remain
web-only should have an explicit, working mobile handoff instead of a silent absence or
placeholder control.
