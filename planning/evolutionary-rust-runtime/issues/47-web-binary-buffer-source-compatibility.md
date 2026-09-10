# Make the fixed Web binary executor compile in the production Worker graph

Type: task
Status: resolved
Blocked by:
Spec: ../spec.md#offline-create

## Delivered

Commit `86f684b7` copies exactly the viewed ciphertext bytes into an owned
`ArrayBuffer`-backed `Uint8Array` at the WebCrypto digest boundary. This resolves the dependent
Web DOM `BufferSource` mismatch without changing transfer bounds, ownership, retry, or credentials.

## Verification

Client Runtime and dependent Web type checks pass. Behavioral digest tests accept exact bytes
and reject same-length corruption; the MV3 Chromium transfer test passed under Xvfb.
