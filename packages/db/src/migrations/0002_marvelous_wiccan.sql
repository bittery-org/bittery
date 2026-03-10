CREATE TABLE "signup_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"invitation_token" text,
	"code" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "signup_verification_email_idx" ON "signup_verification" USING btree ("email");--> statement-breakpoint
CREATE INDEX "signup_verification_invitation_token_idx" ON "signup_verification" USING btree ("invitation_token");--> statement-breakpoint
CREATE INDEX "signup_verification_code_idx" ON "signup_verification" USING btree ("code");--> statement-breakpoint
CREATE INDEX "signup_verification_expires_at_idx" ON "signup_verification" USING btree ("expires_at");