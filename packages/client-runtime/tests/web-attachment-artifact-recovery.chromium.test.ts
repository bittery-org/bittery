import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	type BrowserContext,
	chromium,
	type Page,
} from "../../../apps/extension/node_modules/playwright/index.mjs";

// Match the existing Create Vault harness: repeated Bun DevTools pipe teardown can break
// a later launch. Only Chromium is shared; each history owns an isolated storage context.
let browserTask: ReturnType<typeof chromium.launch> | undefined;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterAll(async () => {
	try {
		await (await browserTask)?.close();
	} finally {
		for (const server of servers) await server.stop(true);
	}
});

type Row = Record<string, any>;
type StoreRows = { store: string; rows: Row[] }[];
function rows(stores: StoreRows, name: string): Row[] {
	const store = stores.find((entry) => entry.store === name);
	if (!store) throw new Error(`Missing physical IndexedDB store: ${name}`);
	return store.rows;
}

async function withRecoveryBrowser(
	run: (fixture: {
		openPage: () => Promise<Page>;
		errors: string[];
		unexpected: string[];
	}) => Promise<void>,
) {
	const bindingsRoot = process.env.BITTERY_JOINED_UPLOAD_BINDINGS_ROOT;
	if (!bindingsRoot)
		throw new Error("Actual feature WASM bindings are required");
	const build = await Bun.build({
		entrypoints: [
			new URL(
				"./web-attachment-artifact-recovery-chromium-harness.ts",
				import.meta.url,
			).pathname,
		],
		target: "browser",
		format: "esm",
	});
	expect(build.success).toBe(true);
	const harness = await build.outputs[0].text();
	const unexpected: string[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/favicon.ico") return new Response(null, { status: 204 });
			if (path === "/")
				return new Response(
					'<script type="module" src="/harness.js"></script>',
					{
						headers: { "content-type": "text/html" },
					},
				);
			if (path === "/harness.js")
				return new Response(harness, {
					headers: { "content-type": "text/javascript" },
				});
			if (path === "/real-core-bindings.js")
				return new Response(Bun.file(`${bindingsRoot}/index.js`), {
					headers: { "content-type": "text/javascript" },
				});
			if (path === "/real-core.wasm")
				return new Response(Bun.file(`${bindingsRoot}/index_bg.wasm`), {
					headers: { "content-type": "application/wasm" },
				});
			unexpected.push(`${request.method} ${path}`);
			return new Response("Unexpected fixture route", { status: 500 });
		},
	});
	servers.push(server);
	let context: BrowserContext | undefined;
	try {
		browserTask ??= chromium.launch({ headless: false });
		context = await (await browserTask).newContext();
		const isolated = context;
		const errors: string[] = [];
		const openPage = async () => {
			const page = await isolated.newPage();
			page.on("pageerror", (error) => errors.push(error.message));
			await page.goto(server.url.toString());
			await page.waitForFunction(() => "artifactRecoveryRead" in globalThis);
			return page;
		};
		await run({ openPage, errors, unexpected });
	} finally {
		try {
			await context?.close();
		} finally {
			await server.stop(true);
		}
	}
}

