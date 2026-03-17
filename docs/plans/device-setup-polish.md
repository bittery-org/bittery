# Device Setup Polish

## Status
Track A — **Done**

## What Was Done (Track A)

All Track A acceptance criteria have been implemented:

- **Desktop dialog**: description corrected to explain that the phone scans the desktop QR (not the other way around). Numbered step instructions (steps 1–5) added below the QR code. When no secret key is stored, a specific guidance message is shown instead of a generic error.
- **Mobile login screen**: all hardcoded English strings replaced with i18n keys. A visible "Setting up this device?" banner card is shown above the form (between logo and Server URL field), replacing the buried button inside the Secret Key field. After a successful QR scan, the full form collapses to a focused single-field view showing only the email (read-only label), server URL (read-only label), and the master password field, plus a "Not you? Start over" reset link.
- **Mobile QR scanner**: all hardcoded strings replaced with i18n keys.
- **Web settings Devices tab**: "Set up another device" button added to the tab header. Clicking it opens a new `WebDeviceSetupDialog` that shows a QR code (when secret key is in session storage), a copyable setup link, numbered step instructions, and the corrected description. Falls back to the no-secret-key guidance message when the key is absent.
- **i18n**: all new keys added to both `en.json` and `de.json`. Paraglide files regenerated.

## Background

Bittery uses a dual-key model (Master Password + Secret Key). This makes account security stronger than most password managers, but it raises setup friction on a second device — the user has to locate and type their Secret Key in addition to their password.

The current flow works but has rough edges:

- Desktop shows a QR code and a copyable setup link, but the dialog description is worded backwards and there are no instructions telling the user what to do
- Mobile buries the "Scan setup QR" button inside the Secret Key field, making it easy to miss
- Scanning the QR pre-fills email, server URL, and Secret Key — but the user still sees the full login form with all fields, including the ones that are now already filled
- The web settings Devices page has no "Set up another device" button at all
- Mobile and the QR scanner have dozens of hardcoded English strings that bypass the i18n system (violating the repo rule)

---

## How This Compares to Other Password Managers

**1Password** — their "Transfer Account" QR also carries email + secret key + server domain. User still types their master password after scanning. This is intentional; 1Password's docs are explicit that the master password never leaves the device. Bittery's current approach matches this model.

**Bitwarden "Login with Device"** — a reversed-QR flow: the new device displays a code, the existing authenticated device receives a push notification and approves it. After approval the new device still derives its own keys from the master password typed locally. Bitwarden cannot skip the master password either.

**Signal linked devices** — truly passwordless transfer, but Signal's threat model is completely different (no master password, keys are bound to a phone number/registration). Not applicable here.

### Why the master password cannot go in the QR

`masterUnlockKey = deriveKeys(deriveMasterKey(password, secretKey, email))`

The master unlock key is the root of all client-side decryption. It is derived locally and never sent to the server. Without the master password, a new device receives only ciphertext it cannot read. Putting the password in a QR code that sits on screen for 30+ seconds would be a serious security regression — so both Bittery and 1Password deliberately stop at pre-filling everything except the password.

### What is achievable short-term vs long-term

| Approach | Password needed on new device? | Backend changes? |
|---|---|---|
| Current (pre-fill via QR) | Yes | None |
| Track A: UX polish | Yes, but only one field remains | None |
| Track B: "Login with Device" | No | Yes — new endpoints + DB table |

---

## Track A — UX Polish (no backend changes)

### Phase 1 — Fix i18n violations (repo rule: no hardcoded user-facing text)

**Files affected:**
- `packages/i18n/messages/en.json` — add all new keys
- `apps/mobile/app/(auth)/login.tsx` — all hardcoded strings: field labels, placeholders, descriptions, `Alert.alert()` messages, biometric text, button labels, subtitle copy
- `apps/mobile/src/components/device-setup-qr-scanner.tsx` — all hardcoded `Alert()` strings and visible UI text

**New i18n key namespaces:**
- `login_*` for the mobile login screen
- `device_setup_scanner_*` for the QR scanner modal

---

### Phase 2 — Mobile: Promote the QR entry point + simplified post-scan view

#### 2a. Add a "Setting up this device?" banner above the login form

