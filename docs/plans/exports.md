## Export Implementation Plan (.bttrx)

### Current state

No export feature exists at runtime. The following stubs exist but are not wired to anything:

- `packages/shared/src/export-types.ts` — defines `ExportedVault`, `ExportedItem`, `VaultExportPayload`, `EncryptedVaultExport` (types only)
- `apps/marketing/src/routes/privacy.tsx` — marketing copy mentions export capability
- `apps/web/src/lib/wasm-crypto.ts` + `worker-crypto.ts` — `exportKeyHandle` (crypto-level key export, unrelated to vault data export)

What already exists that the export feature can build on:

- `vault.listAllItems` tRPC procedure — returns all vaults the user has access to, all encrypted items, and all attachment metadata in a single call (account-wide)
- `vault.getAttachmentDownloadUrl` tRPC mutation + the full attachment download/decrypt flow in `packages/core/src/hooks/use-item-attachments.ts`
- `getDecryptedVaultKey` utility in `packages/shared/src/vault-key-crypto.ts` — already used by the import hook
- `buildItemEncryptionContext`, `buildAttachmentBlobEncryptionContext`, `buildAttachmentNameEncryptionContext` in `packages/core/src/services/encryption-context.ts`
- JSZip is already a dependency (used by the 1Password `.1pux` import provider)
- The import provider architecture in `packages/shared/src/import/` — registry, contract, and 1Password provider — can be extended with a `.bttrx` round-trip provider

### Archive format: .bttrx

A `.bttrx` file is a ZIP archive with the following layout:

```
bittery-export.bttrx
├── export.json
└── files/
    └── {itemId}/
        └── {filename}
```

`export.json` is a decrypted-plaintext `VaultExportPayload`. File attachments are decrypted and written under `files/{itemId}/{filename}`. The export is account-wide: it covers every vault the authenticated user has access to, including personal vaults and any shared or team vaults.

### export.json structure

Items are stored flat with a `vaultId` property rather than nested under each vault. Vaults are metadata-only entries in the `vaults` array.

```json
{
  "version": "1",
  "exportDate": "2026-03-17T10:00:00.000Z",
  "exportedBy": { "email": "user@example.com", "name": "Jane" },
  "vaults": [
    { "id": "v1", "name": "Personal", "type": "personal", "icon": "lock" },
    { "id": "v2", "name": "Work", "type": "team", "icon": null }
  ],
  "items": [
    {
      "id": "i1",
      "vaultId": "v1",
      "category": "login",
      "favorite": false,
      "data": { "title": "GitHub", "username": "jane", "password": "...", "url": "https://github.com" },
      "attachments": [
        { "filename": "screenshot.png", "contentType": "image/png", "data": "<base64>" }
      ],
      "createdAt": "2025-01-01T00:00:00.000Z",
      "updatedAt": "2026-03-17T09:00:00.000Z"
    }
  ],
  "metadata": { "totalItems": 42, "totalVaults": 2 }
}
```

### Design decisions

- **Format**: decrypted plaintext inside the ZIP, no export password re-encryption. Treat the file as a sensitive document.
- **Attachments**: fully downloaded from S3, decrypted client-side, and included in the ZIP under `files/{itemId}/`. Attachment data is also embedded as base64 in the `attachments` array on each item in `export.json` for portability.
- **Scope**: account-wide (all vaults the user can access).
- **Round-trip import**: a `.bttrx` import provider is added alongside the export so users can migrate to a different instance.
- **Platform**: web app only for this iteration (`apps/web`).

### Files to create

| File | Purpose |
|---|---|
| `apps/web/src/hooks/use-vault-export.ts` | Export orchestration hook |
| `apps/web/src/components/export/vault-export-dialog.tsx` | Export dialog component |
| `packages/shared/src/import/providers/bittery-bttrx.ts` | Round-trip import provider |

### Files to modify

| File | Change |
|---|---|
| `packages/shared/src/export-types.ts` | Update types to flat structure (see Phase 1) |
| `packages/shared/src/import/types.ts` | Extend `ImportProviderId` union |
| `packages/shared/src/import/provider-registry.ts` | Register `.bttrx` provider |
| `apps/web/src/routes/_app/settings/index.tsx` | Add export card + dialog mount |
| `packages/i18n/messages/en.json` | Add i18n keys |

### Phase 1: Update shared types

**`packages/shared/src/export-types.ts`**

- Remove `items: ExportedItem[]` from `ExportedVault` — vaults become metadata-only
- Add `vaultId: string` to `ExportedItem`
- Add `ExportedAttachment { filename: string; contentType: string; data: string }` interface
- Add `attachments?: ExportedAttachment[]` to `ExportedItem`
- Change `VaultExportPayload` to have a top-level flat `items: ExportedItem[]` instead of items nested under each vault

**`packages/shared/src/import/types.ts`**

- Extend `ImportProviderId` from `"1password-1pux"` to `"1password-1pux" | "bittery-bttrx"`

### Phase 2: Export hook

**`apps/web/src/hooks/use-vault-export.ts`** (new file)

Mirror the structure of `apps/web/src/hooks/use-vault-import.ts`.

Progress stages:

```
idle → fetching → decrypting → downloading-files → building-archive → completed → error
```

State tracked during progress: `totalItems` / `processedItems`, `totalAttachments` / `processedAttachments`, `currentVaultName`.

Logic:

