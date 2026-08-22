# Accepted Operation discard

Type: grilling
Status: resolved
Blocked by: 05, 09

## Question

Choose whether a user may discard an accepted Operation whose Server outcome is still unknown.
Acceptance means the immutable request and optimistic effect are durable, and the Server may already
have committed the effect even when the response was lost.

Decide whether the first Runtime offers no per-Operation discard, offers a local-only discard with an
explicit ambiguity warning, or adds a Server cancellation protocol that races with execution.

## Evidence

- Removing the local Operation cannot undo an effect the Server may already have committed.
- A cancellation request needs its own atomic ordering against the original Operation and still
  cannot promise cancellation after the original outcome exists.
- Account removal is a broader intentional local-data action and does not need to masquerade as
  cancellation of an individual Server mutation.
- The first slice has no product requirement for abandoning one accepted Login-Item creation.

## Answer

The first Runtime offers no per-Operation discard after durable acceptance. An Operation with an
unknown Server outcome remains visible and pending until the Server returns its retained semantic
outcome.

Removing an Account from the Device remains a separate, explicit Account-lifecycle action. It may
delete that Account's local Replica and Operations, but the UI and implementation must not describe
it as cancellation or imply that it reverses a Server effect. A future per-Operation cancellation
feature requires its own Server ordering protocol and product decision.
