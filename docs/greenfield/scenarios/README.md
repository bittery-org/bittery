# Behavioral scenarios

Scenarios are executable specifications shared by native Rust, WASM, Swift bindings, Kotlin bindings,
and Server/adapter integration tests. Host-independent semantics live in one corpus. Physical failure
claims are mandatory profiles of that corpus: `native-crash-durable` and `browser-transactional` add
different recovery cases without changing the shared Domain state or meanings.

Each scenario contains:

```yaml
id: SYNC-OFFLINE-004
requirements: [SYNC-001, SYNC-004]
given:
  replica: ...
  keys_and_session: ...
  server: ...
  operation_log: ...
  cursor: ...
  clock: ...
  connectivity: ...
when:
  - at: ...
    command_or_event: ...
  - inject_failure: ...
then:
  visible_projection: ...
  durable_replica: ...
  operation_state: ...
  server_state: ...
  emitted_events: ...
```

## Seed scenarios required before implementation

1. [Offline Item edit survives termination before any network request.](01-offline-operation-acceptance.yaml)
2. [Duplicate command delivery commits exactly once.](02-duplicate-operation-delivery.yaml)
3. [Server commit followed by lost response becomes a recoverable indeterminate operation.](03-lost-operation-response.yaml)
4. Concurrent encrypted edits preserve one accepted revision and one Conflict copy.
5. [Interrupted bootstrap never replaces the last usable local generation.](05-interrupted-bootstrap.yaml)
6. Session revocation learned after offline use locks and removes local authorization material.
7. Member departure creates a non-expiring rotation requirement, survives initiator termination,
   blocks affected Vault writes until one atomic epoch cutover, and leaves unrelated Vaults usable.
8. Old offline Device cannot resurrect a permanently deleted Item.
9. Cross-Server copy succeeds before optional source deletion is offered.
10. [Browser Worker or extension background termination loses live keys without corrupting durable
    state.](10-runtime-termination.yaml)
11. Permanent platform-anchor invalidation rejects platform quick unlock, removes only that platform
    record, preserves the encrypted replica and password wrapper, and lets one successful password
    quick unlock explicitly create a replacement without losing the Account.
12. Backup/restore preserves Server identity and existing authentication records.
13. A still-authorized Device reconnects with a queued operation under a superseded Vault epoch,
    fetches the new grant, re-seals the same signed revision, and commits no Conflict copy.
14. A Device that exhausts its reserved Vault-envelope block while offline remains readable but
    accepts no further durable mutation until it obtains a new block or completes rotation online.
15. [Browser Origin loss removes the whole Replica and never masquerades as partial recovery, while
    Bittery-controlled deletion guards Unsynced operations.](16-browser-origin-loss.yaml)
16. [A locked Credential Provider previews only approved fields, unlocks its own core, commits a new
    Login beside a concurrent main-host write, terminates before Sync, and leaves the main host to
    synchronize the exact durable operation.](13-credential-provider-save.yaml)

Unlinked seed scenarios remain OPEN until a dedicated grilling session resolves their complete
expected state. A linked scenario is the accepted seed and may be refined by its downstream owning
ticket without weakening an invariant already named there.
