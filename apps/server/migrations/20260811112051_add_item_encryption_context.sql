DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "item") THEN
        RAISE EXCEPTION 'Items written without exact encryption context are unsupported; reset the database before applying this migration';
    END IF;
END $$;

ALTER TABLE "item"
    ADD COLUMN "encryption_version" integer NOT NULL,
    ADD COLUMN "encrypted_by_user_id" text NOT NULL;

ALTER TABLE "item"
    ADD CONSTRAINT "item_encryption_version_positive"
    CHECK ("encryption_version" > 0),
    ADD CONSTRAINT "item_encrypted_by_user_id_user_id_fk"
    FOREIGN KEY ("encrypted_by_user_id") REFERENCES "user"("id");
