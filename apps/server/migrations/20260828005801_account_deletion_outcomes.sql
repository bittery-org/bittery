-- Write migration SQL here
CREATE TABLE "account_deletion_outcome" (
	"request_id" uuid PRIMARY KEY,
	"credential_proof" bytea NOT NULL CHECK (octet_length("credential_proof") = 32),
	"request_fingerprint" bytea NOT NULL CHECK (octet_length("request_fingerprint") = 32),
	"outcome" text NOT NULL CHECK (
		"outcome" IN ('deleted', 'confirmationMismatch', 'accountDeletionBlocked')
	),
	"created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "account_deletion_outcome_deleted_proof_unique"
	ON "account_deletion_outcome" ("credential_proof")
	WHERE "outcome" = 'deleted';
