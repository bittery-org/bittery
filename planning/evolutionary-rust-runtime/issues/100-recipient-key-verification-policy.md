# 100 — Recipient key verification policy

Type: grilling
Status: resolved
Blocked by: none

## Decision

2026-09-10: the maintainer selected mandatory out-of-band recipient fingerprint verification before
any Vault key is sent. First-use trust is rejected. A changed key requires fresh verification.

Use the existing RSA identity and wrapping formats. Shared Core owns fingerprint interpretation and
Device-local verified-recipient records, scoped to the Account incarnation and canonical Server/User.
The recipient displays a fingerprint derived from their decrypted private key, never a Server-provided
public key. New Devices and Account removal require verification again; no Server data, Bootstrap,
legacy migration or recovery archive may manufacture verification.

The existing Web add-Member, Invitation provisioning and Key rotation callers must all consult this
policy for the exact key they pass to Rust crypto. Existing rotation transport orchestration may remain
transitional; migrating the entire ceremony is not required to enforce this security rule. No host
implements fingerprint comparison, first-use acceptance or changed-key policy.

## Delivery

[101 — implementation and acceptance](101-runtime-recipient-key-verification.md), governed by
[the focused specification](../recipient-key-verification.md).
