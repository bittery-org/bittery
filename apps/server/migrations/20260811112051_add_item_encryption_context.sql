-- Write migration SQL here
ALTER TABLE "item"
    ADD COLUMN "encryption_version" integer,
    ADD COLUMN "encrypted_by_user_id" text;

ALTER TABLE "item"
    ADD CONSTRAINT "item_encryption_version_positive"
    CHECK ("encryption_version" IS NULL OR "encryption_version" > 0),
    ADD CONSTRAINT "item_encryption_context_paired"
    CHECK (("encryption_version" IS NULL) = ("encrypted_by_user_id" IS NULL)),
    ADD CONSTRAINT "item_encrypted_by_user_id_user_id_fk"
    FOREIGN KEY ("encrypted_by_user_id") REFERENCES "user"("id");
