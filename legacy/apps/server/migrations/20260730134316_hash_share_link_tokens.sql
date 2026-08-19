-- Store only the SHA-256 digest of a share link token, never the token itself.
--
-- `share_link.token` was the last plaintext credential left at rest. Anyone able
-- to read the database (backup, replica, log shipping, a compromised read-only
-- credential) could lift a live token and open the link, which for a one-time or
-- access-capped link also silently burns the recipient's single view. Lookups now
-- hash the caller-supplied token and compare digests, mirroring `session`,
-- `signup_verification`, `recovery_verification`, `share_email_verification` and
-- `team_invitation`.
--
-- Unlike the verification codes and invite tokens hashed in
-- 20260730105321_hash_verification_codes_and_invite_tokens.sql, no row is
-- invalidated here. The plaintext is still present at migration time, so the
-- correct digest is derivable in place and EVERY LIVE SHARE LINK KEEPS WORKING --
-- already-distributed URLs resolve exactly as before. `sha256()` is a Postgres
-- 11+ builtin (no pgcrypto needed) and
-- `encode(sha256(convert_to(t, 'UTF8')), 'hex')` is byte-identical to the Rust
-- `hash_token()` (`hex::encode(Sha256::digest(token.as_bytes()))`); tokens are
-- ASCII [0-9A-Za-z], so the UTF8 encoding is the same byte sequence Rust hashes.
--
-- This is ONE-WAY. There is no rollback that restores the plaintext tokens: after
-- this runs the column holds digests only, and reverting the column name would
-- leave every stored value unusable as a lookup key for the server's plaintext
-- comparison. Restoring plaintext requires a backup taken before this migration.
--
-- Share links stay zero-knowledge either way: the decryption key travels in the
-- URL fragment and never reaches the server. What changes is only that a database
-- reader can no longer replay the token half of the link.
--
-- Behaviour that changes for owners: the token is disclosed exactly once, in the
-- `share.create` response. `share.listByItem` and `share.get` no longer return it
-- (the server cannot: it only has the digest), so a share URL cannot be re-derived
-- after creation.

UPDATE "share_link" SET "token" = encode(sha256(convert_to("token", 'UTF8')), 'hex');
ALTER TABLE "share_link" RENAME COLUMN "token" TO "token_hash";
ALTER TABLE "share_link" RENAME CONSTRAINT "share_link_token_unique" TO "share_link_token_hash_unique";
-- Redundant: the renamed UNIQUE constraint already owns an identical btree on the
-- same single column, so every lookup that used this index is served by it.
DROP INDEX "share_link_token_idx";
