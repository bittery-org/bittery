# Runtime Account ownership

Type: grilling
Status: resolved
Blocked by: 03

## Question

Does one process-wide Runtime own the Device catalog or does each Account get an external Runtime?

## Answer

One process-wide `ClientRuntime` owns the Device Account catalog and shared scheduling. Each Account
is an isolated internal module with its own Replica, live keys, Operations, observations, and failure
state. Active account remains a UI pointer and never supplies implicit Runtime scope. The first
acceptance scenario proves one Account without changing the external or durable ownership model.
