CREATE TABLE "beta_waitlist" (
	"id" text PRIMARY KEY,
	"email" text NOT NULL,
	"name" text,
	"use_case" text,
	"source" text,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "beta_waitlist_email_lower_unique" ON "beta_waitlist" (lower("email"));
