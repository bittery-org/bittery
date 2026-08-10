# Idempotency recovery

Idempotency claims are committed before a domain service starts because services own their
transactions. A server crash can therefore leave a claim without proving whether the domain
transaction committed. After five minutes, Bittery marks that claim `indeterminate` and returns
`409 IDEMPOTENCY_OUTCOME_INDETERMINATE` for every replay. It never executes the mutation again
automatically.

Expired completed records are deleted in bounded batches during later claims. Indeterminate
records are deliberately retained until an operator resolves them, so cleanup cannot turn an
unknown committed mutation into a duplicate execution.

## Operator recovery

1. Identify the row by `principal_id`, `method`, `route_target`, and `idempotency_key`.
2. Verify the resource and audit/sync-event state for that exact principal and route. Do not infer
   the outcome from the idempotency row alone.
3. If the mutation committed, reconstructing a response is not safe without all original response
   fields. Leave the row in place and repair or clear the client queue through an authenticated
   support procedure.
4. Only if the mutation is proven not to have committed, delete that exact indeterminate row in a
   transaction. The client may then retry with the same key.

The deletion must target the complete primary key and terminal state:

```sql
DELETE FROM idempotency_record
WHERE principal_id = $1
  AND method = $2
  AND route_target = $3
  AND idempotency_key = $4
  AND state = 'indeterminate';
```

Never bulk-delete indeterminate rows or resolve them based only on age.
