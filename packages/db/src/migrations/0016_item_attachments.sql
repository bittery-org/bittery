CREATE TABLE "item_attachment" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"vault_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"encrypted_name" text NOT NULL,
	"encrypted_content_type" text NOT NULL,
	"encryption_iv" text NOT NULL,
	"encryption_algorithm" text DEFAULT 'AES-GCM' NOT NULL,
	"file_size" integer NOT NULL,
	"uploaded_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "item_attachment" ADD CONSTRAINT "item_attachment_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_attachment" ADD CONSTRAINT "item_attachment_vault_id_vault_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vault"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_attachment" ADD CONSTRAINT "item_attachment_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "item_attachment_itemId_idx" ON "item_attachment" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "item_attachment_vaultId_idx" ON "item_attachment" USING btree ("vault_id");
