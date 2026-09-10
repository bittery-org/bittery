-- The retained Operation outcome now covers every Item mutation, not create alone, so both closed
-- sets widen. The rejection set becomes one shared type because a single column has to hold it and
-- because one fact -- "the Vault is read only" -- must keep one name across kinds.

ALTER TYPE public.operation_kind RENAME TO operation_kind_create_only;

CREATE TYPE public.operation_kind AS ENUM (
    'create_item',
    'update_item',
    'set_item_favorite',
    'trash_item',
    'restore_item',
    'move_item',
    'permanently_delete_item'
);

ALTER TABLE operation_outcome
    ALTER COLUMN operation_kind TYPE public.operation_kind
    USING operation_kind::text::public.operation_kind;

DROP TYPE public.operation_kind_create_only;

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
    'target_vault_read_only'
);

ALTER TABLE operation_outcome
    ALTER COLUMN rejection_code TYPE public.operation_rejection_code
    USING rejection_code::text::public.operation_rejection_code;

DROP TYPE public.create_item_rejection_code;
