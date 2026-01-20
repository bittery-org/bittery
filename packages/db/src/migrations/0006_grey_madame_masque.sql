ALTER TABLE "session" ADD COLUMN "device_name" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "platform" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "browser_name" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "browser_version" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "os_name" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "os_version" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "last_active_at" timestamp DEFAULT now() NOT NULL;