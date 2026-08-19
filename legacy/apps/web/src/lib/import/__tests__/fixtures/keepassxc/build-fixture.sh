#!/usr/bin/env bash
#
# Regenerates the KeePassXC CSV fixtures from `source-database.xml`.
#
# The point of this script is that the committed CSVs are *KeePassXC's own
# exporter output*, not something this repository hand-wrote. `source-database.xml`
# holds the fabricated vault; KeePassXC turns it into a real KDBX and then writes
# the CSV itself. Every timestamp lives in the XML, so re-running this produces
# byte-identical files as long as the KeePassXC version is unchanged.
#
# Usage (from this directory):
#
#   ./build-fixture.sh [/path/to/keepassxc-cli]
#
# Defaults to the macOS app bundle path. Verify the version afterwards and update
# README.md — including the checksums — if it differs from the recorded one.

set -euo pipefail

cd "$(dirname "$0")"

CLI="${1:-/Applications/KeePassXC.app/Contents/MacOS/keepassxc-cli}"
DB_PASSWORD="fixture"
WORK_DB="$(mktemp -d)/fixture.kdbx"

if [[ ! -x "$CLI" ]]; then
	echo "keepassxc-cli not found at: $CLI" >&2
	exit 1
fi

# `LC_ALL=C` keeps the CLI's own prompts in English. It does not affect the
# exported bytes: every group name in the CSV comes from the XML, including the
# root group's.
printf '%s\n%s\n' "$DB_PASSWORD" "$DB_PASSWORD" |
	LC_ALL=C "$CLI" import --set-password source-database.xml "$WORK_DB" >/dev/null

# Current layout, KeePassXC >= 2.6.3: ten columns.
printf '%s\n' "$DB_PASSWORD" |
	LC_ALL=C "$CLI" export --format csv "$WORK_DB" 2>/dev/null \
		>keepassxc-2.7.8-macos.csv

# Pre-2.6.3 layout: the same exporter without the TOTP / Icon / Last Modified /
# Created columns. `CsvExporter::exportGroup` built each row by calling the
# identical `addColumn` for the first six columns and then stopped, so dropping
# the last four fields off every record reproduces what 2.6.2 would have written
# for this database. It is a derivation from pinned exporter source, not a
# capture — see README.md.
python3 - <<'PY'
import csv
import io

with open("keepassxc-2.7.8-macos.csv", encoding="utf-8", newline="") as handle:
    records = list(csv.reader(handle))

buffer = io.StringIO(newline="")
# KeePassXC quotes every cell unconditionally and terminates every record with a
# bare LF, including the last one.
writer = csv.writer(buffer, quoting=csv.QUOTE_ALL, lineterminator="\n")
for record in records:
    writer.writerow(record[:6])

with open("keepassxc-2.6.2-six-column.csv", "w", encoding="utf-8", newline="") as handle:
    handle.write(buffer.getvalue())
PY

rm -rf "$(dirname "$WORK_DB")"

echo "Wrote:"
for file in keepassxc-2.7.8-macos.csv keepassxc-2.6.2-six-column.csv; do
	printf '  %s  %s\n' "$(shasum -a 256 "$file" | cut -d' ' -f1)" "$file"
done
