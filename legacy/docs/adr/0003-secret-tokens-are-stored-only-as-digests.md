# Every out-of-band secret is stored only as a SHA-256 digest

Sessions already stored only `hash_token()`; `20260730105321_hash_verification_codes_and_invite_tokens.sql`
and `20260730134316_hash_share_link_tokens.sql` extended that to signup/recovery/share
verification codes, team invitation tokens, and share link tokens. The exposure being closed
is plaintext at rest: any database read (backup, replica, log shipping, a compromised
read-only credential) previously handed over live, usable credentials. SHA-256 rather than a
password hash is deliberate — these are high-entropy random tokens, and lookup is by digest
equality on an indexed column.

**Consequences.** Both migrations are one-way; there is no rollback that restores the
plaintext. The verification-code migration could not derive digests for existing rows and
therefore invalidated every live one (short TTLs made that acceptable); the share-link
migration hashed in place, so distributed URLs kept working. A share token is now disclosed
exactly once, in the `share.create` response — `share.listByItem` and `share.get` cannot
return it because the server no longer has it, so a share URL cannot be re-derived after
creation. `ee105b6a` follows from that: the client returns one assembled `shareUrl` with the
key in the fragment instead of the parts, since a link that loses its fragment is
unrecoverable, and the mobile share sheet keeps the link on screen with an explicit close
confirmation for the same reason.
