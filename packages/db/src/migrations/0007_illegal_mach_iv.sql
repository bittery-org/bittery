CREATE TABLE "item_tag" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"tag_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_filter" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"vault_id" text NOT NULL,
	"name" text NOT NULL,
	"filter_json" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" text PRIMARY KEY NOT NULL,
	"vault_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "item_tag" ADD CONSTRAINT "item_tag_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_tag" ADD CONSTRAINT "item_tag_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_filter" ADD CONSTRAINT "saved_filter_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_filter" ADD CONSTRAINT "saved_filter_vault_id_vault_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vault"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_vault_id_vault_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vault"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "item_tag_itemId_idx" ON "item_tag" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "item_tag_tagId_idx" ON "item_tag" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "saved_filter_userId_idx" ON "saved_filter" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "saved_filter_vaultId_idx" ON "saved_filter" USING btree ("vault_id");--> statement-breakpoint
CREATE INDEX "tag_vaultId_idx" ON "tag" USING btree ("vault_id");--> statement-breakpoint
CREATE INDEX "tag_vaultId_name_idx" ON "tag" USING btree ("vault_id","name");