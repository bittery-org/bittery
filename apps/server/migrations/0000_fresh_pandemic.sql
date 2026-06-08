CREATE TYPE "public"."billing_plan" AS ENUM('free', 'personal', 'family', 'team');--> statement-breakpoint
CREATE TYPE "public"."billing_status" AS ENUM('none', 'incomplete', 'trialing', 'active', 'past_due', 'canceled', 'unpaid');--> statement-breakpoint
CREATE TYPE "public"."invitation_status" AS ENUM('pending', 'accepted', 'declined', 'expired');--> statement-breakpoint
CREATE TYPE "public"."team_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."team_type" AS ENUM('personal', 'family', 'organization');--> statement-breakpoint
CREATE TYPE "public"."share_link_access_mode" AS ENUM('anyone', 'email-restricted');--> statement-breakpoint
CREATE TYPE "public"."share_link_status" AS ENUM('active', 'expired', 'exhausted', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."sync_entity_type" AS ENUM('item', 'vault', 'vault_member', 'vault_key');--> statement-breakpoint
CREATE TYPE "public"."sync_event_type" AS ENUM('item_created', 'item_updated', 'item_deleted', 'item_restored', 'item_permanently_deleted', 'item_moved', 'vault_created', 'vault_updated', 'vault_deleted', 'vault_access_revoked', 'vault_member_added', 'vault_member_removed', 'vault_key_rotated');--> statement-breakpoint
CREATE TYPE "public"."item_category" AS ENUM('login', 'secure-note', 'credit-card', 'identity', 'totp');--> statement-breakpoint
CREATE TYPE "public"."key_rotation_reason" AS ENUM('member_removed', 'scheduled', 'security_breach', 'manual');--> statement-breakpoint
CREATE TYPE "public"."vault_role" AS ENUM('owner', 'admin', 'member', 'read-only');--> statement-breakpoint
CREATE TYPE "public"."vault_type" AS ENUM('personal', 'team');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"ip_address" text,
	"user_agent" text,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"code" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"used_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"device_name" text,
	"platform" text,
	"device_info" text,
	"browser_name" text,
	"browser_version" text,
	"os_name" text,
	"os_version" text,
	"last_active_at" timestamp DEFAULT now() NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"secret_key_hint" text,
	"encrypted_master_key" text,
	"recovery_key_hint" text,
	"srp_salt" text NOT NULL,
	"srp_verifier" text NOT NULL,
	"public_key" text NOT NULL,
	"encrypted_private_key" text NOT NULL,
	"team_id" text,
	"role" "team_role" DEFAULT 'owner' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "stripe_event_log" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_hash" text,
	"processed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_event_log_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "rate_limit_state" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"subject" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp,
	"locked_until" timestamp,
	"window_start_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limit_state_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
CREATE TABLE "share_access_log" (
	"id" text PRIMARY KEY NOT NULL,
	"share_link_id" text NOT NULL,
	"accessed_by_email" text,
	"ip_address" text,
	"user_agent" text,
	"success" boolean NOT NULL,
	"failure_reason" text,
	"accessed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_email_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"share_link_id" text NOT NULL,
	"email" text NOT NULL,
	"code" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"used_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "share_link" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"created_by_id" text NOT NULL,
	"token" text NOT NULL,
	"status" "share_link_status" DEFAULT 'active' NOT NULL,
	"access_mode" "share_link_access_mode" DEFAULT 'anyone' NOT NULL,
	"is_one_time_use" boolean DEFAULT false NOT NULL,
	"encrypted_item_data" text NOT NULL,
	"encryption_iv" text NOT NULL,
	"encrypted_share_key" text NOT NULL,
	"share_key_iv" text NOT NULL,
	"access_count" integer DEFAULT 0 NOT NULL,
	"max_access_count" integer,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp,
	CONSTRAINT "share_link_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "share_link_allowed_email" (
	"id" text PRIMARY KEY NOT NULL,
	"share_link_id" text NOT NULL,
	"email" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_event" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"event_type" "sync_event_type" NOT NULL,
	"vault_id" text,
	"entity_id" text NOT NULL,
	"entity_type" "sync_entity_type" NOT NULL,
	"client_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"user_id" text NOT NULL,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_event_ack" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"acknowledged_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_id" text NOT NULL,
	"type" "team_type" DEFAULT 'personal' NOT NULL,
	"member_limit" integer,
	"billing_plan" "billing_plan" DEFAULT 'free' NOT NULL,
	"billing_status" "billing_status" DEFAULT 'none' NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"stripe_subscription_item_id" text,
	"stripe_price_id" text,
	"seats_purchased" integer,
	"current_period_end" timestamp,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"image_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "team_stripe_customer_id_unique" UNIQUE("stripe_customer_id"),
	CONSTRAINT "team_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
CREATE TABLE "team_invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"email" text NOT NULL,
	"role" "team_role" DEFAULT 'member' NOT NULL,
	"invited_by_id" text NOT NULL,
	"status" "invitation_status" DEFAULT 'pending' NOT NULL,
	"token" text NOT NULL,
	"pending_vault_keys" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"accepted_at" timestamp,
	CONSTRAINT "team_invitation_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "team_member" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "team_role" DEFAULT 'member' NOT NULL,
	"invited_at" timestamp DEFAULT now() NOT NULL,
	"joined_at" timestamp,
	"deprecated" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folder" (
	"id" text PRIMARY KEY NOT NULL,
	"vault_id" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item" (
	"id" text PRIMARY KEY NOT NULL,
	"vault_id" text NOT NULL,
	"category" "item_category" DEFAULT 'login' NOT NULL,
	"favorite" boolean DEFAULT false NOT NULL,
	"encrypted_data" text NOT NULL,
	"encryption_iv" text NOT NULL,
	"encryption_algorithm" text DEFAULT 'AES-GCM-AAD-V1' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"last_modified_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "item_attachment" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"vault_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"encrypted_name" text NOT NULL,
	"encrypted_content_type" text NOT NULL,
	"encryption_iv" text NOT NULL,
	"encrypted_content_type_iv" text,
	"encryption_algorithm" text DEFAULT 'AES-GCM-AAD-V1' NOT NULL,
	"file_size" integer NOT NULL,
	"uploaded_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" "vault_type" DEFAULT 'personal' NOT NULL,
	"icon" text,
	"image_key" text,
	"created_by_id" text NOT NULL,
	"team_id" text,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_key" (
	"id" text PRIMARY KEY NOT NULL,
	"vault_id" text NOT NULL,
	"user_id" text NOT NULL,
	"encrypted_vault_key" text NOT NULL,
	"role" "vault_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_key_rotation" (
	"id" text PRIMARY KEY NOT NULL,
	"vault_id" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"reason" "key_rotation_reason" NOT NULL,
	"initiated_by_id" text NOT NULL,
	"removed_user_id" text,
	"items_re_encrypted" integer DEFAULT 0 NOT NULL,
	"members_updated" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_access_log" ADD CONSTRAINT "share_access_log_share_link_id_share_link_id_fk" FOREIGN KEY ("share_link_id") REFERENCES "public"."share_link"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_email_verification" ADD CONSTRAINT "share_email_verification_share_link_id_share_link_id_fk" FOREIGN KEY ("share_link_id") REFERENCES "public"."share_link"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link" ADD CONSTRAINT "share_link_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link" ADD CONSTRAINT "share_link_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link_allowed_email" ADD CONSTRAINT "share_link_allowed_email_share_link_id_share_link_id_fk" FOREIGN KEY ("share_link_id") REFERENCES "public"."share_link"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_event" ADD CONSTRAINT "sync_event_vault_id_vault_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vault"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_event" ADD CONSTRAINT "sync_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_event_ack" ADD CONSTRAINT "sync_event_ack_event_id_sync_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."sync_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_event_ack" ADD CONSTRAINT "sync_event_ack_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team" ADD CONSTRAINT "team_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invitation" ADD CONSTRAINT "team_invitation_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invitation" ADD CONSTRAINT "team_invitation_invited_by_id_user_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder" ADD CONSTRAINT "folder_vault_id_vault_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vault"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item" ADD CONSTRAINT "item_vault_id_vault_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vault"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item" ADD CONSTRAINT "item_last_modified_by_user_id_fk" FOREIGN KEY ("last_modified_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_attachment" ADD CONSTRAINT "item_attachment_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_attachment" ADD CONSTRAINT "item_attachment_vault_id_vault_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vault"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_attachment" ADD CONSTRAINT "item_attachment_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault" ADD CONSTRAINT "vault_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_key" ADD CONSTRAINT "vault_key_vault_id_vault_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vault"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_key" ADD CONSTRAINT "vault_key_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_key_rotation" ADD CONSTRAINT "vault_key_rotation_vault_id_vault_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vault"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_key_rotation" ADD CONSTRAINT "vault_key_rotation_initiated_by_id_user_id_fk" FOREIGN KEY ("initiated_by_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_userId_idx" ON "audit_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_log_createdAt_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "recovery_verification_email_idx" ON "recovery_verification" USING btree ("email");--> statement-breakpoint
CREATE INDEX "recovery_verification_code_idx" ON "recovery_verification" USING btree ("code");--> statement-breakpoint
CREATE INDEX "recovery_verification_expires_at_idx" ON "recovery_verification" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_team_id_idx" ON "user" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "stripe_event_log_event_id_idx" ON "stripe_event_log" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "stripe_event_log_processed_at_idx" ON "stripe_event_log" USING btree ("processed_at");--> statement-breakpoint
CREATE INDEX "rate_limit_state_subject_idx" ON "rate_limit_state" USING btree ("scope","subject");--> statement-breakpoint
CREATE INDEX "rate_limit_state_locked_until_idx" ON "rate_limit_state" USING btree ("locked_until");--> statement-breakpoint
CREATE INDEX "rate_limit_state_window_start_at_idx" ON "rate_limit_state" USING btree ("window_start_at");--> statement-breakpoint
CREATE INDEX "share_access_log_shareLinkId_idx" ON "share_access_log" USING btree ("share_link_id");--> statement-breakpoint
CREATE INDEX "share_access_log_accessedAt_idx" ON "share_access_log" USING btree ("accessed_at");--> statement-breakpoint
CREATE INDEX "share_email_verification_shareLinkId_idx" ON "share_email_verification" USING btree ("share_link_id");--> statement-breakpoint
CREATE INDEX "share_email_verification_email_idx" ON "share_email_verification" USING btree ("email");--> statement-breakpoint
CREATE INDEX "share_email_verification_code_idx" ON "share_email_verification" USING btree ("code");--> statement-breakpoint
CREATE INDEX "share_link_itemId_idx" ON "share_link" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "share_link_createdById_idx" ON "share_link" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX "share_link_token_idx" ON "share_link" USING btree ("token");--> statement-breakpoint
CREATE INDEX "share_link_status_idx" ON "share_link" USING btree ("status");--> statement-breakpoint
CREATE INDEX "share_link_allowed_email_shareLinkId_idx" ON "share_link_allowed_email" USING btree ("share_link_id");--> statement-breakpoint
CREATE INDEX "share_link_allowed_email_email_idx" ON "share_link_allowed_email" USING btree ("email");--> statement-breakpoint
CREATE INDEX "sync_event_vaultId_idx" ON "sync_event" USING btree ("vault_id");--> statement-breakpoint
CREATE INDEX "sync_event_userId_idx" ON "sync_event" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sync_event_createdAt_idx" ON "sync_event" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sync_event_seq_idx" ON "sync_event" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "sync_event_entityId_idx" ON "sync_event" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "sync_event_ack_eventId_idx" ON "sync_event_ack" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "sync_event_ack_userId_idx" ON "sync_event_ack" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "team_invitation_teamId_idx" ON "team_invitation" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "team_invitation_email_idx" ON "team_invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "team_invitation_token_idx" ON "team_invitation" USING btree ("token");--> statement-breakpoint
CREATE INDEX "team_member_teamId_idx" ON "team_member" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "team_member_userId_idx" ON "team_member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "folder_vaultId_idx" ON "folder" USING btree ("vault_id");--> statement-breakpoint
CREATE INDEX "item_vaultId_idx" ON "item" USING btree ("vault_id");--> statement-breakpoint
CREATE INDEX "item_deletedAt_idx" ON "item" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "item_attachment_itemId_idx" ON "item_attachment" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "item_attachment_vaultId_idx" ON "item_attachment" USING btree ("vault_id");--> statement-breakpoint
CREATE INDEX "vault_key_vaultId_idx" ON "vault_key" USING btree ("vault_id");--> statement-breakpoint
CREATE INDEX "vault_key_userId_idx" ON "vault_key" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "vault_key_rotation_vaultId_idx" ON "vault_key_rotation" USING btree ("vault_id");--> statement-breakpoint
CREATE INDEX "vault_key_rotation_initiatedById_idx" ON "vault_key_rotation" USING btree ("initiated_by_id");