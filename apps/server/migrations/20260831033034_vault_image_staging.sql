-- Private Vault-image staging. Production HTTP ownership remains unchanged until the atomic
-- create-Vault cutover; these rows are only reachable through the Server Domain seam.
CREATE TABLE vault_image_staging_generation (
    user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    operation_id text NOT NULL,
    binding_fingerprint text NOT NULL CHECK (binding_fingerprint ~ '^[0-9a-f]{64}$'),
    generation bigint NOT NULL CHECK (generation > 0),
    PRIMARY KEY (user_id, operation_id),
    UNIQUE (user_id, operation_id, generation)
);

CREATE TABLE vault_image_staging (
    user_id text NOT NULL,
    operation_id text NOT NULL,
    vault_id text NOT NULL,
    object_key text NOT NULL UNIQUE,
    raw_sha256 text NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
    raw_length bigint NOT NULL CHECK (raw_length > 0 AND raw_length <= 2097152),
    content_type text NOT NULL CHECK (content_type IN (
        'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'
    )),
    state text NOT NULL CHECK (state IN ('unconfirmed', 'confirmed', 'cleanup_pending')),
    generation bigint NOT NULL CHECK (generation > 0),
    lease_expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, operation_id),
    CHECK (object_key = 'vaults/' || user_id || '/' || vault_id || '/create/' || operation_id || '-' || raw_sha256),
    FOREIGN KEY (user_id, operation_id, generation)
        REFERENCES vault_image_staging_generation(user_id, operation_id, generation) ON DELETE CASCADE
);

CREATE INDEX vault_image_staging_user_quota_idx
    ON vault_image_staging (user_id);

CREATE INDEX vault_image_staging_sweep_idx
    ON vault_image_staging (lease_expires_at, user_id, operation_id)
    WHERE state = 'unconfirmed';

CREATE INDEX vault_image_staging_cleanup_idx
    ON vault_image_staging (updated_at, user_id, operation_id)
    WHERE state = 'cleanup_pending';
