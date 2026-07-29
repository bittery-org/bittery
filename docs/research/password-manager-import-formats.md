# Password-manager import formats (issue #29)

Research date: 2026-07-19. Scope: [bittery-org/bittery#29](https://github.com/bittery-org/bittery/issues/29).

## Executive conclusion

Implement these providers incrementally. Documentation is sufficient to start Bitwarden, Chrome, Firefox, 1Password CSV, and KeePass 1.x. For the remaining formats, documentation explains how to export but does not always define a versioned schema. An importer should therefore be based on both a pinned schema and a sanitized export produced by the real application.

The issue should clarify two names:

- Current Dashlane “CSV export” is normally a ZIP/folder containing several CSV files, not one CSV.
- “KeePass CSV” can mean KeePass 1.x or KeePassXC. They have different headers and data coverage; make them distinct providers (or explicitly scope v1 to one of them).

## Format matrix

| Source | Current export shape | Schema / mapping | TOTP | Confidence and caveats |
| --- | --- | --- | --- | --- |
| Bitwarden CSV | UTF-8 plaintext CSV | Official header: `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp`. Types are login and note; `fields` contains custom fields. | `login_totp` is a seed or URI. | High. Bitwarden publishes exact headers and samples. CSV omits cards, identities, passkeys, attachments, trash, and Sends. |
| Bitwarden JSON | Plaintext JSON (also offers encrypted JSON and ZIP-with-attachments) | Official sample defines `folders` and `items`; item types cover login, secure note, card, and identity, with login URIs, fields, and TOTP. | `login.totp`. | High for plaintext JSON. Reject encrypted/account-restricted JSON in v1 with a specific error; do not pretend it is malformed plaintext JSON. |
| LastPass | Plaintext CSV | Baseline header is `url,username,password,extra,name,grouping,fav`; current exports/importers may also include `totp`. `http://sn` represents secure notes; structured secure-note contents can encode cards/identities. | Optional `totp` column in current compatible exports. | Medium. LastPass documents the export procedure but does not publish a stable formal schema. Pin an authentic fixture and corroborate against Bitwarden’s maintained LastPass importer/tests. |
| Dashlane | ZIP/folder of CSVs | Separate files for credentials, IDs, payment information, personal information, and secure notes (and Wi-Fi on some platforms). The credentials schema in current exports includes the login data and OTP secret; filenames/content vary across generations. | Current credential exports can carry OTP secrets; verify the exact current header with a fixture. | Medium. Implement the ZIP as the provider input, then parse recognized member files. Do not label a single `credentials.csv` parser as full Dashlane support. Passkeys and secure-note attachments are not usable in CSV export. |
| Chrome / Chromium | UTF-8 plaintext CSV | Current Chromium source writes `name,url,username,password,note` in that order. | Not exported to CSV. | High. Chromium source and tests are the schema authority. Android/older exports may omit `name` or `note`; support only explicitly tested header variants. |
| Firefox | Plaintext CSV | Current desktop exporter writes login URL, username, password, HTTP realm/form-action metadata, GUID, and created/used/changed timestamps. The canonical fixture header used by current Firefox should be pinned verbatim. | Not exported. | High when tied to Mozilla exporter source plus a current fixture. Mozilla support docs only promise CSV, not the full header contract. |
| Safari / Passwords | Plaintext CSV | Current macOS Passwords app exports website/app passwords. Common desktop exports contain title, URL, username, password, and notes; header spelling and OTP behavior must be pinned from the target macOS version. | Do not promise it until an authentic current export demonstrates it. | Medium. Apple documents export availability and exclusions, but not a machine-readable schema. Also distinguish the Passwords-app CSV from Safari’s broader browsing-data ZIP. |
| KeePass 1.x | UTF-8 plaintext CSV | Official exact schema: `"Account","Login Name","Password","Web Site","Comments"`. Only title, username, password, URL, and notes are preserved. | Not exported. | High. This is the only CSV format formally documented by KeePass itself. |
| KeePassXC | Plaintext CSV | Common/current schema starts `Group,Title,Username,Password,URL,Notes` and newer versions may append TOTP/icon/timestamps. | Version-dependent; newer exports may include `TOTP`. | Medium/high when pinned to a KeePassXC version. Treat separately from KeePass 1.x. |
| 1Password 8 CSV | Plaintext CSV | Officially includes Title, Website, Username, Password, one-time password, favorite, archived, tags, and notes. It only exports Login and Password items. | Official one-time-password field. | High for field set, but pin exact header spelling/order with a fixture. Custom fields, linked items/apps, security questions, and desktop passkeys are omitted; retain 1PUX as the recommended path. |

## Primary sources

- Bitwarden: [custom CSV/JSON format and samples](https://bitwarden.com/help/condition-bitwarden-import/), [export formats and lossiness](https://bitwarden.com/en-gb/help/export-your-data/), and [Authenticator import/export and TOTP behavior](https://bitwarden.com/help/authenticator-import-export/).
- 1Password: [current export instructions and CSV field coverage](https://support.1password.com/export/) and [1PUX specification](https://support.1password.com/1pux-format/).
- Dashlane: [current CSV export behavior](https://support.dashlane.com/hc/en-us/articles/32905278138002-Export-your-Dashlane-data-using-a-CSV-file) and [confirmation of the multi-file ZIP](https://support.dashlane.com/hc/en-us/articles/14632321789586-I-want-to-print-my-passwords-or-other-data).
- Chrome: [Google Password Manager export instructions](https://support.google.com/chrome/answer/13068232) and Chromium’s [CSV writer](https://github.com/chromium/chromium/blob/main/components/password_manager/core/browser/export/password_csv_writer.cc) plus [writer tests](https://github.com/chromium/chromium/blob/main/components/password_manager/core/browser/export/password_csv_writer_unittest.cc).
- Firefox: [Mozilla export instructions](https://support.mozilla.org/en-US/kb/export-login-data-firefox) and Mozilla’s [desktop CSV exporter](https://github.com/mozilla/enterprise-firefox/blob/main/toolkit/components/passwordmgr/LoginExport.sys.mjs).
- Apple: [Passwords app CSV export instructions and exclusions](https://support.apple.com/guide/passwords/export-passwords-mchl35b12625/mac).
- KeePass: [official import/export formats](https://keepass.info/help/base/importexport.html) and [generic CSV examples](https://keepass.info/help/kb/imp_csv.html).
- KeePassXC: [official project/source](https://github.com/keepassxreboot/keepassxc) and a maintainer-produced [CSV example showing the six-column schema](https://github.com/keepassxreboot/keepassxc/issues/4558).
- LastPass schema corroboration: Bitwarden’s maintained [LastPass CSV importer](https://github.com/bitwarden/clients/blob/main/libs/importer/src/importers/lastpass/lastpass-csv-importer.ts) and [tests, including TOTP](https://github.com/bitwarden/clients/blob/main/libs/importer/src/importers/lastpass/lastpass-csv-importer.spec.ts). This is not a LastPass-owned schema, hence the lower confidence rating.

## Fixture strategy without purchasing every product

Do not commit real personal vaults and do not hand-author the only “happy path” fixture.

1. Define one synthetic migration corpus: quoted commas/newlines, non-ASCII text, empty username/password, multiple URLs, notes, folders, favorite/archive state, custom text/password fields, secure note, card, identity, raw TOTP seed, `otpauth://` URI, and an unsupported attachment/passkey.
2. Populate that corpus in each real product, export it, and replace any vendor-generated account identifiers if necessary without changing headers, quoting, line endings, filenames, or archive structure.
3. Commit the sanitized export with a fixture README recording product/version, OS, export date, export path, expected losses, and SHA-256.
4. Add separate malformed fixtures: unclosed quote, truncated final row, duplicate/missing headers, extra/fewer columns, invalid UTF-8/BOM handling, empty file, oversized field, and malformed JSON/ZIP.
5. Re-export on meaningful vendor releases and review fixture diffs before broadening accepted variants.

Most fixtures require no purchase: Bitwarden, Chrome, Firefox, Safari/Passwords, KeePass, and KeePassXC are freely usable; LastPass has a consumer/free path; 1Password and Dashlane can be validated with their trials. If a trial is unavailable, request a sanitized synthetic export from a user/maintainer and record its provenance. Third-party importer fixtures are useful corroboration, but should not be the only acceptance fixture.

## Recommended implementation slices

1. **Strict CSV foundation + Bitwarden CSV/JSON.** Add `papaparse` to `@bittery/shared` (already present elsewhere in the workspace), fail the whole parse on structural CSV errors, validate exact required headers, and add deterministic IDs. Bitwarden exercises folders, custom fields, notes, favorites, richer JSON categories, and TOTP early.
2. **Chrome, Firefox, Safari.** Three small login-only providers, each with explicit accepted header variants and documented lossiness.
3. **1Password CSV.** Keep separate from 1PUX and recommend 1PUX in the UI because CSV is intentionally lossy.
4. **LastPass.** Handle `extra`, grouping, secure-note sentinel, and optional TOTP after securing an authentic fixture.
5. **KeePass 1.x and KeePassXC.** Prefer two provider IDs; do not guess based only on `.csv` extension.
6. **Dashlane ZIP/multi-CSV.** Reuse JSZip, parse every recognized member atomically, map each file type, and warn for attachments/passkeys. This is the broadest and most version-sensitive slice, so land it last.

For every slice, update the provider union/registry, translations in every locale followed by `pnpm i18n:generate`, provider UI descriptions, tests, and `import-passwords.mdx`. The current documentation already claims every source is supported; change the table incrementally so it reflects shipped code.

## Parser and test design for this repository

- The web flow already makes the user choose a provider before selecting a file. Multiple providers accepting `.csv` therefore do not require unreliable auto-detection. `canParse()` can check extension/type; `parse()` must validate the selected provider’s header signature.
- Parse and structurally validate the entire file before producing any `ImportPreview`. Any CSV parser error, duplicate header, missing required header, or row-width mismatch should throw a localized `ImportProviderError`; this satisfies “never partial silent import.” Semantic per-item loss may produce explicit warnings only after the file is structurally valid.
- Generate stable source IDs from provider + row/index (or source GUID), never `Date.now()`/`Math.random()`, so previews and tests are deterministic.
- Centralize CSV decoding, header normalization/BOM handling, structural validation, TOTP parsing, URL normalization, preview summaries, and deterministic custom-field IDs. Keep vendor row mapping in separate providers; avoid one permissive alias-heavy parser that can silently accept the wrong export.
- Test raw CSV behavior, provider mapping, and end-to-end `ImportPreview`. Verify TOTP by generating a code from the imported secret/algorithm/digits/period against a fixed clock, not merely by asserting the secret string.
- The legacy `apps/desktop/src/utils/import-parsers.ts` is not a safe base: it targets an older item shape, marks parses successful even when parser errors coexist with items, skips row failures as warnings, and generates custom-field IDs with time/randomness. Replace or delete it only when the shared providers are wired to desktop.
