CREATE TYPE "public"."key_rotation_reason" AS ENUM('member_removed', 'scheduled', 'security_breach', 'manual');--> statement-breakpoint
CREATE TABLE "vault_key_rotation" (
	"id" text PRIMARY KEY NOT NULL,
	"vault_id" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"reason" "key_rotation_reason" NOT NULL,
	"initiated_by_id" text NOT NULL,
	"removed_user_id" text,
	"items_re_encrypted" integer DEFAULT 0 NOT NULL,
	"members_updated" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "vault" ADD COLUMN "key_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "vault_key_rotation" ADD CONSTRAINT "vault_key_rotation_vault_id_vault_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vault"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_key_rotation" ADD CONSTRAINT "vault_key_rotation_initiated_by_id_user_id_fk" FOREIGN KEY ("initiated_by_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vault_key_rotation_vaultId_idx" ON "vault_key_rotation" USING btree ("vault_id");--> statement-breakpoint
CREATE INDEX "vault_key_rotation_initiatedById_idx" ON "vault_key_rotation" USING btree ("initiated_by_id");