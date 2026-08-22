# Traceability

Every release-blocking behavior must form this chain:

```text
current evidence or new product need
  -> candidate/accepted decision
  -> target requirement
  -> behavioral scenario
  -> implementation test
  -> release evidence
```

## Initial examples

| Evidence or need | Decision | Requirement | Scenario | Test |
| --- | --- | --- | --- | --- |
| Current local queue and optimistic projection | Rust engine owns durable operations | `SYNC-001`, `SYNC-004` | [Seed 1](scenarios/01-offline-operation-acceptance.yaml) | OPEN |
| Duplicate delivery and lost responses | Account-lifetime canonical outcomes make retries exactly once | `SYNC-004`, `ARCH-SERVER-001` | [Seed 2](scenarios/02-duplicate-operation-delivery.yaml), [Seed 3](scenarios/03-lost-operation-response.yaml) | OPEN |
| Current sealed ciphertext cannot safely rebase | Preserve explicit conflict copy | `ITEM-004` | Seed 4 | OPEN |
| Current staged bootstrap | Promote one complete remote base without merging the local overlay | `ARCH-STORE-017`, `SYNC-001` | [Seed 5](scenarios/05-interrupted-bootstrap.yaml) | OPEN |
| Finite Delta retention and old offline Devices | Account stream expiry bootstraps safely; signed Deletion Fences outlive Item content | `SYNC-006`–`SYNC-009`, `ITEM-006` | [Seed 5](scenarios/05-interrupted-bootstrap.yaml), [Seed 8](scenarios/08-offline-device-permanent-deletion.yaml) | OPEN |
| Self-hosted zero-knowledge administration | Admin cannot decrypt/impersonate | `ADMIN-001` | OPEN | OPEN |
| Current Share fragment-key design | Preserve zero-knowledge snapshot link | `SHARE-001` | OPEN | OPEN |
| Platform keys can be invalidated without Account loss | Fail closed to password quick unlock and explicit re-enrollment | `ARCH-STORE-011`, `AUTH-043` | Seed 11 | OPEN |
| Browser runtime termination | Drop live keys while a storage commit remains all-old or all-new | `ARCH-STORE-014`, `ARCH-STORE-016`, `ARCH-STORE-018` | [Seed 10](scenarios/10-runtime-termination.yaml) | OPEN |
| OS-launched mobile Provider must fill and save without the main host | Full Account keys stay in an independent constrained core over one guarded Replica | `ARCH-ENGINE-007`–`ARCH-ENGINE-013`, `ARCH-STORE-027`, `AUTH-045`–`AUTH-048`, `ITEM-007` | [Seed 16](scenarios/13-credential-provider-save.yaml) | OPEN |
| Encrypted Item fields must remain searchable and matchable offline | Persist opaque Account-local Search Snapshots and a separately Device-protected bounded Suggestion Snapshot | `PRIVACY-018`, `ITEM-008`, `ITEM-009`, `OFFLINE-004`, `ARCH-STORE-028`–`ARCH-STORE-031`, `TRAVEL-002` | OPEN in conformance-corpus ticket | OPEN |

This table is deliberately incomplete. Completion requires every `MUST` requirement to link to at
least one accepted scenario and automated test.
