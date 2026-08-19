# Bittery Security Audit - Phase 5: Input Validation & Injection

> Note: `apps/server`, `packages/api`, and `packages/auth` were removed after the Rust server cutover. Any references to those paths in this document are historical audit context, not current implementation guidance.

## 1. Summary

Bittery's input-validation posture is mixed.

The good news is that I did not find a server-side SQL injection path in the current codebase. Raw SQL usage is limited, parameterized through Drizzle's `sql\`\`` template, and I did not find string-built `ORDER BY`, table-name, or column-name injection patterns. The SSE sync endpoint is also materially better than a typical implementation: connection setup is authenticated from the bearer token, the server derives vault membership from the database rather than trusting a client-supplied topic selector, and the endpoint enforces a per-user concurrent-connection cap.

The main weaknesses are input-shape and size enforcement. Almost every tRPC object schema is "loose" in the Zod sense because no route uses `.strict()`, and many routes that accept encrypted blobs, SRP material, or large nested arrays do not place meaningful `.max()` limits on strings or arrays. That creates a broad authenticated denial-of-service and storage-abuse surface. Outside the API, the highest-risk issue in this phase is the desktop native bridge: it exposes sensitive local data and decryption functions over an unauthenticated loopback HTTP server with `Access-Control-Allow-Origin: *`. I also found a high-severity browser-extension message-origin flaw where content scripts trust forged `window.postMessage` traffic from the page, and a mobile credential-provider fallback that broadens results to "all logins" when origin validation fails.

Overall assessment: injection resistance is good at the SQL layer, but external-input validation is inconsistent, and local-bridge / extension trust-boundary handling needs immediate hardening.

## 2. Input Schema Map

All tRPC object schemas reviewed were either `loose` or `missing`. I found no route using `z.any()`, `z.unknown()`, `.passthrough()`, or `.strict()`.

### Core Routes

| Route | Has input schema | Schema quality | Notable gaps |
| --- | --- | --- | --- |
| `healthCheck` | No | missing | No external body/query input. |
| `privateData` | No | missing | No external body/query input beyond session context. |

### Auth Router

| Route | Has input schema | Schema quality | Notable gaps |
| --- | --- | --- | --- |
| `auth.registrationStatus` | No | missing | No external body/query input. |
| `auth.requestSignupVerification` | Yes | loose | Email is bounded; `invitationToken` is a bare string and the object is not strict. |
| `auth.verifySignupVerification` | Yes | loose | Email and code are validated, but `invitationToken` is a bare string and the object is not strict. |
| `auth.signup` | Yes | loose | Multiple encrypted/SRP fields are unbounded bare strings; object is not strict. |
| `auth.signupWithInvitation` | Yes | loose | Same pattern as `auth.signup`: unbounded encrypted/SRP strings and loose identifiers. |
| `auth.startLogin` | Yes | loose | `clientPublicKey` has a max length, but format is not constrained to hex and the object is not strict. |
| `auth.finishLogin` | Yes | loose | Length caps exist, but `attemptId`, `clientPublicKey`, and `clientProof` are not format-constrained. |
| `auth.checkEmail` | Yes | loose | Well-bounded email input; object is not strict. |
| `auth.requestRecoveryVerification` | Yes | loose | Well-bounded email input; object is not strict. |
| `auth.verifyRecoveryCode` | Yes | loose | Email and 6-digit code are validated; object is not strict. |
| `auth.getRecoveryData` | Yes | loose | `recoveryToken` is a bare string with only `.min(1)`. |
| `auth.resetPassword` | Yes | loose | SRP fields and encrypted blobs are unbounded; `encryptedVaultKeys` has no `.max()`. |
| `auth.me` | No | missing | No external body/query input. |
| `auth.logout` | No | missing | No external body/query input. |
| `auth.refreshSession` | No | missing | No external body/query input. |
| `auth.logoutAll` | No | missing | No external body/query input. |
| `auth.updateEmail` | Yes | loose | New email is validated, but SRP/encrypted fields are unbounded and `encryptedVaultKeys` has no `.max()`. |
| `auth.changePassword` | Yes | loose | SRP/encrypted fields are unbounded and `encryptedVaultKeys` has no `.max()`. |
| `auth.regenerateSecretKey` | Yes | loose | SRP/encrypted fields are unbounded and `encryptedVaultKeys` has no `.max()`. |
| `auth.storeRecoveryKey` | Yes | loose | `encryptedMasterKey` and `recoveryKeyHint` are unbounded strings. |
| `auth.deleteAccount` | Yes | loose | Confirmation email is validated; object is not strict. |
| `auth.listDevices` | No | missing | No external body/query input. |
| `auth.revokeDevice` | Yes | loose | `sessionId` is a bare string. |
| `auth.renameDevice` | Yes | loose | `deviceName` is bounded, but `sessionId` is a bare string. |
| `auth.heartbeat` | No | missing | No external body/query input. |

