# Platform authenticator and device-bound unlock capability

Produced by a subagent resolving ticket 02
(`planning/greenfield-decision-map/issues/02-platform-authenticator-and-prf-support.md`).
Every source in this file was fetched on **2026-08-20**. Status: evidence. Facts only; the decisions
they bear on live in their tickets.

**The distinction this file tracks throughout.** A *gated key* is one the OS will only use, or only
unwrap, after it has verified user presence or a biometric — the check happens inside the OS or the
secure hardware, and the app cannot skip it. A *handed-back secret* is one the OS returns to any
process that asks with the right identity, with no user interaction. Both are called "the keychain"
in casual speech. Only the first is a device-bound unlock primitive.

A second distinction that matters and is easy to lose: hardware backing usually promises the key
**cannot be extracted from the device**. It rarely promises the key **cannot be used** by malware
already running as the user on that device. Android's own docs state this split explicitly (see
section 3).

---

## 1. WebAuthn PRF extension

### 1.1 What the spec defines

- The `prf` extension "allows a RP to evaluate outputs from a pseudo-random function (PRF)
  associated with a credential. The PRFs provided by this extension map from BufferSources of any
  length to 32-byte BufferSources." Source: `https://w3c.github.io/webauthn/#prf-extension`
  (text fetched from the spec's own source, `https://raw.githubusercontent.com/w3c/webauthn/main/index.bs`).
- It is built on CTAP's `hmac-secret`, but is a separate client extension "because `hmac-secret`
  requires that inputs and outputs be encrypted in a manner that only the user agent can perform."
  Same source.
- **Load-bearing:** `hmac-secret` gives two PRFs per credential, one for user-verified requests and
  one for the rest. The spec is explicit that WebAuthn "only exposes a single PRF per credential
  and ... that PRF MUST be the one used for when user verification is performed." Same source.
  So a PRF output is, by construction, only obtainable on an assertion where the authenticator
  performed user verification.
- Salt derivation, quoted normatively: "Let salt1 be the value of
  `SHA-256(UTF8Encode("WebAuthn PRF") || 0x00 || eval.first)`." Same for `eval.second` → salt2.
  Same source.
- Inputs: `eval` (`{first, second}`) and `evalByCredential` (a map from base64url credential ID to
  eval values, "Only applicable during assertions when `allowCredentials` is not empty").
  Outputs: `results.first` / `results.second`, 32 bytes each. Same source.
- The `enabled` boolean is a **registration-only** output: "This is only reported during
  registration and is not present in the case of authentication." Same source. If the authenticator
  does not support PRF at all, `get()` returns `{ prf: {} }`. Source:
  `https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API/WebAuthn_extensions`
- The spec warns directly at zero-knowledge designs: "Authenticator extension outputs MUST NOT
  contain cleartext PRF outputs," and it tells relying parties building end-to-end encryption to
  omit `prf.results` when relaying the credential response to a server. Same source.

### 1.2 The CTAP layer underneath

- CTAP 2.1 §12.7: at `authenticatorMakeCredential` "the authenticator generates two random 32-byte
  values (called `CredRandomWithUV` and `CredRandomWithoutUV`) and associates them with the
  credential." At assertion it computes `output1 = HMAC-SHA-256(CredRandom, salt1)`. Source:
  `https://fidoalliance.org/specs/fido-v2.1-ps-20210615/fido-client-to-authenticator-protocol-v2.1-ps-20210615.html#sctn-hmac-secret-extension`
- CTAP 2.2 §12.8 adds `hmac-secret-mc`, which lets `authenticatorMakeCredential` return PRF output
  at registration time. It requires `hmac-secret: true` alongside it. Source:
  `https://fidoalliance.org/specs/fido-v2.2-ps-20250714/fido-client-to-authenticator-protocol-v2.2-ps-20250714.html`

### 1.3 Browser support

| Browser | State | Source |
|---|---|---|
| Chrome / Chromium | "Enabled by default." The feature entry records **no shipping milestone** (`rollout_milestone` and the per-platform milestone fields are all null). The Intent to Ship targeted all six Blink platforms. | `https://chromestatus.com/api/v0/features/5138422207348736`, `https://groups.google.com/a/chromium.org/g/blink-dev/c/iTNOgLwD2bI` |
| Firefox | Meta-bug 1863819 `RESOLVED FIXED` (2026-04-16). Target milestones on its children: baseline **135**, Windows **135**, macOS **139**, Android **149**. | `https://bugzilla.mozilla.org/show_bug.cgi?id=1863819` and its dependent bugs via the Bugzilla REST API |
| Safari / WebKit | "WebKit for Safari 18.0 adds support for the WebAuthn `prf` extension. It allows for retrieving a symmetric key from a passkey to use for the encryption of user data." Safari 26.4 later added registration-time PRF for external security keys. | `https://webkit.org/blog/15865/webkit-features-in-safari-18-0/`, `https://webkit.org/blog/17862/webkit-features-for-safari-26-4/` |

- The widely repeated claim that Chrome shipped PRF in **M116** is **unverified**. No primary Google
  document states a milestone; the Chrome Platform Status entry leaves every milestone field null.
- MDN documents `prf` as usable in both `create()` and `get()` but carries **no browser-compat
  table** for it. There is no `prf` compat-data file in `mdn/browser-compat-data`. Source:
  `https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API/WebAuthn_extensions`

### 1.4 Platform-authenticator support

- **Apple (iCloud Keychain passkeys): supported.** Confirmed by the WebKit release note above
  (Safari 18 / iOS 18 / iPadOS 18 / macOS Sequoia / visionOS 2). Apple also exposes it to native
  apps as `ASAuthorizationPublicKeyCredentialPRFRegistrationInput`/`Output` and
  `...PRFAssertionInput`/`Output`. Source:
  `https://developer.apple.com/documentation/authenticationservices/asauthorizationpublickeycredentialprfassertioninput-swift.struct`
- **Windows Hello: unverified, and the available evidence points to "no".**
  - The Win32 plumbing exists. `WEBAUTHN_HMAC_SECRET_SALT` "Contains the salt values for the
    HMAC-SECRET extension (PRF)", with the remark "SALT values, by default, are converted into RAW
    Hmac-Secret values as per PRF extension." Source:
    `https://learn.microsoft.com/en-us/windows/win32/api/webauthn/ns-webauthn-webauthn_hmac_secret_salt`
  - But Microsoft's own WebAuthn page lists "Hash-based Message Authentication Code (HMAC)-secret
    (enables offline scenarios)" only as an **optional FIDO2 authenticator** feature that relying
    parties "might require". It never states the Windows Hello platform authenticator implements it.
    Source: `https://learn.microsoft.com/en-us/windows/security/identity-protection/hello-for-business/webauthn-apis`
  - A 2024-04-11 feature request asking Microsoft to add PRF to Windows Hello drew a Microsoft reply
    that gave no status, no timeline and no build number, and redirected the asker to the feedback
    platform. Source (community Q&A, not documentation):
    `https://learn.microsoft.com/en-us/answers/questions/4035587/windows-hello-support-for-webauthn-prf-extension`
  - Firefox's Windows PRF bug is gated on the same thing from the browser side. Source:
    `https://bugzilla.mozilla.org/show_bug.cgi?id=1935278`
  - **Refuted claim:** several secondary sources say Windows added Hello `hmac-secret` in the
    February 2026 update KB5077181. That KB was fetched directly and mentions no WebAuthn, Hello,
    FIDO2, `hmac-secret` or PRF content at all. Source:
    `https://support.microsoft.com/en-us/topic/february-10-2026-kb5077181-os-builds-26200-7840-and-26100-7840-f0fa9e54-a22a-4a06-96b6-bf5b2aded506`
- **Android / Google Password Manager: unverified.** Google's own passkey environment-support page
  states Android 9+ for passkeys and does not mention PRF or `hmac-secret` anywhere. Source:
  `https://developers.google.com/identity/passkeys/supported-environments`. The Android credential
  provider guide likewise does not mention PRF or `getClientExtensionResults`. Source:
  `https://developer.android.com/identity/sign-in/credential-provider`. The only Google-authored
  signal is Chromium's Intent to Ship listing Android as a target contingent on "Android's WebAuthn
  library" supporting it — a statement about the browser, not about the GPM authenticator.
- **Hardware keys:** Yubico (vendor primary) requires a YubiKey 5 Series or Bio Series. Source:
  `https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/Developers_Guide_to_PRF.html`

### 1.5 Does PRF work in a browser-extension context?

- **Chrome, from M122:** "extension pages can claim all relying party identifiers that origins they
  have host permissions for can claim." Restrictions: an extension may not claim an RP ID unique to
  another extension, nor an RP ID believed to be an eTLD. Critically, "The origin passed to the
  authenticator to be signed over on the client data json will match the extension origin, and not
  the site." Source: `https://lists.w3.org/Archives/Public/public-webauthn/2023Dec/0078.html`
- **Firefox, from 150:** WebExtensions may call the WebAuthn API and set an RP ID for any domain in
  `host_permissions`. The origin in `clientDataJSON` is `moz-extension://<sha256-derived hash>`,
  described as stable and deterministic. A known bug breaks the flow if the extension popup closes
  when the credential prompt appears; the workaround is a full tab. Source:
  `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Use_the_web_authn_api`
- Both are **browser-specific carve-outs**. The W3C text defines an RP ID as a valid domain string
  tied to the caller's origin, which is why `chrome-extension://` and `moz-extension://` needed
  vendor-specific rules rather than spec language. Source: `https://w3c.github.io/webauthn/`
- **`prf` specifically inside an extension: unverified.** No Chromium document, Chromium bug, MDN
  page or spec text was found that states `prf` works end to end from an extension-claimed RP ID.
  It rides on the same `navigator.credentials.get()` call, so it should work by construction, but
  that is an inference, not a cited fact.

### 1.6 Is the derived secret stable?

- **Across repeated `get()` calls with the same credential and salt: yes, deterministically.**
  `output1 = HMAC-SHA-256(CredRandom, salt1)`, and `CredRandom` is fixed for the credential's
  lifetime. Source: CTAP 2.1 §12.7 (URL above).
- **Across credential re-registration: no. The secret changes.** `CredRandomWithUV` and
  `CredRandomWithoutUV` are generated fresh at each `authenticatorMakeCredential`. A new credential
  for the same account therefore yields a different PRF output for an identical salt. Source: CTAP
  2.1 §12.7. The WebAuthn spec's abstract fallback procedure agrees: "Associate PRF with the current
  credential for the lifetime of the credential."
- **Across iCloud Keychain sync to another device: intended to be stable, observed to be flaky.**
  An Apple engineer states on the developer forums: "This should work as expected, that is, the prf
  should be identical in this case," and asks for a Feedback Assistant report otherwise. Developers
  in the same thread report real cross-device, cross-OS-version mismatches. Source:
  `https://developer.apple.com/forums/thread/822523`
- **Across Google Password Manager sync: unverified.** No primary Google statement found either way.
- **Rotation:** the spec defines no mechanism to rotate or invalidate `CredRandom`. Deleting and
  recreating the credential is the only spec-defined way to change it. The `eval.second` input
  exists so a relying party can fetch a "next" value alongside the current one and rotate at the
  application layer around a stable underlying secret.

---

## 2. Windows Hello, macOS Keychain and Secure Enclave, Linux Secret Service

### 2.1 Windows Hello (`Windows.Security.Credentials.KeyCredential`)

**User presence.** `KeyCredential.RequestSignAsync` "Prompts the user to cryptographcally sign data
using their key credential" [sic, Microsoft's typo]. Source:
`https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.keycredential.requestsignasync`.
The developer guide adds: "causing Windows to request the user's PIN or biometrics through Windows
Hello. At no time will the developer have access to the private key of the user." Source:
`https://learn.microsoft.com/en-us/windows/apps/develop/security/windows-hello`

**But the per-call prompt is not unconditional.** The Hello for Business FAQ: "Microsoft Entra ID and
Active Directory sign-in keys are cached under lock. This means the keys remain available for use
without prompting, as long as the user is interactively signed-in. Microsoft Account sign-in keys
are transactional keys, which means the user is always prompted when accessing the key." Smart-card
emulation mode likewise "verifies the PIN and then discards the PIN in exchange for a ticket ...
Subsequent private key operations won't prompt the user for the PIN." Source:
`https://learn.microsoft.com/en-us/windows/security/identity-protection/hello-for-business/faq`

**Hardware binding is best-effort by default.** "If the device has the right TPM chip, the APIs will
request the TPM chip to create the private and public key and store the result; if there is no TPM
chip available, the OS will create the key pair in code." Source:
`https://learn.microsoft.com/en-us/windows/apps/develop/security/windows-hello`. Hello for Business:
"Keys can be generated in hardware (TPM 1.2 or 2.0) or software, based on the configured policy
setting. To guarantee that keys are generated in hardware, you must configure a policy setting."
Source: `https://learn.microsoft.com/en-us/windows/security/identity-protection/hello-for-business/how-it-works`

**Non-extractability, when TPM-backed.** The Microsoft Platform Crypto Provider "ensures that
private keys are securely stored and cannot be extracted, even by malicious software." Source:
`https://learn.microsoft.com/en-us/windows/win32/seccertenroll/cng-key-storage-providers`. Hello for
Business: "The private key is stored locally and protected by the TPM, and can't be exported." Same
`how-it-works` URL. Export is governed by `NCRYPT_EXPORT_POLICY_PROPERTY`
(`NCRYPT_ALLOW_EXPORT_FLAG` = 0x1, `NCRYPT_ALLOW_PLAINTEXT_EXPORT_FLAG` = 0x2, archiving variants
0x4/0x8); the property "can contain zero or a combination" of these. Source:
`https://learn.microsoft.com/en-us/windows/win32/seccng/key-storage-property-identifiers`

**Shape of the primitive.** `KeyCredential` is "an RSA, 2048-bit, asymmetric key." Its full
documented surface is `Name`, `GetAttestationAsync()`, `RequestSignAsync(IBuffer)`,
`RequestSignForWindowAsync(WindowId, IBuffer)`, `RetrieveAuthorizationContext(IBuffer)`,
`RetrievePublicKey()` and — newly — `RequestDeriveSharedSecretAsync(WindowId, String, IBuffer)`.
Source: `https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.keycredential`

`RequestDeriveSharedSecretAsync` first appears in the `winrt-26100` moniker (Windows 11 24H2). Its
reference page carries the signature and parameter names (`windowId`, `message`, `encryptedRequest`)
and returns a `KeyCredentialOperationResult`, but **has no description, no remarks and no parameter
documentation at all**. Its semantics — in particular whether it is a Hello-gated unwrap suitable
for releasing a wrapped vault key — are **unverified**. Source:
`https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.keycredential.requestderivesharedsecretasync`

**Invalidation.** PIN reset: "Resetting the PIN means that all keys and certificates encrypted with
the old key material will be removed," and the sample code comments `KeyCredentialStatus.NotFound`
as "// PIN reset has occurred somewhere else and key is lost. Repeat key registration." Sources:
`https://learn.microsoft.com/en-us/windows/security/identity-protection/hello-for-business/how-it-works`,
`https://learn.microsoft.com/en-us/windows/apps/develop/security/windows-hello`. Container deletion
via `certutil.exe -deleteHelloContainer` "clears the container where key material created during
Windows Hello for Business provisioning is stored." TPM lockout forces a PIN reset, which triggers
the removal above. Removing Hello *biometrics* only deletes the biometric template database and is
described separately from key removal. Source: the Hello for Business FAQ URL above. Effect of a
full device reset: **unverified** (inferable only from "Each Hello is unique to a specific user and
device ... doesn't sync across devices").

**Windows 11 24H2 plugin passkey managers.** "starting in Windows 11 version 24H2 WebAuthn APIs
support plugin passkey managers." The advertised operations include registering via
`WebAuthNPluginAddAuthenticator`, managing credential metadata with
`WebAuthNPluginAuthenticatorAddCredentials` / `...RemoveCredentials`, and "Performing user
verification using Windows Hello with `WebAuthNPluginPerformUserVerification`." Source:
`https://learn.microsoft.com/en-us/windows/security/identity-protection/hello-for-business/webauthn-apis`.
Whether `WebAuthNPluginPerformUserVerification` returns only a verification result or gates access to
key material is **unverified** — the individual function reference page returned 404 and the only
description found is the bullet above.

**The contrast case — Windows secrets the OS hands back on request.**

- `ProtectedData` (DPAPI) "provides protection using the user or machine credentials to encrypt or
  decrypt data." Protection is scope-based (`DataProtectionScope.CurrentUser` / `LocalMachine`).
  No prompt, no gesture, no Hello involvement is documented anywhere on the page. Source:
  `https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata`
- `PasswordVault`: "Apps not running in an AppContainer (for example, regular Desktop apps) can
  access all the user's lockers, including those of AppContainer apps." No consent step documented
  on `Retrieve`/`RetrieveAll`. Source:
  `https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.passwordvault`
- `CredRead` "reads a credential from the user's credential set. The credential set used is the one
  associated with the logon session of the current token." Silent, gated only by the process token.
  Source: `https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreada`

### 2.2 macOS: Secure Enclave and the keychain

**What the Secure Enclave can hold.** Only 256-bit NIST P-256 EC private keys
(`kSecAttrTokenIDSecureEnclave`), for signing, verification, key agreement and EC encryption. Keys
must be *generated* in the enclave; plaintext key material can neither be imported nor exported.
There is no symmetric-secret or raw-data storage. Source:
`https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave`.
`SecKeyCreateRandomKey` fails with `errSecInteractionNotAllowed` if called in the background on a
locked device. Source:
`https://developer.apple.com/documentation/security/seckeycreaterandomkey(_:_:)`

**Consequence for a password manager:** a symmetric vault key must be *wrapped*, not stored. Apple's
documented pattern is ECIES — encrypt the payload under a random AES key, wrap that AES key to the
enclave key's public half, and unwrap later with `SecKeyCreateDecryptedData` (for example
`eciesEncryptionCofactorX963SHA256AESGCM`). Sources:
`https://developer.apple.com/documentation/security/using-keys-for-encryption`,
`https://developer.apple.com/documentation/security/seckeycreatedecrypteddata(_:_:_:_:)`

**Non-extractability.** Developer docs: "Instead of handling plain-text keys in system memory ...
the Secure Enclave creates, encodes, and performs operations with keys internally—you only receive
the operation outputs." Same `protecting-keys-with-the-secure-enclave` URL. Platform Security guide:
"These keys stay within the AES Engine and aren't made visible even to sepOS software. Although
software can request encryption and decryption operations with hardware keys, it can't extract the
keys." Source: `https://support.apple.com/guide/security/the-secure-enclave-sec59b0b31ff/web`

**Where the access check happens.** "Keychains can use access control lists (ACLs) to set policies
for accessibility and authentication requirements ... **ACLs are evaluated inside the Secure
Enclave.**" Source: `https://support.apple.com/guide/security/keychain-data-protection-secb0694df1a/web`.
And in the pattern Apple recommends — `kSecAttrAccessControl` on the item plus
`kSecUseAuthenticationContext` in the query — "The Secure Enclave passes back a pass/fail result
that gates keychain item access. No user space or operating system software ever has access to the
underlying authentication data." Source:
`https://developer.apple.com/documentation/localauthentication/accessing-keychain-items-with-face-id-or-touch-id`

**How that differs from an ordinary keychain read.** A keychain item stored with only an
accessibility class (say `kSecAttrAccessibleWhenUnlocked`) and no `kSecAttrAccessControl` is
returned by `SecItemCopyMatching` to any process in a matching access group, with no prompt, as
long as the device is unlocked. That is the handed-back case. The gated case requires an access
control object created by `SecAccessControlCreateWithFlags`. Its own docs warn that "Accessing
keychain items or performing operations on keys that are protected by access control objects may
block execution on the main thread," which is the tell that a user interaction can occur. Source:
`https://developer.apple.com/documentation/security/secaccesscontrolcreatewithflags(_:_:_:_:)`

**`LAContext.evaluatePolicy` alone is not cryptographically meaningful.** LocalAuthentication
"returns only a Boolean result" and "your app never gains access to any of the underlying
authentication data." Source: `https://developer.apple.com/documentation/localauthentication`.
Apple further warns "Don't assume that a previous successful policy evaluation means that future
evaluations will also succeed." Source:
`https://developer.apple.com/documentation/localauthentication/lacontext/evaluatepolicy(_:localizedreason:reply:)`.
An app that calls `evaluatePolicy`, gets `true`, and then reveals a secret it already holds in
memory has built an app-level check that instrumentation or a logic bug can bypass. Binding the
`LAContext` into the keychain query via `kSecUseAuthenticationContext` moves the gate into the
Secure Enclave. `touchIDAuthenticationAllowableReuseDuration` (default 0, capped by
`LATouchIDAuthenticationMaximumAllowableReuseDuration`) lets a recent device unlock satisfy a later
evaluation without re-prompting. Source:
`https://developer.apple.com/documentation/localauthentication/lacontext/touchidauthenticationallowablereuseduration`

**macOS-specific.** The Secure Enclave is present "on a Mac with Apple silicon and those with the
Apple T2 Security Chip." Source:
`https://support.apple.com/guide/security/hardware-security-overview-secf020d1074/web`. On macOS the
iOS-style semantics only apply when you opt in: "It's highly recommended that you set the value of
this key to true for all keychain operations" (`kSecUseDataProtectionKeychain`). Source:
`https://developer.apple.com/documentation/security/ksecusedataprotectionkeychain`. Correspondingly,
`kSecAttrAccessGroup` "only applies when also setting `kSecUseDataProtectionKeychain` or
`kSecAttrSynchronizable` to true" on macOS. Source:
`https://developer.apple.com/documentation/security/ksecattraccessgroup`. The legacy file-based
macOS keychain uses per-item `SecAccess` ACL objects rather than the code-signing-derived
access-group model; a single Apple page contrasting the two directly was not found, so treat the
characterisation of the legacy model as **partially unverified**.

### 2.3 Linux: freedesktop.org Secret Service

**The spec defines a D-Bus protocol and nothing else.** No hardware binding, no non-extractability,
no key-material storage format. Those words do not appear in it. Source:
`https://specifications.freedesktop.org/secret-service/latest-single/`

- Locking: "Some items and/or collections may be marked as locked by the service. The secrets of
  locked items cannot be accessed." Source:
  `https://specifications.freedesktop.org/secret-service/latest/unlocking.html`
- `Unlock()` "will return the DBus object paths of objects it could immediately unlock without
  prompting," and may also return a prompt object. Clients "must not assume that an item is already
  unlocked." Same source.
- `Item.GetSecret(IN ObjectPath session, OUT Secret secret)` — "Retrieve the secret for this item."
  Source: `http://specifications.freedesktop.org/secret-service/latest/org.freedesktop.Secret.Item.html`
- `SearchItems` splits results, and "The unlocked return value will contain the object paths of all
  the items that are not locked." Source: the `latest-single` URL above.

**The decisive sentence:** "**This specification does not mandate any form of access control.** The
service may choose to allow certain applications to access a keyring, and others [not]." Source:
`https://specifications.freedesktop.org/secret-service/latest-single/`. There is no application
identity, code signature or entitlement in the protocol. Combined with the locking rules above, this
means: once the login keyring is unlocked — which the standard desktop login flow does
automatically — any process that can reach the same D-Bus session bus can call `SearchItems` and
`GetSecret` and receive plaintext, with no user interaction. (This conclusion is an inference from
the two quoted statements, not a single verbatim sentence in the spec.)

**Transport encryption is cosmetic against an active attacker.** The session algorithms are `plain`
and `dh-ietf1024-sha256-aes128-cbc-pkcs7` (DH over the IETF Second Oakley Group, HKDF-SHA-256 down
to a 128-bit AES key, AES-CBC with PKCS#7 padding). The spec states plainly: "the encryption is not
envisioned to withstand man in the middle attacks or other active attacks." Sources:
`https://specifications.freedesktop.org/secret-service/0.2/ch07s03.html`, the `latest-single` URL.

**TPM.** libsecret ships an *optional, non-default* TPM2 extension to its **file backend** — not to
the D-Bus/gnome-keyring collection backend — built with `-Dtpm2=true`, whose stated purpose is to
fix the fact that "the entire security of the file backend relies on the user's login password
(single point of failure)." Source:
`https://gnome.pages.gitlab.gnome.org/libsecret/libsecret-tpm2.html`. No primary source was found
stating that the default gnome-keyring login keyring is TPM-backed. The gnome-keyring on-disk format
is **unverified** — no primary gnome-keyring document was reachable.

**Net:** Linux Secret Service is a handed-back-secret store. It offers no gated-key primitive at all.

---

## 3. Android Keystore: `setUserAuthenticationRequired`, StrongBox, invalidation

### 3.1 `setUserAuthenticationRequired(true)`

- "Sets whether this key is authorized to be used only if the user has been authenticated." By
  default a key is authorized regardless of authentication state. It requires a secure lock screen,
  and if the key needs authentication on every use, at least one biometric must be enrolled. "This
  authorization applies only to secret key and private key operations." Source:
  `https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec.Builder`
  (javadoc text verified against AOSP:
  `https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/keystore/java/android/security/keystore/KeyGenParameterSpec.java`)
- **Time-based mode:** `setUserAuthenticationParameters(int timeoutSeconds, int type)` — "Sets the
  duration of time (seconds) and authorization type for which this key is authorized to be used
  after successful user authentication." `type` is a set of `KeyProperties.AUTH_*` flags
  (`AUTH_BIOMETRIC_STRONG`, `AUTH_DEVICE_CREDENTIAL`). Same sources.
- **Auth-per-use mode:** timeout `0`. Every cryptographic operation then requires a fresh
  authentication, bound by passing the `Cipher` inside a `BiometricPrompt.CryptoObject`. Same
  sources.
- `setUserAuthenticationValidityDurationSeconds(int)` is deprecated in favour of
  `setUserAuthenticationParameters(int, int)`. Same sources. The exact `@since` API level for the
  replacement (commonly cited as 30) was **not** independently confirmed from a fetched `@since`
  tag — treat the API-level number as unverified.

### 3.2 What invalidates a key

- `setInvalidatedByBiometricEnrollment(boolean)` — **default `true`**. It applies only to keys that
  require user authentication with no positive validity duration, i.e. auth-per-use keys. Such keys
  are "irreversibly invalidated" when **a new biometric is enrolled or all enrolled biometrics are
  deleted**. Passing `false` keeps the key valid across enrolment changes. Source: the
  `KeyGenParameterSpec.Builder` javadoc / AOSP source above.
- Screen-lock removal is a separate and always-fatal condition, not governed by that flag.
  `KeyPermanentlyInvalidatedException` "Indicates that the key can no longer be used because it has
  been permanently invalidated." Documented triggers: the secure lock screen is disabled or
  reconfigured to a non-authenticating mode (None/Swipe); the secure lock screen is forcibly reset
  by a Device Admin; and, for auth-per-use keys, a new fingerprint enrolled or all fingerprints
  removed. It extends `InvalidKeyException`. Source:
  `https://developer.android.com/reference/android/security/keystore/KeyPermanentlyInvalidatedException`
  (verified against
  `https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/keystore/java/android/security/keystore/KeyPermanentlyInvalidatedException.java`)

### 3.3 What error surfaces

- `KeyPermanentlyInvalidatedException` — permanent. Recovery means re-enrolling the key and
  therefore re-wrapping whatever it protected. The exact throw site (conventionally `Cipher.init`)
  is **not stated verbatim** in the fetched javadoc; treat "thrown from `Cipher.init`" as
  unverified in wording, though it is an `InvalidKeyException` subclass and so surfaces at key-use
  initialisation.
- `UserNotAuthenticatedException` — transient. "Indicates that a cryptographic operation could not
  be performed because the user has not been authenticated recently enough." Recovery:
  "Authenticating the user will resolve this issue." Also extends `InvalidKeyException`. Source:
  `https://developer.android.com/reference/android/security/keystore/UserNotAuthenticatedException`
- The practical consequence: the two failures need different handling. One means "prompt and
  retry"; the other means "the wrapped key is gone forever, fall back to the master password."

### 3.4 StrongBox

- `setIsStrongBoxBacked(true)` "Sets whether this key should be protected by a StrongBox security
  chip." If the algorithm or key size is unsupported, "the framework will throw a
  `StrongBoxUnavailableException`," and the recommended fallback is to regenerate without the flag.
  Source: `https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec.Builder`
- `StrongBoxUnavailableException`: "Indicates that an operation could not be performed because the
  requested security hardware is not available." Source:
  `https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/keystore/java/android/security/keystore/StrongBoxUnavailableException.java`
- What StrongBox is: an environment "that has a discrete CPU, secure storage, a high quality true
  random number generator, tamper resistant packaging, and side channel resistance." Source:
  `https://source.android.com/docs/security/best-practices/hardware`
- Supported algorithms: RSA 2048; AES 128 and 256; ECDSA and ECDH P-256; HMAC-SHA256; Triple DES.
  StrongBox also supports key attestation. Source:
  `https://developer.android.com/privacy-and-security/keystore`
- CDD status: StrongBox is an optional second KeyMint instance, **STRONGLY_RECOMMENDED** rather than
  MUST as of the Android 13 CDD. Source:
  `https://android.googlesource.com/platform/compatibility/cdd/+/refs/heads/master-cuttlefish-testing-release/9_security-model/9_11_keys-and-credentials.md`.
  Re-verify against the current CDD before relying on it; this text changes per release.
- "Pixel 3 and later have StrongBox": **unverified** from an allowed primary domain.

### 3.5 Hardware binding and non-extractability

Google states the two guarantees separately, and the difference is the whole point:

- Process isolation, always: "Key material never enters the application process. ... If the app's
  process is compromised, the attacker might be able to use the app's keys but can't extract their
  key material ... to be used outside of the Android device."
- Hardware binding, when available: "Key material can be bound to the secure hardware of the Android
  device, such as the Trusted Execution Environment (TEE) or Secure Element (SE). When this feature
  is enabled for a key, its key material is never exposed outside of secure hardware."
- And the limit, stated bluntly: "If the Android OS is compromised or an attacker can read the
  device's internal storage, the attacker might be able to **use** any app's Android Keystore keys
  on the Android device, but it can't **extract** them from the device." (emphasis added)

Source for all three: `https://developer.android.com/privacy-and-security/keystore`

- `KeyInfo.isInsideSecureHardware()` is **deprecated**, "superseded by getSecurityLevel." Source:
  `https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/keystore/java/android/security/keystore/KeyInfo.java`.
  `getSecurityLevel()` returns `KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT`,
  `SECURITY_LEVEL_STRONGBOX`, `SECURITY_LEVEL_SOFTWARE` or `SECURITY_LEVEL_UNKNOWN`. The exact
  introduction API level (commonly cited as 31) is **unverified**; the developer guide says to use
  it "if your app targets Android 10 (API level 29) or higher."
- Key attestation "gives you more confidence that the keys you use in your app are stored in a
  device's hardware-backed keystore." A chain that validates to Google's root proves the key "is in
  hardware that Google believes to be secure" and "has the properties described in the attestation
  certificate," with `attestationSecurityLevel` of `TrustedEnvironment` or `StrongBox`. Validation
  must happen off-device: "Don't complete the following validation process on the same device."
  Source: `https://developer.android.com/privacy-and-security/security-key-attestation`

### 3.6 The contrast case on Android

- `androidx.security:security-crypto` (`EncryptedSharedPreferences`, `EncryptedFile`, `MasterKeys`)
  was **deprecated in 1.1.0-beta01, 2025-06-04**: "Deprecated all APIs in favour of existing
  platform APIs and direct use of Android Keystore." Source:
  `https://developer.android.com/jetpack/androidx/releases/security`
- Whether the default `MasterKey` (AES256_GCM) requires user authentication to read is
  **unverified by direct quote** — the reference pages could not be fetched with content. The
  default builder does not call `setUserAuthenticationRequired(true)`, which would place it in the
  handed-back column, but that is an inference, not a citation.
- `AccountManager.getAuthToken()` interaction requirements: **unverified**. No substantive reference
  content was retrievable.

---

## 4. iOS keychain access groups, App Groups, and `kSecAccessControl` for an AutoFill extension

### 4.1 The extension is a separate process with a separate container

"Extensions run in their own address space ... They are sandboxed like any other third-party app and
have a container separate from the containing app's container ... They don't have access to each
other's files or memory spaces." Source:
`https://support.apple.com/guide/security/supporting-extensions-secabd3504cd/web`

So nothing is shared implicitly. Sharing must be declared.

### 4.2 Keychain access groups

An app's access groups are exactly three things: "1) Strings in the app's `keychain-access-groups`
entitlement, 2) The app ID string (bundle identifier with team ID prefix), 3) Strings in the
`com.apple.security.application-groups` entitlement. For an app to access a keychain item, one of
the groups to which the app belongs must match the item's access group." Source:
`https://developer.apple.com/documentation/security/ksecattraccessgroup`

