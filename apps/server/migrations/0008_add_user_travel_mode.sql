CREATE TABLE "user_travel_mode" (
	"user_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"hidden_vault_ids" text[] DEFAULT '{}' NOT NULL,
	"enabled_at" timestamptz,
	"updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_travel_mode" ADD CONSTRAINT "user_travel_mode_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TYPE "public"."sync_event_type" ADD VALUE 'travel_mode_updated';
--> statement-breakpoint
ALTER TYPE "public"."sync_entity_type" ADD VALUE 'user';