### Billing Router

| Route | Has input schema | Schema quality | Notable gaps |
| --- | --- | --- | --- |
| `billing.status` | No | missing | No external body/query input. |
| `billing.entitlements` | No | missing | No external body/query input. |
| `billing.attachmentUsage` | No | missing | No external body/query input. |
| `billing.createCheckoutSession` | Yes | loose | Enum-based `plan` is good; object still is not strict. |
| `billing.createPortalSession` | No | missing | No external body/query input. |
| `billing.syncSeats` | Yes | loose | Optional `teamId` is a bare string. |
| `billing.previewAdditionalTeamSeat` | No | missing | No external body/query input. |

### Share Router

| Route | Has input schema | Schema quality | Notable gaps |
| --- | --- | --- | --- |
| `share.create` | Yes | loose | `itemId` is a bare string; `allowedEmails` has no `.max()`; encrypted share blobs are unbounded. |
| `share.listByItem` | Yes | loose | `itemId` is a bare string. |
| `share.get` | Yes | loose | `linkId` is a bare string. |
| `share.revoke` | Yes | loose | `linkId` is a bare string. |
| `share.update` | Yes | loose | `linkId` is a bare string; `addEmails` and `removeEmailIds` have no `.max()`. |
| `share.getAccessLogs` | Yes | loose | Identifier/cursor fields are bare strings; object is not strict. |
| `share.getPublicInfo` | Yes | loose | `token` is a bare string. |
| `share.requestEmailVerification` | Yes | loose | `token` is a bare string; email is validated. |
| `share.verifyEmailAndAccess` | Yes | loose | Email and code are validated, but `token` is a bare string and the route trusts client-supplied `ipAddress` / `userAgent`. |
| `share.accessPublic` | Yes | loose | `token` is a bare string and the route trusts client-supplied `ipAddress` / `userAgent`. |

### Sync Router

| Route | Has input schema | Schema quality | Notable gaps |
| --- | --- | --- | --- |
| `sync.getEventsSince` | Yes | loose | `limit` is bounded, but `sinceId` and `vaultIds[]` are bare strings and `vaultIds` has no `.max()`. |
| `sync.bootstrapItems` | Yes | loose | `limit` is bounded, but `cursor` is a bare string. |
| `sync.getSyncState` | Yes | loose | `vaultIds[]` is unbounded. |
| `sync.acknowledgeEvents` | Yes | loose | `eventIds[]` is unbounded and `clientId` is a bare string. |
| `sync.getLastAcknowledged` | Yes | loose | `clientId` is a bare string. |
| `sync.checkConflict` | Yes | loose | `itemId` is a bare string and `expectedVersion` has no explicit integer/min constraint. |

### Team Router

