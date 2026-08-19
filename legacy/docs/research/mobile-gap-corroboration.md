# Mobile feature-gap corroboration

**Scope:** `apps/mobile`, corroborated against the shared core, native integrations,
other first-party clients, and product plans. This is an implementation inventory, not
a claim that every desktop/web feature must be on a phone. A feature is listed only
where there is direct placeholder evidence, a documented planned state, a usable shared
capability with no mobile presentation, or a concrete test-coverage absence.

## Executive priority

| Priority | Gap | Confidence | Why it matters |
| --- | --- | --- | --- |
| P0 | Native iOS credential autofill | High | A password manager on iOS cannot fill credentials in other apps/sites. The product plan calls this a pre-launch must-have. |
| P1 | Vault creation and management | High | The visible Browse action is knowingly non-functional; a user cannot organize new vaults from mobile. |
| P1 | Mobile-only account onboarding and recovery | High | The app only offers sign-in/unlock, so creating or recovering an account requires another client. |
| P1 | Mobile test coverage for user journeys and native boundary | High | No TypeScript/React Native tests or mobile test command protect the app's security-critical flows. |
| P2 | Security/admin parity: Travel mode controls, Sentinel, device/session and credential management | Medium-high | The shared/web/desktop capabilities exist, but mobile supplies no user-facing route or control. |
| P2 | Passwordless device approval (Device Setup Track B) | High | Planned explicitly; manual Secret Key + password sign-in remains a usable fallback. |

## P0 — Native iOS credential autofill is not implemented

**Evidence**

- The product backlog marks **iOS Autofill** as planned and explicitly states that
  native iOS autofill is not fully shipped: `docs/plans/password-manager-feature-backlog.md:116-124,130-136`.
- The same plan places it first among launch must-haves because daily password-manager
  use depends on it: `docs/plans/password-manager-feature-backlog.md:162-172`.
- The Expo configuration has only ordinary iOS app metadata and associated domains
  (`apps/mobile/app.json:10-25`). There is no iOS Credential Provider extension target
  in the first-party iOS source tree; its app-side source contains only the Expo
  application files.
- In contrast, the configured credential-provider plugin is explicitly Android-only
  (`apps/mobile/app.json:40-58`) and adds Android `CredentialProviderService` and
  `AutofillService` declarations (`apps/mobile/modules/credential-provider/app.plugin.js:119-218`).
- App-wide credential-provider synchronization is also gated to Android:
  `apps/mobile/app/_layout.tsx:35-46`.

**Impact and recommendation**

This is a launch blocker for the advertised iOS app, not merely an extra settings
screen. Implement an iOS Credential Provider extension and its secure, reviewed key
handoff/synchronization path before calling iOS password filling supported. It depends
on an iOS extension target, Keychain/app-group storage design, a native unlock UX, and
security review of the equivalent of Android's credential-provider boundary.

## P1 — Browse exposes a knowingly non-functional vault-create action

**Evidence**

- Browse renders a plus button in the vault segment and calls `handleCreateVault`:
  `apps/mobile/app/(tabs)/vaults.tsx:216-231`.
- That handler does not create or navigate; it only displays a toast:
  `apps/mobile/app/(tabs)/vaults.tsx:126-133`.
- Its translation says, verbatim in product terms, that vault creation is coming soon
  and directs the user to the web app: `packages/i18n/messages/en.json:2108-2113`.
- This is not a missing backend seam: shared core exports vault CRUD hooks
  (`packages/core/src/hooks/vault/index.ts:1-19`), and creation encrypts then creates a
  vault via the core service (`packages/core/src/hooks/vault/use-create-vault.ts:39-48`).
- A mobile search finds no use of `useCreateVault`, `useUpdateVault`,
  `useDeleteVault`, or `useConvertVaultType`; mobile Browse only lists personal/shared
  vaults (`apps/mobile/app/(tabs)/vaults.tsx:81-103`).

**Impact and recommendation**