The entitlement itself holds "The identifiers for the keychain groups that the app may share items
with," and is configured through Xcode's Keychain Sharing capability. Source:
`https://developer.apple.com/documentation/bundleresources/entitlements/keychain-access-groups`

For a containing app and its AutoFill extension to share vault-wrapping material, both targets must
list the identical group string and be signed by the same team. Groups are namespaced by team ID
(the App ID prefix); the exact phrase "App ID prefix" was not re-quoted from a freshly fetched page,
so treat the wording — not the mechanism — as **unverified**.

`com.apple.token` / `kSecAttrAccessGroupToken` is "The access group containing items provided by
external tokens," i.e. CryptoTokenKit smart-card style credentials. It is a different, narrower
mechanism and is **not** the app-to-extension sharing path. Source:
`https://developer.apple.com/documentation/security/ksecattraccessgrouptoken` (the JSON data endpoint
404'd; content came from an indexed excerpt of the same official page — **medium confidence**).

### 4.3 App Groups versus keychain access groups versus `kSecAttrSynchronizable`

- An App Group gives a shared on-disk container, `UserDefaults(suiteName:)`, and IPC (Mach IPC,
  POSIX semaphores and shared memory, UNIX domain sockets). Source:
  `https://developer.apple.com/documentation/xcode/configuring-app-groups`
- It **also** works as a keychain access group: "An app group with an identifier starting with the
  `group.` prefix can be used as a Keychain Access Group, enabling apps to share keychain items with
  each other." Source:
  `https://support.apple.com/guide/security/app-protection-and-app-groups-sec1a976c067/web`
- `kSecAttrSynchronizable` is orthogonal: it controls iCloud Keychain sync, not local sharing.
  Synchronizable items **cannot** use `SecAccessRef`-based ACLs and **cannot** use a
  `kSecAttrAccessible` value ending in `ThisDeviceOnly`. Source:
  `https://developer.apple.com/documentation/security/ksecattrsynchronizable`

The last constraint is load-bearing: device binding and iCloud sync are mutually exclusive by
construction.

### 4.4 Accessibility classes — which are actually device-bound

| Constant | Migrates to a new device? |
|---|---|
| `kSecAttrAccessibleWhenUnlocked` (default) | Yes — "Items with this attribute migrate to a new device when using encrypted backups." |
| `kSecAttrAccessibleAfterFirstUnlock` | Yes — same wording. |
| `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` | No — "Items with this attribute do not migrate to a new device ... After restoring from a backup of a different device, these items will not be present." |
| `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly` | No — "Items with this attribute never migrate to a new device ... Disabling the device passcode causes all items in this class to be deleted." |

Source: `https://developer.apple.com/documentation/security/restricting-keychain-item-accessibility`
and the individual constant pages. Apple's own recommendation: "For extremely sensitive data never
stored in iCloud, use `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`." The Platform Security
guide corroborates that passcode-only items "Don't sync to iCloud Keychain," "Aren't backed up" and
"Aren't included in escrow keybags." Source:
`https://support.apple.com/guide/security/keychain-data-protection-secb0694df1a/web`

Only the `ThisDeviceOnly` variants are device-bound. Note the trade: passcode removal silently
deletes the item, which is an availability risk to design around.

### 4.5 `SecAccessControlCreateFlags`

| Flag | Documented behaviour | Prompts at use? |
|---|---|---|
| `.userPresence` | Equivalent to `biometryAny \| or \| devicePasscode`. "Biometry doesn't have to be available or enrolled. The item is still accessible by Touch ID even if fingers are added or removed, or by Face ID if the user is re-enrolled." | Yes |
| `.biometryAny` | Requires an enrolled biometric. "The item is still accessible by Touch ID if fingers are added or removed, or by Face ID if the user is re-enrolled." | Yes |
| `.biometryCurrentSet` | "**The item is invalidated if fingers are added or removed for Touch ID, or if the user re-enrolls for Face ID.**" | Yes |
| `.devicePasscode` | "Constraint to access an item with a passcode." | Yes |
| `.watch` | Locates a nearby paired Apple Watch running watchOS 6+. **Deprecated** in macOS 15 / Mac Catalyst 18, replaced by `.companion`. | Yes |
| `.and` / `.or` | "all constraints must be satisfied" / "at least one constraint must be satisfied". | Depends |
| `.applicationPassword` | Used with `kSecAttrAccessibleWhenPasscodeSet`; the system prompts for an app-specific password at creation and retrieval, and the item is unreadable without it. | Yes |
| `.privateKeyUsage` | Required to create and use a Secure Enclave key pair. "An attempt to use this constraint while generating a key pair outside the Secure Enclave fails. Similarly, an attempt to sign a block with a private key generated without this constraint inside the Secure Enclave fails." | No, by itself |

Source: `https://developer.apple.com/documentation/security/secaccesscontrolcreateflags` and each
per-case page.

`.biometryCurrentSet` is Apple's analogue of Android's `setInvalidatedByBiometricEnrollment(true)`.
`.biometryAny` and `.userPresence` are the analogues of setting it to `false`. Apple's default is the
permissive one — you must opt into `.biometryCurrentSet`; Android's default is the strict one.

---

## 5. Can an OS-launched credential-provider process do a biometric-gated unwrap with the containing app not running?

### 5.1 iOS and macOS — yes, but only on the interactive path

**Process launch.** "The system automatically launches extension processes as needed and manages
their lifetime." Communication is "between the extension and the app from which it was activated"
(the host app requesting autofill) "using interprocess communications mediated by the system
framework." Source:
`https://support.apple.com/guide/security/supporting-extensions-secabd3504cd/web`

No single Apple sentence was found that says in so many words "the containing app need not be
running." Treat that specific phrasing as **strongly implied by the documented process model, but
not verbatim-sourced**. What *is* verbatim-sourced is that the extension has its own address space
and its own container, and the system launches and manages it.

**The two paths, and which one can show a biometric prompt.**

1. `provideCredentialWithoutUserInteraction(for:)` — the fast path when the user taps a QuickType
   bar suggestion. Apple's discussion, quoted in full on the key points: "If your extension requires
   user interaction to provide the credential, **like when someone needs to unlock their credentials
   database**, call `cancelRequest(withError:)`. Use the error domain `ASExtensionErrorDomain`, and
   the code `ASExtensionError.Code.userInteractionRequired`." And decisively: "**As your view
   controller isn't presented while the system calls this method, don't show or use any user
   interface from this method.**" Source:
   `https://developer.apple.com/documentation/authenticationservices/ascredentialproviderviewcontroller/providecredentialwithoutuserinteraction(for:)-3mo23`
   → No Face ID or Touch ID prompt is possible here. A locked vault must decline with
   `.userInteractionRequired`. Apple names this exact scenario in the docs.
2. The interactive path. After that decline the system presents the extension's view controller;
   `prepareCredentialList(for:)` states "After calling this method, the system presents the view
   controller to the user." Source:
   `https://developer.apple.com/documentation/authenticationservices/ascredentialproviderviewcontroller/preparecredentiallist(for:)`.
   `prepareInterfaceToProvideCredential(for:)` is the equivalent entry for a single chosen
   credential. With a presented view controller the extension can run `LAContext` and
   Secure-Enclave-gated keychain reads in its own process.

**Entitlement.** `com.apple.developer.authentication-services.autofill-credential-provider` is
required on **both** the extension and its containing app. Source:
`https://developer.apple.com/documentation/AuthenticationServices/ASCredentialProviderViewController`

**Net for iOS/macOS:** the extension can do its own biometric-gated unwrap without the containing app
running — but only after it has declined the silent path. The silent path is unusable for a
zero-knowledge vault unless the unwrapping key is currently in a non-gated state.

### 5.2 Android — yes, and the service is bound on demand

**Two-phase model, quoted.** "Credential Manager interacts with credential providers in two phases:
1. The first phase is the begin/query phase whereby the system binds to credential provider services
and invokes `onBeginGetCredentialRequest()` ... providers must process these requests and respond
with `Begin…` responses, populating them with entries ... Each entry must have a `PendingIntent`
set. 2. Once the user selects an entry, the selection phase commences and the `PendingIntent`
associated with the entry gets fired, bringing up the corresponding provider activity." Source:
`https://developer.android.com/identity/sign-in/credential-provider`

So the provider's Activity does **not** need to be running. The system binds the service for phase
one and launches the Activity only after the user picks an entry. The service is declared with
`android:permission="android.permission.BIND_CREDENTIAL_PROVIDER_SERVICE"` and the
`android.service.credentials.CredentialProviderService` intent action. Source:
`https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/service/credentials/CredentialProviderService.java`

The older `AutofillService` behaves the same way and is even more explicit about impermanence: bound
only after the user enables it in Settings, lifecycle is bind → `onConnected()` →
`onFillRequest()`/`onSaveRequest()` → `onDisconnected()` → unbind, and "the service's process might
be killed by the Android System when unbound." Source:
`https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/service/autofill/AutofillService.java`

**Where the biometric prompt comes from.** Two mechanisms:

- Provider-driven: the provider's launched Activity shows a standard `BiometricPrompt`, bound to a
  `CryptoObject` for a Keystore-gated operation. Sample code on
  `https://developer.android.com/identity/sign-in/credential-provider`
- System-driven single-tap (Android 15): attach `BiometricPromptData` to a `CreateEntry` or
  `PublicKeyCredentialEntry` and the system itself shows the prompt inline, without launching the
  provider Activity. It carries `allowedAuthenticators` (defaulting to `DEVICE_WEAK` for creation
  and `BIOMETRIC_WEAK` for sign-in if unset) and an optional `cryptoObject`. Constraints: if the
  device is configured to use `DEVICE_CREDENTIALS` for a PIN or passcode, "the standard credential
  manager flow will be used instead of the single-tap flow" and the provider always receives a
  `null` `biometricPromptResult`; and sign-in single-tap is "enabled for single account scenarios
  only." Source: `https://developer.android.com/identity/sign-in/single-tap-biometric`.
  The precise API level (35) was not confirmed from a class javadoc; the "Android 15" framing is
  directly quoted.

**Process and UID.** Neither the `CredentialProviderService` nor the `AutofillService` javadoc
states this. The general Service contract does: "A service runs in the same process as the
application in which it is declared and in the main thread of that application by default." Source:
`https://developer.android.com/guide/components/services`. Since both are declared as ordinary
`<service>` components in the provider app's manifest, they run under the app's own UID and so reach
the app's own Keystore keys. This is a **reasoned inference from the general Service rule**, not a
statement in the credential-provider docs.

**Net for Android:** yes. The provider process is launched cold by the system, runs as the app's own
UID, and can drive a `BiometricPrompt` bound to a `CryptoObject` for a Keystore-gated unwrap — either
inside its own Activity, or via system-rendered `BiometricPromptData` on Android 15.

---

## Capability matrix

| Platform / primitive | Hardware binding | User presence enforced by OS | Key non-extractable | Invalidation triggers | Notes |
|---|---|---|---|---|---|
| **WebAuthn PRF** (platform authenticator) | Depends on the authenticator; not guaranteed by the spec | Yes — WebAuthn exposes only the user-verified PRF, so an output implies UV was performed | Yes — `CredRandom` never leaves the authenticator; only HMAC outputs are returned | Credential deletion or re-registration (new `CredRandom`). No spec-level rotation mechanism | 32-byte output. Windows Hello support **unverified** and evidence points to no. GPM support **unverified**. Works in Chrome ≥122 / Firefox ≥150 extension contexts in principle; `prf` specifically in an extension is **unverified**. Spec forbids relaying `prf.results` to a server |
| **Windows Hello** (`KeyCredential`) | TPM when present; **silent software fallback otherwise** unless policy forces hardware | Partly — `RequestSignAsync` prompts, but Entra/AD keys are "cached under lock" and usable without prompting while signed in | Yes when TPM-backed: "can't be exported"; MS Platform Crypto Provider "cannot be extracted, even by malicious software" | PIN reset (removes all keys encrypted with old key material); `certutil -deleteHelloContainer`; TPM lockout → PIN reset. Device reset **unverified** | RSA-2048 sign-only in the documented surface. `RequestDeriveSharedSecretAsync` exists from build 26100 but is **completely undocumented** — semantics unverified |
| **Windows DPAPI / PasswordVault / CredRead** | No | **No** — silent, gated only by the logon session token | No | n/a | The handed-back case. Desktop apps outside an AppContainer "can access all the user's lockers" |
| **Apple Secure Enclave** (iOS, Apple silicon / T2 Macs) | Yes | Yes when the key carries an access control object — "ACLs are evaluated inside the Secure Enclave" | Yes — keys are generated in-enclave, cannot be imported or exported | `.biometryCurrentSet`: any biometric enrolment change. `WhenPasscodeSetThisDeviceOnly`: passcode removal deletes the item | P-256 EC only. A symmetric vault key must be ECIES-wrapped, not stored |
| **Apple keychain, no access control** | No (software, class-key protected) | **No** — returned to any process in a matching access group while unlocked | No | Accessibility class transitions only | The handed-back case. Non-`ThisDeviceOnly` classes also migrate via encrypted backup |
| **Android Keystore, TEE-backed** | Yes | Yes with `setUserAuthenticationRequired(true)`; enforced below the app process | Extraction: yes. **Use: no** — "an attacker might be able to use any app's Keystore keys on the device, but it can't extract them" | New biometric enrolled or all removed (default `setInvalidatedByBiometricEnrollment(true)`); lock screen disabled or set to None/Swipe; Device Admin lock-screen reset | `KeyPermanentlyInvalidatedException` (permanent) vs `UserNotAuthenticatedException` (retry after auth) |
| **Android StrongBox** | Yes — discrete CPU, secure storage, tamper-resistant packaging, side-channel resistance | Same as TEE | Same as TEE, in stronger hardware | Same as TEE | `StrongBoxUnavailableException` when unsupported; app must fall back. RSA-2048, AES-128/256, ECDSA/ECDH P-256, HMAC-SHA256, 3DES only. CDD status STRONGLY_RECOMMENDED, not MUST |
| **Android software keystore** | No | Yes, but enforced only in the system process | Only by process isolation, not by hardware | Same as TEE | Distinguish with `KeyInfo.getSecurityLevel()`; `isInsideSecureHardware()` is deprecated |
| **Android EncryptedSharedPreferences** | Via the Keystore master key | **No** by default (inference — **unverified** by direct quote) | Master key yes; the plaintext preference value no | Master key invalidation | `androidx.security:security-crypto` **deprecated** 2025-06-04 in favour of direct Keystore use |
| **Linux Secret Service** | **No** — the spec has no notion of it | **No** — the spec "does not mandate any form of access control"; an unlocked collection serves any process on the session bus | **No** | Collection lock/unlock only | Transport crypto "not envisioned to withstand man in the middle attacks or other active attacks". libsecret TPM2 is optional, non-default, and applies to the *file* backend, not gnome-keyring |

---

## Explicit unverified list

1. Chrome's PRF shipping milestone. Chrome Platform Status records "Enabled by default" with every
   milestone field null. The widely cited M116 has no primary source.
2. Windows Hello platform-authenticator `hmac-secret` / PRF support. No Microsoft documentation
   asserts it. The KB5077181 claim circulating in secondary sources was checked and is false.
3. Android / Google Password Manager PRF support. No Google or Android primary document found.
4. Whether `prf` specifically works from an extension-claimed RP ID in Chrome or Firefox.
5. GPM PRF stability across synced devices. (The Apple side has an Apple engineer's statement of
   intent plus reports of real cross-version mismatches.)
6. Semantics of `KeyCredential.RequestDeriveSharedSecretAsync` — signature only, no documentation.
7. Semantics of `WebAuthNPluginPerformUserVerification` — one bullet only; the function reference
   page 404s.
8. Effect of a full Windows device reset on the Hello container.
9. gnome-keyring's on-disk format and default TPM posture — no primary gnome-keyring doc reachable.
10. A verbatim Apple sentence stating the containing app need not be running for an AutoFill
    extension. The process model implies it; the sentence was not found.
11. `EncryptedSharedPreferences` and `AccountManager` read-without-auth behaviour — no direct quote.
12. Exact `@since` API levels for `setUserAuthenticationParameters` (~30), `getSecurityLevel` (~31),
    `setIsStrongBoxBacked` (~28), `BiometricPromptData` (~35). Android's JS-rendered reference pages
    were unreliable; AOSP javadoc was used instead and carries no `@since` tags.
13. Legacy macOS file-based keychain ACL model versus the data-protection keychain.
14. `kSecAttrAccessGroupToken` page content — retrieved from an indexed excerpt, not a full fetch.
