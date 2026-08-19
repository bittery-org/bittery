DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "item"
        WHERE "last_modified_by" IS NULL
    ) THEN
        RAISE EXCEPTION 'Items without a modifier are unsupported; reset the database before applying this migration';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "item_attachment"
        WHERE "encrypted_content_type_iv" IS NULL OR "uploaded_by" IS NULL
    ) THEN
        RAISE EXCEPTION 'Attachments without a dedicated content-type IV are unsupported; reset the database before applying this migration';
    END IF;
END $$;

ALTER TABLE "item"
    ALTER COLUMN "last_modified_by" SET NOT NULL;

ALTER TABLE "item_attachment"
    ALTER COLUMN "encrypted_content_type_iv" SET NOT NULL,
    ALTER COLUMN "uploaded_by" SET NOT NULL;

DROP TABLE IF EXISTS "folder";
