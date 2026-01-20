CREATE TYPE "public"."sync_entity_type" AS ENUM('item', 'vault', 'vault_member', 'vault_key');--> statement-breakpoint
CREATE TYPE "public"."sync_event_type" AS ENUM('item_created', 'item_updated', 'item_deleted', 'item_restored', 'vault_created', 'vault_updated', 'vault_deleted', 'vault_member_added', 'vault_member_removed', 'vault_key_rotated');--> statement-breakpoint
CREATE TABLE "sync_event" (
	"id" text PRIMARY KEY NOT NULL,
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
ALTER TABLE "item" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "item" ADD COLUMN "last_modified_by" text;--> statement-breakpoint
ALTER TABLE "sync_event" ADD CONSTRAINT "sync_event_vault_id_vault_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vault"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_event" ADD CONSTRAINT "sync_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_event_ack" ADD CONSTRAINT "sync_event_ack_event_id_sync_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."sync_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_event_ack" ADD CONSTRAINT "sync_event_ack_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_event_vaultId_idx" ON "sync_event" USING btree ("vault_id");--> statement-breakpoint
CREATE INDEX "sync_event_userId_idx" ON "sync_event" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sync_event_createdAt_idx" ON "sync_event" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sync_event_entityId_idx" ON "sync_event" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "sync_event_ack_eventId_idx" ON "sync_event_ack" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "sync_event_ack_userId_idx" ON "sync_event_ack" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "item" ADD CONSTRAINT "item_last_modified_by_user_id_fk" FOREIGN KEY ("last_modified_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;