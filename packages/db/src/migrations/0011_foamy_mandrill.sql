ALTER TABLE "user" DROP CONSTRAINT "user_team_id_team_id_fk";
--> statement-breakpoint
ALTER TABLE "team" ADD COLUMN "image_key" text;