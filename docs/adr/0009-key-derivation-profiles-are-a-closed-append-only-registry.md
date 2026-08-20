# Key-derivation profiles are a closed, append-only registry

Status: proposed

Previously accepted; reopened by Wayfinder ticket 07 on 2026-08-20.

[ADR 0007](0007-the-authentication-salt-derives-from-the-secret-key.md) made key-derivation
parameters Server-wide and published in the Server descriptor, because there is no pre-login exchange
left to carry per-Account parameters. That leaves a client reading derivation parameters out of a
document it does not trust. `AUTH-017` closes the gap by never reading parameters at all: every client
compiles in an ordered registry of frozen profiles, and the descriptor names one entry.

An identifier a client does not hold means "update your client", never "derive with what I sent you".
A Malicious Operator publishing Argon2id at one pass and 8 KiB has no effect, because there is nothing
in the descriptor a client will obey. Downgrade resistance stops being parameter validation, which is
easy to get subtly wrong, and becomes a comparison of two small integers.

Entries are never removed. The instinct from iteration-count floors is to retire weak entries, and it
is wrong here: the pinned profile is the only route to an Account's Vault keys, and no one but the
User can re-derive. Dropping an entry does not discourage old Accounts, it destroys them, including
one whose owner declined an upgrade or has not signed in for two years. `AUTH-005` already says losing
every credential loses the Account; a retired profile would make not signing in lose it too.

`AUTH-018` pins each Account to the profile it was created under. A stronger published profile is an
offer at the end of a full sign-in, while the master password is in hand, and the User may decline. A
weaker one is derived past and written to Security History, so a rollback to an old backup or a
Malicious Operator cheapening an offline grind is Detectable rather than silent.

## Considered options

**Publishing explicit parameters with a client-enforced floor and ceiling** was rejected. It is the
frozen product's shape, which published an algorithm with a minimum, default, and maximum iteration
count. It gives operators tuning they have no reason to want, and every tuned deployment is a
deployment whose users derive under parameters nobody reviewed. The ceiling exists only as a
denial-of-service guard, which is a tell that the flexibility is a liability.

**Publishing both the identifier and the parameters, cross-checked** was considered and rejected as
redundant. A client that holds the table does not need the tuple, and carrying it invites an
implementation to trust the wire copy.

**Retiring entries after a period of forced upgrade** was rejected. It keeps the floor rising, and it
converts a dormant Account into an unrecoverable one, which contradicts `AUTH-005`.

**Serving the Account's profile from the Server after a failed attempt** was rejected. It removes the
registry walk, and it reinstates exactly the account-existence oracle ADR 0007 closed: an attacker
gets a different answer for an email that holds an Account than for one that does not.

**Storing the pinned profile per Account on the Server** was rejected. It would help an administrator
diagnose a stuck sign-in, and it would cost an entry on the `PRIVACY-007` plaintext allowlist that the
security whitepaper must defend forever. The Server has no protocol need for it: a signature produced
under the wrong profile is simply an invalid signature.

## Consequences

Adding a profile requires a client release, and every client must ship the new entry before any Server
publishes it, or clients refuse the descriptor. Registry changes are therefore release-coordinated,
not operator-driven.

A Device with no local state finds its profile from the Emergency Kit, which prints it, or by walking
the registry downward (`AUTH-019`). Each attempt costs one Argon2id run, so a genuinely wrong password
costs the walk before the client can say so. The registry is expected to gain an entry every few
years, which is what keeps that bounded; nothing else does.

Because `AUTH-016` fixes 64 MiB of memory and the registry is append-only, every surface that performs
a full sign-in must be able to allocate 64 MiB for the duration. That constrains the extension and
mobile architecture work, and it will not bend later.

A profile upgrade re-derives both HKDF outputs and re-wraps what the Vault-unlock material protects,
so it is the master password change path. The key rotation and crash-safety work inherits an upgrade
that must be resumable, because a re-wrap interrupted halfway must not strand an Account between two
profiles.