| Route | Has input schema | Schema quality | Notable gaps |
| --- | --- | --- | --- |
| `team.list` | No | missing | No external body/query input. |
| `team.get` | Yes | loose | `teamId` is a bare string. |
| `team.create` | Yes | loose | Object is not strict; user-facing fields are not consistently length-bounded. |
| `team.update` | Yes | loose | `teamId` is a bare string; mutable text fields are not consistently bounded. |
| `team.createImageUpload` | Yes | loose | File metadata fields are not consistently bounded. |
| `team.delete` | Yes | loose | `teamId` is a bare string. |
| `team.leave` | Yes | loose | Deeply nested `vaultRotations/memberKeys/reEncryptedItems` arrays have no `.max()` and encrypted blobs are unbounded. |
| `team.getLeaveRotationData` | Yes | loose | `teamId` is a bare string. |
| `team.members.list` | Yes | loose | `teamId` is a bare string. |
| `team.members.getTeamRotationData` | Yes | loose | `teamId` / `userId` are bare strings. |
| `team.members.remove` | Yes | loose | Nested rotation arrays are unbounded and encrypted blobs are unbounded. |
| `team.members.deleteAccount` | Yes | loose | Identifier fields are bare strings. |
| `team.vaults` | Yes | loose | `teamId` is a bare string. |
| `team.invitations.getByToken` | Yes | loose | `token` is a bare string. |
| `team.invitations.list` | Yes | loose | `teamId` is a bare string. |
| `team.invitations.send` | Yes | loose | Identifier fields are bare strings; nested pending-vault-key arrays are not tightly bounded. |
| `team.invitations.cancel` | Yes | loose | `invitationId` is a bare string. |
| `team.invitations.resend` | Yes | loose | `invitationId` is a bare string. |
| `team.invitations.pending` | No | missing | No external body/query input. |
| `team.invitations.accept` | Yes | loose | `token` plus key-material fields are accepted in a non-strict object. |
| `team.invitations.decline` | Yes | loose | `token` is a bare string. |

### Vault Router

| Route | Has input schema | Schema quality | Notable gaps |
| --- | --- | --- | --- |
| `vault.get` | Yes | loose | `vaultId` is a bare string. |
| `vault.list` | No | missing | No external body/query input. |
| `vault.createImageUpload` | Yes | loose | File metadata fields are not consistently bounded. |
| `vault.create` | Yes | loose | Vault identifiers and encrypted vault-key fields are unbounded/non-strict. |
| `vault.update` | Yes | loose | `vaultId` is a bare string; mutable text/icon fields are not consistently bounded. |
| `vault.convertType` | Yes | loose | Identifier fields are bare strings and key-rotation payloads are not tightly bounded. |
| `vault.delete` | Yes | loose | `vaultId` is a bare string. |
| `vault.listItems` | Yes | loose | Identifier/cursor fields are bare strings; pagination arrays/filters are not tightly bounded. |
| `vault.listAllItems` | No | missing | No external body/query input. |
| `vault.listAllDeletedItems` | No | missing | No external body/query input. |
| `vault.getItem` | Yes | loose | `itemId` is a bare string. |
| `vault.createItem` | Yes | loose | Encrypted item payload fields are unbounded strings. |
| `vault.bulkImportItems` | Yes | loose | `items[]` has no `.max()` and nested encrypted fields are unbounded. |
| `vault.updateItem` | Yes | loose | `itemId` is a bare string; encrypted payload fields are unbounded. |
| `vault.toggleFavorite` | Yes | loose | `itemId` is a bare string. |
| `vault.deleteItem` | Yes | loose | `itemId` is a bare string. |
| `vault.listDeletedItems` | Yes | loose | Identifier/cursor fields are bare strings. |
| `vault.restoreItem` | Yes | loose | `itemId` is a bare string. |
| `vault.moveItem` | Yes | loose | Item/vault identifiers are bare strings; re-encrypted payload fields are unbounded. |
| `vault.permanentlyDeleteItem` | Yes | loose | `itemId` is a bare string. |
| `vault.stats` | No | missing | No external body/query input. |
| `vault.createAttachmentUpload` | Yes | loose | Size is validated positive, but filename/content-type fields are not tightly bounded. |
| `vault.createAttachment` | Yes | loose | Storage identifiers are bare strings and encrypted metadata fields are unbounded. |
| `vault.listAttachments` | Yes | loose | `itemId` is a bare string. |
| `vault.getAttachmentDownloadUrl` | Yes | loose | `attachmentId` is a bare string. |
| `vault.updateAttachment` | Yes | loose | `attachmentId` is a bare string; encrypted metadata fields are unbounded. |
| `vault.deleteAttachment` | Yes | loose | `attachmentId` is a bare string. |
| `vault.members.list` | Yes | loose | `vaultId` is a bare string. |
| `vault.members.availableTeamMembers` | Yes | loose | `vaultId` is a bare string. |
| `vault.members.updateRole` | Yes | loose | Identifier fields are bare strings; role enum is good, object is not strict. |
| `vault.members.remove` | Yes | loose | Identifier fields are bare strings and rotation payloads are not tightly bounded. |
| `vault.members.getRotationData` | Yes | loose | `vaultId` is a bare string. |
| `vault.members.lookupUser` | Yes | loose | Identifier/search fields are accepted in a non-strict object. |
| `vault.members.add` | Yes | loose | Identifier fields are bare strings; wrapped key material is not tightly bounded. |

