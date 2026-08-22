# Runtime and host network ownership

Type: grilling
Status: resolved
Blocked by: 03, 05

## Question

Choose which side constructs Server requests, interprets semantic outcomes, and owns retry policy for
the first post-login Web slice. The current TypeScript login and Session renewal remain available,
while Rust must preserve immutable Operation bytes and exactly-once reconciliation.

Decide whether Rust owns typed request construction and interpretation behind a narrow host transport
adapter, the host continues using generated API calls on Rust's behalf, or Rust immediately absorbs
the full HTTP and Session renewal implementation.

## Evidence

- Host-owned generated calls would require TypeScript, Kotlin, and Swift to reproduce request
  fingerprints, retry classes, and outcome interpretation.
- Moving full Session renewal into Rust now would widen the post-login slice back into authentication
  and Account lifecycle.
- Browser Fetch/SSE and native HTTP stacks vary, so production and in-memory transport adapters form a
  real internal seam even when Rust owns protocol behavior.

## Answer

Rust owns typed Server request construction, immutable request bytes and fingerprints, retry
classification, semantic outcome interpretation, and Session creation and renewal. Internal
production and in-memory transport adapters execute Rust's HTTP requests and SSE wakeups but do not
manage authentication state. This revision follows the maintainer's decision to move login directly
into Rust in the first slice.

## Comments

The initial answer left Session renewal in the Web adapter because the first slice began after login.
When the maintainer moved login into Rust, Session renewal moved with it; leaving renewal in the host
would recreate the split the revised slice removes.
