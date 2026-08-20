# Platform authenticator and PRF support matrix

Type: research
Status: resolved
Blocked by: none

## Question

Establish what device-bound unlock capability each target platform actually offers today.

Required facts:

- WebAuthn PRF extension: browser and platform-authenticator support matrix, whether it works inside an extension context, and whether the derived secret is stable across credential re-registration.
- Windows Hello, macOS Keychain and Secure Enclave, and Linux Secret Service: what each guarantees about user presence, hardware binding, and key non-extractability, and how those differ from an ordinary keychain read.
- Android Keystore `setUserAuthenticationRequired` and `StrongBox`, plus what invalidates a key (biometric enrolment change, screen-lock removal) and what error surfaces when it does.
- iOS Keychain access groups, App Groups, and `kSecAccessControl` flags relevant to an AutoFill extension in a separate process.
- Whether an OS-launched credential-provider process on iOS and Android can perform a biometric-gated unwrap without the containing app running.

Write findings to `planning/greenfield-decision-map/research/platform-authenticators.md`. Facts only, with source URLs and retrieval dates.

## Answer

Findings: [`research/platform-authenticators.md`](../research/platform-authenticators.md), with a
capability matrix and an explicit unverified list. Retrieved 2026-08-20.

The result guts WebAuthn PRF as a browser quick-unlock baseline, and it splits the desktop platforms
into three genuinely different capability levels rather than one.

- **PRF is dead on Windows and unproven on Android.** No Microsoft document asserts that Windows Hello
  implements `hmac-secret`; a 2024 feature request got a non-answer, and the widely repeated claim
  that KB5077181 added it is false. That KB was fetched and mentions no WebAuthn content at all. No
  Google primary source confirms PRF for Google Password Manager either. **Apple (Safari 18+, iOS 18+)
  is the only confirmed platform authenticator.**
- **PRF does not survive credential re-registration.** CTAP generates a fresh `CredRandom` per
  `authenticatorMakeCredential`, so a re-registered passkey yields a different secret. Cross-device
  sync is *intended* to be stable, per an Apple engineer statement, but has documented real-world
  version-skew failures.
- **PRF in an extension context is unverified.** Chrome 122+ and Firefox 150+ let extensions claim RP
  IDs, but no primary source confirms `prf` works over that path, and `clientDataJSON.origin` becomes
  the extension origin.
- **Linux has no gated-key primitive at all.** The Secret Service specification states outright that
  it "does not mandate any form of access control". An unlocked login keyring serves any process on
  the session bus, and the spec contains no hardware binding anywhere.
- **Windows Hello is sign-only, and its prompt is conditional.** `KeyCredential` exposes no documented
  unwrap. The newer `RequestDeriveSharedSecretAsync` (build 26100+) ships with zero documentation.
  Entra and AD keys are cached under lock and usable without prompting.
- **Both mobile credential providers can perform a cold biometric-gated unwrap.** Android binds the
  service on demand under the app's own UID; iOS launches the extension in its own process. But
  `provideCredentialWithoutUserInteraction` forbids any UI, so a locked vault must decline with
  `.userInteractionRequired` and wait for the interactive path. Direct input to ticket 13.
- **Invalidation defaults point in opposite directions.** Android invalidates on biometric enrolment
  change by default; Apple requires opting into `.biometryCurrentSet` to get the same behaviour.

This ticket surfaced facts and decided nothing. Ticket 12 owns the Device Unlock Wrapper decision and
ticket 13 owns credential-provider key access.
