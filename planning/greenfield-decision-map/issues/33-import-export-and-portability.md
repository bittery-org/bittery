# Import, export, and portability

Type: grilling
Status: ready-for-human
Blocked by: 31

## Question

In the first release, and the only bridge for existing users, since `PROD-FOUNDATION-005` guarantees no compatibility with current ciphertext or databases. The frozen product has six web-only importers (1Password `.1pux`, Bitwarden, Chrome, Firefox, KeePassXC, and round-trip `.bttrx`) plus a server-side bulk import capped at 16 MiB and 200 items.

Decide:

- The supported import format list for the first release.
- The export format: whether there is a canonical encrypted export and a plaintext one, and what warnings attach to each.
- Whether import runs client-side only, or whether a server-side bulk path exists and what it sees.
- What survives a round trip: attachments, TOTP, passkeys, custom fields, history, favourites.
- Migration for existing Bittery users, given the clean reset.
- Authenticated export offline, which `OFFLINE-001` requires.

Produces: format specifications and a disposition for a family currently sitting in Unclassified.