Users cannot create a new personal vault, change its metadata, or manage its lifecycle
without leaving the app. The create action is especially misleading because it is shown
as the primary Browse affordance. First ship personal-vault creation with name/icon and
the established encryption mutation; then add edit/delete and shared-vault conversion
behind the existing role/ownership rules. Dependencies are primarily native form UX,
the existing shared mutations, and mutation/error tests—no server capability appears
missing.

## P1 — No mobile-only signup or account-recovery journey

**Evidence**

- The entire mobile auth route set consists of `login` and `unlock` under
  `apps/mobile/app/(auth)/`; the login screen's two steps collect existing email,
  Secret Key, and master password, then invokes `useLogin`
  (`apps/mobile/app/(auth)/login.tsx:61-69,198-227,229-274`).
- The only alternate onboarding path is scanning an existing device setup payload
  (`apps/mobile/app/(auth)/login.tsx:456-575`). It still ends in the same existing
  account sign-in flow.
- There is no mobile `signup`, `recover`, or invitation-acceptance route. This is
  corroborated by the first-party web auth routes: sign-in navigates to `/signup`
  (`apps/web/src/routes/_auth/login.tsx:17-33`), signup is a separate route
  (`apps/web/src/routes/_auth/signup.tsx:10-37`), and recovery implements a five-step
  flow from email through a new Secret Key (`apps/web/src/routes/_auth/recover.tsx:27-32,86-99`).
- Account recovery is described as already done on the product roadmap
  (`docs/plans/password-manager-feature-backlog.md:96-109`), which makes the
  mobile absence a client gap rather than speculative future scope.

**Impact and recommendation**

A person with only a phone cannot begin using Bittery or recover there after losing
credentials; both are high-stress moments for a password manager. Add native signup
(including invitation handling where applicable) and the recovery-key flow, reusing the
shared crypto/recovery services rather than introducing a mobile-only protocol. The
recovery flow must preserve the web flow's verification-code, Recovery Key, encryption,
and new Secret Key guarantees. Dependencies: auth API parity, recovery-kit generation/
download/share UX, and security-focused integration tests.

## P1 — Mobile has no automated React Native feature coverage

**Evidence**

- `apps/mobile/package.json` supplies development, build, and `check-types` scripts,
  but no `test` script or test runner dependency: `apps/mobile/package.json:6-20,72-79`.
- Repository inventory finds no TypeScript/TSX `*.test.*`, `*.spec.*`, or mobile
  `__tests__` files. The sole mobile test file is Kotlin crypto-vector coverage:
  `apps/mobile/modules/credential-provider/android/src/test/java/expo/modules/credentialprovider/crypto/CryptoTestVectors.kt:1-22`.
- The app contains high-risk, platform-specific flows: Android-only credential sync is
  enabled at startup (`apps/mobile/app/_layout.tsx:35-46`); the settings screen mutates
  device-wide biometric and auto-lock state across all accounts
  (`apps/mobile/src/screens/settings-screen.tsx:212-281`); and sign-in mirrors a master
  unlock key into the credential provider (`apps/mobile/app/(auth)/login.tsx:198-218`).

**Impact and recommendation**

This does not prove a current user-visible defect, but it is a high-confidence release
gap: UI, routing, multi-account, lock/unlock, and Android credential-provider
synchronization regressions have no app-level safety net. Establish a mobile test
command and cover, at minimum: cold start/account gating; full sign-in and quick/
biometric unlock; account switching/removal; create/edit/delete/restore; role-limited
vault behavior; credential-provider sync/writeback; and failure/retry handling. Keep
the Kotlin vectors, but treat them as crypto compatibility tests rather than workflow
coverage.

## P2 — Security and account-management capabilities are not exposed on mobile

**Evidence**

- Mobile Settings presents account/server display, theme, biometric unlock, auto-lock,
  lock, trash, account removal, and app version only
  (`apps/mobile/src/screens/settings-screen.tsx:359-575`). There is no route or control
  for remote sessions/devices, master-password or email change, Secret Key regeneration,
  Recovery Key setup/regeneration, Travel mode, or Sentinel.
