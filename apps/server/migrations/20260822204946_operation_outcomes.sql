ALTER TYPE public.sync_event_type ADD VALUE 'operation_resolved';
ALTER TYPE public.sync_entity_type ADD VALUE 'operation';

CREATE TABLE operation_outcome (
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    operation_kind TEXT NOT NULL,
    request_fingerprint BYTEA NOT NULL,
    result_status TEXT NOT NULL,
    entity_id TEXT,
    entity_version INTEGER,
    rejection_code TEXT,
    rejection_details JSONB,
    resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, operation_id),
    CONSTRAINT operation_outcome_id_length CHECK (length(operation_id) BETWEEN 1 AND 255),
    CONSTRAINT operation_outcome_kind CHECK (operation_kind IN ('create_item')),
    CONSTRAINT operation_outcome_fingerprint_length CHECK (octet_length(request_fingerprint) = 32),
    CONSTRAINT operation_outcome_rejection_details_size CHECK (
        rejection_details IS NULL OR octet_length(rejection_details::text) <= 4096
    ),
    CONSTRAINT operation_outcome_result_status CHECK (result_status IN ('applied', 'rejected')),
    CONSTRAINT operation_outcome_rejection_code CHECK (
        rejection_code IS NULL OR rejection_code IN (
            'invalid_ciphertext', 'vault_access_denied', 'vault_read_only', 'item_id_conflict'
        )
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