### Audit Router

| Route | Has input schema | Schema quality | Notable gaps |
| --- | --- | --- | --- |
| `audit.teamEvents` | Yes | loose | This is one of the better schemas: bounded `limit`, bounded `search`, enums for filters; `cursor` and `actorUserId` remain bare strings and the object is not strict. |

## 3. Findings

### Finding 1: Unauthenticated local desktop bridge exposes bearer tokens, vault keys, and plaintext decryption to any local web page

Status update (March 11, 2026):
- The loopback HTTP bridge on `127.0.0.1:48765` has been removed.
- Desktop-extension communication now uses native messaging plus desktop-local IPC, and the desktop app no longer exposes `/native-bridge/*` HTTP endpoints.
- This finding remains here as historical audit context for the removed design.

- Severity: Critical
- Location:
  - `apps/desktop/src-tauri/src/lib.rs:142-166`
  - `apps/desktop/src-tauri/src/lib.rs:176-205`
  - `apps/desktop/src-tauri/src/lib.rs:447-595`
  - `apps/desktop/src-tauri/src/lib.rs:1118-1456`
- Description:
  - The desktop app starts an HTTP server on `127.0.0.1:48765` and exposes multiple `/native-bridge/*` endpoints without any authentication or origin verification.
  - Sensitive read endpoints return data with `Access-Control-Allow-Origin: *`, including:
    - account inventory,
    - session bearer tokens and user ids,
    - persisted vault keys,
    - decrypted item contents via `/native-bridge/decrypt-items`.
  - The POST decryption endpoint also reads the full request body into memory and calls `String::from_utf8(...).unwrap()`, so malformed or very large input can crash or exhaust the bridge in addition to leaking data.
- Attack scenario:
  1. The victim has the Bittery desktop app running and at least one account unlocked.
  2. The victim visits a malicious website in any browser on the same machine.
  3. The page issues `fetch("http://127.0.0.1:48765/native-bridge/session-data")` and reads the JSON response because the bridge allows `Access-Control-Allow-Origin: *`.
  4. The page steals `auth_token` values, enumerates accounts, and requests `/native-bridge/vault-keys`.
  5. The page can then call `/native-bridge/decrypt-items` with encrypted items obtained from extension state, sync state, or API responses and receive plaintext secrets back from the desktop app.
  6. If desired, the attacker can also send malformed or oversized JSON to destabilize the local bridge process.