- The web settings route explicitly imports and renders dialogs for password/email,
  Secret Key, Recovery Key, devices, import/export, and deletion
  (`apps/web/src/routes/_app/settings/index.tsx:41-52,217-362`).
- Travel mode is not merely an idea: shared core can query it, choose hidden vaults,
  enable it, and disable it with a master-password proof
  (`packages/core/src/hooks/use-travel-mode.ts:36-60,89-105,113-178`), while desktop
  imports a dedicated travel-mode settings component
  (`apps/desktop/src/components/settings/settings-security-panel.tsx:1-10`). Mobile
  does process `travel_mode_updated` sync events and verifies the policy before a
  biometric unlock (`apps/mobile/src/hooks/use-mobile-sync.ts:198-245`,
  `apps/mobile/src/contexts/biometric-auth-context.tsx:203-230`), but has no settings
  surface to configure or disable the policy.
- Sentinel has a protected first-party web route (`apps/web/src/routes/_app/security.tsx:1-11`),
  and its implementation consumes the shared password-security hook
  (`apps/web/src/routes/_app/security.lazy.tsx:1-19`); no mobile screen or hook import
  exposes it.

**Impact and recommendation**

This is a medium-high confidence mobile-surface gap, not evidence that the shared
features are broken. Prioritize a small Security & Account area: device/session review
and revocation, Recovery Key status/actions, password/email/Secret Key maintenance,
then Travel mode and Sentinel readout/remediation. Be careful with Travel mode: its
disable operation deliberately requires a master-password proof, so a mobile UI must
use the shared mutation rather than shortcutting its policy. Dependencies include
existing core/API operations, secure re-entry dialogs, entitlement handling for
Sentinel, and product choices about which sensitive destructive actions are appropriate
on a phone.

## P2 — Passwordless “set up from existing device” approval is deliberately unfinished

**Evidence**

- The device-setup plan specifies a new mobile `device-request` route that displays a
  QR and waits for approval (`docs/plans/device-setup-polish.md:251-258`).
- The plan's Track B acceptance criteria are unchecked for the mobile QR/waiting state,
  desktop/web approval, and immediately unlocked completion
  (`docs/plans/device-setup-polish.md:284-290`).
- The current mobile path instead scans a setup payload from an existing client and
  still asks for the master password (`apps/mobile/app/(auth)/login.tsx:174-182,341-440,563-575`).

**Impact and recommendation**

This is not P1 because full sign-in remains functional, and the plan intentionally
separates it as a future sprint. It would materially reduce the Secret Key/device-setup
friction once the P0/P1 trust paths are solid. Implement only with the planned
ephemeral-keypair, short-expiry, and encrypted-master-unlock-key constraints; this is
an authentication protocol feature, not just another QR screen.

## Deliberately not counted as gaps

Several initially suspicious areas are implemented and therefore excluded: item
creation/editing, attachments, password history, TOTP, tags, share links, and trash.
For example, item creation calls the shared mutation after validation
(`apps/mobile/app/(vault)/create.tsx:90-201`); item detail exposes attachments, sharing,
and password history (`apps/mobile/app/(vault)/[vaultId]/[itemId].tsx:122-182`); and
Trash has restore plus permanent delete mutations (`apps/mobile/app/(tabs)/trash.tsx:88-145`).
This keeps the priorities focused on corroborated omissions rather than surface-area
differences.

## Suggested sequencing

1. **P0:** iOS Credential Provider/autofill with security review and native integration
   tests.
2. **P1:** replace the vault-create placeholder with personal-vault CRUD; at the same
   time introduce the mobile test harness around the changed critical flows.
3. **P1:** mobile signup and recovery; then close the adjacent Security & Account
   management gaps as a coherent safe-operations surface.
4. **P2:** passwordless device approval, Travel mode management, and Sentinel/mobile
   remediation according to product entitlement and security-policy decisions.
