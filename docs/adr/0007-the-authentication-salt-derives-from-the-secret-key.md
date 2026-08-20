# The authentication salt derives from the Secret Key

Status: accepted

The salt for the Argon2id run that produces the Authentication Key is derived client-side from the
Secret Key. The Server never stores it, never sends it, and has no endpoint that returns anything about
an Account before a full sign-in begins.

A password-authentication design normally stores a random salt per Account and hands it to the client
before the exchange. That endpoint is an account-existence oracle: ask for an email address, learn
whether it holds an Account. Hiding it means answering unknown addresses with a decoy salt derived
deterministically from a Server secret, and getting that indistinguishable in timing as well as content,
forever, on a path that is also the busiest unauthenticated endpoint the Server has.

The Secret Key removes the problem instead of defending it. It is required for every full sign-in
already under `AUTH-004`, it never reaches the Server, and it carries roughly 128 bits of entropy. A salt
derived from it is unique per Account by construction and unpredictable to anyone who does not already
hold the Secret Key, which is stronger pre-computation resistance than OPAQUE offers and costs no
dependency. With the salt gone from the wire there is no pre-login request left to enumerate.

## Considered options

**A Server-stored per-Account salt with a deterministic decoy for unknown addresses** was rejected. It is
the conventional design and it works, but it keeps an enumeration surface that ticket 14 would have to
defend permanently, and it buys flexibility this product does not need.

**A Secret Key salt with Server-stored per-Account key-derivation parameters** was rejected as the worst
of both. It keeps unpredictable salts but keeps the pre-login round trip too, so it pays the cost of both
routes for the benefit of one.

**A salt derived from the email address and Server identity** was considered. It also removes the round
trip, but the salt becomes public, so pre-computation returns and changing an email address silently
invalidates the Authentication Key.

## Consequences

Key-derivation parameters can no longer be per-Account, because there is no pre-login exchange to carry
them. They become Server-wide, published in the Server descriptor that ticket 23 defines, and pinned by
the client. This is a gain rather than a concession: per-Account parameters are exactly the vector a
Malicious Operator uses to hand one Device weaker parameters than another, and that vector no longer
exists. Ticket 07 inherits the pinning and upgrade rules.

An Account whose Authentication Key predates a parameter change must record which parameters it used.
That is the Authentication profile: not a secret, held in Device state and printed on the Emergency Kit
beside the Secret Key it already carries. [ADR
0008](0008-memory-hard-work-is-spent-once-and-only-on-human-secrets.md) collapsed the two derivations
into one run, so there is a single profile per Account and the term is now **key-derivation profile**. Ticket 09 owns the Emergency Kit contents and ticket 10 owns
Device state.

Rotating the Secret Key changes the salt, so it re-derives the Authentication Key. That is already true
of the credential itself, which binds both secrets, so it adds no new obligation.

The Sign-in Challenge endpoint still needs abuse defence under ticket 14. It no longer leaks Account
existence, but it is unauthenticated and it hands out nonces.