test("WASM Recover refuses changed published IndexedDB bytes without writes", async () => {
	await withRecoveryBrowser(async ({ openPage, errors, unexpected }) => {
		let page = await openPage();
		const seeded = await page.evaluate(() =>
			(globalThis as any).artifactRecoverySeed(),
		);
		expect(seeded.requests.at(-1)).toBe("finishProvisional");
		const published = rows(seeded.rows, "artifacts");
		expect(published).toHaveLength(1);
		expect(published[0]).toMatchObject({
			...seeded.artifact,
			publicationState: "published",
			physicalGeneration: seeded.token.generation,
		});
		const provisional = rows(seeded.rows, "provisional_artifacts");
		expect(provisional).toHaveLength(1);
		expect(provisional[0]).toMatchObject({
			...seeded.token,
			current: true,
			publicationState: 2,
		});
		const chunks = rows(seeded.rows, "provisional_chunks");
		expect(chunks.length).toBeGreaterThan(2);
		const bytes = Buffer.concat(
			chunks.map((chunk) => Buffer.from(chunk.bytes)),
		);
		expect(bytes.byteLength.toString()).toBe(seeded.artifact.byteLength);
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(
			seeded.artifact.ciphertextSha256,
		);
		await page.close();

		// A new page loads a fresh WASM instance. No writer, publication proof, or adapter survives.
		page = await openPage();
		const healthy = await page.evaluate(() =>
			(globalThis as any).artifactRecoveryRead(),
		);
		expect(healthy.result).toEqual({ accepted: true, token: seeded.token });
		expect(healthy.before).toEqual(seeded.rows);
		expect(healthy.after).toEqual(seeded.rows);
		const changed = await page.evaluate(
			(token) => (globalThis as any).artifactRecoveryCorrupt(token),
			seeded.token,
		);
		const expected = structuredClone(seeded.rows) as StoreRows;
		const first = rows(expected, "provisional_chunks").find(
			(chunk) => chunk.chunkIndex === 0,
		);
		if (!first) throw new Error("Expected first fixture chunk");
		first.bytes[Math.floor(first.bytes.length / 2)] ^= 1;
		expect(changed).toEqual(expected);
		await page.close();

		page = await openPage();
		const corrupt = await page.evaluate(() =>
			(globalThis as any).artifactRecoveryRead(),
		);
		expect(corrupt.before).toEqual(changed);
		expect(corrupt.after).toEqual(changed);
		for (const request of [...healthy.requests, ...corrupt.requests])
			expect([
				"recoverProvisional",
				"resumeRecoveredProvisional",
				"readSealedProvisionalChunk",
			]).toContain(request);
		expect(errors).toEqual([]);
		expect(unexpected).toEqual([]);
		expect(corrupt.result.accepted).toBe(false);
	});
}, 45_000);

test("WASM Recover distinguishes absent and incomplete IndexedDB scopes without writes", async () => {
	await withRecoveryBrowser(async ({ openPage, errors, unexpected }) => {
		let page = await openPage();
		const seeded = await page.evaluate(() =>
			(globalThis as any).artifactRecoveryBeginIncomplete(),
		);
		expect(rows(seeded.rows, "provisional_artifacts")).toHaveLength(1);
		expect(rows(seeded.rows, "provisional_artifacts")[0]).toMatchObject({
			...seeded.writer,
			current: true,
			publicationState: 0,
		});
		expect(rows(seeded.rows, "provisional_chunks")).toHaveLength(1);
		expect(rows(seeded.rows, "artifacts")).toEqual([]);
		await page.close();
		page = await openPage();
		const incomplete = await page.evaluate(() =>
			(globalThis as any).artifactRecoveryRead(),
		);
		expect(incomplete.before).toEqual(seeded.rows);
		expect(incomplete.after).toEqual(seeded.rows);
		const deleted = await page.evaluate(() =>
			(globalThis as any).artifactRecoveryDeleteAccount(),
		);
		for (const store of deleted) expect(store.rows).toEqual([]);
		await page.close();
		page = await openPage();
		const absent = await page.evaluate(() =>
			(globalThis as any).artifactRecoveryRead(),
		);
		expect(absent.before).toEqual(deleted);
		expect(absent.after).toEqual(deleted);
		expect(errors).toEqual([]);
		expect(unexpected).toEqual([]);
		expect({ incomplete: incomplete.result, absent: absent.result }).toEqual({
			incomplete: { accepted: true, token: null },
			absent: { accepted: true, token: null },
		});
	});
}, 45_000);

