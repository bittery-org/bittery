import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PlaywrightTestConfig } from "@playwright/test";
import { defineConfig, devices } from "@playwright/test";
import { shouldBuildE2eServerBinaries } from "./scripts/e2e-server-binaries";
import { E2E_SERVER_RATE_LIMITS } from "./tests/e2e-server-env";
import { E2E_POSTGRES_BASE_URL } from "./tests/fixtures/e2e-database";
import { MAIL_OUTBOX_PATHS } from "./tests/fixtures/mail-outbox";

/**
 * Playwright E2E configuration for the Bittery web app.
 *
 * Two projects, each with its own API server, database and web app:
 *   cloud       - API :3010 / web :3011, database `bittery_e2e`
 *   self-hosted - API :3020 / web :3021, database `bittery_e2e_selfhosted`
 *
 * Nothing here may touch :3000 / :3001 or the `bittery` dev database - the dev
 * stack is expected to be running and must survive a suite run untouched.
 *
 * Prerequisites: `pnpm build:crypto-wasm`, a running Postgres
 * (`pnpm db:start`), and Chromium (`pnpm exec playwright install chromium`).
 */

const configDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(configDir, "../..");

// Chromium's shared-memory segments live under TMPDIR, and a RAM-backed /tmp
// fills at two workers - renderers then die with ERR_INSUFFICIENT_RESOURCES.
const browserTmpDir = path.join(repoRoot, "node_modules/.cache/e2e-tmp");
mkdirSync(browserTmpDir, { recursive: true });
process.env.TMPDIR = browserTmpDir;

// The web app fails to boot without the generated Paraglide output, which is
// gitignored, so a clean checkout would otherwise 500 on every route.
const paraglideEntry = path.join(
	repoRoot,
	"packages/i18n/src/paraglide/messages.js",
);
if (!existsSync(paraglideEntry)) {
	execFileSync("pnpm", ["--filter", "@bittery/i18n", "run", "build"], {
		cwd: repoRoot,
		stdio: "inherit",
	});
}

// tests/e2e-launch.mjs builds this too, but Playwright starts both API
// `webServer`s at once and the second would then block on cargo's target-dir
// lock for the whole of the first build; here it happens once, before either.
// CI skips this after its explicit build; workers skip it to avoid racing Cargo
// fingerprint checks when they re-import the config.
if (
	shouldBuildE2eServerBinaries({
		E2E_SERVER_BINARIES_READY: process.env.E2E_SERVER_BINARIES_READY,
		TEST_WORKER_INDEX: process.env.TEST_WORKER_INDEX,
	})
) {
	execFileSync(
		"cargo",
		[
			"build",
			"--manifest-path",
			"apps/server/Cargo.toml",
			"--bin",
			"bittery-server",
			"--bin",
			"migrate",
		],
		{ cwd: repoRoot, stdio: "inherit" },
	);
}

// The API server is `cargo build`-ed on first boot. CI pre-builds it in a step
// of its own, but a cache-cold runner still has to fit a full debug build here.
const API_SERVER_TIMEOUT = process.env.CI ? 900000 : 300000;
// Both web apps compile their module graph on the first request, which is far
// slower on a shared CI runner than on a dev machine.
const WEB_APP_TIMEOUT = process.env.CI ? 300000 : 180000;

type Stack = "cloud" | "self-hosted";

const ALL_STACKS: Stack[] = ["cloud", "self-hosted"];

function isStack(value: string | undefined): value is Stack {
	return value === "cloud" || value === "self-hosted";
}

/**
 * Which stacks need servers for this run - project names map 1:1 to stacks.
 *
 * This fails open, and that is the point: skipping a stack a test actually
 * needs leaves its `webServer` absent, and the run then fails as if the app
 * were broken rather than as if the config were wrong. So an unparseable
 * argument, no `--project` at all, or `--ui` (which switches projects at
 * runtime, long after this is evaluated) all start both stacks.
 */
