-- Object ownership outlives the Vault/User whose transaction retired its last reference.
-- No foreign key may erase a physical deletion duty during Account or Vault teardown.
CREATE TABLE vault_image_cleanup (
    object_key text PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vault_image_cleanup_pending_idx ON vault_image_cleanup(last_attempted_at, created_at, object_key);