Currently the only way to open the QR scanner is a small button buried inside the Secret Key field. Almost nobody finds it.

Replace it with a tappable card above the form (between the logo and the Server URL field):

```
+---------------------------------------------+
|  []  Setting up this device?                |
|      Scan the QR from your desktop or web   |
|      app to fill in your details.        >  |
+---------------------------------------------+
```

Tapping it opens the same `DeviceSetupQrScanner`. Remove the old button from inside the Secret Key field.

**File:** `apps/mobile/app/(auth)/login.tsx`

#### 2b. Simplified post-scan view

After a successful QR scan, email + server URL + secret key are pre-filled. The full form still shows six fields including the ones the user does not need to touch.

After scan success, switch to a focused single-field view:

```
  Welcome back
  user@example.com · your-server.com

  +------------------------------------------+
  |  Master Password                         |
  +------------------------------------------+

  [  Sign In  ]

  Not you? Start over
```

Implementation: add a `setupComplete` boolean to state. When true, render a condensed view showing only the email (read-only), server URL (read-only badge), and password field. The "Not you? Start over" link resets `setupComplete` and clears the pre-filled values.

**File:** `apps/mobile/app/(auth)/login.tsx`

---

### Phase 3 — Desktop dialog polish

#### 3a. Fix the description (currently backwards)

Current: `"Select an account and scan the QR code on the mobile sign-in screen."`

This implies the user scans something on the mobile screen using the desktop — the opposite of what actually happens.

New: `"Open Bittery on your phone, tap Sign in, then tap 'Setting up this device?' to fill in your details automatically."`

**File:** `packages/i18n/messages/en.json`

#### 3b. Add numbered step instructions

Below the QR code panel, add a compact numbered list:

1. Download Bittery on your device
2. Open the app and tap **Sign in**
3. Tap **"Setting up this device?"**
4. Point your camera at this QR code
5. Enter your master password

**File:** `apps/desktop/src/components/device-setup-dialog.tsx`

New i18n keys: `vaults_sidebar_account_switcher_device_setup_dialog_step_1` through `_step_5`

#### 3c. Better empty state when secret key is not stored

When the secret key is missing, the QR area currently shows a plain error message. Replace with guidance:

**QR unavailable** — Your Secret Key is not stored in this session. Use the setup link below — it will prefill your email and server URL on the new device. You will need to enter your Secret Key manually.

**File:** `apps/desktop/src/components/device-setup-dialog.tsx`

New i18n key: `vaults_sidebar_account_switcher_device_setup_dialog_no_secret_key_guidance`

---

### Phase 4 — Web settings: "Set up another device" button

The web app has no way to start a device setup flow at all.

#### 4a. Create `apps/web/src/components/settings/device-setup-dialog.tsx`

Mirrors the desktop `DeviceSetupDialog`. Data sources:
- Email + team name: `useQuery(trpc.auth.me.queryOptions())`
- Server URL: `getServerUrl()` from `@/lib/auth-server`
- Secret Key: `storage.getStoredSecretKey(email)`

Renders:
- QR code (when secret key is available) using `QRCodeSVG` from `qrcode.react`
- Copyable setup link field
- Numbered step instructions (same as desktop)
- Warning when secret key is not available

#### 4b. Add button to the Devices tab header

In `apps/web/src/routes/_app/settings/index.tsx`, add a button to the Devices tab header row that opens the new dialog.

New i18n key: `settings_devices_action_setup_another`

---

### Track A — File Summary

| File | Change |
|---|---|
| `packages/i18n/messages/en.json` | All new i18n keys |
| `apps/desktop/src/components/device-setup-dialog.tsx` | Fix description, add step instructions, better no-secret-key empty state |
| `apps/mobile/app/(auth)/login.tsx` | i18n throughout, banner above form, simplified post-scan view |
| `apps/mobile/src/components/device-setup-qr-scanner.tsx` | i18n throughout |
| `apps/web/src/routes/_app/settings/index.tsx` | Add "Set up another device" button |
| `apps/web/src/components/settings/device-setup-dialog.tsx` | New file — web device setup dialog |

---

## Track B — "Login with Device" (future feature, requires backend)

This feature makes second-device setup truly passwordless: the new device only needs the QR scan, no master password entry at all.

### How it works

