ALTER TABLE pending_attachment_upload
    ADD COLUMN durable_request_fingerprint text,
    ADD COLUMN ciphertext_sha256 text,
    ADD COLUMN durable_created_by text,
    ADD COLUMN durable_item_id text,
    ADD COLUMN durable_vault_id text,
    ADD COLUMN durable_team_id text,
    ADD COLUMN next_cleanup_at timestamptz,
    ADD COLUMN cleanup_attempt_id text,
    ALTER COLUMN created_by DROP NOT NULL,
    ALTER COLUMN item_id DROP NOT NULL,
    ALTER COLUMN vault_id DROP NOT NULL,
    ALTER COLUMN team_id DROP NOT NULL,
    DROP CONSTRAINT pending_attachment_upload_created_by_user_id_fk,
    DROP CONSTRAINT pending_attachment_upload_item_id_item_id_fk,
    DROP CONSTRAINT pending_attachment_upload_vault_id_vault_id_fk,
    DROP CONSTRAINT pending_attachment_upload_team_id_team_id_fk,
    ADD CONSTRAINT pending_attachment_upload_created_by_user_id_fk
        FOREIGN KEY (created_by) REFERENCES "user"(id) ON DELETE SET NULL,
    ADD CONSTRAINT pending_attachment_upload_item_id_item_id_fk
        FOREIGN KEY (item_id) REFERENCES item(id) ON DELETE SET NULL,
    ADD CONSTRAINT pending_attachment_upload_vault_id_vault_id_fk
        FOREIGN KEY (vault_id) REFERENCES vault(id) ON DELETE SET NULL,
    ADD CONSTRAINT pending_attachment_upload_team_id_team_id_fk
        FOREIGN KEY (team_id) REFERENCES team(id) ON DELETE SET NULL,
    ADD CONSTRAINT pending_attachment_upload_durable_evidence CHECK (
        (durable_request_fingerprint IS NULL AND ciphertext_sha256 IS NULL
            AND durable_created_by IS NULL AND durable_item_id IS NULL
            AND durable_vault_id IS NULL AND durable_team_id IS NULL AND next_cleanup_at IS NULL
            AND cleanup_attempt_id IS NULL)
        OR
        (durable_request_fingerprint IS NOT NULL AND durable_request_fingerprint ~ '^[0-9a-f]{64}$'
            AND ciphertext_sha256 IS NOT NULL AND ciphertext_sha256 ~ '^[0-9a-f]{64}$'
            AND durable_created_by IS NOT NULL AND length(durable_created_by) > 0
            AND durable_item_id IS NOT NULL AND length(durable_item_id) > 0
            AND durable_vault_id IS NOT NULL AND length(durable_vault_id) > 0
            AND durable_team_id IS NOT NULL AND length(durable_team_id) > 0
            AND next_cleanup_at IS NOT NULL
            AND (cleanup_attempt_id IS NULL OR cleanup_attempt_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
    );

CREATE UNIQUE INDEX pending_attachment_upload_attachment_id_unique
    ON pending_attachment_upload(attachment_id);
CREATE INDEX pending_attachment_upload_durable_cleanup_due
    ON pending_attachment_upload(next_cleanup_at, id)
    WHERE durable_request_fingerprint IS NOT NULL;
CREATE INDEX item_attachment_storage_key_idx ON item_attachment(storage_key);

-- Preserve ordinary reservation cascade behavior. Durable claims instead retain immutable
-- original scope and their object-cleanup duty after live authorization references disappear.
CREATE FUNCTION delete_ordinary_attachment_reservations_before_parent()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'user' THEN
        DELETE FROM pending_attachment_upload WHERE created_by = OLD.id AND durable_request_fingerprint IS NULL;
    ELSIF TG_TABLE_NAME = 'item' THEN
        DELETE FROM pending_attachment_upload WHERE item_id = OLD.id AND durable_request_fingerprint IS NULL;
    ELSIF TG_TABLE_NAME = 'vault' THEN
        DELETE FROM pending_attachment_upload WHERE vault_id = OLD.id AND durable_request_fingerprint IS NULL;
    ELSIF TG_TABLE_NAME = 'team' THEN
        DELETE FROM pending_attachment_upload WHERE team_id = OLD.id AND durable_request_fingerprint IS NULL;
    END IF;
    RETURN OLD;
END;
$$;
CREATE TRIGGER delete_ordinary_attachment_reservations BEFORE DELETE ON "user"
    FOR EACH ROW EXECUTE FUNCTION delete_ordinary_attachment_reservations_before_parent();
CREATE TRIGGER delete_ordinary_attachment_reservations BEFORE DELETE ON item
    FOR EACH ROW EXECUTE FUNCTION delete_ordinary_attachment_reservations_before_parent();
CREATE TRIGGER delete_ordinary_attachment_reservations BEFORE DELETE ON vault
    FOR EACH ROW EXECUTE FUNCTION delete_ordinary_attachment_reservations_before_parent();
CREATE TRIGGER delete_ordinary_attachment_reservations BEFORE DELETE ON team
    FOR EACH ROW EXECUTE FUNCTION delete_ordinary_attachment_reservations_before_parent();
