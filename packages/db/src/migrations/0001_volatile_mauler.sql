CREATE TABLE "login_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"normalized_email_hash" text NOT NULL,
	"client_public_key" text NOT NULL,
	"server_ephemeral_secret" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "login_attempt" ADD CONSTRAINT "login_attempt_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "login_attempt_user_id_idx" ON "login_attempt" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "login_attempt_email_hash_idx" ON "login_attempt" USING btree ("normalized_email_hash");--> statement-breakpoint
CREATE INDEX "login_attempt_expires_at_idx" ON "login_attempt" USING btree ("expires_at");