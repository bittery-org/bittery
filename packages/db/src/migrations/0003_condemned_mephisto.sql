CREATE TABLE "pending_attachment_upload" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"vault_id" text NOT NULL,
	"item_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"file_size" integer NOT NULL,
	"storage_size" integer NOT NULL,
	"content_type" text NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pending_attachment_upload_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "team_member" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "team_member" CASCADE;--> statement-breakpoint
ALTER TABLE "item_attachment" ADD COLUMN "storage_size" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_attachment_upload" ADD CONSTRAINT "pending_attachment_upload_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_attachment_upload" ADD CONSTRAINT "pending_attachment_upload_vault_id_vault_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vault"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_attachment_upload" ADD CONSTRAINT "pending_attachment_upload_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_attachment_upload" ADD CONSTRAINT "pending_attachment_upload_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_attachment_upload_teamId_idx" ON "pending_attachment_upload" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "pending_attachment_upload_itemId_idx" ON "pending_attachment_upload" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "pending_attachment_upload_createdBy_idx" ON "pending_attachment_upload" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "pending_attachment_upload_expiresAt_idx" ON "pending_attachment_upload" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault" ADD CONSTRAINT "vault_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE restrict ON UPDATE no action;