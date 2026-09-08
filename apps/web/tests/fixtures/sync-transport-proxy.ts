import { createServer, request as requestHttp } from "node:http";
import { connect, type Socket } from "node:net";

/** Transport fault for the suite's local HTTP API, leaving the page and Worker alive. */
export async function createSyncTransportProxy() {
	let offline = false;
	const sockets = new Set<Socket>();
	const apiSockets = new Set<Socket>();
	const server = createServer((request, response) => {
		const address = request.url ?? "";
		if (!URL.canParse(address)) {
			request.socket.destroy();
			return;
		}
		const target = new URL(address);
		if (target.protocol !== "http:") {
			request.socket.destroy();
			return;
		}
		const isApi = target.pathname.startsWith("/api/v1/");
		if (offline && isApi) {
			request.socket.destroy();
			return;
		}
		if (isApi) apiSockets.add(request.socket);
		const upstream = requestHttp(
			target,
			{ method: request.method, headers: request.headers, agent: false },
			(answer) => {
				response.writeHead(answer.statusCode ?? 502, answer.headers);
				answer.pipe(response);
				answer.on("error", () => response.destroy());
			},
		);
		upstream.on("error", () => response.destroy());
		response.on("close", () => {
			apiSockets.delete(request.socket);
			upstream.destroy();
		});
		request.pipe(upstream);
	});
	// Chromium tunnels WebSockets through CONNECT; keep Vite alive during API faults.
	server.on("connect", (request, socket, head) => {
		const address = `http://${request.url ?? ""}`;
		if (!URL.canParse(address)) {
			socket.destroy();
			return;
		}
		const target = new URL(address);
		if (!target.hostname || !target.port || target.pathname !== "/") {
			socket.destroy();
			return;
		}
		const upstream = connect(Number(target.port), target.hostname);
		upstream.on("error", () => socket.destroy());
		upstream.on("close", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
		socket.on("close", () => upstream.destroy());
		upstream.on("connect", () => {
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) upstream.write(head);
			socket.pipe(upstream).pipe(socket);
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("Sync transport proxy did not bind a TCP port");
	}
	return {
		url: `http://127.0.0.1:${address.port}`,
		setOffline(value: boolean) {
			offline = value;
			if (offline) {
				for (const socket of apiSockets) socket.destroy();
			}
		},
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
	};
}
