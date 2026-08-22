# Sync is a per-Account transaction stream

Bittery gives each Account one ordered Sync stream and maps one Server transaction to one atomic Sync
Commit per affected Account. This deliberately pays the write-time fan-out cost instead of giving a
client a growing per-Vault Cursor vector or coupling it to a Server-global sequence; the result is one
small rollback-pinnable Cursor, one atomic Replica apply boundary, and a direct commit marker for every
ordinary Operation.
