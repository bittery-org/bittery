-- Write migration SQL here
ALTER TABLE idempotency_record
    ADD COLUMN claim_expires_at TIMESTAMPTZ,
    ADD COLUMN terminal_reason TEXT;

UPDATE idempotency_record
SET claim_expires_at = created_at + INTERVAL '5 minutes'
WHERE state = 'pending';

ALTER TABLE idempotency_record
    DROP CONSTRAINT idempotency_record_state,
    DROP CONSTRAINT idempotency_record_completed_response;

ALTER TABLE idempotency_record
    ADD CONSTRAINT idempotency_record_state
        CHECK (state IN ('pending', 'completed', 'indeterminate')),
    ADD CONSTRAINT idempotency_record_response_state CHECK (
        (state = 'pending'
            AND claim_expires_at IS NOT NULL
            AND response_status IS NULL
            AND response_body IS NULL
            AND terminal_reason IS NULL)
        OR
        (state = 'completed'
            AND claim_expires_at IS NULL
            AND response_status BETWEEN 100 AND 599
            AND response_body IS NOT NULL
            AND terminal_reason IS NULL)
        OR
        (state = 'indeterminate'
            AND claim_expires_at IS NULL
            AND response_status IS NULL
            AND response_body IS NULL
            AND terminal_reason IS NOT NULL)
    );

CREATE INDEX idempotency_record_pending_claim_expiry_idx
    ON idempotency_record (claim_expires_at)
    WHERE state = 'pending';

COMMENT ON COLUMN idempotency_record.terminal_reason IS
    'Fail-closed outcome marker. Indeterminate rows require operator verification before deletion.';
