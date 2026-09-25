import { readFileSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { createServer, request, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";

interface SyncDiagnostic {
	path: string;
	mode: string;
	status: number;
	sinceCursor?: string | null;
	atMs: number;
	bytes: number;
	events?: string[];
	cursor?: string | null;
	requiresFullRefresh?: boolean;
	parseFailed?: boolean;
}

/** Real HTTP forwarding with controllable socket loss; never fabricates a Server outcome. */
export async function nativeNetwork(directory: string) {
	const control = join(directory, "network-mode");
	const acknowledgement = join(directory, "network-acknowledgement");
	writeFileSync(control, "online", { mode: 0o600 });
	writeFileSync(acknowledgement, "online", { mode: 0o600 });
	const travelCommitted = join(directory, "network-travel-committed");
	writeFileSync(travelCommitted, "", { mode: 0o600 });
	let heldTravelReply: ServerResponse | undefined;
	const travelLossEvidence = {
		mutations: 0,
		committedRepliesHeld: 0,
		policySuccessfulReads: 0,
		passwordStarts: 0,
		loginFinishes: 0,
		explicitUnlockStarts: 0,
		explicitUnlockFinishes: 0,
	};
	const syncResponses: SyncDiagnostic[] = [];
	let mode = "online";
	let refused = 0;
	let blockedMoves = 0;
	let blockedDeletionItems = 0;
	let lostDeletions = 0;
	let travelDisableAttempts = 0;
	let travelDisableRepliesLost = 0;
	let travelDisableRequestsPrevented = 0;
	let travelDisableSuccessfulReplies = 0;
	let travelDisableDeniedReplies = 0;
	let travelPolicySuccessfulReadsAfterDenial = 0;
	let travelPasswordStarts = 0;
	let travelLoginFinishes = 0;
	let travelPolicyReadsAfterLoss = 0;
	let travelPolicyReadsPrevented = 0;
	let travelPolicySuccessfulReadsAfterLoss = 0;
	const travelSelectionEvidence = {
		saves: 0,
		enables: 0,
		requestsPrevented: 0,
		repliesLost: 0,
		successfulMutations: 0,
		policySuccessfulReadsAfterLoss: 0,
		passwordStarts: 0,
		loginFinishes: 0,
	};
	const deletionTarget = join(directory, "network-deletion-target");
	const deletionReply = join(directory, "network-deletion-reply");
	const createTarget = join(directory, "network-create-target");
	const createReply = join(directory, "network-create-reply");
	writeFileSync(deletionTarget, "", { mode: 0o600 });
	writeFileSync(deletionReply, "", { mode: 0o600 });
	writeFileSync(createTarget, "", { mode: 0o600 });
	writeFileSync(createReply, "", { mode: 0o600 });
	let target: { vaultId: string; operationId: string } | undefined;
	let create:
		| {
				vaultId: string;
				itemId: string;
				operationId: string;
		  }
		| undefined;
	let heldCreateReply: ServerResponse | undefined;
	let lostCreates = 0;
	const createRequests: {
		path: string;
		operationId: string;
		body: string;
	}[] = [];
	const createResponses: { status: number; body: string }[] = [];
	const createOutcomeLookups: { path: string; status: number; body: string }[] =
		[];
	const deletionRequests: {
		operationId: string;
		vaultId: string;
		body: string;
	}[] = [];
	const authenticationResponses: {
		phase: "start" | "finish" | "delete";
		status: number;
	}[] = [];
	const blockedMove = join(directory, "network-blocked-move");
	writeFileSync(blockedMove, "", { mode: 0o600 });
	const sockets = new Set<Socket>();
	const track = (socket: Socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	};
	const server = createServer((incoming, outgoing) => {
		const blockMove =
			mode === "prepare-only" &&
			incoming.method === "POST" &&
			/^\/api\/v1\/items\/[0-9a-f-]{36}\/moves$/.test(incoming.url ?? "");
		const path = incoming.url ?? "";
		const travelMode = mode;
		const selectionAttempt =
			travelMode === "travel-selection-before" ||
			travelMode === "travel-selection-after";
		const saveSelection =
			incoming.method === "PUT" && path === "/api/v1/travel-mode/hidden-vaults";
		const enableSelection =
			incoming.method === "POST" && path === "/api/v1/travel-mode/enable";
		const travelLoss =
			travelMode === "travel-loss-held" ||
			travelMode === "travel-loss-reconcile" ||
			travelMode === "travel-loss-unlock";
		// The later explicit cleanup is Disable. Count Save/Enable for the full fixture,
		// including after convergence, so a delayed replay cannot escape the assertion.
		if (saveSelection || enableSelection) travelLossEvidence.mutations++;
		if (travelLoss) {
			if (
				incoming.method === "POST" &&
				path === "/api/v1/auth/login-attempts"
			) {
				if (travelMode === "travel-loss-unlock")
					travelLossEvidence.explicitUnlockStarts++;
				else travelLossEvidence.passwordStarts++;
			}
			if (
				incoming.method === "POST" &&
				/^\/api\/v1\/auth\/login-attempts\/[^/]+\/finish$/.test(path)
			) {
				if (travelMode === "travel-loss-unlock")
					travelLossEvidence.explicitUnlockFinishes++;
				else travelLossEvidence.loginFinishes++;
			}
			if (
				travelMode === "travel-loss-held" &&
				incoming.method === "GET" &&
				path === "/api/v1/travel-mode"
			) {
				incoming.socket.destroy();
				return;
			}
		}
		if (selectionAttempt) {
			if (saveSelection) travelSelectionEvidence.saves++;
			if (enableSelection) travelSelectionEvidence.enables++;
			if (incoming.method === "POST" && path === "/api/v1/auth/login-attempts")
				travelSelectionEvidence.passwordStarts++;
			if (
				incoming.method === "POST" &&
				/^\/api\/v1\/auth\/login-attempts\/[^/]+\/finish$/.test(path)
			)
				travelSelectionEvidence.loginFinishes++;
		}
		if (
			travelMode === "travel-selection-before" &&
			(saveSelection || enableSelection)
		) {
			travelSelectionEvidence.requestsPrevented++;
			incoming.socket.destroy();
			return;
		}
		const travelAttempt = [
			"travel-disable-before",
			"travel-disable-after",
			"travel-disable-retry",
			"travel-disable-uncertain",
			"travel-disable-reconcile",
			"travel-disable-wrong-password",
			"travel-disable-password-retry",
		].includes(travelMode);
		const disable =
			incoming.method === "POST" && path === "/api/v1/travel-mode/disable";
		if (travelAttempt) {
			if (disable) travelDisableAttempts++;
			if (incoming.method === "POST" && path === "/api/v1/auth/login-attempts")
				travelPasswordStarts++;
			if (
				incoming.method === "GET" &&
				path === "/api/v1/travel-mode" &&
				(travelDisableRepliesLost > 0 || travelDisableRequestsPrevented > 0)
			)
				travelPolicyReadsAfterLoss++;
			if (
				incoming.method === "POST" &&
				/^\/api\/v1\/auth\/login-attempts\/[^/]+\/finish$/.test(path)
			)
				travelLoginFinishes++;
		}
		if (travelMode === "travel-disable-before" && disable) {
			travelDisableRequestsPrevented++;
			incoming.socket.destroy();
			return;
		}
		if (
			travelMode === "travel-disable-uncertain" &&
			travelDisableRepliesLost > 0 &&
			incoming.method === "GET" &&
			path === "/api/v1/travel-mode"
		) {
			travelPolicyReadsPrevented++;
			incoming.socket.destroy();
			return;
		}
		const targetDeletion =
			target !== undefined &&
			incoming.method === "POST" &&
			path === `/api/v1/vaults/${target.vaultId}/deletions`;
		const exactDeletion =
			targetDeletion &&
			incoming.headers["idempotency-key"] === target?.operationId;
		const targetCreate =
			create !== undefined &&
			incoming.method === "PUT" &&
			path === `/api/v1/vaults/${create.vaultId}/items/${create.itemId}`;
		const exactCreate =
			targetCreate &&
			incoming.headers["idempotency-key"] === create?.operationId;
		const exactCreateOutcomeLookup =
			create !== undefined &&
			incoming.method === "GET" &&
			path === `/api/v1/operations/${create.operationId}`;
		const deletionFirst = mode === "deletion-first";
		const itemMutation =
			path.startsWith("/api/v1/items") && incoming.method !== "GET";
		const blockedForDeletion =
			deletionFirst &&
			(path.startsWith("/api/v1/sync/") ||
				itemMutation ||
				(incoming.method !== "GET" &&
					!path.startsWith("/api/v1/auth/") &&
					!exactDeletion));
		if (targetDeletion && deletionRequests.length < 32) {
			const selected = target;
			const chunks: Buffer[] = [];
			let length = 0;
			incoming.on("data", (chunk: Buffer) => {
				length += chunk.length;
				if (length <= 65536) chunks.push(chunk);
			});
			incoming.on("end", () => {
				if (selected)
					deletionRequests.push({
						operationId: String(incoming.headers["idempotency-key"]),
						vaultId: selected.vaultId,
						body:
							length <= 65536
								? Buffer.concat(chunks).toString("utf8")
								: "oversized",
					});
			});
		}
		if (targetCreate && createRequests.length < 8) {
			const chunks: Buffer[] = [];
			let length = 0;
			incoming.on("data", (chunk: Buffer) => {
				length += chunk.length;
				if (length <= 65536) chunks.push(chunk);
			});
			incoming.on("end", () => {
				createRequests.push({
					path,
					operationId: String(incoming.headers["idempotency-key"]),
					body:
						length <= 65536
							? Buffer.concat(chunks).toString("utf8")
							: "oversized",
				});
			});
		}
		const bootstrapOnly =
			mode === "bootstrap-only" &&
			incoming.method !== "GET" &&
			!path.startsWith("/api/v1/auth/") &&
			!path.startsWith("/api/v1/sync/") &&
			!exactDeletion &&
			!exactCreate;
		if (
			mode === "offline" ||
			blockMove ||
			blockedForDeletion ||
			bootstrapOnly
		) {
			if (deletionFirst && itemMutation) blockedDeletionItems++;
			refused++;
			if (blockMove) {
				blockedMoves++;
				const operationId = incoming.headers["idempotency-key"];
				if (typeof operationId === "string")
					writeFileSync(blockedMove, operationId);
			}
			incoming.socket.destroy();
			return;
		}
		const upstream = request(
			{
				hostname: "127.0.0.1",
				port: 3010,
				method: incoming.method,
				path: incoming.url,
				headers: incoming.headers,
				agent: false,
			},
			(response) => {
				if (exactCreateOutcomeLookup) {
					const chunks: Buffer[] = [];
					let length = 0;
					response.on("data", (chunk: Buffer) => {
						length += chunk.length;
						if (length <= 65536) chunks.push(chunk);
					});
					response.on("end", () => {
						createOutcomeLookups.push({
							path,
							status: response.statusCode ?? 502,
							body:
								length <= 65536
									? Buffer.concat(chunks).toString("utf8")
									: "oversized",
						});
					});
				}
				if (exactCreate && response.statusCode === 200) {
					const chunks: Buffer[] = [];
					let length = 0;
					response.on("data", (chunk: Buffer) => {
						length += chunk.length;
						if (length <= 65536) chunks.push(chunk);
					});
					response.on("end", () => {
						const bytes = Buffer.concat(chunks);
						if (length > 65536) return;
						const body = bytes.toString("utf8");
						createResponses.push({ status: 200, body });
						if (mode !== "create-loss" || lostCreates !== 0) return;
						let value: {
							kind?: unknown;
							operationId?: unknown;
							result?: {
								status?: unknown;
								itemId?: unknown;
								version?: unknown;
							};
						};
						try {
							value = JSON.parse(body);
						} catch {
							outgoing.destroy();
							return;
						}
						if (
							value.kind !== "create_item" ||
							value.operationId !== create?.operationId ||
							value.result?.status !== "applied" ||
							value.result.itemId !== create?.itemId ||
							typeof value.result.version !== "number" ||
							heldCreateReply
						) {
							outgoing.destroy();
							return;
						}
						writeFileSync(createReply, bytes);
						heldCreateReply = outgoing;
						lostCreates++;
					});
					if (mode === "create-loss" && lostCreates === 0) {
						response.on("error", () => outgoing.destroy());
						response.resume();
						return;
					}
				}
				if (
					travelLoss &&
					incoming.method === "GET" &&
					path === "/api/v1/travel-mode" &&
					response.statusCode === 200
				)
					travelLossEvidence.policySuccessfulReads++;
				if (
					travelMode === "travel-loss-held" &&
					enableSelection &&
					response.statusCode === 200
				) {
					response.on("error", () => outgoing.destroy());
					response.on("end", () => {
						// Retain only the socket, after the actual Server body is consumed.
						// A second mutation is a test failure, never another held response owner.
						if (heldTravelReply || travelLossEvidence.committedRepliesHeld) {
							outgoing.destroy();
							return;
						}
						heldTravelReply = outgoing;
						travelLossEvidence.committedRepliesHeld++;
						writeFileSync(travelCommitted, "enable-committed");
					});
					response.resume();
					return;
				}
				if (
					selectionAttempt &&
					incoming.method === "GET" &&
					path === "/api/v1/travel-mode" &&
					response.statusCode === 200 &&
					(travelSelectionEvidence.requestsPrevented > 0 ||
						travelSelectionEvidence.repliesLost > 0)
				)
					travelSelectionEvidence.policySuccessfulReadsAfterLoss++;
				if (
					selectionAttempt &&
					(saveSelection || enableSelection) &&
					response.statusCode === 200
				) {
					travelSelectionEvidence.successfulMutations++;
					if (travelMode === "travel-selection-after") {
						response.on("error", () => outgoing.destroy());
						response.on("end", () => {
							travelSelectionEvidence.repliesLost++;
							outgoing.destroy();
						});
						response.resume();
						return;
					}
				}
				if (
					travelAttempt &&
					incoming.method === "GET" &&
					path === "/api/v1/travel-mode" &&
					response.statusCode === 200 &&
					(travelDisableRepliesLost > 0 || travelDisableRequestsPrevented > 0)
				)
					travelPolicySuccessfulReadsAfterLoss++;
				if (travelAttempt && disable && response.statusCode === 200)
					travelDisableSuccessfulReplies++;
				if (travelAttempt && disable && response.statusCode === 401)
					travelDisableDeniedReplies++;
				if (
					travelAttempt &&
					incoming.method === "GET" &&
					path === "/api/v1/travel-mode" &&
					response.statusCode === 200 &&
					travelDisableDeniedReplies > 0
				)
					travelPolicySuccessfulReadsAfterDenial++;
				if (
					(travelMode === "travel-disable-after" ||
						travelMode === "travel-disable-uncertain") &&
					disable &&
					response.statusCode === 200
				) {
					response.on("error", () => outgoing.destroy());
					response.on("end", () => {
						travelDisableRepliesLost++;
						outgoing.destroy();
					});
					response.resume();
					return;
				}
				const syncPath = (incoming.url ?? "").split("?")[0] ?? "";
				if (syncPath.startsWith("/api/v1/sync/") && syncResponses.length < 96) {
					const record: SyncDiagnostic = {
						path: syncPath,
						sinceCursor: new URL(
							incoming.url ?? "",
							"http://fixture.invalid",
						).searchParams.get("sinceId"),
						mode,
						status: response.statusCode ?? 502,
						atMs: Date.now(),
						bytes: 0,
					};
					syncResponses.push(record);
					let line = "";
					const chunks: Buffer[] = [];
					response.on("data", (chunk: Buffer) => {
						record.bytes += chunk.length;
						if (syncPath === "/api/v1/sync/events") {
							const lines = `${line}${chunk.toString("utf8")}`.split("\n");
							line = (lines.pop() ?? "").slice(-128);
							for (const part of lines) {
								const name = part.trim();
								if (
									[
										"event: connected",
										"event: sync",
										"event: session_revoked",
									].includes(name)
								) {
									record.events ??= [];
									if (record.events.length < 32) record.events.push(name);
								}
							}
						} else if (
							syncPath === "/api/v1/sync/changes" &&
							record.bytes <= 1024 * 1024
						)
							chunks.push(chunk);
					});
					response.on("end", () => {
						if (
							syncPath !== "/api/v1/sync/changes" ||
							record.bytes > 1024 * 1024
						)
							return;
						try {
							const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
							record.cursor =
								typeof value.cursor?.id === "string" ? value.cursor.id : null;
							record.requiresFullRefresh = value.requiresFullRefresh === true;
							record.events = Array.isArray(value.events)
								? value.events
										.slice(0, 32)
										.map(
											(event: {
												id: string;
												type: string;
												entityType: string;
											}) => `${event.type}:${event.entityType}:${event.id}`,
										)
								: [];
						} catch {
							record.parseFailed = true;
						} finally {
							chunks.length = 0;
						}
					});
				}

				if (authenticationResponses.length < 32) {
					const phase =
						incoming.method === "DELETE" && incoming.url === "/api/v1/users/me"
							? "delete"
							: incoming.method !== "POST"
								? undefined
								: incoming.url === "/api/v1/auth/login-attempts"
									? "start"
									: /^\/api\/v1\/auth\/login-attempts\/[^/]+\/finish$/.test(
												incoming.url ?? "",
											)
										? "finish"
										: undefined;
					if (phase)
						authenticationResponses.push({
							phase,
							status: response.statusCode ?? 502,
						});
				}
				if (
					deletionFirst &&
					exactDeletion &&
					lostDeletions === 0 &&
					response.statusCode === 200
				) {
					const chunks: Buffer[] = [];
					let length = 0;
					response.on("data", (chunk: Buffer) => {
						length += chunk.length;
						if (length <= 65536) chunks.push(chunk);
						else response.destroy();
					});
					response.on("error", () => outgoing.destroy());
					response.on("end", () => {
						const bytes = Buffer.concat(chunks);
						let value: {
							kind?: unknown;
							operationId?: unknown;
							result?: { status?: unknown; vaultId?: unknown };
						};
						try {
							value = JSON.parse(bytes.toString("utf8"));
						} catch {
							outgoing.destroy();
							return;
						}
						if (
							value.kind === "delete_vault" &&
							value.operationId === target?.operationId &&
							value.result?.status === "applied" &&
							value.result.vaultId === target?.vaultId
						) {
							lostDeletions++;
							// The real effect is committed. Persist only its closed public receipt,
							// then retire every connection before Core can observe the result.
							writeFileSync(deletionReply, bytes);
							mode = "offline";
							writeFileSync(control, mode);
							writeFileSync(acknowledgement, mode);
							for (const socket of sockets) socket.destroy();
						} else {
							outgoing.writeHead(response.statusCode ?? 502, response.headers);
							outgoing.end(bytes);
						}
					});
					return;
				}
				outgoing.writeHead(response.statusCode ?? 502, response.headers);
				response.on("error", () => outgoing.destroy());
				response.pipe(outgoing);
			},
		);
		upstream.on("socket", track);
		upstream.on("error", () => outgoing.destroy());
		incoming.on("aborted", () => upstream.destroy());
		outgoing.on("close", () => upstream.destroy());
		incoming.pipe(upstream);
	});
	server.on("connection", track);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Native proxy has no TCP address");
	const update = () => {
		const next = readFileSync(control, "utf8");
		if (
			next !== "online" &&
			next !== "offline" &&
			next !== "prepare-only" &&
			next !== "bootstrap-only" &&
			next !== "travel-selection-before" &&
			next !== "travel-selection-after" &&
			next !== "travel-loss-held" &&
			next !== "travel-loss-reconcile" &&
			next !== "travel-loss-unlock" &&
			next !== "travel-disable-after" &&
			next !== "travel-disable-before" &&
			next !== "travel-disable-retry" &&
			next !== "travel-disable-uncertain" &&
			next !== "travel-disable-reconcile" &&
			next !== "travel-disable-wrong-password" &&
			next !== "travel-disable-password-retry" &&
			next !== "create-loss" &&
			next !== "deletion-first"
		)
			return;
		if (next === "deletion-first") {
			try {
				const value: unknown = JSON.parse(readFileSync(deletionTarget, "utf8"));
				if (
					typeof value !== "object" ||
					value === null ||
					Object.keys(value).sort().join(",") !== "operationId,vaultId"
				)
					return;
				const selected = value as { vaultId: unknown; operationId: unknown };
				if (
					typeof selected.vaultId !== "string" ||
					typeof selected.operationId !== "string" ||
					![selected.vaultId, selected.operationId].every((id) =>
						/^[0-9a-f-]{36}$/.test(id),
					)
				)
					return;
				target = {
					vaultId: selected.vaultId,
					operationId: selected.operationId,
				};
			} catch {
				return;
			}
		}
		if (next === "create-loss") {
			try {
				const value: unknown = JSON.parse(readFileSync(createTarget, "utf8"));
				if (
					typeof value !== "object" ||
					value === null ||
					Object.keys(value).sort().join(",") !== "itemId,operationId,vaultId"
				)
					return;
				const selected = value as {
					vaultId: unknown;
					itemId: unknown;
					operationId: unknown;
				};
				if (
					![selected.vaultId, selected.itemId, selected.operationId].every(
						(id) =>
							typeof id === "string" &&
							/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
								id,
							),
					)
				)
					return;
				create = {
					vaultId: selected.vaultId as string,
					itemId: selected.itemId as string,
					operationId: selected.operationId as string,
				};
			} catch {
				return;
			}
		}
		mode = next;
		if (mode !== "travel-loss-held" && heldTravelReply) {
			heldTravelReply.destroy();
			heldTravelReply = undefined;
		}
		if (mode !== "create-loss" && heldCreateReply) {
			heldCreateReply.destroy();
			heldCreateReply = undefined;
		}
		if (mode === "offline" || mode === "deletion-first")
			for (const socket of sockets) socket.destroy();
		writeFileSync(acknowledgement, mode);
	};
	watchFile(control, { interval: 20 }, update);
	return {
		serverUrl: `http://127.0.0.1:${address.port}`,
		control,
		acknowledgement,
		blockedMove,
		deletionTarget,
		deletionReply,
		createTarget,
		createReply,
		travelCommitted,
		get travelLossEvidence() {
			return { ...travelLossEvidence };
		},
		get deletionRequests() {
			return deletionRequests.slice();
		},
		get lostDeletions() {
			return lostDeletions;
		},
		get lostCreates() {
			return lostCreates;
		},
		get createRequests() {
			return createRequests.slice();
		},
		get createResponses() {
			return createResponses.slice();
		},
		get createOutcomeLookups() {
			return createOutcomeLookups.slice();
		},
		get travelDisableEvidence() {
			return {
				attempts: travelDisableAttempts,
				repliesLost: travelDisableRepliesLost,
				requestsPrevented: travelDisableRequestsPrevented,
				successfulReplies: travelDisableSuccessfulReplies,
				deniedReplies: travelDisableDeniedReplies,
				policySuccessfulReadsAfterDenial:
					travelPolicySuccessfulReadsAfterDenial,
				passwordStarts: travelPasswordStarts,
				loginFinishes: travelLoginFinishes,
				policyReadsAfterLoss: travelPolicyReadsAfterLoss,
				policyReadsPrevented: travelPolicyReadsPrevented,
				policySuccessfulReadsAfterLoss: travelPolicySuccessfulReadsAfterLoss,
			};
		},
		get travelSelectionEvidence() {
			return { ...travelSelectionEvidence };
		},
		get blockedDeletionItems() {
			return blockedDeletionItems;
		},
		get syncDiagnostics() {
			return syncResponses;
		},
		get authenticationResponses() {
			return authenticationResponses.slice();
		},
		get refused() {
			return refused;
		},
		get blockedMoves() {
			return blockedMoves;
		},
		async close() {
			unwatchFile(control, update);
			heldCreateReply?.destroy();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}
