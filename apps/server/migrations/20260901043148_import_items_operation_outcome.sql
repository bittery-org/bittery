-- Import joins the retained Operation lookup contract while its legacy route remains unchanged.
-- This migration adds consumer and persistence awareness only; no Import executor writes these rows.
ALTER TABLE operation_outcome
    DROP CONSTRAINT operation_outcome_result_shape;

ALTER TYPE public.operation_kind RENAME TO operation_kind_without_import_items;
CREATE TYPE public.operation_kind AS ENUM (
    'create_item',
    'update_item',
    'set_item_favorite',
    'trash_item',
    'restore_item',
    'move_item',
    'permanently_delete_item',
    'create_share',
    'create_vault',
    'import_items'
);
ALTER TABLE operation_outcome
    ALTER COLUMN operation_kind TYPE public.operation_kind
    USING operation_kind::text::public.operation_kind;
DROP TYPE public.operation_kind_without_import_items;

ALTER TABLE operation_outcome
    ADD CONSTRAINT operation_outcome_result_shape CHECK (
        (result_status = 'applied'
            AND rejection_code IS NULL
            AND rejection_details IS NULL
            AND (
                (operation_kind IN (
                        'create_item',
                        'update_item',
                        'set_item_favorite',
                        'trash_item',
                        'restore_item',
                        'move_item',
                        'permanently_delete_item'
                    )
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
                    AND applied_payload - ARRAY['shareLinkId', 'baseShareUrl', 'expiresAt'] = '{}'::jsonb)
                OR
                (operation_kind = 'create_vault'
                    AND entity_id IS NULL
                    AND entity_version IS NULL
                    AND applied_payload IS NOT NULL
                    AND jsonb_typeof(applied_payload) = 'object'
                    AND applied_payload ?& ARRAY['vaultId']
                    AND jsonb_typeof(applied_payload->'vaultId') = 'string'
                    AND applied_payload - ARRAY['vaultId'] = '{}'::jsonb)
                OR
                (operation_kind = 'import_items'
                    AND entity_id IS NULL
                    AND entity_version IS NULL
                    AND applied_payload IS NOT NULL
                    AND jsonb_typeof(applied_payload) = 'object'
                    AND applied_payload ?& ARRAY['vaultId', 'importedCount']
                    AND jsonb_typeof(applied_payload->'vaultId') = 'string'
                    AND jsonb_typeof(applied_payload->'importedCount') = 'number'
                    AND (applied_payload->>'importedCount')::numeric = trunc((applied_payload->>'importedCount')::numeric)
                    AND (applied_payload->>'importedCount')::numeric BETWEEN 0 AND 200
                    AND applied_payload - ARRAY['vaultId', 'importedCount'] = '{}'::jsonb))
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
                (operation_kind IN (
                        'create_item',
                        'update_item',
                        'set_item_favorite',
                        'trash_item',
                        'restore_item',
                        'move_item',
                        'permanently_delete_item'
                    )
                    AND rejection_code NOT IN (
                        'share_entitlement_denied',
                        'share_limit_reached',
                        'vault_id_conflict',
                        'team_membership_required',
                        'vault_sharing_entitlement_denied',
                        'shared_vault_limit_reached'
                    ))
                OR
                (operation_kind = 'create_vault'
                    AND rejection_details IS NULL
                    AND rejection_code IN (
                        'vault_id_conflict',
                        'team_membership_required',
                        'vault_sharing_entitlement_denied',
                        'shared_vault_limit_reached'
                    ))
                OR
                (operation_kind = 'import_items'
                    AND rejection_details IS NULL
                    AND rejection_code IN (
                        'invalid_ciphertext',
                        'vault_access_denied',
                        'vault_read_only',
                        'item_id_conflict'
                    )))
            )
    );
