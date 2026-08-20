# The authentication salt no longer derives from the Secret Key

Status: superseded by ADR-0006

The proposed signature challenge-response derived an Argon2id salt from the Secret Key to remove a
pre-login salt lookup. ADR 0006 replaced that construction with RFC 9807 OPAQUE. OPAQUE applies its
key-stretching function after the oblivious pseudorandom function and defines fake responses for
unknown credentials; no Bittery authentication salt exists outside the selected OPAQUE profile.

The old decision's enumeration and profile-discovery conclusions do not survive. Ticket 14 owns fake
responses and abuse policy. Ticket 07 owns profile parameters, pinning, discovery, and upgrades within
the OPAQUE record-and-wrapper migration fixed by `AUTH-014`.
