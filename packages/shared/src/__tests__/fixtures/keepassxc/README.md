# KeePassXC import fixtures

| File | SHA-256 |
| --- | --- |
| `keepassxc-2.7.8-macos.csv` | `8b14e25ba98facc97d63b3ebefceac780d3b626e59514c5032ad6460c449f1fb` |
| `keepassxc-2.6.2-six-column.csv` | `8060db28b2d4d7d24cb9dc72e3f62accde63e5661146e2f9a82e090b16baf183` |
| `source-database.xml` | `99861f21308270d32d945da1bcf7f6e0e0e181c42453cfbbb3f5e8b96fc89e68` |

Both CSVs are parsed byte-for-byte by `../../import-keepassxc.test.ts`.

## Provenance

### `keepassxc-2.7.8-macos.csv` — written by KeePassXC itself

| Field | Value |
| --- | --- |
| Product | KeePassXC |
| Version | 2.7.8 (`keepassxc-cli --version`) |
| Platform / OS | macOS 26.5.2 (build 25F84), Apple silicon, `/Applications/KeePassXC.app` |
| Export date | 2026-07-30 |
| Export path | `keepassxc-cli export --format csv`, i.e. `CsvExporter::exportDatabase` — the same exporter the GUI's **Database → Export → Export to CSV…** calls |
| Schema source | `src/format/CsvExporter.cpp` (`keepassxreboot/keepassxc`) |
| Independent corroboration | maintainer-produced six-column sample in [keepassxc#4558](https://github.com/keepassxreboot/keepassxc/issues/4558) |

**The bytes are authentic KeePassXC output; the vault contents are fabricated.**
No real credential, host or person appears in it. `source-database.xml` holds the
fabricated vault as a KDBX XML document, and `./build-fixture.sh` feeds it through
`keepassxc-cli import` and then `keepassxc-cli export --format csv`, so the CSV is
whatever KeePassXC 2.7.8 decides to write. Every timestamp lives in the XML rather
than being stamped at build time, so re-running the script on the same KeePassXC
version reproduces the file byte-for-byte.

Authoring the vault as XML is also the only way to get the TOTP rows: the CLI has
no flag for setting a TOTP secret, so the three storage formats KeePassXC accepts
(`otp`, `TOTP Seed` + `TOTP Settings`, and the Steam variant of the latter) are
set as entry attributes in the XML instead.

### `keepassxc-2.6.2-six-column.csv` — derived from pinned exporter source

| Field | Value |
| --- | --- |
| Product | KeePassXC 2.0 - 2.6.2 layout |
| Version | not a capture; see below |
| Export date | n/a |
| Schema source | `src/format/CsvExporter.cpp` at tags `2.0.0`, `2.1.4`, `2.3.4`, `2.4.3`, `2.5.4` and `2.6.2`, all of which write exactly six columns |

**This is not a capture of a live export**, and no KeePassXC build older than 2.7.8
was available to produce one. `./build-fixture.sh` derives it by dropping the last
four fields off every record of the 2.7.8 file. That reproduces 2.6.2's output for
this vault because `CsvExporter::exportGroup` built the first six columns with the
same `addColumn` calls in the same order and simply stopped there — the TOTP, Icon,
Last Modified and Created columns were appended in 2.6.3 and nothing before them
changed. Read it as the derivation it is: the *layout* is pinned to exporter source
across six tags, the *bytes* were not written by a 2.6.x binary.

## Accepted header layouts

| Layout | KeePassXC versions | Pinned by |
| --- | --- | --- |
| `Group,Title,Username,Password,URL,Notes,TOTP,Icon,Last Modified,Created` | >= 2.6.3 | `keepassxc-2.7.8-macos.csv` |
| `Group,Title,Username,Password,URL,Notes` | 2.0 - 2.6.2 | `keepassxc-2.6.2-six-column.csv` |

Matching is exact and ordered. A reordered, extra or missing column raises
`csv-unknown-header-variant` and imports nothing. Do not widen this list without
adding a fixture to this directory first.

KeePass 1.x's `"Account","Login Name","Password","Web Site","Comments"` is
detected by name and rejected with `keepassxc-keepass1-export-unsupported`, so the
user is told they exported from the wrong product rather than being handed a column
diff. It is a separate format and will be a separate provider.

## Exact header

```
"Group","Title","Username","Password","URL","Notes","TOTP","Icon","Last Modified","Created"
```

## Format rules these files pin

Straight from `CsvExporter::addColumn` / `exportGroup`:

1. **Every cell is quoted, unconditionally** — including empty ones, which are
   written as `""` rather than as a bare empty field.
2. **`"` inside a value is doubled** (`replace("\"", "\"\"")`). Nothing else is
   escaped and values are never trimmed. See the `Jenkins` row, whose password is
   `pa"ss,word`.
3. **Records are LF-separated and the file ends with a trailing LF**, on macOS as
   well — the exporter appends `"\n"` after every row, the final one included.
4. **A multi-line note keeps its raw newlines inside the quoted cell.** The
   `Jenkins` row's note spans two physical lines; only the strict parser's quote
   handling makes it one record.
5. **`Group` is the full path from the database's root group down**, `/`-separated,
   built by `exportGroup` recursing with `groupPath`. The root group's own name is
   always the first segment.
6. **Nothing marks the recycle bin.** Its entries are exported like any others,
   under the recycle bin group's (localized) name — see *Deliberate decisions*.
7. **`TOTP` is always an `otpauth://` URI when present.**
   `Entry::totpSettingsString` passes `forceOtp`, so entries stored in KeePassXC's
   legacy `[step];[digits]` or KeeOtp attribute formats are converted on export and
   the secret is never left behind. Its `secret` is `Base32::sanitizeInput` output,
   which keeps `=` padding and percent-encodes it (`…%3D%3D%3D%3D`, the `Broker`
   row).
8. **Timestamps are `Qt::ISODate` UTC**, e.g. `2026-07-21T14:32:09Z`.
9. **`Icon` is KeePassXC's internal icon index**, a bare number.

## Coverage

| Case | Row |
| --- | --- |
| Entry directly in the root group | `Router Admin` |
| Nested group path | `db-primary` (`Passwords/Work/Servers`) |
| Two entries sharing one group | `GitHub`, `Jenkins` |
| Scheme-less URL | `Router Admin` (`192.168.1.1`) |
| Non-HTTP scheme kept verbatim | `db-primary` (`ssh://…`) |
| Password containing a doubled quote and a comma | `Jenkins` |
| Note spanning two lines inside a quoted cell | `Jenkins` |
| Non-ASCII group name, username, password and note | `Kontoauszug` |
| Completely blank entry (skipped on import) | the empty row in `Passwords/Work` |
| Empty username, password and URL; note only | `WLAN Codes` |
| TOTP stored as an `otp` attribute | `GitHub` |
| TOTP stored as `TOTP Seed` + `TOTP Settings`, 8 digits, padded secret | `Broker` |
| TOTP using the Steam encoder (settings Bittery cannot reproduce) | `Steam` |
| Recycle-bin entry | `Old Forum` |
| Custom entry attributes that the CSV does not carry | `db-primary` (`Port`, `Replica`) |

## Expected losses

KeePassXC's own lossiness — the export simply does not contain these, so no
per-item warning is raised for them:

- Custom entry attributes / additional fields (the `db-primary` row has two in the
  source database and neither reaches the CSV).
- File attachments.
- Tags, entry colours, expiry dates, auto-type sequences, `OverrideURL`.
- Password history, usage counts, entry and group UUIDs.
- Additional URLs (`KP2A_URL_*` style attributes).
- Group hierarchy as structure — only the flattened path string survives.
- Favourites: KeePassXC has none, so every imported item is `favorite: false`.

Bittery's mapping decisions on top of that:

| Column | Outcome |
| --- | --- |
| `Group` | source vault, root segment stripped (see below) |
| `Title` | `title`; an empty one becomes `Imported item <n>` with a `missing-title` warning |
| `Username`, `Password`, `Notes` | mapped directly |
| `URL` | `url` + `urls[0]`, normalized only by adding a scheme when one is missing |
| `TOTP` | `totpSecret` plus issuer, account name, algorithm, digits and period |
| `Icon` | **dropped.** A KeePassXC icon index has no meaning outside KeePassXC. |
| `Last Modified`, `Created` | **dropped.** `DecryptedItemData` has no fields for them; Bittery stamps its own timestamps at import. |

## Deliberate decisions

**Group paths keep their shape; the root segment is dropped.** Every path the
exporter writes starts at the database's root group, whose name is whatever the
database was created with — `Passwords` here, `Root` for a database made through
the GUI wizard, and localized in both cases (`keepassxc-cli db-create` under a
German locale writes `Passwörter`). It is the same for every row and names the
database, not a folder the user filed anything under, so it is stripped. What
remains is used verbatim, `/` included: `Passwords/Work/Servers` becomes one source
vault named `Work/Servers`. Bittery's vaults are flat, so the alternative — a vault
per path segment — would merge two unrelated `Servers` groups under different
parents. Entries sitting directly in the root group land in a synthetic **No Group**
vault, the same way Bitwarden's unfoldered items do.

One consequence: a group literally named `Work/Servers` is indistinguishable from a
`Servers` group inside `Work`, because the exporter joins segments with `/` and
does not escape a `/` inside a group name. Both arrive as the same source vault.

**The recycle bin is not skipped.** KeePassXC exports it with everything else and
the CSV carries no marker for it — the only signal is the group's name, which is
localized (`tr("Recycle Bin")`) and which a user is free to give a real group.
Matching on it would silently drop live credentials, so recycle-bin entries arrive
as an ordinary source vault named after the group and the user can decline to map
it. The import docs tell people to empty the recycle bin before exporting.

**Every entry imports as a login.** KeePassXC has exactly one entry type and the
CSV has no type column, so there is nothing to infer a secure note or card from.
The `WLAN Codes` row — a note with no credentials — is a login with only `notes`
set.

**Steam and other unreproducible TOTP settings are reported, not silently
mangled.** Bittery has no Steam encoder and `TotpDigits` only holds 6-8, so an
`otpauth://` URI carrying `encoder=steam` or a digit count outside that range
imports its secret but raises `totp-settings-unsupported`: the code Bittery shows
would otherwise quietly differ from the one KeePassXC shows.

## Sanitizing applied

Nothing was removed after the fact — the source vault was fabricated for this
fixture, so there was never anything real in it to sanitize. Hosts are all
`example.com` / `example.de` / `example.org` / `.internal.example.com` or the
RFC 1918 address `192.168.1.1`. `biome.json` excludes this directory so the
formatter cannot rewrite byte-sensitive content.

## Known gaps

- [ ] **An export from a vault a person actually uses.** These bytes come from a
      real KeePassXC 2.7.8, but from a vault built for this test.
- [ ] **A capture from a pre-2.6.3 binary**, which would replace the derived
      six-column file.
- [ ] **A Windows or Linux export.** The exporter writes LF on every platform, so
      no difference is expected — but it is unverified.
- [ ] **A GUI export**, as opposed to `keepassxc-cli export`. Both call
      `CsvExporter::exportDatabase`; only the CLI path is exercised here.
- [ ] **A group name containing a `/`**, which is ambiguous by construction. The
      case is covered synthetically in `../../import-keepassxc.test.ts`.
- [ ] **An entry with a file attachment**, to pin that attachments leave no trace
      in the CSV.

Re-check `CsvExporter.cpp` and `Entry::totpSettingsString` on meaningful KeePassXC
releases before widening the accepted layouts.