```
New device (mobile)            Server             Existing device (desktop/web)
------------------             ------             ----------------------------
1. Generate temp keypair
2. POST createDeviceApproval -> store request
   { tempPublicKey, ttl }    <- return requestId
3. Display QR:
   { requestId, serverUrl }
                                                  4. Scan QR (new scanner mode)
                             <- GET pollApproval  5. Fetch request details
                                                  6. Show "Approve sign-in for iPhone?"
                                                  7. User approves ->
                                                     encrypt(masterUnlockKey, tempPublicKey)
                             <- POST approveDevice
                               { requestId, encryptedMUK, sessionToken }
                             -> store approval
4. Poll resolves             <- GET pollApproval
5. Decrypt MUK with
   temp private key
6. Store MUK, use sessionToken
7. Immediately unlocked
```

### Why this is secure

- The `masterUnlockKey` is encrypted with the new device's temporary public key before it ever touches the server — the server stores only ciphertext it cannot decrypt
- The temp keypair is ephemeral — generated fresh per request, discarded after use
- The approval request has a short TTL (2 minutes); if the approving device does not act in time, both sides reject it
- The approving device shows the new device name/platform so the user can verify before approving
- The session token is only issued after the approving device confirms

### Backend changes required

**New DB table: `device_approval_requests`**

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | |
| `userId` | text FK | -> user |
| `tempPublicKey` | text | RSA/ECDH public key PEM |
| `encryptedMUK` | text nullable | populated on approval |
| `sessionToken` | text nullable | short-lived, populated on approval |
| `deviceName` | text | shown in approval UI |
| `platform` | text | |
| `status` | enum | pending / approved / expired |
| `createdAt` | timestamp | |
| `expiresAt` | timestamp | createdAt + 2 min |

**New tRPC procedures:**

- `auth.createDeviceApprovalRequest` — new device calls with `tempPublicKey` + device metadata; returns `requestId`
- `auth.getDeviceApprovalRequest` — approving device fetches request details; scoped to authenticated user's own requests
- `auth.approveDeviceRequest` — approving device sends `requestId + encryptedMUK`; server mints a session token and stores it
- `auth.pollDeviceApproval` — new device polls; returns `{ status, encryptedMUK, sessionToken }` once approved (or extend the existing SSE sync stream to push `device_approval_granted` events to avoid polling)

### Client changes required

**New mobile screen:** `apps/mobile/app/(auth)/device-request.tsx`
- Generates ephemeral keypair on mount
- Calls `createDeviceApprovalRequest`
- Displays QR of `{ requestId, serverUrl }`
- Shows animated "Waiting for approval from another device..." state
- On approval: decrypts MUK, stores session, navigates to vault

**Desktop/web new mode:**
- A "Approve a device" scanner on the desktop setup dialog (or separate button)
- Scans the `requestId` QR, fetches request details, shows approval confirmation
- On confirm: reads current session's MUK from storage, encrypts with `tempPublicKey`, POSTs approval

### Recommendation

Ship Track A first to remove the current rough edges. Track B is a full feature sprint and should be planned separately after Track A ships.

---

## Acceptance Criteria

### Track A — Acceptance Criteria

- [x] Desktop: dialog description clearly explains the flow direction (phone scans desktop, not other way around)
- [x] Desktop: numbered step instructions visible below the QR code
- [x] Desktop: when no secret key is stored, helpful guidance shown instead of a plain error
- [x] Mobile: login screen has a visible "Setting up this device?" banner above the form
- [x] Mobile: after scanning a QR, only the password field is shown — all other fields are hidden and pre-filled
- [x] Mobile: zero hardcoded English strings in the login screen or QR scanner
- [x] Web: Settings -> Devices tab has a "Set up another device" button in the header
- [x] Web: clicking it opens a dialog with a QR code (when secret key is available) and a copyable setup link

### Track B

- [ ] Mobile: a "Set up from existing device" option shows a QR and a "Waiting for approval..." state
- [ ] Desktop/Web: an authenticated device can scan the mobile QR and see an "Approve sign-in?" dialog
- [ ] After approval, the mobile device is immediately signed in and unlocked with no password entry
- [ ] Approval requests expire after 2 minutes
- [ ] The server never stores a plaintext master unlock key
