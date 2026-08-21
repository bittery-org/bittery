# Key-derivation profile benchmark

Measured: 2026-08-21

## Purpose

Check that candidate profile `0x01` can allocate and execute through the intended pure-Rust and
Rust-to-WASM path before freezing its bytes. This is a feasibility measurement, not the release
baseline and not a user-visible performance budget.

The candidate follows the [RFC 9106 memory-constrained recommendation](https://www.rfc-editor.org/rfc/rfc9106.html#section-4):
Argon2id version `0x13`, 65,536 KiB, three passes, and four lanes. It uses the 16 all-zero salt and
`T = Nh` shape from [RFC 9807's ristretto255/SHA-512 configuration](https://www.rfc-editor.org/rfc/rfc9807.html#section-7),
so the output is 64 bytes and the optional secret and associated data are absent.

## Method

A throwaway Rust crate used RustCrypto `argon2` 0.5.3 and `wasm-bindgen` 0.2.127. The same function
ran as an optimized native binary and as `wasm32-unknown-unknown` produced by wasm-pack in release
mode with its Node target. The WASM module ran in Node's WebAssembly runtime because the collaborative
browser preview was unavailable after both status and open attempts.

Environment:

- Linux x86-64 KVM guest, eight presented AMD EPYC 9645 vCPUs, 128 MiB shared L3 cache.
- Rust 1.97.1 and Cargo 1.97.1.
- Node 24.18.1 and wasm-pack 0.13.1.
- Optimized release builds; no browser, extension worker, constrained memory container, or low-end
  physical Device was measured.

Each call used the ASCII test password `correct horse battery staple`, a 16-byte zero salt, 65,536
KiB, three passes, and a 64-byte output. One lane was measured only as a rejected comparison. Repeated
WASM samples ran both lane counts in fresh processes and three calls per process; later calls reuse the
grown WASM memory.

## Results

| Build | Lanes | Observed elapsed time | Result |
| --- | ---: | ---: | --- |
| Native Rust | 1 | 117.5 ms | completed |
| Native Rust | 4 | 118.1 ms | completed |
| Node WASM | 1 | 185.6–307.7 ms | completed in all 6 recorded calls |
| Node WASM | 4 | 182.0–244.8 ms | completed in all 6 recorded calls |

The lane count changes the Argon2 output as expected. Four lanes did not impose a consistent penalty
in this single-threaded WASM execution, so the measurement supplies no reason to depart from RFC 9106's
four-lane recommendation.

## Limits and release gate

This host is not the weakest supported client, Node is not Chromium or Firefox, the sample is small,
and peak resident memory was not instrumented. The results prove only that a pure-Rust WASM module can
grow enough memory and complete this profile in the available environment.

Before release, the same positive and negative vectors must run repeatedly in Rust and WASM on the
approved low-end baseline for every supported full-sign-in client, including Chromium and Firefox.
The gate is successful allocation and correct completion. It records elapsed time and peak memory but
sets no cryptographic wall-clock threshold; the performance-budget decision owns user-visible limits.
A capability failure reopens either profile `0x01` or the claimed platform baseline rather than
silently reducing parameters.
