-- Retained Vault metadata/deletion outcomes outlive the Vault and membership rows.
-- The existing applied/rejected shapes for every prior kind remain unchanged.
ALTER TABLE operation_outcome DROP CONSTRAINT operation_outcome_result_shape;
ALTER TABLE operation_outcome DROP CONSTRAINT operation_outcome_applied_payload_size;
ALTER TYPE public.operation_kind RENAME TO operation_kind_before_vault_mutations;
CREATE TYPE public.operation_kind AS ENUM ('create_item', 'update_item', 'set_item_favorite', 'trash_item', 'restore_item', 'move_item', 'permanently_delete_item', 'create_share', 'create_vault', 'import_items', 'create_vault_member_removal_rotation_plans', 'finalize_vault_member_removal_rotation_plans', 'create_team_leave_rotation_plans', 'finalize_team_leave_rotation_plans', 'create_team_member_removal_rotation_plans', 'finalize_team_member_removal_rotation_plans', 'update_vault', 'delete_vault');
ALTER TABLE operation_outcome ALTER COLUMN operation_kind TYPE public.operation_kind USING operation_kind::text::public.operation_kind;
DROP TYPE public.operation_kind_before_vault_mutations;

ALTER TABLE operation_outcome
    ADD CONSTRAINT operation_outcome_result_shape CHECK ((
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
                (operation_kind IN ('create_vault', 'update_vault', 'delete_vault')
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
                    AND applied_payload - ARRAY['vaultId', 'importedCount'] = '{}'::jsonb)
                OR
                (operation_kind IN ('create_vault_member_removal_rotation_plans', 'finalize_vault_member_removal_rotation_plans', 'create_team_leave_rotation_plans', 'finalize_team_leave_rotation_plans', 'create_team_member_removal_rotation_plans', 'finalize_team_member_removal_rotation_plans')
                    AND entity_id IS NULL AND entity_version IS NULL
                    AND rotation_operation_payload_valid(operation_kind::text, applied_payload)))
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
                    AND rejection_code IN ('invalid_ciphertext', 'vault_access_denied', 'vault_read_only', 'item_id_conflict', 'item_not_found', 'item_version_conflict', 'item_trashed', 'item_not_trashed', 'source_vault_mismatch', 'target_vault_access_denied', 'target_vault_read_only', 'attachment_state_conflict'))
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
                (operation_kind IN ('update_vault', 'delete_vault')
                    AND rejection_details IS NULL
                    AND rejection_code = 'vault_access_denied')
                OR
                (operation_kind = 'import_items'
                    AND rejection_details IS NULL
                    AND rejection_code IN (
                        'invalid_ciphertext',
                        'vault_access_denied',
                        'vault_read_only',
                        'item_id_conflict'
                    ))
                OR (operation_kind = 'create_vault_member_removal_rotation_plans' AND rejection_code IN ('vault_access_denied', 'vault_member_not_found', 'self_removal_forbidden', 'vault_owner_protected', 'vault_admin_peer_protected', 'shared_vault_required', 'vault_sharing_entitlement_denied') AND rejection_details IS NULL)
                OR (operation_kind = 'finalize_vault_member_removal_rotation_plans' AND rejection_code IN ('vault_access_denied', 'vault_membership_changed', 'self_removal_forbidden', 'vault_owner_protected', 'vault_admin_peer_protected', 'shared_vault_required', 'vault_sharing_entitlement_denied', 'rotation_plan_unavailable', 'rotation_plan_mismatch', 'rotation_plan_incomplete', 'rotation_plan_stale')
                    AND ((rejection_code <> 'rotation_plan_stale' AND rejection_details IS NULL)
                        OR (rejection_code = 'rotation_plan_stale' AND jsonb_typeof(rejection_details) = 'object'
                            AND rejection_details ?& ARRAY['planId','reason']
                            AND rejection_details - ARRAY['planId','reason'] = '{}'::jsonb
                            AND jsonb_typeof(rejection_details->'planId') = 'string'
                            AND length(rejection_details->>'planId') > 0
                            AND rejection_details->>'reason' IN ('vault_version','member_set','item_state','attachment_state'))))
                OR (operation_kind = 'create_team_leave_rotation_plans' AND rejection_code IN ('team_member_not_found', 'personal_team_departure_forbidden', 'team_owner_leave_forbidden') AND rejection_details IS NULL)
                OR (operation_kind = 'finalize_team_leave_rotation_plans' AND rejection_code IN ('team_membership_changed', 'personal_team_departure_forbidden', 'team_owner_leave_forbidden', 'rotation_plan_unavailable', 'rotation_plan_mismatch', 'rotation_plan_incomplete', 'rotation_plan_stale', 'rotation_plan_set_mismatch')
                    AND ((rejection_code <> 'rotation_plan_stale' AND rejection_details IS NULL)
                        OR (rejection_code = 'rotation_plan_stale' AND jsonb_typeof(rejection_details) = 'object'
                            AND rejection_details ?& ARRAY['planId','reason']
                            AND rejection_details - ARRAY['planId','reason'] = '{}'::jsonb
                            AND jsonb_typeof(rejection_details->'planId') = 'string'
                            AND length(rejection_details->>'planId') > 0
                            AND rejection_details->>'reason' IN ('vault_version','member_set','item_state','attachment_state'))))
                OR (operation_kind = 'create_team_member_removal_rotation_plans' AND rejection_code IN ('team_member_not_found', 'personal_team_departure_forbidden', 'self_removal_forbidden', 'team_management_denied', 'team_owner_protected', 'team_management_entitlement_denied', 'vault_management_incomplete') AND rejection_details IS NULL)
                OR (operation_kind = 'finalize_team_member_removal_rotation_plans' AND rejection_code IN ('team_membership_changed', 'personal_team_departure_forbidden', 'self_removal_forbidden', 'team_management_denied', 'team_owner_protected', 'team_management_entitlement_denied', 'vault_management_incomplete', 'rotation_plan_unavailable', 'rotation_plan_mismatch', 'rotation_plan_incomplete', 'rotation_plan_stale', 'rotation_plan_set_mismatch')
                    AND ((rejection_code <> 'rotation_plan_stale' AND rejection_details IS NULL)
                        OR (rejection_code = 'rotation_plan_stale' AND jsonb_typeof(rejection_details) = 'object'
                            AND rejection_details ?& ARRAY['planId','reason']
                            AND rejection_details - ARRAY['planId','reason'] = '{}'::jsonb
                            AND jsonb_typeof(rejection_details->'planId') = 'string'
                            AND length(rejection_details->>'planId') > 0
                            AND rejection_details->>'reason' IN ('vault_version','member_set','item_state','attachment_state')))))
            )
    ) IS TRUE);

-- Rotation arrays reflect the complete Team set; the prior 4KiB cap remains for other kinds.
ALTER TABLE operation_outcome ADD CONSTRAINT operation_outcome_applied_payload_size CHECK (
    applied_payload IS NULL OR operation_kind IN ('create_vault_member_removal_rotation_plans', 'finalize_vault_member_removal_rotation_plans', 'create_team_leave_rotation_plans', 'finalize_team_leave_rotation_plans', 'create_team_member_removal_rotation_plans', 'finalize_team_member_removal_rotation_plans') OR octet_length(applied_payload::text) <= 4096
);
