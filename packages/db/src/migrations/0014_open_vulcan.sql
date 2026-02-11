ALTER TYPE "public"."sync_event_type" ADD VALUE 'item_permanently_deleted' BEFORE 'item_moved';--> statement-breakpoint
ALTER TYPE "public"."sync_event_type" ADD VALUE 'vault_access_revoked' BEFORE 'vault_member_added';--> statement-breakpoint
ALTER TABLE "sync_event" DROP CONSTRAINT "sync_event_vault_id_vault_id_fk";
--> statement-breakpoint
ALTER TABLE "sync_event" ADD CONSTRAINT "sync_event_vault_id_vault_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vault"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_event_createdAt_id_idx" ON "sync_event" USING btree ("created_at","id");
