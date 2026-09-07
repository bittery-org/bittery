# Preserve Attachment uploader AAD through Move preparation

Type: task
Status: resolved
Blocked by: 24, 44
Spec: ../spec.md#replica-contract

## Delivered

Commit `4e185621` fixes shared-Attachment Move preparation to use the retained `uploaded_by`
identity for source and target blob AAD and authenticated publication identity. The User performing
the Move may differ from the uploader.

Target metadata uses that same uploader, and the rewrapped Attachment key binds the Server's
incremented envelope version `N + 1`. These companion changes landed in the parent Move slice.
Algorithms, formats, Attachment key, and accepted intent remain unchanged.

## Verification

The fixed vector authenticates a shared source and opens the target only under the original
uploader scope, rejecting mover scope. Existing format, corruption, restart, artifact, and retry
tests remain. Both full CI gates passed after [ticket 44](44-ticket-43-ci-gate-drift.md).
