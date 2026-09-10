# Keep Attachment source grants and exclusive lifecycle inside Client Core

Type: task
Status: resolved
Blocked by: 24, 45
Spec: ../spec.md#offline-create

## Delivered contract

The existing authenticated Attachment download-grant route returns comparable source authority:
Attachment, Item, Vault, storage key, envelope version, uploader, metadata, and byte bounds.
Core validates it against the accepted Move source before passing only invocation URL, headers,
and bounded binary primitives to the host.

- Only exact 200 supplies a grant. A 404 or authority mismatch is a non-outcome stale-preparation
  signal. Only Move finalization may prove and retain `attachment_state_conflict`.
- One 401 uses central durable Session renewal and one replay. 403, rate limits, network/Server
  failure, and overflow preserve retry; malformed success authority is an invariant failure.
- Each scan/transcrypt pass obtains a fresh exact source grant. URLs remain ephemeral.
- Core holds a primitive per-Account host lease and its execution fence across live-reference
  derivation, orphan sweep, and preparation. Every newly leased drive sweeps again.
- Lease loss cancels sweep/drive. Candidate rotation prevents one contended Account from starving
  others. Lock, close, restart, and repeated lease/sweep failure never discard accepted work.
  The host receives neither the live set nor sweep policy.

## Verification

Delivered in `d64825bd`, `3210f1b8`, `f0e15789`, and `af3144e0`.
Server grant/contract tests, Core transport and renewal tests, lease-loss/fairness/handoff histories,
and both full CI gates passed. Authenticated browser composition was later proved in
[ticket 28](28-remaining-item-write-kinds.md#attachment-move).