- Recommended fix:
  - Remove the unauthenticated loopback HTTP surface for sensitive operations. Prefer Tauri IPC or a native-messaging channel that is authenticated per caller.
  - If a local HTTP bridge must exist, require all of the following:
    - a random per-session bearer token that is never exposed to ordinary web pages,
    - strict `Origin` allowlisting for the exact extension origin or app origin,
    - no wildcard CORS,
    - request-size limits before buffering the body,
    - typed request structs instead of `serde_json::Value`,
    - no `unwrap()` on untrusted input.
  - Example hardening sketch:

```rust
let origin = req.headers().get("origin").and_then(|v| v.to_str().ok());
if origin != Some(expected_extension_origin.as_str()) {
    return Ok(Response::builder()
        .status(StatusCode::FORBIDDEN)
        .body(Body::from("forbidden"))
        .unwrap());
}

let auth = req.headers().get("authorization").and_then(|v| v.to_str().ok());
if auth != Some(format!("Bearer {}", bridge_token).as_str()) {
    return Ok(Response::builder()
        .status(StatusCode::UNAUTHORIZED)
        .body(Body::from("unauthorized"))
        .unwrap());
}
```

### Finding 2: Unbounded encrypted blobs and arrays create a broad API denial-of-service and storage-abuse surface

- Severity: High
- Location:
  - `packages/api/src/routers/auth.ts:387-405`
  - `packages/api/src/routers/auth.ts:1045-1061`
  - `packages/api/src/routers/auth.ts:1208-1321`
  - `packages/api/src/routers/share.ts:61-75`
  - `packages/api/src/routers/share.ts:406-413`
  - `packages/api/src/routers/sync.ts:37-43`
  - `packages/api/src/routers/sync.ts:217-262`
  - `packages/api/src/routers/team.ts:465-490`
  - `packages/api/src/routers/team.ts:957-983`
  - `packages/api/src/routers/vault.ts:1125-1146`
  - `apps/server/src/index.ts:23-75`
- Description:
  - Many API routes accept attacker-controlled encrypted strings and nested arrays without `.max()` limits.
  - Representative examples include:
    - SRP verifier/salt and encrypted key material in auth setup and recovery flows,
    - shared-item ciphertext and recipient email arrays,
    - sync `vaultIds[]` / `eventIds[]`,
    - team-rotation payloads with nested `memberKeys[]` and `reEncryptedItems[]`,
    - `vault.bulkImportItems.items[]` with unbounded ciphertext fields.
  - I also did not find a global HTTP request-body limit in the Hono server setup. That means the application relies almost entirely on per-route validation, and many of the relevant routes do not enforce practical size ceilings.
  - Because these fields are "encrypted" does not reduce abuse risk. The server still has to parse JSON, validate Zod objects, allocate memory, insert rows, write sync events, and sometimes run large transactional rotations.
- Attack scenario:
  1. An authenticated attacker creates or joins a vault.
  2. The attacker calls `vault.bulkImportItems` with tens of thousands of items, each containing very large ciphertext strings, or calls team/vault member-rotation routes with massive nested arrays.
  3. The server buffers the body, allocates large JS objects, validates them, and attempts heavy database work inside transactions.
  4. The attacker repeats the operation to consume CPU, memory, database storage, and sync-processing capacity.
  5. Other users experience degraded latency, failed writes, or storage exhaustion.
- Recommended fix:
  - Introduce central bounded Zod helpers and use them everywhere for IDs, ciphertexts, IVs, algorithm fields, and batch arrays.
  - Add a global request-body limit in front of `/trpc/*`.
  - Add per-user and per-team quotas for high-volume objects such as items, sync events, share emails, and rotation batches.
  - Example schema hardening pattern:

