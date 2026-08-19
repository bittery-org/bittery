-- Convert all timestamp columns to timestamptz (timestamp with time zone)
-- SQLx maps OffsetDateTime to timestamptz, so this is required for correct Rust type mapping.
-- PostgreSQL treats existing timestamp values as UTC when converting to timestamptz.

-- audit_log
ALTER TABLE "audit_log" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';

-- recovery_verification
ALTER TABLE "recovery_verification" ALTER COLUMN "expires_at" TYPE timestamptz USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "recovery_verification" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "recovery_verification" ALTER COLUMN "used_at" TYPE timestamptz USING "used_at" AT TIME ZONE 'UTC';

-- session
ALTER TABLE "session" ALTER COLUMN "expires_at" TYPE timestamptz USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "session" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "session" ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "session" ALTER COLUMN "last_active_at" TYPE timestamptz USING "last_active_at" AT TIME ZONE 'UTC';

-- "user"
ALTER TABLE "user" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "user" ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC';

-- stripe_event_log
ALTER TABLE "stripe_event_log" ALTER COLUMN "processed_at" TYPE timestamptz USING "processed_at" AT TIME ZONE 'UTC';

-- rate_limit_state
ALTER TABLE "rate_limit_state" ALTER COLUMN "last_attempt_at" TYPE timestamptz USING "last_attempt_at" AT TIME ZONE 'UTC';
ALTER TABLE "rate_limit_state" ALTER COLUMN "locked_until" TYPE timestamptz USING "locked_until" AT TIME ZONE 'UTC';
ALTER TABLE "rate_limit_state" ALTER COLUMN "window_start_at" TYPE timestamptz USING "window_start_at" AT TIME ZONE 'UTC';
ALTER TABLE "rate_limit_state" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "rate_limit_state" ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC';

-- share_access_log
ALTER TABLE "share_access_log" ALTER COLUMN "accessed_at" TYPE timestamptz USING "accessed_at" AT TIME ZONE 'UTC';

-- share_email_verification
ALTER TABLE "share_email_verification" ALTER COLUMN "expires_at" TYPE timestamptz USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "share_email_verification" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "share_email_verification" ALTER COLUMN "used_at" TYPE timestamptz USING "used_at" AT TIME ZONE 'UTC';

-- share_link
ALTER TABLE "share_link" ALTER COLUMN "expires_at" TYPE timestamptz USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "share_link" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "share_link" ALTER COLUMN "last_accessed_at" TYPE timestamptz USING "last_accessed_at" AT TIME ZONE 'UTC';

-- share_link_allowed_email
ALTER TABLE "share_link_allowed_email" ALTER COLUMN "verified_at" TYPE timestamptz USING "verified_at" AT TIME ZONE 'UTC';
ALTER TABLE "share_link_allowed_email" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';

-- sync_event
ALTER TABLE "sync_event" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';

-- sync_event_ack
ALTER TABLE "sync_event_ack" ALTER COLUMN "acknowledged_at" TYPE timestamptz USING "acknowledged_at" AT TIME ZONE 'UTC';

-- team
ALTER TABLE "team" ALTER COLUMN "current_period_end" TYPE timestamptz USING "current_period_end" AT TIME ZONE 'UTC';
ALTER TABLE "team" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "team" ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC';

-- team_invitation
ALTER TABLE "team_invitation" ALTER COLUMN "expires_at" TYPE timestamptz USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_invitation" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "team_invitation" ALTER COLUMN "accepted_at" TYPE timestamptz USING "accepted_at" AT TIME ZONE 'UTC';

-- folder
ALTER TABLE "folder" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "folder" ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC';

-- item
ALTER TABLE "item" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "item" ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC';
ALTER TABLE "item" ALTER COLUMN "deleted_at" TYPE timestamptz USING "deleted_at" AT TIME ZONE 'UTC';

-- item_attachment
ALTER TABLE "item_attachment" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';

-- vault
ALTER TABLE "vault" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "vault" ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC';

-- vault_key
ALTER TABLE "vault_key" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';

-- vault_key_rotation
ALTER TABLE "vault_key_rotation" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "vault_key_rotation" ALTER COLUMN "completed_at" TYPE timestamptz USING "completed_at" AT TIME ZONE 'UTC';

-- login_attempt
ALTER TABLE "login_attempt" ALTER COLUMN "expires_at" TYPE timestamptz USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "login_attempt" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';

-- signup_verification
ALTER TABLE "signup_verification" ALTER COLUMN "expires_at" TYPE timestamptz USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "signup_verification" ALTER COLUMN "used_at" TYPE timestamptz USING "used_at" AT TIME ZONE 'UTC';
ALTER TABLE "signup_verification" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "signup_verification" ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC';

-- pending_attachment_upload
ALTER TABLE "pending_attachment_upload" ALTER COLUMN "expires_at" TYPE timestamptz USING "expires_at" AT TIME ZONE 'UTC';
ALTER TABLE "pending_attachment_upload" ALTER COLUMN "consumed_at" TYPE timestamptz USING "consumed_at" AT TIME ZONE 'UTC';
ALTER TABLE "pending_attachment_upload" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';

-- favicon
ALTER TABLE "favicon" ALTER COLUMN "fetched_at" TYPE timestamptz USING "fetched_at" AT TIME ZONE 'UTC';
ALTER TABLE "favicon" ALTER COLUMN "failed_at" TYPE timestamptz USING "failed_at" AT TIME ZONE 'UTC';
ALTER TABLE "favicon" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "favicon" ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC';
