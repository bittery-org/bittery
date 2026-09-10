import { expect, test } from "bun:test";
import { once } from "node:events";
import { createServer, type IncomingMessage, request } from "node:http";
import { createSyncTransportProxy } from "../tests/fixtures/sync-transport-proxy";

function throughProxy(proxy: string, target: string): Promise<IncomingMessage> {
	return new Promise((resolve, reject) => {
		const upstream = request(proxy, { path: target }, resolve);
		upstream.on("error", reject);
		upstream.end();
	});
}

async function body(response: IncomingMessage) {
	const chunks = [];
	for await (const chunk of response) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString();
}

test("API fault terminates a held stream, denies reconnects, preserves assets, and recovers", async () => {
	let apiRequests = 0;
	const server = createServer((request, response) => {
		if (request.url === "/api/v1/sync/events") {
			apiRequests += 1;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write("event: connected\ndata: {}\n\n");
		} else {
			response.end("asset bytes");
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (address === null || typeof address === "string")
		throw new Error("no TCP port");
	const target = `http://127.0.0.1:${address.port}`;
	const proxy = await createSyncTransportProxy();
	try {
		for (const invalid of ["/origin-form", "ftp://127.0.0.1/file"]) {
			await expect(throughProxy(proxy.url, invalid)).rejects.toThrow();
		}
		const held = await throughProxy(proxy.url, `${target}/api/v1/sync/events`);
		expect(held.statusCode).toBe(200);
		const [chunk] = await once(held, "data");
		expect(chunk.toString()).toBe("event: connected\ndata: {}\n\n");
		const disconnected = once(held, "aborted");
		proxy.setOffline(true);
		await disconnected;
		await expect(
			throughProxy(proxy.url, `${target}/api/v1/sync/events`),
		).rejects.toThrow();
		expect(apiRequests).toBe(1);
		expect(
			await body(await throughProxy(proxy.url, `${target}/asset.js`)),
		).toBe("asset bytes");
		proxy.setOffline(false);
		const reconnected = await throughProxy(
			proxy.url,
			`${target}/api/v1/sync/events`,
		);
		expect(reconnected.statusCode).toBe(200);
		expect(apiRequests).toBe(2);
		reconnected.destroy();
	} finally {
		await proxy.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
