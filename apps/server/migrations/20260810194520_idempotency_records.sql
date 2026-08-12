CREATE TABLE idempotency_record (
    principal_id TEXT NOT NULL,
    method TEXT NOT NULL,
    route_target TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint BYTEA NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    response_status SMALLINT,
    response_content_type TEXT,
    response_body BYTEA,
    response_etag TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
    PRIMARY KEY (principal_id, method, route_target, idempotency_key),
    CONSTRAINT idempotency_record_method_length CHECK (length(method) BETWEEN 1 AND 16),
    CONSTRAINT idempotency_record_route_length CHECK (length(route_target) BETWEEN 1 AND 1024),
    CONSTRAINT idempotency_record_key_length CHECK (length(idempotency_key) BETWEEN 1 AND 255),
    CONSTRAINT idempotency_record_fingerprint_length CHECK (octet_length(request_fingerprint) = 32),
    CONSTRAINT idempotency_record_state CHECK (state IN ('pending', 'completed')),
    CONSTRAINT idempotency_record_response_size CHECK (
        response_body IS NULL OR octet_length(response_body) <= 2097152
    ),
    CONSTRAINT idempotency_record_completed_response CHECK (
        (state = 'pending' AND response_status IS NULL AND response_body IS NULL)
        OR
        (state = 'completed' AND response_status BETWEEN 100 AND 599 AND response_body IS NOT NULL)
    )
);

CREATE INDEX idempotency_record_completed_expiry_idx
    ON idempotency_record (expires_at)
    WHERE state = 'completed';
