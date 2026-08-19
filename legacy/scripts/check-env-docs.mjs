import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// Keeps the self-hosting docs and the server's environment variables in sync,
// in both directions:
//
//  1. Every variable documented in the self-hosting docs is actually read by
//     `apps/server/src`, so the docs cannot advertise a knob that does nothing.
//
//  2. Every variable the server reads is documented, so a new knob cannot ship
//     to .env.example and docker-compose.yml while the docs never learn about
//     it. This is the direction that failed for the three
//     `RATE_LIMIT_SIGNUP_VERIFY_*` variables.
//
//  3. The rate-limit table is duplicated in configuration.mdx and
//     docker-compose.mdx, so every `RATE_LIMIT_*` variable must appear in both.
//     Updating one page and not the other is the same drift one level down.
//
// Both allow-lists below are explicit and carry a reason per entry, and a stale
// entry is an error - the check must never quietly stop covering something.
//
// Usage: node scripts/check-env-docs.mjs

const SERVER_SRC = "apps/server/src";
const DOCS_DIR = "apps/marketing/src/content/docs/self-hosting";
const ENV_EXAMPLE = ".env.example";

// The rate-limit tuning table is duplicated across these two pages.
const RATE_LIMIT_DOC_FILES = ["configuration.mdx", "docker-compose.mdx"];

// Documented, but deliberately not read by the Rust server.
const DOCS_ONLY_VARS = new Map([
	[
		"BITTERY_RELEASE",
		"consumed by Compose to pin the coordinated server and web image pair",
	],
	["DOMAIN", "consumed by Caddy and Compose for TLS; never reaches the server"],
	["COMPOSE_PROFILES", "a docker compose flag, not an application variable"],
	["MINIO_ROOT_PASSWORD", "read by the bundled MinIO image, not by the server"],
	[
		"DB_PASSWORD",
		"interpolated into DATABASE_URL by Compose; the server only sees DATABASE_URL",
	],
	["POSTGRES_DB", "read by the built-in postgres image, not by the server"],
	["POSTGRES_USER", "read by the built-in postgres image, not by the server"],
	["VITE_SERVER_URL", "build-time variable for the web SPA (apps/web)"],
	[
		"VITE_BILLING_MARKETING_ENABLED",
		"build-time variable for the web SPA (apps/web)",
	],
]);

// Read by the server, but deliberately absent from the self-hosting docs.
const UNDOCUMENTED_SERVER_VARS = new Map([
	[
		"BITTERY_ATTACHMENT_UPLOAD_SECRET",
		"optional override that falls back to JWT_SECRET; no self-hoster needs to set it",
	],
	[
		"BITTERY_DEV_MAIL_OUTBOX",
		"local-development file the dev auth stubs append emailed verification codes to; must not be advertised as a deployment option",
	],
	[
		"BITTERY_ENABLE_DEV_AUTH_STUBS",
		"local-development stub for auth email delivery; must not be advertised as a deployment option",
	],
	[
		"HOST",
		"bind address; the shipped images always run on the 0.0.0.0 default",
	],
	[
		"NODE_ENV",
		"production detection inherited from the Node-era server; set by the images, not by operators",
	],
	[
		"REDIS_POOL_SIZE",
		"connection-pool tuning; defaults to 4 and is not part of the supported surface",
	],
	[
		"STRIPE_SECRET_KEY",
		"cloud-only billing; self-hosted builds have no billing",
	],
	[
		"STRIPE_WEBHOOK_SECRET",
		"cloud-only billing; self-hosted builds have no billing",
	],
	[
		"STRIPE_PRICE_PERSONAL_MONTHLY",
		"cloud-only billing; self-hosted builds have no billing",
	],
	[
		"STRIPE_PRICE_FAMILY_MONTHLY",
		"cloud-only billing; self-hosted builds have no billing",
	],
	[
		"STRIPE_PRICE_TEAM_SEAT_MONTHLY",
		"cloud-only billing; self-hosted builds have no billing",
	],
	[
		"WEB_APP_URL",
		"cloud-only base URL for share links; the self-hosted Compose stack does not set it",
	],
]);