```ts
const idSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const ciphertextSchema = z.string().min(1).max(16_384);
const ivSchema = z.string().min(1).max(256);

const encryptedItemSchema = z.object({
  itemId: idSchema,
  encryptedData: ciphertextSchema,
  encryptionIv: ivSchema,
  encryptionAlgorithm: z.enum(["AES-GCM-AAD-V1"]),
});

const bulkImportSchema = z.object({
  vaultId: idSchema,
  clientId: idSchema.optional(),
  items: z.array(encryptedItemSchema).max(500),
}).strict();
```

### Finding 3: SRP registration and recovery flows accept malformed or oversized verifier material with weak format validation

- Severity: Medium
- Location:
  - `packages/api/src/routers/auth.ts:387-405`
  - `packages/api/src/routers/auth.ts:1045-1061`
  - `packages/api/src/routers/auth.ts:1208-1321`
  - `packages/auth/src/index.ts:241-285`
  - `packages/auth/src/index.ts:366-373`
  - `packages/crypto/core/crates/bittery-crypto-core/src/srp6a/server.rs:86-103`
- Description:
  - The login routes (`startLogin` / `finishLogin`) at least bound `clientPublicKey` and `clientProof`, but the account-establishment and account-rotation routes accept `srpSalt` and `srpVerifier` as unconstrained bare strings.
  - Those values are stored and later consumed by SRP server operations (`generateServerEphemeral`, `deriveServerSession`) which parse them as big integers.
  - That means malformed hex or oversized verifier material is not rejected at the API boundary. The first strong validation happens later in the crypto layer when the server is already attempting to use the stored values.
  - The crypto layer does correctly reject `A % N == 0`, but that does not solve the basic input-shape problem for persisted SRP fields.
- Attack scenario:
  1. An attacker signs up or resets a password using an oversized or malformed `srpVerifier` / `srpSalt`.
  2. The server stores the data because the route only requires `z.string()`.
  3. On later login attempts, the auth service parses and processes those values as SRP big integers.
  4. Depending on the payload, this causes repeated authentication failures, excessive CPU/memory use, or noisy server-side exceptions for that account.
  5. An attacker can automate this against many disposable accounts to create churn in authentication infrastructure.
- Recommended fix:
  - Validate SRP fields at the API boundary using exact or narrowly bounded hex schemas before storage.
  - Reject verifiers/salts outside expected lengths for the chosen SRP group and hash function.
  - Treat all SRP inputs as structured cryptographic types, not generic strings.
  - Example:

```ts
const srpHex = (max: number) =>
  z.string().regex(/^[0-9a-f]+$/i).max(max);

const srpSaltSchema = srpHex(128);
const srpVerifierSchema = srpHex(1024);
```

### Finding 4: Extension content scripts trust forged page `postMessage` events for autofill and save flows

- Severity: High
- Location:
  - `apps/extension/src/content-script/save-prompt.ts:154-187`
  - `apps/extension/src/content-script/save-prompt.ts:233-247`
  - `apps/extension/src/content-script/autofill/overlay-utils.ts:120-143`
  - `apps/extension/src/content-script/autofill/overlay-utils.ts:233-252`
- Description:
  - The save-prompt and autofill overlay handlers listen for `window` `message` events but do not verify `event.source`, `event.origin`, or a per-iframe nonce.
  - They only branch on `event.data.type`.
  - This means page JavaScript can impersonate the extension iframe while the prompt/overlay is open and trigger privileged extension actions such as:
    - selecting an autofill item,
    - resizing / ready-signaling the iframe,
    - saving a new credential,
    - updating an existing credential,
    - cancelling the prompt.
  - This is in contrast to the passkey bridge, which does validate `event.source`, `event.origin`, and a source marker.
- Attack scenario:
  1. The victim visits a malicious site with the Bittery extension installed.
  2. The site causes an autofill overlay or save prompt to open.
  3. The site's own JavaScript sends forged `window.postMessage(...)` events such as `AUTOFILL_SELECT`, `SAVE_CREDENTIAL`, or `UPDATE_EXISTING_CREDENTIAL`.
  4. The content script accepts the forged message because it checks only `event.data.type`.
  5. The extension either fills attacker-chosen data into the page or forwards an unintended save/update request to the background script.
