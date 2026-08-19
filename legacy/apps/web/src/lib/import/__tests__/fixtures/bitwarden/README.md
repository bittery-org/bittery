# Bitwarden import fixtures

| File | SHA-256 |
| --- | --- |
| `individual-export.json` | `9f2f598479308adee58e0a1799cd8581329ae754170c061cc8b6e8f6cb6ac97e` |
| `individual-export.csv` | `8a845226a464a8632ef3db31ed1d6d278a8d164b218bc8036f54dff4705f1f4c` |

Both are real exports of the same Bitwarden vault, taken minutes apart, parsed
byte-for-byte by the `real sanitized export` suite in
`../../bitwarden.test.ts`. The inline synthetic fixtures in that file stay
for the cases a real free-plan vault cannot produce — see the gap list below.

## Provenance

| Field | Value |
| --- | --- |
| Bitwarden product | Web Vault, free individual plan |
| Product version | not recorded at export time |
| Platform / OS | macOS (Darwin 25.5.0), browser |
| Export date | 2026-07-29 |
| Export path in the UI | Settings → Export vault → File format `.json` / `.csv`, unencrypted |
| Original filenames | `bitwarden_export_20260729120709.json`, `bitwarden_export_20260729120827.csv` |

## What these exports pinned down

Three things a real export shows that Bitwarden's published documentation does
not. Each has a test guarding it:

1. **The CSV header carries an undocumented 12th column, `archivedDate`**, between
   `reprompt` and `login_uri`. The documented header is 11 columns. The parser
   therefore *requires* only the documented columns and reads `archivedDate`
   opportunistically, so both old and new exports work. A non-empty value skips
   the row with an `archived-skipped` warning.
2. **Unfoldered items omit `folderId` entirely** in JSON, rather than writing
   `"folderId": null` as the published samples show.
3. **CSV records are CRLF-separated while newlines inside a quoted field are bare
   LF.** The `fields` column packs custom fields as `name: value` lines using LF.

## Coverage

| Case | JSON | CSV |
| --- | --- | --- |
| Folders → source vaults, empty folder, unfoldered bucket | yes | yes |
| Favorite | yes | yes |
| Quoted comma inside a field | n/a | yes (`login_uri`) |
| Quoted embedded newline | n/a | yes (`fields`) |
| CRLF records | n/a | yes |
| Login with no username, password or TOTP | yes | yes |
| Raw base32 TOTP seed | yes | yes |
| `otpauth://` URI, non-default algorithm/digits/period | yes | yes |
| Custom field types text (0), hidden (1), boolean (2), linked (3) | yes | flattened |
| Password history | yes | dropped by Bitwarden |
| Card, identity, SSH key | yes | dropped by Bitwarden |
| Two-line German address, SSN, passport, licence | yes | n/a |
| Non-ASCII (`ö`, `ü`, `ß`) | yes | n/a |

CSV lossiness is Bitwarden's, not ours: the CSV export contains only logins and
notes, so the card, identity and SSH key are absent from the file entirely. One
test asserts the CSV/JSON item sets side by side so this stays visible.

Note one flattening artifact: a linked (type 3) custom field is written by
Bitwarden as the literal text `link: undefined` in the CSV `fields` column. The
JSON path drops linked fields with a `linked-field-skipped` warning, but CSV
carries no type information, so it is imported verbatim. Dropping any field whose
value happens to be the string `undefined` would risk discarding real user data,
so the parser does not guess.

## Sanitizing applied

Values were replaced with fakes **of the same shape**. Key order, indentation,
quoting, line endings and encoding are untouched — those are exactly what the
parser is being tested against. `biome.json` excludes this directory so the
formatter cannot rewrite them.

- All folder and item UUIDs → fresh UUIDs (the originals shared an
  account-scoped suffix)
- Real name, email, street, city, postcode, state, company, phone, username →
  fictional equivalents, keeping German formatting and the `ö`/`ü`/`ß` characters
- Passwords, including the one in password history → different random strings of
  the same length
- Card number → `4111111111111111` (the standard Visa test number)
- SSH key material → a throwaway ed25519 pair used nowhere else

The CSV needed no edits — by the time it was exported the vault already held only
sanitized values. It is a byte-identical copy.

The TOTP values are deliberately **not** sanitized: `JBSWY3DPEHPK3PXP` is a
public RFC test seed, and the tests assert fixed-clock codes derived from it.

## Known gaps — still only synthetic

Not reachable on a free individual plan, or not worth forcing:

- [ ] **Attachments** — paid plan only, so the attachment-`.zip` rejection path
      (`bitwarden-attachment-export-unsupported`) is exercised synthetically.
- [ ] **Passkeys** (`login.fido2Credentials`) — storable on free Bitwarden, but
      only by registering one against a real site.
- [ ] **Organization / collections export** — needs an organization.
- [ ] **Encrypted / password-protected export** — a one-line variant, covered
      synthetically.
- [ ] **A live archived item** — the `archivedDate` column is present and honoured,
      but every row in this export has it empty. The test fills it in on a copy of
      the fixture rather than shipping an archived row.
- [ ] **A comma or newline inside `name` or `notes`** — both quoting cases are
      covered, but only via `login_uri` and `fields`.
- [ ] **A doubled-quote escape (`""`)** — covered synthetically only.

Re-export and review the fixture diff on meaningful Bitwarden releases before
widening the accepted header variants.
