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