- Recommended fix:
  - Mirror the passkey bridge model:
    - require `event.source === iframe.contentWindow`,
    - require `event.origin === new URL(iframe.src).origin`,
    - include a random nonce in both directions and reject messages without the correct nonce,
    - validate each message payload with Zod before acting on it.
  - Example:

```ts
const expectedOrigin = new URL(iframe.src).origin;
const nonce = crypto.randomUUID();

const messageHandler = (event: MessageEvent) => {
  if (event.source !== iframe.contentWindow) return;
  if (event.origin !== expectedOrigin) return;
  if (!event.data || event.data.nonce !== nonce) return;
  const parsed = SavePromptMessageSchema.safeParse(event.data);
  if (!parsed.success) return;
  // handle parsed.data
};
```

### Finding 5: Android credential-provider fallback returns all login items when origin validation fails

- Severity: Medium
- Location:
  - `apps/mobile/modules/credential-provider/android/src/main/java/expo/modules/credentialprovider/service/BitteryCredentialProviderService.kt:141-166`
- Description:
  - When the credential provider cannot resolve a trustworthy web origin or decides the domain is not a valid web domain, it falls back to `getLoginItemsByUserId(userId)` and returns all login credentials for each unlocked account.
  - This broadens exposure exactly when the trust signal is weakest: unrecognized browsers, native apps, bad origin resolution, or cert mismatches.
  - Even if plaintext is still protected later by user interaction, the provider is exposing broad credential metadata and candidate-account lists to an untrusted caller context.
- Attack scenario:
  1. A malicious or unsupported app triggers the credential-provider flow without a verifiable web origin.
  2. Origin resolution fails or produces a non-web domain.
  3. Bittery returns entries for all saved login items instead of rejecting the request or requiring a narrower confirmation flow.
  4. The caller gains a cross-site inventory of usernames/sites available in the unlocked vault.
- Recommended fix:
  - Do not fall back to "all logins" for untrusted or unresolved origins.
  - For unresolved callers, either:
    - return no credentials, or
    - require an explicit in-app picker that does not pre-populate the full account inventory for the caller.
  - Log these cases distinctly so allowlist/cert issues can be fixed without weakening caller validation.

### Finding 6: Public share-access logs trust caller-supplied IP address and user-agent fields

- Severity: Low
- Location:
  - `packages/api/src/routers/share.ts:753-759`
  - `packages/api/src/routers/share.ts:777-780`
  - `packages/api/src/routers/share.ts:983-987`
  - `packages/api/src/routers/share.ts:1003-1005`
  - `packages/api/src/routers/share.ts:1210-1228`
- Description:
  - The public share-access routes accept optional `ipAddress` and `userAgent` fields from the client and write them directly into `share_access_log`.
  - That makes the access log attacker-controlled rather than server-observed.
  - This is not a direct confidentiality/integrity break in primary data, but it weakens auditability and incident response because forged telemetry can be injected at will.
- Attack scenario:
  1. An attacker accesses a public share link and sets `ipAddress` and `userAgent` to arbitrary values in the tRPC input.
  2. The route writes those values into the access log via `logAccess(...)`.
  3. The share owner later reviews access logs and sees falsified network/client metadata.
- Recommended fix:
  - Remove `ipAddress` and `userAgent` from public tRPC input entirely.
  - Derive those values from request context on the server.
  - If reverse-proxy headers are used, normalize them in one trusted place and never let the client override them via body parameters.

## 4. Positive Findings

