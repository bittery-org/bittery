ALTER TABLE "item_attachment"
    ADD COLUMN "encrypted_attachment_key" text NOT NULL,
    ADD COLUMN "attachment_key_iv" text NOT NULL,
    ADD COLUMN "attachment_key_algorithm" text NOT NULL,
    ADD COLUMN "envelope_version" integer NOT NULL DEFAULT 1;

ALTER TABLE "pending_attachment_upload"
    ADD COLUMN "attachment_id" text NOT NULL;