1. Call `trpcClient.vault.listAllItems.query()` — returns all encrypted items with vault metadata for the whole account
2. Collect unique vaults from the result; build a vault key map by calling `getDecryptedVaultKey` from `packages/shared/src/vault-key-crypto.ts` for each vault (uses `storage` from `@/lib/storage` and `decrypt` / `rsaDecrypt` from `@/lib/wasm-crypto`)
3. For each item, decrypt `encryptedData` using `crypto.decrypt(item.encryptedData, vaultKey, buildItemEncryptionContext({ vaultId, itemId, version, userId }))`
4. For each attachment on each item: call `vault.getAttachmentDownloadUrl.mutate({ attachmentId })`, fetch the presigned URL, decrypt blob with `buildAttachmentBlobEncryptionContext`, decrypt name with `buildAttachmentNameEncryptionContext`, convert base64 result to `Uint8Array` for the ZIP entry
5. Build the `VaultExportPayload` with flat `items` array (each item includes `vaultId` and its decrypted `attachments`)
6. Create a JSZip instance: `zip.file("export.json", JSON.stringify(payload, null, 2))`, and for each attachment: `zip.file("files/{itemId}/{filename}", bytes)`
7. `zip.generateAsync({ type: "blob" })` → create an `<a>` with `href = URL.createObjectURL(blob)` and `download = "bittery-export.bttrx"` → programmatically click

### Phase 3: VaultExportDialog component

**`apps/web/src/components/export/vault-export-dialog.tsx`** (new file)

Mirror the visual structure of `apps/web/src/components/import/vault-import-dialog.tsx`.

View states:

1. **Confirm** — shows vault count, item count, attachment count. "Start Export" and "Cancel" buttons.
2. **In progress** — current stage label and progress bar. Item/attachment counters visible underneath.
3. **Completed** — "Download Archive" button (triggers the blob download) + success message.
4. **Error** — error message + "Try Again" button that resets state to Confirm.

### Phase 4: Settings UI

**`apps/web/src/routes/_app/settings/index.tsx`**

- Add `const [isExportDialogOpen, setIsExportDialogOpen] = useState(false)` alongside the existing `isImportDialogOpen` state
- Insert an export card directly below the import card using the same visual pattern (icon + title + description + action button). Use the `Download` icon from `lucide-react`.
- Mount `<VaultExportDialog open={isExportDialogOpen} onOpenChange={setIsExportDialogOpen} />` at the bottom of the component alongside `<VaultImportDialog>`

### Phase 5: i18n keys

**`packages/i18n/messages/en.json`** — add after the existing import keys (around line 565):

```json
"settings_general_export_title": "Export your vault data",
"settings_general_export_description": "Download a .bttrx archive containing all your items and decrypted attachments.",
"settings_general_export_open": "Export",
"vault_export_dialog_title": "Export Vault Data",
"vault_export_dialog_description": "All vaults, items, and attachments will be exported as a .bttrx archive. Keep this file safe — it contains your unencrypted data.",
"vault_export_dialog_summary_vaults": "{count, plural, one {# vault} other {# vaults}}",
"vault_export_dialog_summary_items": "{count, plural, one {# item} other {# items}}",
"vault_export_dialog_summary_attachments": "{count, plural, one {# attachment} other {# attachments}}",
"vault_export_dialog_confirm_button": "Start Export",
"vault_export_dialog_cancel": "Cancel",
"vault_export_dialog_download": "Download Archive",
"vault_export_dialog_try_again": "Try Again",
"vault_export_dialog_stage_fetching": "Fetching items…",
"vault_export_dialog_stage_decrypting": "Decrypting items…",
"vault_export_dialog_stage_downloading_files": "Downloading attachments…",
"vault_export_dialog_stage_building_archive": "Building archive…",
"vault_export_dialog_stage_completed": "Export complete",
"vault_export_dialog_error_generic": "Export failed. Please try again."
```

### Phase 6: .bttrx import provider (round-trip)

**`packages/shared/src/import/providers/bittery-bttrx.ts`** (new file)

```
id: "bittery-bttrx"
fileAccept: ".bttrx"
fileTypeLabel: ".bttrx"
```

`canParse(file)`: returns true if filename ends with `.bttrx`.

`parse(file)`:

1. JSZip load the file
2. Read and JSON-parse `export.json` as `VaultExportPayload`
3. Build `ImportSourceVault[]` from `payload.vaults`
4. Build `ImportSourceItem[]` from flat `payload.items`, mapping each to an `ImportSourceItem` with `sourceVaultId = item.vaultId`
5. Items with `attachments` in the export emit an `attachments-skipped` warning — attachment re-upload is out of scope for v1
6. Return `ImportPreview`

**`packages/shared/src/import/provider-registry.ts`**: import `bitteryBttrxImportProvider` and add it to the `providers` array.

### Verification checklist

- Export an account with multiple vaults: confirm all vault IDs appear in `vaults[]` and all items have a correct `vaultId` property
- Export items of all 5 categories (login, secure-note, credit-card, identity, totp): confirm all fields are present in `export.json`
- Export a vault with file attachments: unzip and confirm `files/{itemId}/{filename}` entries are readable and `attachments[].data` in `export.json` is valid base64
- Round-trip: import the `.bttrx` back via the import dialog, confirm items land in the correct vaults
- Team vault (RSA-encrypted vault key): confirm the RSA decryption path works identically to the personal vault path
- Switch UI language to German: confirm no hardcoded English strings appear in the export card or dialog

### Known limitations in v1

**Attachment re-upload on .bttrx import**: the existing `bulkImportItems` tRPC endpoint handles encrypted item payloads only. For v1 the `.bttrx` import provider imports items without their attachments and emits an `attachments-skipped` warning per item. Full attachment re-upload is deferred to a follow-up.

**Large vault memory pressure**: downloading and decrypting all attachments in-browser could be memory-intensive for accounts with many large files. A note in the export dialog sets expectations.