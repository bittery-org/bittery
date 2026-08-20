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
plaintext is whatever this ticket defines, plus an Ed25519 signature carried **inside** the ciphertext.
The signature covers the plaintext bytes as encrypted, so the Item document needs no canonical
serialization for signing to be sound, though it may want one for other reasons.

`CRYPTO-001` puts Item content directly under the Vault key with no per-Item key, so nothing in the
Item model may assume a key of its own. Attachments do have one (`CRYPTO-010`, context `0x21`).
