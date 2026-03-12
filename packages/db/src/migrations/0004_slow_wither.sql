ALTER TABLE "session" ADD COLUMN "client_id" text;--> statement-breakpoint
CREATE INDEX "session_expires_at_idx" ON "session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "session_user_platform_client_id_idx" ON "session" USING btree ("user_id","platform","client_id");