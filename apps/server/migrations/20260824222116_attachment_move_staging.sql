ALTER TYPE public.operation_rejection_code ADD VALUE IF NOT EXISTS 'attachment_state_conflict';

CREATE TABLE attachment_move_staging_generation (
    user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    operation_id text NOT NULL,
    request_fingerprint text NOT NULL,
    generation bigint NOT NULL CHECK (generation > 0),
    PRIMARY KEY (user_id, operation_id)
);

CREATE TABLE attachment_move_manifest (
    user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    operation_id text NOT NULL,
    item_id text NOT NULL,
    source_vault_id text NOT NULL,
    target_vault_id text NOT NULL,
    request_fingerprint text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, operation_id)
);

CREATE TABLE attachment_move_staging (
    user_id text NOT NULL,
    operation_id text NOT NULL,
    attachment_id text NOT NULL,
    expected_envelope_version integer NOT NULL,
    ciphertext_sha256 text NOT NULL CHECK (ciphertext_sha256 ~ '^[0-9a-f]{64}$'),
    storage_key text NOT NULL UNIQUE,
    storage_size bigint NOT NULL CHECK (storage_size >= 0),
    PRIMARY KEY (user_id, operation_id, attachment_id),
    UNIQUE (attachment_id),
    FOREIGN KEY (user_id, operation_id)
        REFERENCES attachment_move_manifest(user_id, operation_id) ON DELETE CASCADE
);

CREATE INDEX attachment_move_manifest_expiry_idx
    ON attachment_move_manifest (expires_at, user_id, operation_id);

CREATE TABLE attachment_move_cleanup (
    id bigserial PRIMARY KEY,
    user_id text NOT NULL,
    operation_id text NOT NULL,
    storage_key text NOT NULL,
    claim_token text,
    claimed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, operation_id, storage_key)
);

CREATE INDEX attachment_move_cleanup_unclaimed_idx
    ON attachment_move_cleanup (id) WHERE claim_token IS NULL;

CREATE INDEX attachment_move_cleanup_claim_expiry_idx
    ON attachment_move_cleanup (claimed_at, id) WHERE claim_token IS NOT NULL;

CREATE FUNCTION enqueue_deleted_attachment_move_staging() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO attachment_move_cleanup (user_id, operation_id, storage_key)
    SELECT user_id, operation_id, storage_key
    FROM attachment_move_staging
    WHERE user_id = OLD.user_id AND operation_id = OLD.operation_id
    ON CONFLICT DO NOTHING;
    RETURN OLD;
END;
$$;

CREATE TRIGGER enqueue_deleted_attachment_move_staging
BEFORE DELETE ON attachment_move_manifest
FOR EACH ROW EXECUTE FUNCTION enqueue_deleted_attachment_move_staging();
