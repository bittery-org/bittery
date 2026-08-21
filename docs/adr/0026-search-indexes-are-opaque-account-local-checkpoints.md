# Search indexes are opaque Account-local checkpoints

Status: accepted

Bittery persists one encrypted Search Index snapshot per Account and combines Accounts only in
volatile unlocked memory. A fresh random key protects each opaque chunked snapshot, and canonical
changes invalidate then asynchronously replace it instead of persisting observable term postings or
blocking every mutation on a whole-index rewrite. This deliberately accepts aggregate ciphertext size
and occasional progressive rebuilds to avoid durable domain, term-frequency, and cross-Account
linkage; the locked mobile Suggestion Index remains a separately Device-protected bounded projection.
