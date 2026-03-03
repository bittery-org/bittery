CREATE TYPE "public"."billing_plan" AS ENUM('free', 'personal', 'family', 'team');--> statement-breakpoint
CREATE TYPE "public"."billing_status" AS ENUM('none', 'incomplete', 'trialing', 'active', 'past_due', 'canceled', 'unpaid');--> statement-breakpoint
CREATE TABLE "stripe_event_log" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_hash" text,
	"processed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_event_log_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
ALTER TABLE "team" ADD COLUMN "billing_plan" "billing_plan" DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "team" ADD COLUMN "billing_status" "billing_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "team" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "team" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "team" ADD COLUMN "stripe_subscription_item_id" text;--> statement-breakpoint
ALTER TABLE "team" ADD COLUMN "stripe_price_id" text;--> statement-breakpoint
ALTER TABLE "team" ADD COLUMN "seats_purchased" integer;--> statement-breakpoint
ALTER TABLE "team" ADD COLUMN "current_period_end" timestamp;--> statement-breakpoint
ALTER TABLE "team" ADD COLUMN "cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "stripe_event_log_event_id_idx" ON "stripe_event_log" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "stripe_event_log_processed_at_idx" ON "stripe_event_log" USING btree ("processed_at");--> statement-breakpoint
ALTER TABLE "team" ADD CONSTRAINT "team_stripe_customer_id_unique" UNIQUE("stripe_customer_id");--> statement-breakpoint
ALTER TABLE "team" ADD CONSTRAINT "team_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id");