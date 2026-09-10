-- Rotation joins the lifetime semantic contract. Historical response-cache migrations stay frozen.
ALTER TABLE operation_outcome DROP CONSTRAINT operation_outcome_result_shape;
ALTER TABLE operation_outcome DROP CONSTRAINT operation_outcome_applied_payload_size;
ALTER TYPE public.operation_kind RENAME TO operation_kind_before_rotation;
CREATE TYPE public.operation_kind AS ENUM ('create_item', 'update_item', 'set_item_favorite', 'trash_item', 'restore_item', 'move_item', 'permanently_delete_item', 'create_share', 'create_vault', 'import_items', 'create_vault_member_removal_rotation_plans', 'finalize_vault_member_removal_rotation_plans', 'create_team_leave_rotation_plans', 'finalize_team_leave_rotation_plans', 'create_team_member_removal_rotation_plans', 'finalize_team_member_removal_rotation_plans');
ALTER TABLE operation_outcome ALTER COLUMN operation_kind TYPE public.operation_kind USING operation_kind::text::public.operation_kind;
DROP TYPE public.operation_kind_before_rotation;
ALTER TYPE public.operation_rejection_code RENAME TO operation_rejection_code_before_rotation;
CREATE TYPE public.operation_rejection_code AS ENUM ('invalid_ciphertext', 'vault_access_denied', 'vault_read_only', 'item_id_conflict', 'item_not_found', 'item_version_conflict', 'item_trashed', 'item_not_trashed', 'source_vault_mismatch', 'target_vault_access_denied', 'target_vault_read_only', 'attachment_state_conflict', 'share_entitlement_denied', 'share_limit_reached', 'vault_id_conflict', 'team_membership_required', 'vault_sharing_entitlement_denied', 'shared_vault_limit_reached', 'vault_member_not_found', 'self_removal_forbidden', 'vault_owner_protected', 'vault_admin_peer_protected', 'shared_vault_required', 'vault_membership_changed', 'rotation_plan_unavailable', 'rotation_plan_mismatch', 'rotation_plan_incomplete', 'rotation_plan_stale', 'team_member_not_found', 'personal_team_departure_forbidden', 'team_owner_leave_forbidden', 'team_membership_changed', 'rotation_plan_set_mismatch', 'team_management_denied', 'team_owner_protected', 'team_management_entitlement_denied', 'vault_management_incomplete');
ALTER TABLE operation_outcome ALTER COLUMN rejection_code TYPE public.operation_rejection_code USING rejection_code::text::public.operation_rejection_code;
DROP TYPE public.operation_rejection_code_before_rotation;

-- CHECK constraints cannot contain subqueries. This immutable validator closes every array record;
-- cardinality is one for Vault removal and unbounded for the authoritative Team Vault set.
CREATE FUNCTION rotation_operation_payload_valid(kind text, payload jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    entry jsonb;
    entries jsonb;
    field text;
    fields text[];
    version_field text;
    creation boolean := kind LIKE 'create_%';
    vault_removal boolean := kind LIKE '%vault_member_removal%';
BEGIN
    IF jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF creation THEN
        IF NOT payload ? 'plans' OR payload - 'plans' <> '{}'::jsonb THEN RETURN false; END IF;
        entries := payload->'plans';
        fields := ARRAY['id','vaultId','initiatorUserId','state','idleExpiresAt','absoluteExpiresAt'];
        version_field := 'expectedKeyVersion';
    ELSE
        IF vault_removal THEN
            IF NOT payload ? 'rotations' OR payload - 'rotations' <> '{}'::jsonb THEN RETURN false; END IF;
        ELSE
            IF NOT payload ?& ARRAY['rotations','personalTeamId'] OR payload - ARRAY['rotations','personalTeamId'] <> '{}'::jsonb
                OR jsonb_typeof(payload->'personalTeamId') IS DISTINCT FROM 'string' OR length(payload->>'personalTeamId') = 0 THEN RETURN false; END IF;
        END IF;
        entries := payload->'rotations';
        fields := ARRAY['planId','vaultId','rotationId'];
        version_field := 'keyVersion';
    END IF;
    IF jsonb_typeof(entries) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    IF vault_removal AND jsonb_array_length(entries) <> 1 THEN RETURN false; END IF;
    FOR entry IN SELECT value FROM jsonb_array_elements(entries) LOOP
        IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR NOT entry ?& (fields || version_field)
            OR entry - (fields || version_field) <> '{}'::jsonb THEN RETURN false; END IF;
        FOREACH field IN ARRAY fields LOOP
            IF jsonb_typeof(entry->field) IS DISTINCT FROM 'string' OR length(entry->>field) = 0 THEN RETURN false; END IF;
        END LOOP;
        IF creation AND entry->>'state' <> 'preparing' THEN RETURN false; END IF;
        IF jsonb_typeof(entry->version_field) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
        IF (entry->>version_field)::numeric <> trunc((entry->>version_field)::numeric)
            OR (entry->>version_field)::numeric NOT BETWEEN 1 AND 2147483647 THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
END;
$$;

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
