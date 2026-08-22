# Web cutover and replaced-path cleanup

Type: task
Status: ready-for-agent
Blocked by: 21
Spec: ../spec.md#web-cutover

## Outcome

Make the Rust Runtime the only active Web owner for the first-slice paths and remove Web-specific
transitional orchestration without breaking Desktop or Extension.

## Work

- Switch the Web composition root, providers, Sign-in, Items projection, Sync ownership, and create
  flow completely to Runtime.
- Prove no Account can activate both transitional and Runtime writers.
- Delete Web-only providers/hooks/adapters and dead branches replaced by the Runtime.
- Retain shared TypeScript modules still imported by Desktop/Extension and label their ownership in
  the next-host tickets rather than wrapping them as permanent compatibility.
- Update architecture docs, diagrams, generated-file instructions, and checks.

## Verification

Web unit, integration, offline, and end-to-end suites pass on the Runtime path; a dependency/import
audit finds no Web reachability into replaced TS auth/Replica/Sync mutation owners. `pnpm check:ci`
and `pnpm check:ci:rust` pass.
