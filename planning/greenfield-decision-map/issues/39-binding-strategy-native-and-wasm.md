# Binding strategy across native and WASM

Type: prototype
Status: ready-for-human
Blocked by: 38

## Question

The weakest link in the stack as currently specified. `bittery-bindings` promises "UniFFI and WASM projection", but UniFFI ships **no first-party WASM generator**: the Rust-side feature is literally named `wasm-unstable-single-threaded` and is documented as "likely to change or go away completely". The usual pairing, `uniffi-bindgen-react-native`, says in its own docs that it "should not yet be used in production" and is maintained by one person outside Mozilla. UniFFI also has **no cancellation** and **no stream primitive**, which is exactly what `ARCH-ENGINE-006` observation needs. See [library maturity](../research/library-maturity.md), which recommends prototyping this before committing the architecture.

Build the spike: one Rust interface, driven from a browser Worker and from at least one native binding, exercising an async command, an observation stream, and a cancellation.

Decide from the result:

- Whether UniFFI serves both, or whether the browser gets a hand-written `wasm-bindgen` shim at the cost of one duplicated interface.
- How observation crosses the boundary, given no stream primitive exists.
- How cancellation is expressed, given none exists.
- Whether `uniffi-bindgen-js` is a credible second option.
- What the fixture corpus has to run against, if the bindings diverge.

Produces: a prototype under `planning/greenfield-decision-map/prototypes/`, a `bittery-bindings` decision, and an ADR.
