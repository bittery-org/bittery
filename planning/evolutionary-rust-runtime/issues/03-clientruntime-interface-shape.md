# ClientRuntime interface shape

Type: grilling
Status: resolved
Blocked by: 02

## Question

Choose the external `ClientRuntime` interface shape shared by the Web Worker and later native
bindings. It must hide Replica, queue, Cursor, Bootstrap, crypto ordering, retry, and reconciliation;
accepted durable work must survive caller loss.

Compare a three-entry first-slice interface with implicit Account/Vault scope, a Web-oriented method
surface, and a closed typed request/observation protocol with explicit Account scope and thin
host-specific convenience adapters.

## Evidence

Three independent designs agree that the Runtime must publish coherent immutable projections and
must return command acceptance only after operation plus optimistic effect commit atomically. They
also agree that cancellation stops waiting or observation, never an already accepted Operation.

- A minimal `open`/`observe`/`submit` interface maximizes immediate Depth but bakes first-slice
  single-Account and personal-Vault assumptions into the external seam.
- A Web-oriented `open`/`snapshot`/`subscribe`/`commit`/`retrySync` surface minimizes React adapter
  work but exposes host-oriented control and is less neutral for Compose, SwiftUI, and providers.
- A typed `request`/`observe`/`close` protocol keeps Account, command, projection, and audience
  families explicit and binding-stable, but needs discipline to avoid becoming a generic dispatcher.

## Answer

The external Runtime seam is a closed typed protocol with `request`, `observe`, and `close`. The first
slice implements only the Sign-in, Login-Item creation, Items projection, and Runtime-status variants
it needs. Account scope is explicit wherever an Account already exists; Sign-in returns the new
Account identity. Host-specific TypeScript, Kotlin, and Swift adapters may expose convenient methods
but add no Domain, Replica, authentication, or Sync behavior. Cancellation stops waiting or
observation and never cancels an accepted durable Operation.
