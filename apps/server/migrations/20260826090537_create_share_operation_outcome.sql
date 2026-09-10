-- Share creation joins the retained Operation contract without putting its raw capability on the
-- Server. Its applied payload is a closed non-secret object, while its rejection vocabulary is a
-- closed four-code subset of the database-wide Operation rejection type.
ALTER TYPE public.operation_kind RENAME TO operation_kind_without_share;
CREATE TYPE public.operation_kind AS ENUM (
    'create_item',
    'update_item',
    'set_item_favorite',
    'trash_item',
    'restore_item',
    'move_item',
    'permanently_delete_item',
    'create_share'
);
ALTER TABLE operation_outcome
    ALTER COLUMN operation_kind TYPE public.operation_kind
    USING operation_kind::text::public.operation_kind;
DROP TYPE public.operation_kind_without_share;

ALTER TYPE public.operation_rejection_code RENAME TO operation_rejection_code_without_share;
CREATE TYPE public.operation_rejection_code AS ENUM (
    'invalid_ciphertext',
    'vault_access_denied',
    'vault_read_only',
    'item_id_conflict',
    'item_not_found',
    'item_version_conflict',
    'item_trashed',
    'item_not_trashed',
    'source_vault_mismatch',
    'target_vault_access_denied',
    'target_vault_read_only',
    'attachment_state_conflict',
    'share_entitlement_denied',
    'share_limit_reached'
);
ALTER TABLE operation_outcome
    ALTER COLUMN rejection_code TYPE public.operation_rejection_code
    USING rejection_code::text::public.operation_rejection_code;
DROP TYPE public.operation_rejection_code_without_share;

ALTER TABLE operation_outcome
    ADD COLUMN applied_payload JSONB;

ALTER TABLE operation_outcome
    DROP CONSTRAINT operation_outcome_result_shape;

ALTER TABLE operation_outcome
    ADD CONSTRAINT operation_outcome_result_shape CHECK (
        (result_status = 'applied'
            AND rejection_code IS NULL
            AND rejection_details IS NULL
            AND (
                (operation_kind <> 'create_share'
                    AND entity_id IS NOT NULL
                    AND entity_version IS NOT NULL
                    AND applied_payload IS NULL)
                OR
                (operation_kind = 'create_share'
                    AND entity_id IS NULL
                    AND entity_version IS NULL
                    AND applied_payload IS NOT NULL
                    AND jsonb_typeof(applied_payload) = 'object'
                    AND applied_payload ?& ARRAY['shareLinkId', 'baseShareUrl', 'expiresAt']
                    AND jsonb_typeof(applied_payload->'shareLinkId') = 'string'
                    AND jsonb_typeof(applied_payload->'baseShareUrl') = 'string'
                    AND jsonb_typeof(applied_payload->'expiresAt') = 'string'
                    AND applied_payload - ARRAY['shareLinkId', 'baseShareUrl', 'expiresAt'] = '{}'::jsonb))
            )
        OR
        (result_status = 'rejected'
            AND entity_id IS NULL
            AND entity_version IS NULL
            AND applied_payload IS NULL
            AND rejection_code IS NOT NULL
            AND (
                (operation_kind = 'create_share'
                    AND rejection_details IS NULL
                    AND rejection_code IN (
                        'item_not_found',
                        'vault_read_only',
                        'share_entitlement_denied',
                        'share_limit_reached'
                    ))
                OR
                (operation_kind <> 'create_share'
                    AND rejection_code NOT IN (
                        'share_entitlement_denied',
                        'share_limit_reached'
                    )))
            )
    );

ALTER TABLE operation_outcome
    ADD CONSTRAINT operation_outcome_applied_payload_size CHECK (
        applied_payload IS NULL OR octet_length(applied_payload::text) <= 4096
    );
