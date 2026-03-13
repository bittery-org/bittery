CREATE TYPE "public"."favicon_status" AS ENUM('pending', 'fetched', 'failed');--> statement-breakpoint
CREATE TABLE "favicon" (
	"domain" text PRIMARY KEY NOT NULL,
	"image_data" "bytea",
	"content_type" text,
	"status" "favicon_status" DEFAULT 'pending' NOT NULL,
	"fetched_at" timestamp,
	"failed_at" timestamp,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "favicon_status_idx" ON "favicon" USING btree ("status");--> statement-breakpoint
CREATE INDEX "favicon_fetched_at_idx" ON "favicon" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "favicon_failed_at_idx" ON "favicon" USING btree ("failed_at");