# Server domain services own their SQL; there is no repository tier

`5eec0c71` deleted `repo/auth.rs`, `repo/team.rs`, `repo/vault.rs` and `repo/waitlist.rs`
and inlined their queries into `services/auth.rs`, `services/team.rs`, `services/vault.rs`
and `services/waitlist.rs` (−1031/+701 lines). The stated reason was to put DB access next
to its call site and drop the indirection hop between a rule and the query that enforces it.
What survives in `repo/` is what is genuinely shared or cross-cutting — `common`
(`generate_resource_id`, `hash_token`, `insert_audit_event`, `insert_sync_event`) plus
`access`, `audit`, `billing`, `share`, `sync` and `travel_mode` — and that asymmetry is the
intended end state, not an unfinished migration.

**Consequences.** Domain services have no seam to substitute, so their tests run against a
live Postgres (`test_support::with_raw_test_db` / `with_rpc_test_app`) and are attached
in-module via `#[cfg(test)] #[path = "auth_tests.rs"] mod tests;` so they can reach private
helpers. Reintroducing a repository tier to enable mock-based unit tests would be a
re-litigation of this decision, not a fix.
