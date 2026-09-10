# Accepted Operation discard

Type: grilling
Status: resolved
Blocked by: 05, 09

## Question

May the first Runtime discard one accepted Operation whose Server outcome is unknown?

## Answer

The first Runtime offers no per-Operation discard after durable acceptance. An Operation with an
unknown Server outcome remains visible and pending until the Server returns its retained semantic
outcome.

Removing an Account from the Device remains a separate, explicit Account-lifecycle action. It may
delete that Account's local Replica and Operations, but the UI and implementation must not describe
it as cancellation or imply that it reverses a Server effect. A future per-Operation cancellation
feature requires its own Server ordering protocol and product decision.
