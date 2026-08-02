-- Store SHA-256 hashes instead of plaintext for every short-lived credential that
-- is handed to a user out-of-band (verification codes, team invitation tokens).
--
-- The exposure being closed is plaintext at rest: any database read (backup,
-- replica, log shipping, a compromised read-only credential) previously disclosed
-- live, usable codes and invite tokens. Lookups now hash the caller-supplied value
-- and compare hashes, mirroring how `session` already stores only `hash_token()`.
--
-- Existing rows cannot be carried over, because deriving the hash would require
-- re-reading the very plaintext we are removing. Every affected row is short-lived,
-- so all live rows are invalidated instead:
--   * signup_verification      - 15 minute TTL, deleted outright
--   * recovery_verification    - 15 minute TTL, deleted outright
--   * share_email_verification - 15 minute TTL, deleted outright
--   * team_invitation          - 7 day TTL; pending rows are marked 'expired' and
--                                the token column is overwritten with an
--                                unguessable digest. History (accepted/declined)
--                                is preserved.
-- Users with an in-flight code simply request a new one. Users holding an unused
-- invite link must be invited again with team.invitations.send: the rows touched
-- here are marked 'expired', and the admin invitation list only returns rows with
-- status = 'pending', so they are not visible in the UI and team.invitations.resend
-- cannot be reached for them. Re-sending to the same address works because the
-- duplicate guard in send only rejects an already-'pending' invitation.
-- (team.invitations.resend does rotate the token, but only for invitations that are
-- still listed.)

DELETE FROM "signup_verification";
ALTER TABLE "signup_verification" RENAME COLUMN "code" TO "code_hash";
ALTER TABLE "signup_verification" RENAME COLUMN "invitation_token" TO "invitation_token_hash";
ALTER INDEX "signup_verification_code_idx" RENAME TO "signup_verification_code_hash_idx";
ALTER INDEX "signup_verification_invitation_token_idx" RENAME TO "signup_verification_invitation_token_hash_idx";

DELETE FROM "recovery_verification";
ALTER TABLE "recovery_verification" RENAME COLUMN "code" TO "code_hash";
ALTER INDEX "recovery_verification_code_idx" RENAME TO "recovery_verification_code_hash_idx";

DELETE FROM "share_email_verification";
ALTER TABLE "share_email_verification" RENAME COLUMN "code" TO "code_hash";
ALTER INDEX "share_email_verification_code_idx" RENAME TO "share_email_verification_code_hash_idx";

UPDATE "team_invitation" SET "status" = 'expired' WHERE "status" = 'pending';
ALTER TABLE "team_invitation" RENAME COLUMN "token" TO "token_hash";
ALTER TABLE "team_invitation" RENAME CONSTRAINT "team_invitation_token_unique" TO "team_invitation_token_hash_unique";
-- Destroys the plaintext at rest while keeping the NOT NULL / UNIQUE contract.
-- The result is not the hash of the old token, so the old link can never be
-- redeemed again; the rows are already 'expired' above.
UPDATE "team_invitation"
SET "token_hash" = encode(sha256(convert_to("token_hash" || '|' || "id" || '|invalidated', 'UTF8')), 'hex');
