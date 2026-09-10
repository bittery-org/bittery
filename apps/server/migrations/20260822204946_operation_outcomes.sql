ALTER TYPE public.sync_event_type ADD VALUE 'operation_resolved';
ALTER TYPE public.sync_entity_type ADD VALUE 'operation';

CREATE TYPE public.operation_kind AS ENUM ('create_item');
CREATE TYPE public.operation_outcome_status AS ENUM ('applied', 'rejected');
CREATE TYPE public.create_item_rejection_code AS ENUM (
    'invalid_ciphertext',
    'vault_access_denied',
    'vault_read_only',
    'item_id_conflict'
);

CREATE TABLE operation_outcome (
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    operation_kind operation_kind NOT NULL,
    request_fingerprint BYTEA NOT NULL,
    result_status operation_outcome_status NOT NULL,
    entity_id TEXT,
    entity_version INTEGER,
    rejection_code create_item_rejection_code,
    rejection_details JSONB,
    resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, operation_id),
    CONSTRAINT operation_outcome_id_length CHECK (length(operation_id) BETWEEN 1 AND 255),
    CONSTRAINT operation_outcome_fingerprint_length CHECK (octet_length(request_fingerprint) = 32),
    CONSTRAINT operation_outcome_rejection_details_size CHECK (
        rejection_details IS NULL OR octet_length(rejection_details::text) <= 4096
    ),
    CONSTRAINT operation_outcome_result_shape CHECK (
        (result_status = 'applied'
            AND entity_id IS NOT NULL
            AND entity_version IS NOT NULL
            AND rejection_code IS NULL
            AND rejection_details IS NULL)
        OR
        (result_status = 'rejected'
            AND entity_id IS NULL
            AND entity_version IS NULL
            AND rejection_code IS NOT NULL)
    )
);
