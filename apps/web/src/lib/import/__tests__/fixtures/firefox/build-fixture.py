"""Reproduce Firefox's LoginExport.sys.mjs byte-for-byte.

Mirrors `LoginExport._buildCSVRow` and `exportAsCSV`:
  - every column value that is not null/undefined is wrapped in double quotes
  - `"` inside a value is doubled
  - null/undefined writes a *bare* empty field (no quotes)
  - rows are joined with CRLF, and the file has NO trailing newline
"""

import hashlib
import pathlib

COLUMNS = [
    "origin",
    "username",
    "password",
    "httpRealm",
    "formActionOrigin",
    "guid",
    "timeCreated",
    "timeLastUsed",
    "timePasswordChanged",
]

# (origin, username, password, httpRealm, formActionOrigin, guid, tCreated, tLastUsed, tPwChanged)
# None means the login property is null -> Firefox writes a bare empty field.
ROWS = [
    # Plain form login.
    (
        "https://github.com",
        "octocat",
        "hunter2",
        None,
        "https://github.com",
        "{6f0d5a1c-3b8e-4a2f-9c17-5e4b8d2a7f31}",
        "1784538843000",
        "1785325338000",
        "1784538843000",
    ),
    # Non-ASCII username and password.
    (
        "https://konto.example.de",
        "jörg.müller@example.de",
        "paßwort-123",
        None,
        "https://konto.example.de",
        "{b2c4e8f0-7d13-4c95-8a26-1f9e3b5d0c74}",
        "1784909141000",
        "1785313800000",
        "1784909141000",
    ),
    # Empty-string username: quoted empty, distinct from a null field.
    (
        "https://www.example.org",
        "",
        "kein-benutzername",
        None,
        "https://www.example.org",
        "{3e7a9d15-0c62-4b48-9f83-6d2a1e5c8b09}",
        "1780428127000",
        "1780428127000",
        "1780428127000",
    ),
    # Password containing a doubled quote and a comma.
    (
        "https://quote.example.com",
        "quoter",
        'pa"ss,word',
        None,
        "https://quote.example.com",
        "{9c1f4b8a-5e30-42d7-b6c9-8a07f2d4e153}",
        "1784538843000",
        "1785325338000",
        "1785313800000",
    ),
    # HTTP-auth login: httpRealm set, formActionOrigin null.
    (
        "https://intranet.example.com",
        "realm-user",
        "realm-pass",
        "Restricted Area",
        None,
        "{47d2a6e9-8f15-4c03-a92b-3e6d0b7c1af8}",
        "1784909141000",
        "1784909141000",
        "1784909141000",
    ),
    # Firefox Sync account entry, present in any export from a signed-in profile.
    # The password is a JSON blob of sync keys, so every quote is doubled.
    (
        "chrome://FirefoxAccounts",
        "a1b2c3d4e5f60718293a4b5c6d7e8f90",
        '{"version":1,"accountData":{"kSync":"0f1e2d3c4b5a69788796a5b4c3d2e1f0","kXCS":"1a2b3c4d5e6f7081"}}',
        "Firefox Accounts credentials",
        None,
        "{c8e5f207-1a94-4d6b-83f0-2b7c9e1d4a65}",
        "1780428127000",
        "1785325338000",
        "1780428127000",
    ),
    # Port-qualified origin.
    (
        "https://www7.example.com:8080",
        "port-user",
        "port-pass",
        None,
        "https://www7.example.com:8080",
        "{5b93c0d7-6e28-41af-9d54-7c1a8f3e6b02}",
        "1784538843000",
        "1784538843000",
        "1784538843000",
    ),
    # Form action origin pointing at a different host than the login origin.
    # Bittery drops it; the row exists so a test can prove it is not imported.
    (
        "https://portal.example.com",
        "sso-user",
        "sso-pass",
        None,
        "https://sso.example.net",
        "{2f6d8a04-9c73-4b15-8e02-4a9d7f1c6b38}",
        "1784909141000",
        "1785325338000",
        "1784909141000",
    ),
    # Empty-string httpRealm: must not become an "HTTP Realm" field.
    (
        "http://legacy.example.net",
        "legacy-user",
        "legacy-pass",
        "",
        None,
        "{80a4c1e6-3d59-4f27-9b6a-0c8e5d2f7139}",
        "1780428127000",
        "1780428127000",
        "1780428127000",
    ),
    # No guid, no timestamps at all — the shape Mozilla's own exporter test emits
    # for logins that were never synced or used.
    ("file://", "file: username", "file: password", None, "file://", None, None, None, None),
]


def build_row(values):
    row = []
    for value in values:
        if isinstance(value, str):
            value = value.replace('"', '""')
        row.append("" if value is None else f'"{value}"')
    return row


def main():
    header = ['"url"' if name == "origin" else f'"{name}"' for name in COLUMNS]
    rows = [header] + [build_row(values) for values in ROWS]
    # https://tools.ietf.org/html/rfc7111 suggests always using CRLF.
    text = "\r\n".join(",".join(row) for row in rows)

    target = pathlib.Path(
        "packages/shared/src/__tests__/fixtures/firefox/logins.csv"
    ).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    data = text.encode("utf-8")
    target.write_bytes(data)

    print(target)
    print("bytes:", len(data))
    print("sha256:", hashlib.sha256(data).hexdigest())
    print("ends with newline:", data.endswith(b"\n"))


if __name__ == "__main__":
    main()
