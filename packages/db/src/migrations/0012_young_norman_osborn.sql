CREATE TABLE "login_rate_limit" (
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
CREATE INDEX "login_rate_limit_email_idx" ON "login_rate_limit" USING btree ("email");--> statement-breakpoint
CREATE INDEX "login_rate_limit_ip_idx" ON "login_rate_limit" USING btree ("ip_address");--> statement-breakpoint
CREATE INDEX "login_rate_limit_locked_until_idx" ON "login_rate_limit" USING btree ("locked_until");