// Matches the accessors the server reads environment variables through:
// `std::env::var("X")`, `env::var_os("X")`, and the `env_*` helpers
// (`env_i64`, `env_flag`, ...). A new accessor must either follow that naming
// or be added here, otherwise its variable is invisible to check 2.
const ENV_ACCESSOR =
	/\benv(?:::var(?:_os)?|_[a-z0-9_]+)\s*\(\s*"([A-Z][A-Z0-9_]*)"/g;

// Some variables are reached indirectly - `STRIPE_PRICE_*` for instance is
// looked up through a plan-to-variable table, so the name and the `env::var`
// call sit in different places. Any env-var-shaped literal in the server that
// .env.example also lists counts as a read: that pair is not a coincidence, and
// .env.example is one of the two places the undocumented variables were hiding.
const ENV_SHAPED_LITERAL = /"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)"/g;
const CONFIG_ENV_LITERAL = /"([A-Z][A-Z0-9_]*)"/g;

// `| \`NAME\` | default | description |` table rows, and `NAME=value` lines in
// shell snippets (including Compose-style `- NAME=value`).
const DOC_TABLE_ROW = /^\|\s*`([A-Z][A-Z0-9_]*)`/gm;
const DOC_ASSIGNMENT = /^\s*(?:[-#]\s*)?([A-Z][A-Z0-9_]*)=/gm;

function listFiles(dir, predicate) {
	return readdirSync(resolve(dir), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && predicate(entry.name))
		.map((entry) =>
			relative(process.cwd(), join(entry.parentPath, entry.name)),
		);
}

function matchAll(content, pattern) {
	return [...content.matchAll(pattern)].map((match) => match[1]);
}

// Test modules set and read variables purely to exercise the code under test;
// documenting those would be noise.
function isTestFile(fileName) {
	return fileName.endsWith("_tests.rs") || fileName === "test_support.rs";
}

const exampleVars = new Set(
	matchAll(readFileSync(resolve(ENV_EXAMPLE), "utf8"), DOC_ASSIGNMENT),
);

const serverVars = new Set();
for (const filePath of listFiles(
	SERVER_SRC,
	(name) => name.endsWith(".rs") && !isTestFile(name),
)) {
	const content = readFileSync(filePath, "utf8");
	const productionContent = content.split("\n#[cfg(test)]")[0];
	for (const name of matchAll(content, ENV_ACCESSOR)) {
		serverVars.add(name);
	}
	// Startup configuration intentionally receives an injected lookup function instead of reading
	// process-global state itself. Every env-shaped literal in its production section is therefore
	// a real configuration key, even when it is not listed in .env.example.
	if (filePath === `${SERVER_SRC}/config/mod.rs`) {
		for (const name of matchAll(productionContent, CONFIG_ENV_LITERAL)) {
			serverVars.add(name);
		}
	}
	for (const name of matchAll(content, ENV_SHAPED_LITERAL)) {
		if (exampleVars.has(name)) {
			serverVars.add(name);
		}
	}
}

const documentedVars = new Set();
const varsByDocFile = new Map();
for (const filePath of listFiles(DOCS_DIR, (name) => name.endsWith(".mdx"))) {
	const content = readFileSync(filePath, "utf8");
	const names = [
		...matchAll(content, DOC_TABLE_ROW),
		...matchAll(content, DOC_ASSIGNMENT),
	];
	varsByDocFile.set(filePath, new Set(names));
	for (const name of names) {
		documentedVars.add(name);
	}
}

const errors = [];

if (serverVars.size === 0) {
	errors.push(
		`no environment variables found in ${SERVER_SRC} - the ENV_ACCESSOR pattern in this script is probably stale`,
	);
}

// 1. Documented -> read by the server.
for (const name of [...documentedVars].sort()) {
	if (serverVars.has(name) || DOCS_ONLY_VARS.has(name)) {
		continue;
	}
	errors.push(
		`${name} is documented in ${DOCS_DIR} but nothing in ${SERVER_SRC} reads it. Remove it from the docs, or add it to DOCS_ONLY_VARS in this script with a reason if it is consumed outside the server.`,
	);
}

// 2. Read by the server -> documented.
for (const name of [...serverVars].sort()) {
	if (documentedVars.has(name) || UNDOCUMENTED_SERVER_VARS.has(name)) {
		continue;
	}
	errors.push(
		`${name} is read by ${SERVER_SRC} but is documented nowhere in ${DOCS_DIR}. Document it, or add it to UNDOCUMENTED_SERVER_VARS in this script with a reason.`,
	);
}

// 3. Every RATE_LIMIT_* variable appears on both pages carrying the table.
for (const name of [...serverVars].sort()) {
	if (!name.startsWith("RATE_LIMIT_") || UNDOCUMENTED_SERVER_VARS.has(name)) {
		continue;
	}
	for (const fileName of RATE_LIMIT_DOC_FILES) {
		const filePath = join(DOCS_DIR, fileName);
		const names = varsByDocFile.get(filePath);
		if (!names) {
			errors.push(
				`${filePath} not found, but this script expects the rate-limit table there. Update RATE_LIMIT_DOC_FILES.`,
			);
			continue;
		}
		if (!names.has(name)) {
			errors.push(
				`${name} is missing from ${filePath}. Both pages carry the rate-limit table and must list every RATE_LIMIT_* variable.`,
			);
		}
	}
}

// 4. Neither allow-list may rot: an entry that no longer applies has to go.
for (const [name, reason] of DOCS_ONLY_VARS) {
	if (!documentedVars.has(name)) {
		errors.push(
			`DOCS_ONLY_VARS lists ${name} ("${reason}") but it is no longer documented. Drop the entry.`,
		);
		continue;
	}
	if (serverVars.has(name)) {
		errors.push(
			`DOCS_ONLY_VARS lists ${name} ("${reason}") but ${SERVER_SRC} now reads it. Drop the entry.`,
		);
	}
}

for (const [name, reason] of UNDOCUMENTED_SERVER_VARS) {
	if (!serverVars.has(name)) {
		errors.push(
			`UNDOCUMENTED_SERVER_VARS lists ${name} ("${reason}") but ${SERVER_SRC} no longer reads it. Drop the entry.`,
		);
		continue;
	}
	if (documentedVars.has(name)) {
		errors.push(
			`UNDOCUMENTED_SERVER_VARS lists ${name} ("${reason}") but it is documented now. Drop the entry.`,
		);
	}
}

if (errors.length > 0) {
	console.error("Env var documentation check failed:\n");
	for (const error of errors) {
		console.error(`  - ${error}`);
	}
	process.exit(1);
}

console.log(
	`Env var documentation check passed (${serverVars.size} server env vars, ${documentedVars.size} documented, ${UNDOCUMENTED_SERVER_VARS.size + DOCS_ONLY_VARS.size} allow-listed).`,
);
