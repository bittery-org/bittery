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
| Current local queue and optimistic projection | Rust engine owns durable operations | `SYNC-001` | Seed 1 | OPEN |
| Current sealed ciphertext cannot safely rebase | Preserve explicit conflict copy | `ITEM-004` | Seed 4 | OPEN |
| Current staged bootstrap | Preserve atomic promotion | `SYNC-001` | Seed 5 | OPEN |
| Self-hosted zero-knowledge administration | Admin cannot decrypt/impersonate | `ADMIN-001` | OPEN | OPEN |
| Current Share fragment-key design | Preserve zero-knowledge snapshot link | `SHARE-001` | OPEN | OPEN |
| Native credential-provider requirement | Constrained runtime per process | `ARCH-ENGINE-002` | Seed 11 | OPEN |

This table is deliberately incomplete. Completion requires every `MUST` requirement to link to at
least one accepted scenario and automated test.

