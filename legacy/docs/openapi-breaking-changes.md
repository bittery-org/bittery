# Approved OpenAPI breaking changes

These changes belong to the coordinated staged Vault-key-rotation cutover. The product clients,
server and generated contract ship together, so the superseded rotation protocol is not retained.
Each line below is intentionally scoped to one oasdiff error; unrelated breaking changes remain
blocked by CI.

- Auth operation IDs changed from their implicit snake_case Rust handler names to explicit camelCase names; HTTP paths, methods, payloads, and security requirements are unchanged

- POST /api/v1/items/{itemId}/attachment-uploads removed the required property `publicUrl` from the response with the `200` status
- POST /api/v1/items/{itemId}/attachments added the new required request property `attachmentId`
- POST /api/v1/items/{itemId}/attachments added the new required request property `attachmentKeyAlgorithm`
- POST /api/v1/items/{itemId}/attachments added the new required request property `attachmentKeyIv`
- POST /api/v1/items/{itemId}/attachments added the new required request property `encryptedAttachmentKey`
- POST /api/v1/items/{itemId}/attachments added the new required request property `envelopeVersion`
- POST /api/v1/teams/{teamId}/leave api path removed without deprecation
- GET /api/v1/teams/{teamId}/leave-rotation-data api path removed without deprecation
- DELETE /api/v1/teams/{teamId}/members/{userId} api path removed without deprecation
- GET /api/v1/teams/{teamId}/members/{userId}/removal-rotation-data api path removed without deprecation
- DELETE /api/v1/vaults/{vaultId}/members/{userId} api removed without deprecation
- GET /api/v1/vaults/{vaultId}/members/{userId}/removal-rotation-data api path removed without deprecation