function selectedStacks(): Stack[] {
	const override = process.env.E2E_STACKS;
	if (override) {
		const names = override
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean);
		if (names.length > 0 && names.every(isStack)) {
			return [...new Set(names)];
		}
		return ALL_STACKS;
	}

	const argv = process.argv.slice(2);
	if (argv.some((arg) => arg === "--ui" || arg.startsWith("--ui-"))) {
		return ALL_STACKS;
	}

	const selected = new Set<Stack>();
	for (const [index, arg] of argv.entries()) {
		let value: string | undefined;
		if (arg.startsWith("--project=")) {
			value = arg.slice("--project=".length);
		} else if (arg === "--project") {
			value = argv[index + 1];
		} else {
			continue;
		}
		if (!isStack(value)) {
			return ALL_STACKS;
		}
		selected.add(value);
	}
	return selected.size > 0 ? [...selected] : ALL_STACKS;
}

function apiServerEnv(options: {
	mode: Stack;
	port: number;
	database: string;
	webAppUrl: string;
	outboxPath: string;
}): Record<string, string> {
	return {
		...E2E_SERVER_RATE_LIMITS,
		HOST: "127.0.0.1",
		PORT: String(options.port),
		DATABASE_URL: `${E2E_POSTGRES_BASE_URL}/${options.database}`,
		// With the postgres rate-limit adapter below, every auth request holds a
		// second connection for the limiter write; the default pool of 5 queues on
		// sqlx's acquire timeout and surfaces as intermittent 500s.
		DATABASE_MAX_CONNECTIONS: "25",
		NODE_ENV: "test",
		BITTERY_MODE: options.mode,
		BITTERY_CLOUD_PUBLIC_SIGNUP: "true",
		// The plan step and /billing must render; specs pick the Free plan, so no
		// Stripe credentials are needed.
		BITTERY_CLOUD_BILLING_ENABLED: "true",
		BITTERY_ENABLE_DEV_AUTH_STUBS: "true",
		BITTERY_DEV_MAIL_OUTBOX: options.outboxPath,
		JWT_SECRET: "e2e-jwt-secret-not-used-outside-tests",
		BITTERY_STORAGE_ENDPOINT: OBJECT_STORAGE_ENDPOINT,
		BITTERY_STORAGE_BUCKET: "bittery-e2e",
		BITTERY_STORAGE_ACCESS_KEY_ID: "e2e-access-key",
		BITTERY_STORAGE_SECRET_ACCESS_KEY: "e2e-secret-key",
		BITTERY_STORAGE_REGION: "auto",
		CORS_ORIGIN: options.webAppUrl,
		WEB_APP_URL: options.webAppUrl,
		// Postgres-backed limits keep the run off the shared valkey, which the dev
		// stack also uses and which no `--fresh` reset would clear.
		RATE_LIMIT_ADAPTER: "postgres",
		RATE_LIMIT_REDIS_URL: "",
		REDIS_URL: "",
		TRUST_PROXY_MODE: "none",
	};
}

function webAppEnv(serverUrl: string, webAppUrl: string) {
	return {
		// apps/web has no `.env` and Vite's envDir is apps/web, so the repo-root
		// `.env` never reaches it - without this every API call 404s against the
		// web app's own origin.
		VITE_SERVER_URL: serverUrl,
		VITE_WEBAPP_URL: webAppUrl,
		VITE_DISABLE_DEVTOOLS: "true",
		// Unprefixed on purpose - vite.config.ts reads it to configure the dev
		// server (HMR off, deps pre-bundled), and it never reaches client code.
		E2E: "1",
	};
}

const STACK_PORTS: Record<Stack, { api: number; web: number }> = {
	cloud: { api: 3010, web: 3011 },
	"self-hosted": { api: 3020, web: 3021 },
};

const STACK_DATABASES: Record<Stack, string> = {
	cloud: "bittery_e2e",
	"self-hosted": "bittery_e2e_selfhosted",
};

const OBJECT_STORAGE_PORT = 3030;
const OBJECT_STORAGE_ENDPOINT = `http://127.0.0.1:${OBJECT_STORAGE_PORT}`;

