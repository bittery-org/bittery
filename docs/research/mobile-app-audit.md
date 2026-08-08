# Mobile app audit

Audit date: 2026-08-08. Scope: `apps/mobile` and the shared packages it directly uses. This is a static, repository-evidence audit; it does not claim device-runtime coverage. Findings marked **confirmed** are directly demonstrated by source. Findings marked **inferred** are missing mobile integrations for capabilities that the shared layer already exposes.

## Confirmed incomplete or non-functional features

### 1. Creating a vault is an explicit UI stub

**Impact:** A user can tap the plus control in Browse, but cannot create a vault.

`BrowseScreen` wires the plus button to `handleCreateVault` (`apps/mobile/app/(tabs)/vaults.tsx:218-230`). That handler only displays a toast and performs no navigation or mutation (`apps/mobile/app/(tabs)/vaults.tsx:126-133`). This is not a missing backend capability: the shared mobile-consumable hooks export `useCreateVault` (`packages/core/src/hooks/index.ts:179-190`).

### 2. Saving credentials offered by Android Autofill always fails

**Impact:** The Autofill service can fill existing entries, but it refuses every system save request for a newly entered or updated credential.

The service's `onSaveRequest` logs that it is not implemented and calls `callback.onFailure("Save not supported")` (`apps/mobile/modules/credential-provider/android/src/main/java/expo/modules/credentialprovider/service/BitteryAutofillService.kt:207-210`). This is a direct functional rejection, not merely absent UI.

### 3. The credential-provider integration is incomplete across the supported mobile platforms

**Impact:** The app declares a broad native credential-provider contract—vault/MUK management, biometric escrow, vault sync, passkey writeback, and credential operations—but that contract is not implemented consistently across the mobile platforms advertised by the repository.

The JavaScript bridge declares these production operations, for example MUK management (`apps/mobile/modules/credential-provider/src/CredentialProviderModule.ts:24-57`), vault sync and passkey-mutation methods (`apps/mobile/modules/credential-provider/src/CredentialProviderModule.ts:95-123`), and credential-provider methods (`apps/mobile/modules/credential-provider/src/CredentialProviderModule.ts:154-215`). The native counterpart for the other mobile platform is the untouched Expo-module starter surface: a `PI` constant, `hello`, `setValueAsync`, and a demo web view (`apps/mobile/modules/credential-provider/ios/CredentialProviderModule.swift:11-46`); none of the declared operations is defined there. The React Native code avoids calling these methods outside Android (`apps/mobile/app/_layout.tsx:37-46`), so this is feature absence rather than an established crash path.

### 4. Custom fields are display-only on mobile

**Impact:** Existing custom fields can be read and copied, but mobile users cannot add, edit, delete, or change their type.

The shared item model supports custom fields with IDs, labels, values, and field types (`packages/shared/src/types.ts:28-36`, `packages/shared/src/types.ts:77-88`). The detail UI only maps them to read-only rows (`apps/mobile/src/components/item-details/custom-fields.tsx:18-34`). In the edit route, the field collection is initialized without a setter (`apps/mobile/app/(vault)/[vaultId]/edit/[itemId].tsx:115-120`) and is passed back unchanged on save (`apps/mobile/app/(vault)/[vaultId]/edit/[itemId].tsx:177-205`). The create route only renders the category form, tags, and notes (`apps/mobile/app/(vault)/create.tsx:386-418`) and its save payload never assigns `customFields` (`apps/mobile/app/(vault)/create.tsx:147-173`).

### 5. Identity creation and editing expose only three of the supported fields

**Impact:** Mobile cannot create or change middle name, addresses, phone numbers, date of birth, SSN, passport number, or driver's license. Existing values remain visible, but users must use another client to manage them.

The shared identity model includes all of those fields (`packages/shared/src/types.ts:96-106`). The read-only identity detail surface renders them, including addresses and phone numbers (`apps/mobile/src/components/item-details/identity-fields.tsx:23-91`). In contrast, `IdentityForm` holds and returns only first name, last name, and email (`apps/mobile/src/components/item-forms/identity-form.tsx:7-35`) and renders only those three inputs (`apps/mobile/src/components/item-forms/identity-form.tsx:40-74`). The edit screen consequently supplies only the same three identity values to the form (`apps/mobile/app/(vault)/[vaultId]/edit/[itemId].tsx:298-306`).

### 6. Mobile sharing cannot create email-restricted links

**Impact:** The mobile sharing sheet can only create public-to-anyone links, even though the shared sharing service supports email-restricted links and an allowed-email list.

The shared service accepts `accessMode: "email-restricted"` plus `allowedEmails` (`packages/core/src/services/share-service.ts:19-28`) and forwards those emails when that mode is selected (`packages/core/src/services/share-service.ts:158-168`). The mobile sheet hard-codes `accessMode: "anyone"` and supplies no email list (`apps/mobile/src/components/share/share-item-sheet.tsx:97-105`). Its visible controls cover expiration and one-time use only (`apps/mobile/src/components/share/share-item-sheet.tsx:257-290`).

### 7. EAS/OTA configuration contains literal template identifiers

**Impact:** Release update integration is not configured for a real Expo project. Builds or clients relying on EAS Update cannot target a valid project/update URL from this committed configuration.

`app.json` sets both `extra.eas.projectId` and `updates.url` to the literal placeholder `your-project-id` (`apps/mobile/app.json:79-92`). The mobile package exposes EAS build commands (`apps/mobile/package.json:11-14`), so the placeholder is on an enabled release path rather than dead sample metadata.

## Inferred missing mobile integrations

### 8. Travel Mode has no user-facing mobile control surface

**Confidence:** High for absence of a mobile UI; no claim that policy enforcement is absent.

The shared hook can fetch Travel Mode, choose hidden vaults, enable it, and disable it with a password proof (`packages/core/src/hooks/use-travel-mode.ts:36-192`), and it is exported for all platform clients (`packages/core/src/hooks/index.ts:151-168`). The mobile navigation only registers Items, Search, Browse, Settings, tags, and trash (`apps/mobile/app/(tabs)/_layout.tsx:18-39`); the complete Settings surface exposes appearance, biometric/autolock/lock, trash, accounts, about, and sign-out (`apps/mobile/src/screens/settings-screen.tsx:393-515`, `apps/mobile/src/screens/settings-screen.tsx:517-584`). No corresponding route, control, or `useTravelMode` integration appears in the mobile source. Core enforcement during unlock/sync may still protect data; this finding is specifically the missing user configuration/recovery UI.

### 9. There is no in-app route to enable or configure the credential provider

**Confidence:** Medium; operating-system settings may still offer a manual path.

The bridge exposes `openCredentialProviderSettings` specifically to launch the operating-system credential-provider settings (`apps/mobile/modules/credential-provider/src/CredentialProviderModule.ts:170-175`). The root enables background sync only under Android (`apps/mobile/app/_layout.tsx:37-46`), while the Settings screen limits its credential-provider interaction to propagating auto-lock timeout (`apps/mobile/src/screens/settings-screen.tsx:250-280`). The visible security controls are biometric unlock, auto-lock, and lock vault (`apps/mobile/src/screens/settings-screen.tsx:419-465`). Thus there is no repository-evidenced mobile UI path to explain availability, open provider settings, or show sync status/errors; users likely must discover the OS configuration themselves.

## Notes

- The report intentionally treats platform behavior collectively. It does not infer a crash where `Platform.OS` guards prevent the incomplete native bridge from being invoked.
- No application code was changed for this audit.
