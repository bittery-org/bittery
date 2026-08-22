# Runtime Account ownership

Type: grilling
Status: resolved
Blocked by: 03

## Question

Choose whether one process-wide `ClientRuntime` owns several independent Account modules or each
Account receives a separate external Runtime instance. Existing clients support several Accounts on
one Device, while Active account is only a UI pointer.

The first acceptance scenario still exercises one Account. This decision fixes the durable Account
catalog, lock isolation, observation scope, scheduling ownership, and the shape later used by Desktop,
Extension, Android, iOS, and credential providers.

## Evidence

- The typed Runtime protocol already carries explicit Account scope and does not require an implicit
  Active account.
- Current clients keep several Accounts but distribute their lifecycle across AccountStore,
  AccountSessionManager, per-Account replicas, and host providers.
- One external Runtime per Account simplifies local ownership but makes Device-wide lock, shared
  background scheduling, and host observation a coordination problem again.
- A process-wide Runtime can contain independent per-Account modules so corruption or failure in one
  Account does not prevent another from opening.

## Answer

One process-wide `ClientRuntime` owns the Device Account catalog and shared scheduling. Each Account
is an isolated internal module with its own Replica, live keys, Operations, observations, and failure
state. Active account remains a UI pointer and never supplies implicit Runtime scope. The first
acceptance scenario proves one Account without changing the external or durable ownership model.
