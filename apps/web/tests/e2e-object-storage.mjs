import { createHash } from "node:crypto";
import { createServer } from "node:http";

const HOST = "127.0.0.1";
const PORT = Number(process.env.E2E_OBJECT_STORAGE_PORT ?? 3030);
const objects = new Map();
const operationUploadAttempts = new Map();
const objectUploadEvidence = new Map();

// This loopback-only fake accepts the signed S3-shaped requests without
// validating AWS credentials; the browser flows under test own the encryption.

function setCorsHeaders(response) {
	response.setHeader("access-control-allow-origin", "*");
	response.setHeader(
		"access-control-allow-headers",
		"authorization, content-length, content-type, x-amz-content-sha256, x-amz-checksum-sha256, x-amz-date",
	);
	response.setHeader(
		"access-control-allow-methods",
		"DELETE, GET, HEAD, OPTIONS, PUT",
	);
}

async function readBody(request) {
	const chunks = [];
	for await (const chunk of request) {
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

const server = createServer(async (request, response) => {
	setCorsHeaders(response);
	if (request.method === "OPTIONS") {
		response.writeHead(204).end();
		return;
	}

	const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
	if (request.method === "GET" && url.pathname === "/healthz") {
		response.writeHead(200, { "content-type": "text/plain" }).end("ok");
		return;
	}
	if (
		request.method === "GET" &&
		url.pathname === "/__acceptance/object-upload"
	) {
		const key = url.searchParams.get("key");
		if (!key || key.length > 2048 || !/^\/[A-Za-z0-9/_.-]+$/.test(key)) {
			response.writeHead(400).end();
			return;
		}
		response
			.writeHead(200, { "content-type": "application/json" })
			.end(
				JSON.stringify(
					objectUploadEvidence.get(key) ?? { attempts: 0, last: null },
				),
			);
		return;
	}

	// Loopback fixture diagnostics count arrivals, including failed checksum requests. Never
	// retain signed query strings, headers, image contents, or credentials in the counter.
	if (
		request.method === "GET" &&
		url.pathname === "/__acceptance/image-upload-attempts"
	) {
		const operationId = url.searchParams.get("operationId");
		if (
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
				operationId ?? "",
			)
		) {
			response.writeHead(400).end();
			return;
		}
		response.writeHead(200, { "content-type": "application/json" }).end(
			JSON.stringify({
				attempts: operationUploadAttempts.get(operationId) ?? 0,
			}),
		);
		return;
	}
	const key = decodeURIComponent(url.pathname);
	if (request.method === "PUT") {
		const operation =
			/\/vaults\/[^/]+\/[^/]+\/create\/([0-9a-f-]{36})-[0-9a-f]{64}$/.exec(
				key,
			)?.[1];
		if (operation)
			operationUploadAttempts.set(
				operation,
				(operationUploadAttempts.get(operation) ?? 0) + 1,
			);
		const body = await readBody(request);
		const checksum = createHash("sha256").update(body).digest("base64");
		// Exact received facts only: no signed URL, authorization or other request headers.
		objectUploadEvidence.set(key, {
			attempts: (objectUploadEvidence.get(key)?.attempts ?? 0) + 1,
			last: {
				headers: Object.fromEntries(
					[
						"content-type",
						"content-length",
						"x-amz-content-sha256",
						"x-amz-checksum-sha256",
					].map((name) => [name, request.headers[name] ?? null]),
				),
				byteLength: body.byteLength,
				sha256: createHash("sha256").update(body).digest("hex"),
			},
		});
		const providedChecksum = request.headers["x-amz-checksum-sha256"];
		if (providedChecksum !== undefined && providedChecksum !== checksum) {
			response.writeHead(400).end("Checksum mismatch");
			return;
		}
		objects.set(key, {
			body,
			checksum,
			contentType:
				request.headers["content-type"] ?? "application/octet-stream",
		});
		response.writeHead(200, { etag: `"e2e-${body.byteLength}"` }).end();
		return;
	}

	const object = objects.get(key);
	if (request.method === "HEAD") {
		if (!object) {
			response.writeHead(404).end();
			return;
		}
		response
			.writeHead(200, {
				"content-length": object.body.byteLength,
				"content-type": object.contentType,
				"x-amz-checksum-sha256": object.checksum,
			})
			.end();
		return;
	}

	if (request.method === "GET") {
		if (!object) {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, {
			"content-length": object.body.byteLength,
			"content-type": object.contentType,
		});
		response.end(object.body);
		return;
	}

	if (request.method === "DELETE") {
		objects.delete(key);
		response.writeHead(204).end();
		return;
	}

	response.writeHead(405, { allow: "DELETE, GET, HEAD, OPTIONS, PUT" }).end();
});

server.listen(PORT, HOST, () => {
	process.stdout.write(
		`E2E object storage listening on http://${HOST}:${PORT}\n`,
	);
});

function shutdown() {
	server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
