import { createServer } from "node:http";

const HOST = "127.0.0.1";
const PORT = Number(process.env.E2E_OBJECT_STORAGE_PORT ?? 3030);
const objects = new Map();

// This loopback-only fake accepts the signed S3-shaped requests without
// validating AWS credentials; the browser flows under test own the encryption.

function setCorsHeaders(response) {
	response.setHeader("access-control-allow-origin", "*");
	response.setHeader(
		"access-control-allow-headers",
		"authorization, content-length, content-type, x-amz-content-sha256, x-amz-date",
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

	const key = decodeURIComponent(url.pathname);
	if (request.method === "PUT") {
		const body = await readBody(request);
		objects.set(key, {
			body,
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
