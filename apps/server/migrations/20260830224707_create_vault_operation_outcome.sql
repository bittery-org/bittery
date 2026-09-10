-- Vault creation joins the retained Operation lookup contract before its reachable executor does.
-- This migration widens persistence only; the legacy create-Vault route remains unchanged.
ALTER TABLE operation_outcome
    DROP CONSTRAINT operation_outcome_result_shape;

ALTER TYPE public.operation_kind RENAME TO operation_kind_without_create_vault;
CREATE TYPE public.operation_kind AS ENUM (
    'create_item',
    'update_item',
    'set_item_favorite',
    'trash_item',
    'restore_item',
    'move_item',
    'permanently_delete_item',
    'create_share',
    'create_vault'
);
ALTER TABLE operation_outcome
    ALTER COLUMN operation_kind TYPE public.operation_kind
    USING operation_kind::text::public.operation_kind;
DROP TYPE public.operation_kind_without_create_vault;

ALTER TYPE public.operation_rejection_code RENAME TO operation_rejection_code_without_create_vault;
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
    'share_limit_reached',
    'vault_id_conflict',
    'team_membership_required',
    'vault_sharing_entitlement_denied',
    'shared_vault_limit_reached'
);
ALTER TABLE operation_outcome
    ALTER COLUMN rejection_code TYPE public.operation_rejection_code
    USING rejection_code::text::public.operation_rejection_code;
DROP TYPE public.operation_rejection_code_without_create_vault;

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
                    AND applied_payload - ARRAY['vaultId'] = '{}'::jsonb))
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
                    )))
            )
    );
