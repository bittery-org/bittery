import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

async function freePort(): Promise<number> {
	const reservation = createServer();
	reservation.listen(0, "127.0.0.1");
	await once(reservation, "listening");
	const address = reservation.address();
	if (address === null || typeof address === "string")
		throw new Error("No test port");
	await new Promise<void>((resolve, reject) =>
		reservation.close((error) => (error ? reject(error) : resolve())),
	);
	return address.port;
}

test("object-store fixture verifies received bytes and exposes the exact S3 checksum without overwriting on mismatch", async () => {
	// Read the actual launch environment without starting or rebuilding an application stack.
	const priorReady = process.env.E2E_SERVER_BINARIES_READY;
	const priorTmp = process.env.TMPDIR;
	let config: typeof import("../playwright.config")["default"];
	try {
		process.env.E2E_SERVER_BINARIES_READY = "1";
		config = (await import("../playwright.config")).default;
	} finally {
		if (priorReady === undefined) delete process.env.E2E_SERVER_BINARIES_READY;
		else process.env.E2E_SERVER_BINARIES_READY = priorReady;
		if (priorTmp === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = priorTmp;
	}
	const servers = Array.isArray(config.webServer) ? config.webServer : [];
	const storageEnvironments = servers
		.map((server) => server.env)
		.filter((env) => env?.BITTERY_STORAGE_ENDPOINT !== undefined);
	expect(storageEnvironments.length).toBeGreaterThan(0);
	for (const env of storageEnvironments) {
		expect(env?.BITTERY_STORAGE_CDN_URL).toBe(
			`${env?.BITTERY_STORAGE_ENDPOINT}/${env?.BITTERY_STORAGE_BUCKET}`,
		);
	}
	const port = await freePort();
	const server = spawn(
		"node",
		[
			fileURLToPath(
				new URL("../tests/e2e-object-storage.mjs", import.meta.url),
			),
		],
		{
			env: { ...process.env, E2E_OBJECT_STORAGE_PORT: String(port) },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const exited = once(server, "exit");
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.once("exit", () =>
				reject(new Error("Object store exited before readiness")),
			);
			server.stdout.on("data", (chunk: Buffer) => {
				if (
					chunk
						.toString()
						.includes(
							`E2E object storage listening on http://127.0.0.1:${port}`,
						)
				)
					resolve();
			});
		});
		const publicBase = new URL(
			storageEnvironments[0]?.BITTERY_STORAGE_CDN_URL ?? "",
		);
		publicBase.port = String(port);
		const operationId = "11111111-1111-4111-8111-111111111111";
		const url = `${publicBase}/vaults/user-fixture/vault-fixture/create/${operationId}-${"a".repeat(64)}`;
		const attemptsUrl = `http://127.0.0.1:${port}/__acceptance/image-upload-attempts?operationId=${operationId}`;
		const uploadEvidence = (target: string) =>
			fetch(
				`http://127.0.0.1:${port}/__acceptance/object-upload?key=${encodeURIComponent(new URL(target).pathname)}`,
			).then((response) => response.json());
		expect(await (await fetch(attemptsUrl)).json()).toEqual({ attempts: 0 });
		expect(await uploadEvidence(url)).toEqual({ attempts: 0, last: null });
		const body = new Uint8Array([137, 80, 78, 71, 0, 255, 4]);
		const checksum = createHash("sha256").update(body).digest("base64");
		const headers = {
			"content-type": "image/png",
			"content-length": String(body.length),
			"x-amz-content-sha256": createHash("sha256").update(body).digest("hex"),
			"x-amz-checksum-sha256": checksum,
			authorization: "fixture-must-not-retain-this-header",
		};
		expect(
			(
				await fetch(
					`${url}?X-Amz-Signature=fixture-query-must-not-be-retained`,
					{
						method: "PUT",
						headers,
						body,
					},
				)
			).status,
		).toBe(200);
		expect(await (await fetch(attemptsUrl)).json()).toEqual({ attempts: 1 });
		expect(await uploadEvidence(url)).toEqual({
			attempts: 1,
			last: {
				headers: {
					"content-type": "image/png",
					"content-length": String(body.length),
					"x-amz-content-sha256": headers["x-amz-content-sha256"],
					"x-amz-checksum-sha256": checksum,
				},
				byteLength: body.length,
				sha256: createHash("sha256").update(body).digest("hex"),
			},
		});
		const head = await fetch(url, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(head.headers.get("x-amz-checksum-sha256")).toBe(checksum);
		expect(head.headers.get("content-length")).toBe(String(body.length));
		expect(head.headers.get("content-type")).toBe("image/png");
		expect(new Uint8Array(await (await fetch(url)).arrayBuffer())).toEqual(
			body,
		);

		// Keeping the claimed checksum while changing bytes must neither replace nor create an object.
		const different = new Uint8Array([0, 1, 2]);
		for (const target of [url, `${url}-absent`]) {
			expect(
				(
					await fetch(target, {
						method: "PUT",
						headers: { ...headers, "content-length": String(different.length) },
						body: different,
					})
				).status,
			).toBe(400);
		}
		// The rejected checksum attempt still reached storage and must not be reported as no upload.
		expect(await (await fetch(attemptsUrl)).json()).toEqual({ attempts: 2 });
		expect(await uploadEvidence(url)).toMatchObject({
			attempts: 2,
			last: {
				byteLength: different.length,
				sha256: createHash("sha256").update(different).digest("hex"),
				headers: { "x-amz-checksum-sha256": checksum },
			},
		});
		expect(await uploadEvidence(`${url}-unrelated`)).toEqual({
			attempts: 0,
			last: null,
		});
		expect(
			(
				await fetch(
					`http://127.0.0.1:${port}/__acceptance/object-upload?key=invalid`,
				)
			).status,
		).toBe(400);
		expect(
			(await fetch(attemptsUrl.replace(operationId, "invalid"))).status,
		).toBe(400);
		expect((await fetch(`${url}-absent`, { method: "HEAD" })).status).toBe(404);
		expect(
			(await fetch(url, { method: "HEAD" })).headers.get(
				"x-amz-checksum-sha256",
			),
		).toBe(checksum);
		expect(new Uint8Array(await (await fetch(url)).arrayBuffer())).toEqual(
			body,
		);

		// Existing Attachment fixtures can omit the checksum header; HEAD still describes actual bytes.
		expect(
			(await fetch(`${url}-legacy`, { method: "PUT", body: different })).status,
		).toBe(200);
		expect(
			(await fetch(`${url}-legacy`, { method: "HEAD" })).headers.get(
				"x-amz-checksum-sha256",
			),
		).toBe(createHash("sha256").update(different).digest("base64"));
		expect(await uploadEvidence(`${url}-legacy`)).toEqual({
			attempts: 1,
			last: {
				headers: {
					"content-type": null,
					"content-length": String(different.length),
					"x-amz-content-sha256": null,
					"x-amz-checksum-sha256": null,
				},
				byteLength: different.length,
				sha256: createHash("sha256").update(different).digest("hex"),
			},
		});
		const cors = await fetch(url, {
			method: "OPTIONS",
			headers: {
				origin: "http://localhost:3010",
				"access-control-request-method": "PUT",
				"access-control-request-headers": "x-amz-checksum-sha256",
			},
		});
		expect(cors.status).toBe(204);
		expect(
			cors.headers.get("access-control-allow-headers")?.split(", "),
		).toContain("x-amz-checksum-sha256");
		expect(
			cors.headers.get("access-control-allow-methods")?.split(", "),
		).toContain("HEAD");
	} finally {
		server.kill("SIGTERM");
		await exited;
	}
}, 10_000);
