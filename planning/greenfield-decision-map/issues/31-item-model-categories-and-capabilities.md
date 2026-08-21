# Item model, categories, custom fields, TOTP, and Passkeys

Type: grilling
Status: ready-for-human
Blocked by: 08

## Question

`ITEM-001` fixes five categories with encrypted custom fields and no user-authored schemas; `ITEM-002` makes TOTP and Passkeys stored capabilities rather than Bittery-login methods.

Decide:

- The five category schemas at field level, and the custom-field type system.
- The Item envelope: which fields are separately sealed, and which travel together.
- TOTP storage and generation, including URI import and steam-style variants.
- Passkey storage: credential format, RP binding, and what the extension and future credential providers need from it.
- URL and domain representation, since [search and autofill](20-search-and-autofill-index.md) depends on its shape.
- Trash, restore, and permanent deletion at Item level.
- Favorite, now encrypted, and how sorting works without the Server seeing it.

Produces: `ITEM-*` refinement and the canonical Item schema.

### Inherited from ticket 08, key hierarchy and canonical envelope format

`CRYPTO-008` and `CRYPTO-012` bound this ticket's plaintext layout from outside. An Item revision's
plaintext is one canonical unsigned body plus an Ed25519 signature carried **inside** the ciphertext.
The signature covers the exact canonical unsigned bytes, so this ticket must define one serialization
rather than treating object-key order or host encoding as irrelevant. The body also contains the
ordered Attachment manifest fixed by `CRYPTO-013`.

`CRYPTO-001` puts Item content directly under the Vault key with no per-Item key, so nothing in the
Item model may assume a key of its own. Attachments do have one (`CRYPTO-010`, context `0x21`).

### Inherited from Search and autofill index

The Item schema must classify every user-authored field as secret or non-secret for indexing. Secure
Note bodies, Custom Field names and non-secret values, and Attachment names are searchable; passwords,
TOTP seeds, passkey private material, recovery material, secret-classified Custom Field values, and
Attachment bytes are not. New fields default to not searchable until the closed classification admits
them. URL storage preserves every User-confirmed exact website/application association while the
shared matcher derives registrable-site candidates from canonical hosts.
