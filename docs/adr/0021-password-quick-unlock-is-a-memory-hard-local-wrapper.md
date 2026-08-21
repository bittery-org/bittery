# Password quick unlock is a memory-hard local wrapper

Status: accepted

Bittery lets an enrolled Device reopen its Account Key Set with the master password but without a
Server or Secret Key. Each Account and Device has a separate context `0x03` envelope. Its wrapping
key comes from the immutable pinned Argon2id profile over a canonical input containing the password,
stable identities, and a random local Device factor, followed by labeled HKDF-SHA-512 narrowing.

This route exists because Windows, Linux, and many browser profiles have no documented capability
that cryptographically gates key use on fresh local authorization. Requiring full sign-in there would
make the Secret Key an everyday input. Treating an ordinary keychain read or app-level biometric
dialog as equivalent to Secure Enclave or WebAuthn PRF would make a false security claim. Platform
quick unlock therefore remains an optional, explicitly enabled enhancement over the portable
password baseline.

The trade-off is offline guessing: anyone who copies the local wrapper record also obtains its Device
factor and can test master-password candidates at the Account's Argon2id cost. Bittery states that
limit, ships no cheaper local KDF, exports no Account keys through client bindings, and never treats
the local factor as hardware-bound. A platform anchor may authorize several Accounts, but their
wrapping keys and Account Key Sets remain independent. Secure Enclave uses one installation-wide
anchor; WebAuthn remains honest about its RP boundary and uses one PRF anchor per stable Server.
