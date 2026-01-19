CREATE TYPE "public"."share_link_access_mode" AS ENUM('anyone', 'email-restricted');--> statement-breakpoint
CREATE TYPE "public"."share_link_status" AS ENUM('active', 'expired', 'exhausted', 'revoked');--> statement-breakpoint
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
CREATE TABLE "share_link_rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"links_created_today" integer DEFAULT 0 NOT NULL,
	"daily_limit" integer DEFAULT 50 NOT NULL,
	"last_reset_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "share_access_log" ADD CONSTRAINT "share_access_log_share_link_id_share_link_id_fk" FOREIGN KEY ("share_link_id") REFERENCES "public"."share_link"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_email_verification" ADD CONSTRAINT "share_email_verification_share_link_id_share_link_id_fk" FOREIGN KEY ("share_link_id") REFERENCES "public"."share_link"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link" ADD CONSTRAINT "share_link_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link" ADD CONSTRAINT "share_link_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link_allowed_email" ADD CONSTRAINT "share_link_allowed_email_share_link_id_share_link_id_fk" FOREIGN KEY ("share_link_id") REFERENCES "public"."share_link"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link_rate_limit" ADD CONSTRAINT "share_link_rate_limit_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
CREATE INDEX "share_link_rate_limit_userId_idx" ON "share_link_rate_limit" USING btree ("user_id");