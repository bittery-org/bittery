CREATE TYPE "public"."vault_key_rotation_plan_state" AS ENUM(
	'preparing', 'ready', 'completed', 'stale', 'failed', 'abandoned', 'expired'
);
--> statement-breakpoint
CREATE TYPE "public"."vault_key_rotation_stale_reason" AS ENUM(
	'vault_version', 'member_set', 'item_state', 'attachment_state'
);
--> statement-breakpoint
CREATE TYPE "public"."vault_key_rotation_manifest_kind" AS ENUM(
	'member', 'item', 'attachment'
);
--> statement-breakpoint
CREATE TABLE "vault_key_rotation_plan" (
	"id" text PRIMARY KEY NOT NULL,
	"vault_id" text NOT NULL,
	"initiator_user_id" text NOT NULL,
	"reason" "key_rotation_reason" NOT NULL,
	"authorization_context" text NOT NULL,
	"excluded_user_id" text,
	"expected_key_version" integer NOT NULL,
	"state" "vault_key_rotation_plan_state" DEFAULT 'preparing' NOT NULL,
	"stale_reason" "vault_key_rotation_stale_reason",
	"failure_message" text,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"idle_expires_at" timestamptz NOT NULL,
	"absolute_expires_at" timestamptz NOT NULL,
	"completed_at" timestamptz,
	CONSTRAINT "vault_key_rotation_plan_deadlines_check" CHECK ("idle_expires_at" <= "absolute_expires_at")
);
--> statement-breakpoint
CREATE TABLE "vault_key_rotation_plan_manifest" (
	"plan_id" text NOT NULL,
	"kind" "vault_key_rotation_manifest_kind" NOT NULL,
	"entity_id" text NOT NULL,
	"expected_version" integer NOT NULL,
	"payload" text NOT NULL,
	PRIMARY KEY ("plan_id", "kind", "entity_id")
);
--> statement-breakpoint
CREATE TABLE "vault_key_rotation_plan_staged_output" (
	"plan_id" text NOT NULL,
	"kind" "vault_key_rotation_manifest_kind" NOT NULL,
	"entity_id" text NOT NULL,
	"payload" text NOT NULL,
	"payload_hash" text NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	PRIMARY KEY ("plan_id", "kind", "entity_id")
);
--> statement-breakpoint
ALTER TABLE "vault_key_rotation_plan" ADD CONSTRAINT "vault_key_rotation_plan_vault_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vault"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "vault_key_rotation_plan" ADD CONSTRAINT "vault_key_rotation_plan_initiator_fk" FOREIGN KEY ("initiator_user_id") REFERENCES "public"."user"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "vault_key_rotation_plan_manifest" ADD CONSTRAINT "vault_key_rotation_plan_manifest_plan_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."vault_key_rotation_plan"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "vault_key_rotation_plan_staged_output" ADD CONSTRAINT "vault_key_rotation_plan_staged_output_plan_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."vault_key_rotation_plan"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX "vault_key_rotation_plan_cleanup_idx" ON "vault_key_rotation_plan" ("absolute_expires_at", "id") WHERE "state" IN ('preparing', 'ready', 'completed', 'expired', 'failed', 'stale', 'abandoned');
--> statement-breakpoint
CREATE INDEX "vault_key_rotation_plan_vault_idx" ON "vault_key_rotation_plan" ("vault_id");
