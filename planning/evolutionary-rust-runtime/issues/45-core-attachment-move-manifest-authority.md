# Keep Attachment Move manifest authority inside Client Core

Type: task
Status: resolved
Blocked by: 24
Spec: ../spec.md#offline-create

## Delivered contract

Client Core owns the typed authenticated Attachment Move manifest PUT, bounded response decoding,
current Session, one-refresh recovery, and durable Session replacement before exact replay.
Manifest response capacity is 16 MiB; a valid multi-Attachment manifest must not hit a 64-KiB cap.

Preparation, dispatch, Bootstrap/Sync, reconciliation, Lock, and close share the Account execution
fence and central Session lifecycle. Renewed credentials carry into subsequent exchanges.
Busy/transient/second-401 answers preserve accepted work; host ports supply only binary streams.
Invocation URLs and signed credentials are never persisted or logged.

## Verification

Tests cover exact method/body/Account/Operation, valid large manifests, strict classifications,
durable refresh before replay, second 401, cross-Runtime duplicates, and same-Runtime serialization.
Both full CI gates passed. [Ticket 46](46-core-attachment-source-and-exclusive-lifecycle.md)
adds source-grant and cross-context lease ownership.
