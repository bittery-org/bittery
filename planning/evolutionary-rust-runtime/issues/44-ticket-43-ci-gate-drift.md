# Repair the clean-tree CI drift blocking Ticket 43

Type: task
Status: resolved
Blocked by: 24
Spec: ../spec.md#end-to-end

## Delivered

Repaired three integration drifts blocking ticket 43:

- The transitional Sync Move request sends the required `mode: "prepared"` with its existing
  attachment-free shape. Attachment-bearing work is not silently represented as an empty Move.
- Server and Desktop Cargo lockfiles reflect crypto-core's already-declared `aes`, `ghash`,
  and `zeroize` dependency edges. No versions or manifests changed.

## Verification

The behavioral Sync request test and dependent types pass. Server/Desktop locked Cargo checks
pass without rewriting lockfiles. Both full repository gates passed without tracked-file drift.
Transitional modules remain only while other hosts still need them; ticket 58 removes Web reachability.
