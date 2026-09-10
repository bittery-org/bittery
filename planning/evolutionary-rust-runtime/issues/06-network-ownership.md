# Runtime and host network ownership

Type: grilling
Status: resolved
Blocked by: 03, 05

## Question

Who owns request construction, authentication, response interpretation, and retry?

## Answer

Rust owns typed Server request construction, immutable request bytes and fingerprints, retry
classification, semantic outcome interpretation, and Session creation and renewal. Internal
production and in-memory transport adapters execute Rust's HTTP requests and SSE wakeups but do not
manage authentication state.
