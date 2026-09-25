# Extension production acceptance

Type: task
Status: needs-triage
Blocked by: 76
Spec: ../desktop-extension/spec.md

## Contract

Run release-build real Chromium Extension acceptance, including all ticket 41 lifecycle distinctions, actual native messaging to accepted Desktop, autofill and passkeys. Independently review and simplify the complete accumulated Extension change.

Ticket106 supplies the Chrome-specific source/admission capability after Desktop acceptance73.
This ticket retains actual populated Chrome upgrade, browser restart, surviving-owner broker
reattachment and Worker/document-owner-loss acceptance. Moving the source adapter out of91 removes
the delivery cycle without removing any of those production obligations.

## Acceptance

Record actual browser/OS/revision and every scenario from spec. Include pending work during owner loss, reconnect convergence, multi-Account isolation, lock/disconnect/revocation races, teardown and restart. Run targeted checks and both full root checks. Chrome minimum API compatibility is distinct from the tested browser version; Firefox/Safari remain unclaimed.

## Comments

2026-09-08: dependency-ordered delivery scope recorded. No implementation or acceptance is claimed.
