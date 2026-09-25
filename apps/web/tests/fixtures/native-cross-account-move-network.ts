import { readFileSync, writeFileSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	request,
	type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { nativeNetwork } from "./native-network";

/** Drops a fully consumed real durable grant reply; never supplies an authenticated outcome. */
export async function nativeCrossAccountMoveNetwork(directory: string) {
	const network = await nativeNetwork(directory);
	const upstreamOrigin = new URL(network.serverUrl);
	const control = join(directory, "cross-move-network-mode");
	const committed = join(directory, "cross-move-grant-committed.json");
	writeFileSync(control, "capture", { mode: 0o600 });
	const sockets = new Set<Socket>();
	const durableBodies: string[] = [];
	const registrations: { body: string; status: number }[] = [];
	let fixed:
		| { attachmentId: string; key: string; request: unknown }
		| undefined;
	let lostReplies = 0;
	let claimChanged = false;
	const forward = (
		incoming: IncomingMessage,
		outgoing: ServerResponse,
		body?: Buffer,
	) => {
		const path = incoming.url ?? "";
		const grantRoute =
			incoming.method === "POST" && path.endsWith("/attachment-uploads");
		const registrationRoute =
			incoming.method === "POST" && path.endsWith("/attachments");
		const decoded = body ? JSON.parse(body.toString("utf8")) : undefined;
		const durable = grantRoute && decoded?.durableUpload != null;
		const mode = readFileSync(control, "utf8");
		if (mode === "locked" || (mode === "unlock" && durable)) {
			outgoing.destroy();
			return;
		}
		if (durable) durableBodies.push(body?.toString("utf8") ?? "");
		const upstream = request(
			new URL(path, upstreamOrigin),
			{
				method: incoming.method,
				headers: incoming.headers,
				agent: false,
			},
			(response) => {
				response.on("error", () => outgoing.destroy());
				if (!durable && !registrationRoute) {
					outgoing.writeHead(response.statusCode ?? 502, response.headers);
					response.pipe(outgoing);
					return;
				}
				const chunks: Buffer[] = [];
				let bytes = 0;
				response.on("data", (chunk: Buffer) => {
					bytes += chunk.length;
					if (bytes > 131072) response.destroy();
					else chunks.push(chunk);
				});
				response.on("end", () => {
					const payload = Buffer.concat(chunks);
					if (
						registrationRoute &&
						decoded?.attachmentId === fixed?.attachmentId
					)
						registrations.push({
							body: body?.toString("utf8") ?? "",
							status: response.statusCode ?? 502,
						});
					if (durable && response.statusCode === 200) {
						let answer: { attachmentId: string; key: string };
						try {
							answer = JSON.parse(payload.toString("utf8"));
							if (
								typeof answer.attachmentId !== "string" ||
								typeof answer.key !== "string"
							)
								throw new Error("Invalid durable grant response");
						} catch {
							outgoing.destroy();
							return;
						}
						if (
							fixed &&
							(fixed.attachmentId !== answer.attachmentId ||
								fixed.key !== answer.key)
						)
							claimChanged = true;
						if (!fixed) {
							fixed = {
								attachmentId: answer.attachmentId,
								key: answer.key,
								request: decoded,
							};
							lostReplies++;
							writeFileSync(control, "locked");
							// Signed URLs and headers are invocation-scoped and never enter this record.
							writeFileSync(committed, JSON.stringify(fixed), { mode: 0o600 });
							outgoing.destroy();
							return;
						}
					}
					outgoing.writeHead(response.statusCode ?? 502, response.headers);
					outgoing.end(payload);
				});
			},
		);
		upstream.on("error", () => outgoing.destroy());
		incoming.on("aborted", () => upstream.destroy());
		outgoing.on("close", () => upstream.destroy());
		if (body) upstream.end(body);
		else incoming.pipe(upstream);
	};
	const server = createServer((incoming, outgoing) => {
		const buffered =
			incoming.method === "POST" &&
			/\/(attachment-uploads|attachments)$/.test(incoming.url ?? "");
		if (!buffered) {
			forward(incoming, outgoing);
			return;
		}
		const chunks: Buffer[] = [];
		let bytes = 0;
		incoming.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 65536) incoming.destroy();
			else chunks.push(chunk);
		});
		incoming.on("end", () => {
			try {
				forward(incoming, outgoing, Buffer.concat(chunks));
			} catch {
				outgoing.destroy();
			}
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
	if (!address || typeof address === "string")
		throw new Error("Cross Move proxy has no address");
	return {
		serverUrl: `http://127.0.0.1:${address.port}`,
		control,
		committed,
		get evidence() {
			return {
				lostReplies,
				claimChanged,
				fixed,
				durableBodies: durableBodies.slice(),
				registrations: registrations.slice(),
			};
		},
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			await network.close();
		},
	};
}
