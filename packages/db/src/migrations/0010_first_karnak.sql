CREATE TYPE "public"."team_type" AS ENUM('personal', 'family', 'organization');--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "team_id" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "role" "team_role" DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE "team" ADD COLUMN "type" "team_type" DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "team" ADD COLUMN "member_limit" integer;--> statement-breakpoint
ALTER TABLE "team_member" ADD COLUMN "deprecated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_team_id_idx" ON "user" USING btree ("team_id");