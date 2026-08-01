//! Known-answer test vectors for the SRP-6a implementation.
//!
//! # Provenance
//!
//! The fixed inputs (`I`, `p`, `s`, `a`, `b`) and the expected `x`, `k`, `v`,
//! `A`, `B`, `u` and premaster secret `S` are copied verbatim from **RFC 5054
//! Appendix B** (1024-bit group from Appendix A, SHA-1). They are therefore
//! independent of this codebase: if a `num-bigint` upgrade, a padding change or
//! a hash-input reordering silently altered the arithmetic on *both* sides of
//! the protocol, the roundtrip tests would still pass but these would not.
//!
//! This implementation follows RFC 5054 exactly for those quantities:
//!
//! ```text
//! x = H(s | H(I | ":" | p))
//! k = H(N | PAD(g))
//! v = g^x mod N
//! A = g^a mod N
//! B = (k*v + g^b) mod N
//! u = H(PAD(A) | PAD(B))
//! S = (B - k * g^x)^(a + u*x) mod N   [client]
//! S = (A * v^u)^b mod N               [server]
//! ```
//!
//! RFC 5054 stops at the premaster secret, because TLS-SRP feeds `S` straight
//! into the TLS PRF and never computes a session key or proofs. The session key
//! and the two proofs therefore come from **RFC 2945 section 3**, with `H(S)`
//! in place of RFC 2945's SHA-interleave (the widespread SRP-6a convention this
//! implementation uses):
//!
//! ```text
//! K  = H(PAD(S))
//! M1 = H(H(N) xor H(PAD(g)), H(I), s, PAD(A), PAD(B), K)
//! M2 = H(PAD(A), M1, K)
//! ```
//!
//! `K`, `M1` and `M2` were computed by an independent Python script written
//! from those formulas, not by running this crate. The same script re-derives
//! every RFC 5054 quantity above and asserts it against the RFC's printed
//! values, so the padding and ordering conventions it used for `K`/`M1`/`M2`
//! are the ones the RFC vectors already validated.
//!
//! Note that `K` begins with a zero byte (`01 7e ef ...`). Any regression that
//! dropped the leading-zero padding when re-encoding hash outputs would change
//! `M1` and `M2`, so these vectors also pin the padding behaviour.

/// RFC 5054 Appendix B: salt `s` (16 bytes).
pub(super) const SALT: &str = "beb25379d1a8581eb5a727673a2441ee";

/// RFC 5054 Appendix B: identity `I`.
pub(super) const USERNAME: &str = "alice";

/// RFC 5054 Appendix B: password `p`.
pub(super) const PASSWORD: &str = "password123";

/// RFC 5054 Appendix B: `x = SHA1(s | SHA1(I | ":" | p))`.
pub(super) const X: &str = "94b7555aabe9127cc58ccf4993db6cf84d16c124";

/// RFC 5054 Appendix B: `k = SHA1(N | PAD(g))`.
pub(super) const K_MULTIPLIER: &str = "7556aa045aef2cdd07abaf0f665c3e818913186f";

/// RFC 5054 Appendix B: `u = SHA1(PAD(A) | PAD(B))`.
pub(super) const U: &str = "ce38b9593487da98554ed47d70a7ae5f462ef019";

/// RFC 5054 Appendix B: verifier `v = g^x mod N`.
pub(super) const VERIFIER: &str = concat!(
    "7e273de8696ffc4f4e337d05b4b375beb0dde1569e8fa00a9886d8129bada1f1",
    "822223ca1a605b530e379ba4729fdc59f105b4787e5186f5c671085a1447b52a",
    "48cf1970b4fb6f8400bbf4cebfbb168152e08ab5ea53d15c1aff87b2b9da6e04",
    "e058ad51cc72bfc9033b564e26480d78e955a5e29e7ab245db2be315e2099afb",
);

/// RFC 5054 Appendix B: client secret ephemeral `a`.
pub(super) const CLIENT_SECRET: &str =
    "60975527035cf2ad1989806f0407210bc81edc04e2762a56afd529ddda2d4393";

/// RFC 5054 Appendix B: client public ephemeral `A = g^a mod N`.
pub(super) const CLIENT_PUBLIC: &str = concat!(
    "61d5e490f6f1b79547b0704c436f523dd0e560f0c64115bb72557ec44352e890",
    "3211c04692272d8b2d1a5358a2cf1b6e0bfcf99f921530ec8e39356179eae45e",
    "42ba92aeaced825171e1e8b9af6d9c03e1327f44be087ef06530e69f66615261",
    "eef54073ca11cf5858f0edfdfe15efeab349ef5d76988a3672fac47b0769447b",
);

/// RFC 5054 Appendix B: server secret ephemeral `b`.
pub(super) const SERVER_SECRET: &str =
    "e487cb59d31ac550471e81f00f6928e01dda08e974a004f49e61f5d105284d20";

/// RFC 5054 Appendix B: server public ephemeral `B = (k*v + g^b) mod N`.
pub(super) const SERVER_PUBLIC: &str = concat!(
    "bd0c61512c692c0cb6d041fa01bb152d4916a1e77af46ae105393011baf38964",
    "dc46a0670dd125b95a981652236f99d9b681cbf87837ec996c6da04453728610",
    "d0c6ddb58b318885d7d82c7f8deb75ce7bd4fbaa37089e6f9c6059f388838e7a",
    "00030b331eb76840910440b1b27aaeaeeb4012b7d7665238a8e3fb004b117b58",
);

/// RFC 5054 Appendix B: premaster secret `S`, identical on both sides.
pub(super) const PREMASTER_SECRET: &str = concat!(
    "b0dc82babcf30674ae450c0287745e7990a3381f63b387aaf271a10d233861e3",
    "59b48220f7c4693c9ae12b0a6f67809f0876e2d013800d6c41bb59b6d5979b5c",
    "00a172b4a2a5903a0bdcaf8a709585eb2afafa8f3499b200210dcc1f10eb3394",
    "3cd67fc88a2f39a4be5bec4ec0a3212dc346d7e474b29ede8a469ffeca686e5a",
);

/// RFC 2945 section 3: session key `K = H(PAD(S))`. Note the leading zero byte.
pub(super) const SESSION_KEY: &str = "017eefa1cefc5c2e626e21598987f31e0f1b11bb";

/// RFC 2945 section 3: client proof
/// `M1 = H(H(N) xor H(PAD(g)), H(I), s, PAD(A), PAD(B), K)`.
pub(super) const CLIENT_PROOF: &str = "62c71b289cb22a034b405667e1541202ce5d8e03";

/// RFC 2945 section 3: server proof `M2 = H(PAD(A), M1, K)`.
pub(super) const SERVER_PROOF: &str = "b475d7f2d75ce9537748005483e5d326048b59e9";