- SQL injection resistance looked good in the reviewed code. Raw SQL usage relied on Drizzle parameterization and I did not find string-concatenated SQL or user-controlled identifier injection.
- The SSE connect endpoint takes only the bearer token from `Authorization`, derives vault scope from `vault_key` rows, and does not let the client choose another user's channel or topic.
  - `apps/server/src/sync/sse-handler.ts:157-158`
  - `apps/server/src/sync/sse-handler.ts:460-487`
- SSE also caps concurrent connections at 10 per user, which is a meaningful anti-abuse control for reconnection floods.
  - `apps/server/src/sync/sse-handler.ts:157-158`
  - `apps/server/src/sync/sse-handler.ts:477-483`
- The sync catch-up route bounds `limit` to `1..1000` and intersects requested vault ids with current memberships before querying visible events.
  - `packages/api/src/routers/sync.ts:37-56`
- The login SRP path is stronger than the account-establishment SRP paths:
  - `clientPublicKey` and `clientProof` have explicit length caps in the API layer,
  - the crypto layer parses SRP values as hex and rejects `A % N == 0`.
  - `packages/api/src/routers/auth.ts:770-818`
  - `packages/crypto/core/crates/bittery-crypto-core/src/srp6a/server.rs:86-103`
- Extension passkey bridging is implemented more defensively than the autofill/save flows. It checks `event.source`, `event.origin`, and a source marker before trusting page messages.
  - `apps/extension/src/content-script/passkey-bridge.ts:225-238`
- Android exported services are limited to system-guarded bind permissions, and the credential-selection activities are not exported.
  - `apps/mobile/modules/credential-provider/android/src/main/AndroidManifest.xml:24-68`
- I did not find `z.any()`, `z.unknown()`, or `.passthrough()` in the reviewed server/extension/mobile input paths.

## 5. Open Questions

- I did not find an explicit global HTTP request-body limit or general `Content-Type` enforcement for the Bun/Hono server. Confirm whether these are applied by infrastructure in front of the app; if not, they should be enforced in-process.
- Extension background messaging (`chrome.runtime.onMessage`) uses cast-based payload handling rather than schema validation.
  - `apps/extension/src/background/message-router.ts:66-79`
  - `apps/extension/src/background/message-router.ts:346-363`
  - Ordinary web pages cannot directly use this path in the current manifest because there is no `onMessageExternal`, so I did not elevate it to a finding. It is still worth hardening with Zod to reduce the blast radius of compromised extension contexts.
- The Tauri desktop configuration disables CSP entirely.
  - `apps/desktop/src-tauri/tauri.conf.json:26-28`
  - That is not, by itself, an input-validation bug, but it increases the impact of any future webview injection issue and compounds the severity of the native-bridge exposure.
- I did not find explicit per-user quotas for item count, vault count, or sync-event generation rate beyond some billing-specific attachment/storage checks. Confirm whether operational quotas exist elsewhere.

## 6. Cross-References

- Phase 4's SSE isolation findings appear materially improved. This phase confirms that the current SSE connect path still does not accept a client-controlled channel selector and enforces a per-user connection cap.
  - `docs/security-audit/phase-4-data-isolation-multi-tenancy.md`
- Phase 4 already noted that sync and share routes depend heavily on application-layer scoping rather than database-native isolation. The broad "loose schema" pattern in this phase increases the pressure on those same application-layer controls, especially under DoS conditions.
  - `docs/security-audit/phase-4-data-isolation-multi-tenancy.md`
- Phase 2 established that server sessions are opaque bearer tokens hashed server-side. That makes the desktop native-bridge exposure especially serious: stealing a raw `auth_token` from the bridge gives the attacker a usable bearer credential immediately.
  - `docs/security-audit/phase-2-authentication-session-security.md`
- Phase 1 observed that sensitive cryptographic material is already more exposed to JS/runtime layers than the architecture intends. The desktop bridge and extension message-origin issues in this phase amplify that concern by creating new paths to misuse decrypted secrets or wrapped keys at the edge.
  - `docs/security-audit/phase-1-cryptographic-review.md`
