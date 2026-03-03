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
CREATE INDEX "rate_limit_state_subject_idx" ON "rate_limit_state" USING btree ("scope","subject");
--> statement-breakpoint
CREATE INDEX "rate_limit_state_locked_until_idx" ON "rate_limit_state" USING btree ("locked_until");
--> statement-breakpoint
CREATE INDEX "rate_limit_state_window_start_at_idx" ON "rate_limit_state" USING btree ("window_start_at");
--> statement-breakpoint
DROP TABLE IF EXISTS "share_link_rate_limit" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "recovery_rate_limit" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "login_rate_limit" CASCADE;