test("WASM full sweep preserves a physically published Pending scope until its ownership ends", async () => {
	await withRecoveryBrowser(async ({ openPage, errors, unexpected }) => {
		let page = await openPage();
		const published = await page.evaluate(() =>
			(globalThis as any).artifactRecoverySeed(),
		);
		expect(published.requests.at(-1)).toBe("finishProvisional");
		expect(rows(published.rows, "provisional_artifacts")).toHaveLength(1);
		expect(rows(published.rows, "provisional_artifacts")[0]).toMatchObject({
			...published.token,
			current: true,
			publicationState: 2,
		});
		expect(rows(published.rows, "provisional_chunks").length).toBeGreaterThan(
			2,
		);
		await page.close();

		// This primitive history supplies only the accepted Pending scope, never a live owner.
		// Runtime inventory derivation is covered separately by the actual SQLite reopen history.
		page = await openPage();
		const retained = await page.evaluate(() =>
			(globalThis as any).artifactRecoverySweep(true),
		);
		expect(retained.before).toEqual(published.rows);
		expect(retained.after).toEqual(published.rows);
		expect(retained.deleted).toBe(0);
		expect(retained.requests).toEqual(["listArtifactOwners"]);
		const recovered = await page.evaluate(() =>
			(globalThis as any).artifactRecoveryRead(),
		);
		expect(recovered.result).toEqual({
			accepted: true,
			token: published.token,
		});
		expect(recovered.before).toEqual(published.rows);
		expect(recovered.after).toEqual(published.rows);
		await page.close();

		// The same full sweep with empty ownership must retain its ordinary deletion behavior.
		page = await openPage();
		const discarded = await page.evaluate(() =>
			(globalThis as any).artifactRecoverySweep(false),
		);
		expect(discarded.before).toEqual(published.rows);
		expect(discarded.deleted).toBeGreaterThan(0);
		expect(discarded.requests[0]).toBe("listArtifactIds");
		expect(discarded.requests).toContain("deleteArtifact");
		for (const store of discarded.after) expect(store.rows).toHaveLength(0);
		expect(errors).toEqual([]);
		expect(unexpected).toEqual([]);
	});
}, 45_000);

test("WASM Recover preserves an older publication while explicit redo remains incomplete", async () => {
	await withRecoveryBrowser(async ({ openPage, errors, unexpected }) => {
		let page = await openPage();
		const published = await page.evaluate(() =>
			(globalThis as any).artifactRecoverySeed(),
		);
		const pending = await page.evaluate(() =>
			(globalThis as any).artifactRecoveryBeginIncomplete(),
		);
		expect(pending.writer.generation).not.toBe(published.token.generation);
		expect(rows(pending.rows, "artifacts")).toEqual(
			rows(published.rows, "artifacts"),
		);
		const generations = rows(pending.rows, "provisional_artifacts");
		expect(generations).toHaveLength(2);
		expect(
			generations.find((row) => row.generation === published.token.generation),
		).toMatchObject({ current: false, publicationState: 2 });
		expect(
			generations.find((row) => row.generation === pending.writer.generation),
		).toMatchObject({ current: true, publicationState: 0 });
		await page.close();
		page = await openPage();
		const recovered = await page.evaluate(() =>
			(globalThis as any).artifactRecoveryRead(),
		);
		expect(recovered.before).toEqual(pending.rows);
		expect(recovered.after).toEqual(pending.rows);
		expect(errors).toEqual([]);
		expect(unexpected).toEqual([]);
		expect(recovered.result).toEqual({ accepted: true, token: null });
	});
}, 45_000);

for (const damage of [
	"duplicateCurrent",
	"incompleteMapping",
	"extraChunk",
	"missingCurrent",
] as const) {
	test(`WASM Recover refuses ${damage} in published IndexedDB state without writes`, async () => {
		await withRecoveryBrowser(async ({ openPage, errors, unexpected }) => {
			let page = await openPage();
			const published = await page.evaluate(() =>
				(globalThis as any).artifactRecoverySeed(),
			);
			const changed = await page.evaluate(
				({ token, damage }) =>
					(globalThis as any).artifactRecoveryDamageBinding(token, damage),
				{ token: published.token, damage },
			);
			expect(changed).not.toEqual(published.rows);
			await page.close();
			page = await openPage();
			const recovered = await page.evaluate(() =>
				(globalThis as any).artifactRecoveryRead(),
			);
			expect(recovered.before).toEqual(changed);
			expect(recovered.after).toEqual(changed);
			for (const request of recovered.requests)
				expect([
					"recoverProvisional",
					"resumeRecoveredProvisional",
					"readSealedProvisionalChunk",
				]).toContain(request);
			expect(errors).toEqual([]);
			expect(unexpected).toEqual([]);
			expect(recovered.result.accepted).toBe(false);
		});
	}, 45_000);
}
