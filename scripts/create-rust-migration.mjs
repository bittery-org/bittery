import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const rawName = process.argv.slice(2).join(" ").trim();

if (!rawName) {
	console.error("Usage: pnpm run db:create -- <migration-name>");
	process.exit(1);
}

const slug = rawName
	.toLowerCase()
	.replace(/[^a-z0-9]+/g, "_")
	.replace(/^_+|_+$/g, "");

if (!slug) {
	console.error(
		"Migration name must contain at least one alphanumeric character",
	);
	process.exit(1);
}

const migrationsDir = resolve("apps/server/migrations");
mkdirSync(migrationsDir, { recursive: true });

const versions = readdirSync(migrationsDir)
	.map((fileName) => /^([0-9]+)_.*\.sql$/.exec(fileName)?.[1])
	.filter(Boolean)
	.map((version) => Number(version));

const nextVersion = (versions.length ? Math.max(...versions) + 1 : 0)
	.toString()
	.padStart(4, "0");

const fileName = `${nextVersion}_${slug}.sql`;
const filePath = join(migrationsDir, fileName);

writeFileSync(filePath, "-- Write migration SQL here\n", { flag: "wx" });

console.log(`Created ${filePath}`);
