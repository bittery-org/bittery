# Server Operation outcome contract

Type: research
Status: resolved
Blocked by: 05, 06, 07, 09, 10

## Question

Derive the in-place Server contract that gives a retried create-Item Operation one durable semantic
outcome committed atomically with its Domain effect or proved non-effect.

## Evidence

- Current HTTP idempotency commits a claim before the Domain call and stores response bytes after it.
  A committed Item can therefore exist without a durable result.
- Current completed records expire after 24 hours and stale claims become indeterminate.
- Current create-Item Domain code already commits Item, audit, and Item Sync event together, but its
  access checks occur before that transaction.
- The existing Item route already accepts `Idempotency-Key` and a client-chosen final Item ID.

## Answer

Add a deep Server Operation module and an Account-lifetime `operation_outcome` table keyed by
`(user_id, operation_id)`. `Idempotency-Key` becomes the required stable Operation ID on durable
mutation routes. The Server independently fingerprints operation kind, route identity, canonical
path values, exact raw request bytes, and any normalized concurrency precondition; authentication,
Session, and transport-only headers are excluded.

For create Item, one PostgreSQL transaction takes a transaction-scoped lock for `(user_id,
operation_id)`, then reads any retained outcome. An identical fingerprint replays it; a different
fingerprint returns `OPERATION_ID_REUSED`. With no outcome, the same transaction performs validation
and authorization, applies the Item or proves a closed semantic rejection, writes its audit and Sync
records, inserts the final outcome, and commits. Infrastructure and authentication failures roll back
without an outcome. No unresolved Operation row can commit.

The existing `PUT /vaults/{vaultId}/items/{itemId}` returns a generated closed applied/rejected
Operation-outcome body. A distinct Operation ID racing for the same Item ID receives a retained
semantic conflict rather than an aborted unique-constraint transaction. Authenticated
`GET /operations/{operationId}` returns the same User-scoped generated type after response loss.

Every terminal outcome emits a User-scoped `operation_resolved` Sync event; an applied create also
retains the existing `item_created` event. Bootstrap does not enumerate lifetime outcome history:
local pending IDs use retry or lookup, and later outcomes arrive through current bounded changes.

All current HTTP-response-cache idempotency users must move to semantic domain outcomes before the
old table, expiry, claim lifecycle, errors, and wrappers are removed. Temporary internal sequencing
does not create a second public API version or a shippable dual protocol.
