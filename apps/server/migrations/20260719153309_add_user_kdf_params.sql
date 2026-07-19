ALTER TABLE "user" ADD COLUMN "kdf_algorithm" text;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "kdf_iterations" integer;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "kdf_schema_version" integer;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "user") THEN
    RAISE EXCEPTION 'Legacy accounts are unsupported; reset the database before applying the KDF migration';
  END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE "user"
  ADD CONSTRAINT "user_kdf_algorithm_current" CHECK (kdf_algorithm = 'pbkdf2-sha256'),
  ADD CONSTRAINT "user_kdf_iterations_current" CHECK (kdf_iterations = 600000),
  ADD CONSTRAINT "user_kdf_schema_version_current" CHECK (kdf_schema_version = 1);
--> statement-breakpoint
ALTER TABLE "user"
  ALTER COLUMN "kdf_algorithm" SET NOT NULL,
  ALTER COLUMN "kdf_iterations" SET NOT NULL,
  ALTER COLUMN "kdf_schema_version" SET NOT NULL;
