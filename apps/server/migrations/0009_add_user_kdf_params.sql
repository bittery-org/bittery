ALTER TABLE "user" ADD COLUMN "kdf_algorithm" text;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "kdf_iterations" integer;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "kdf_schema_version" integer;
--> statement-breakpoint
UPDATE "user" SET
  kdf_algorithm = 'pbkdf2-sha256',
  kdf_iterations = 310000,
  kdf_schema_version = 1
WHERE kdf_iterations IS NULL;
--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "kdf_algorithm" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "kdf_iterations" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "kdf_schema_version" SET NOT NULL;
