CREATE TABLE "recovery_rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"ip_address" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp DEFAULT now() NOT NULL,
	"locked_until" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
ALTER TABLE "user" ADD COLUMN "encrypted_master_key" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "recovery_key_hint" text;--> statement-breakpoint
CREATE INDEX "recovery_rate_limit_email_idx" ON "recovery_rate_limit" USING btree ("email");--> statement-breakpoint
CREATE INDEX "recovery_rate_limit_ip_idx" ON "recovery_rate_limit" USING btree ("ip_address");--> statement-breakpoint
CREATE INDEX "recovery_rate_limit_locked_until_idx" ON "recovery_rate_limit" USING btree ("locked_until");--> statement-breakpoint
CREATE INDEX "recovery_verification_email_idx" ON "recovery_verification" USING btree ("email");--> statement-breakpoint
CREATE INDEX "recovery_verification_code_idx" ON "recovery_verification" USING btree ("code");--> statement-breakpoint
CREATE INDEX "recovery_verification_expires_at_idx" ON "recovery_verification" USING btree ("expires_at");