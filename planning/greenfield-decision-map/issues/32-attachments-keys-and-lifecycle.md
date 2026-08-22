# Attachments: keys, chunking, and lifecycle

Type: grilling
Status: ready-for-human
Blocked by: 08, 15

## Question

Settled already: Attachments are **first-class in the first release**, with **no quotas** and as few configuration options as possible. The frozen product gates them behind optional S3 and a billing entitlement, and GCs orphaned uploads every 15 minutes. Both gates are gone.

Decide:

- Per-Attachment key wrapping under the Vault key, and what rotation rewrites.
- Chunking and streaming: whether large files are chunked, and how integrity is verified.
- Upload lifecycle: pending state, resumption, and orphan collection without a quota to bound it.
- Offline pinning: what is downloaded eagerly, what on demand, and who chooses.
- Storage adapters, including whether local disk is first-class alongside object storage.
- What the Server learns: size, count, MIME type, and whether any of that is padded or hidden.
- Attachment names, which `ITEM-003` encrypts.

Produces: `ATTACH-001` promotion to first-release requirements and a storage specification.

### Inherited from ticket 08, key hierarchy and canonical envelope format

`CRYPTO-013` settles the framing: an Attachment is a sequence of independent envelopes, one per chunk,
each binding the Attachment identifier, its chunk index, and the **total chunk count**. Binding the
count is what makes truncation fail to decrypt rather than read as a short file. Chunking cannot move
above the format, because an AEAD tag verifies only once a whole message is present.

Chunk size, resumability, pinning, and lifecycle remain this ticket's. `CRYPTO-001` keeps the
per-Attachment key wrapped by the Vault key (context `0x21`), and `PRIVACY-007` already exposes chunk
count and total byte size, so the binding leaks nothing new. The signed Item revision commits to each
wrapped-key envelope and the ordered SHA-256 digest of every chunk envelope; this ticket must define
when that manifest becomes final during upload and how resumable work is promoted atomically. Its
chunk-size choice cannot exceed `CRYPTO-003`'s 32 MiB plaintext-per-envelope ceiling.

### Inherited from Vault key rotation and epochs

A Vault-key rotation rewrites no existing Attachment-key envelope, Item manifest, or Attachment
chunk. Each remains under the epoch it already names, and historical grants remain while it is
retained. A newly created Attachment key consumes one context `0x21` reservation from the current
Vault epoch; context `0x22` chunk envelopes spend the Attachment key's separate `CRYPTO-003` limit.

Compromise or replacement of one Attachment key does not trigger Vault rotation. This ticket still
owns whether that Attachment is re-encrypted under a fresh key and how such a replacement becomes a
new signed manifest revision.

### Inherited from Sync protocol: cursor, bootstrap, and retention windows

A current Trash Tombstone forces retention of the referenced last live Item revision and all
Attachment keys and bytes required to restore it, regardless of ordinary revision retention.
Permanent deletion atomically removes that material and retains only the signed content-free
Tombstone Deletion Fence. This ticket defines upload/download/chunk and ordinary Attachment lifecycle
without weakening those Trash boundaries.