type WebServer = Extract<
	NonNullable<PlaywrightTestConfig["webServer"]>,
	unknown[]
>[number];

function stackServers(stack: Stack): WebServer[] {
	const { api, web } = STACK_PORTS[stack];
	const serverUrl = `http://localhost:${api}`;
	const webAppUrl = `http://localhost:${web}`;
	const diagnosticLog = path.join(browserTmpDir, `${stack}-api.log`);
	return [
		{
			// `exec` preserves the launcher's real-server PID while the redirection gives
			// behavioral E2E assertions access to the exact diagnostics the Server emitted.
			command: `exec node tests/e2e-launch.mjs > ${JSON.stringify(diagnosticLog)} 2>&1`,
			url: `${serverUrl}/healthz`,
			// Never true, not even locally: a reused server keeps its own
			// environment, which silently drops the rate-limit overrides and the
			// mail outbox. See tests/e2e-server-env.ts.
			reuseExistingServer: false,
			timeout: API_SERVER_TIMEOUT,
			stdout: "pipe",
			stderr: "pipe",
			env: apiServerEnv({
				mode: stack,
				port: api,
				database: STACK_DATABASES[stack],
				webAppUrl,
				outboxPath: MAIL_OUTBOX_PATHS[stack],
			}),
		},
		{
			command: `pnpm exec vite dev --port ${web} --strictPort`,
			url: `${webAppUrl}/login`,
			reuseExistingServer: false,
			timeout: WEB_APP_TIMEOUT,
			env: webAppEnv(serverUrl, webAppUrl),
		},
	];
}

export default defineConfig({
	testDir: "./tests/e2e",
	// Parallelism here is file-level, not test-level: this pins a spec file to a
	// single worker, which is what keeps the 16 shared `beforeAll` accounts and
	// import-export.spec.ts's ordered-not-independent tests correct.
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	// A worker is a whole Chromium doing 600k-iteration PBKDF2, and they all share
	// one single-process Vite dev server that compiles routes on demand; starving
	// it surfaces as a route that never renders, not as a failed assertion.
	// Deliberately a constant, not os.cpus(): the knee sits well below the core
	// count because Vite, the API server and Postgres want the same cores. On 8
	// cores, 4 workers inflated per-test duration 30% for no wall-clock gain; a
	// GitHub-hosted ubuntu-latest runner has 4, hence half as many there.
	workers: Number(process.env.E2E_WORKERS) || (process.env.CI ? 2 : 3),
	reporter: [
		["list"],
		["html", { outputFolder: "playwright-report", open: "never" }],
	],
	// SRP auth is slow, and specs on the default get 15-30% slower under worker
	// contention; the headroom is free on a passing test.
	timeout: 90000,
	expect: {
		timeout: 10000,
	},
	use: {
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		// `retain-on-failure` still records everything first, including each of the
		// ~120 extra BrowserContexts the specs open - an ffmpeg per context, and a
		// blocking file finalize on every close.
		video: process.env.CI ? "on-first-retry" : "off",
		actionTimeout: 15000,
		navigationTimeout: 30000,
	},
	projects: [
		{
			name: "cloud",
			testIgnore: /self-hosted\.spec\.ts$/,
			use: {
				...devices["Desktop Chrome"],
				baseURL: `http://localhost:${STACK_PORTS.cloud.web}`,
			},
		},
		{
			name: "self-hosted",
			testMatch: /self-hosted\.spec\.ts$/,
			use: {
				...devices["Desktop Chrome"],
				baseURL: `http://localhost:${STACK_PORTS["self-hosted"].web}`,
			},
		},
	],
	webServer: [
		{
			command: "node tests/e2e-object-storage.mjs",
			url: `${OBJECT_STORAGE_ENDPOINT}/healthz`,
			reuseExistingServer: false,
			timeout: 30000,
			env: { E2E_OBJECT_STORAGE_PORT: String(OBJECT_STORAGE_PORT) },
		},
		...selectedStacks().flatMap(stackServers),
	],
});
