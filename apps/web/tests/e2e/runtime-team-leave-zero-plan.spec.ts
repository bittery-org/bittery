import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page, Route } from "@playwright/test";
import {
	expect,
	generateTestUser,
	signIn,
	signUp,
	type TestUser,
	test,
} from "../fixtures/auth";
import { activateTeamPlan } from "../fixtures/billing";
import {
	captureFixtureAccount,
	deleteFixtureUser,
} from "../fixtures/runtime-account-cleanup";
import { inviteMember, openTeamPage, signUpFromInvite } from "../fixtures/team";

const privateDirectory = process.env.BITTERY_107_PRIVATE_DIR;
const fixtureDatabase = process.env.BITTERY_107_DATABASE;

type FixtureAccount = Awaited<ReturnType<typeof captureFixtureAccount>>;
type OperationEvidence = {
	order: number;
	kind: "start" | "finalize";
	teamId: string | null;
	operationId: string | null;
	idempotencyKey: string | null;
	requestPlanCount: number | null;
	requestPlanSetExactEmpty: boolean | null;
	status: number;
	responseDelivered: boolean;
	resultStatus: string | null;
	resultCode: string | null;
	bodyReadError: string | null;
	bodyKeys: string[] | null;
	planCount: number | null;
	rotationCount: number | null;
	personalTeamId: string | null;
};

async function retainedReplicaIdentity(
	page: Page,
	accountId: string,
	startOperationId: string,
	finalizeOperationId?: string,
) {
	return page.evaluate(
		async ({ accountId, startOperationId, finalizeOperationId }) => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open("bittery_replica");
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				const transaction = database.transaction(
					["heads", "rotation_attempts", "operation_receipts"],
					"readonly",
				);
				const read = <T>(request: IDBRequest<T>) =>
					new Promise<T>((resolve, reject) => {
						request.onsuccess = () => resolve(request.result);
						request.onerror = () => reject(request.error);
					});
				const [head, attempt, finalizeReceipt] = await Promise.all([
					read(
						transaction.objectStore("heads").get(accountId) as IDBRequest<
							| { accountId: string; userId: string; incarnation: string }
							| undefined
						>,
					),
					read(
						transaction
							.objectStore("rotation_attempts")
							.get([accountId, startOperationId]) as IDBRequest<
							{ recordId: string; payloadJson: string } | undefined
						>,
					),
					finalizeOperationId
						? read(
								transaction
									.objectStore("operation_receipts")
									.get([accountId, finalizeOperationId]) as IDBRequest<
									{ payloadJson: string } | undefined
								>,
							)
						: Promise.resolve(undefined),
				]);
				const phase = attempt
					? (
							JSON.parse(attempt.payloadJson) as {
								phase?: { type?: string; finalizeOperationId?: string };
							}
						).phase
					: undefined;
				const receiptResult = finalizeReceipt
					? (
							JSON.parse(finalizeReceipt.payloadJson) as {
								result?: { type?: string };
							}
						).result
					: undefined;
				return {
					accountId: head?.accountId ?? null,
					userId: head?.userId ?? null,
					incarnationId: head?.incarnation ?? null,
					startOperationId: attempt?.recordId ?? null,
					finalizeOperationId: phase?.finalizeOperationId ?? null,
					phase: phase?.type ?? null,
					finalizeReceiptType: receiptResult?.type ?? null,
				};
			} finally {
				database.close();
			}
		},
		{ accountId, startOperationId, finalizeOperationId },
	);
}

async function persistRecovery(
	name: string,
	user: TestUser,
	account: FixtureAccount | undefined,
) {
	if (!privateDirectory) return;
	await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
	const fileName = `${name}-${user.email.replace(/[^a-z0-9.-]/g, "_")}.json`;
	await writeFile(
		join(privateDirectory, fileName),
		JSON.stringify({ user, account }),
		{ mode: 0o600 },
	);
}

async function waitForOwnedBilling(email: string, teamId: string) {
	if (!privateDirectory) throw new Error("BITTERY_107_PRIVATE_DIR is required");
	await writeFile(
		join(privateDirectory, "billing-request.json"),
		JSON.stringify({ email, teamId }),
		{ mode: 0o600 },
	);
	await expect
		.poll(
			async () => {
				try {
					const marked = JSON.parse(
						await readFile(
							join(privateDirectory, "billing-ready.json"),
							"utf8",
						),
					) as { email?: string; teamId?: string };
					return marked.email === email && marked.teamId === teamId;
				} catch {
					return false;
				}
			},
			{ timeout: 180_000 },
		)
		.toBe(true);
}

async function accountAndTeam(page: Page, email: string) {
	const account = await captureFixtureAccount(page, email);
	const team = await page.evaluate(async (accountId) => {
		const cryptoModulePath = "/src/lib/crypto.ts";
		const { runtimeClient } = (await import(
			cryptoModulePath
		)) as typeof import("../../src/lib/crypto");
		const result = await runtimeClient.readTeamPage({ accountId });
		return {
			userId: result.user.id,
			teamId: result.team?.id ?? null,
			teamName: result.team?.name ?? null,
			teamRole: result.team?.userRole ?? null,
		};
	}, account.accountId);
	return { account, ...team };
}

async function personalVaultIds(page: Page, accountId: string) {
	return page.evaluate(async (accountId) => {
		const cryptoModulePath = "/src/lib/crypto.ts";
		const { runtimeClient } = (await import(
			cryptoModulePath
		)) as typeof import("../../src/lib/crypto");
		const store = runtimeClient.items(accountId);
		return new Promise<string[]>((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error("Runtime Items authority did not become ready"));
			}, 30_000);
			const check = () => {
				const snapshot = store.getSnapshot();
				if (snapshot.state !== "ready") return;
				clearTimeout(timer);
				unsubscribe();
				resolve(
					snapshot.value.vaults
						.filter((vault) => vault.vaultType === "personal")
						.map((vault) => vault.vaultId),
				);
			};
			const unsubscribe = store.subscribe(check);
			check();
		});
	}, accountId);
}

async function observeRotation(
	page: Page,
	serverOrigin: string,
	dropFirstFinalizeResponse: boolean,
) {
	let order = 0;
	let afterFinalize = false;
	let finalizeResponseDropped = false;
	const operations: OperationEvidence[] = [];
	const sync: Array<{
		order: number;
		kind: "vaultPage" | "catchUp";
		status: number;
		afterFinalize: boolean;
		accept: string | null;
		versionOptIn: boolean;
		versionIncluded: boolean | null;
		bodyReadError: string | null;
	}> = [];
	const pending: Promise<void>[] = [];
	// Playwright's CDP response body can disappear when the page navigates while
	// the dedicated Runtime worker is fetching. Forward the original browser
	// request once and inspect the real Server response before fulfilling it.
	const handle = async (route: Route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (url.origin !== serverOrigin) {
			await route.continue();
			return;
		}
		const path = url.pathname;
		const isOperation =
			request.method() === "POST" && path.includes("/leave-rotation-plans");
		const isVaultPage =
			path === "/api/v1/sync/bootstrap" &&
			url.searchParams.get("phase") === "vaults";
		const isCatchUp = path === "/api/v1/sync/changes";
		if (!isOperation && !isVaultPage && !isCatchUp) {
			await route.continue();
			return;
		}
		const requestOrder = ++order;
		const requestAfterFinalize = afterFinalize;
		const response = await route.fetch();
		let suppressResponse = false;
		try {
			if (isOperation) {
				let bodyReadError: string | null = null;
				const body = (await response.json().catch((error: unknown) => {
					bodyReadError = String(error).slice(0, 300);
					return null;
				})) as {
					operationId?: string;
					result?: {
						status?: string;
						code?: string;
						plans?: unknown[];
						rotations?: unknown[];
						personalTeamId?: string;
					};
				} | null;
				suppressResponse =
					path.endsWith("/finalize") &&
					dropFirstFinalizeResponse &&
					!finalizeResponseDropped &&
					response.status() === 200 &&
					body?.result?.status === "applied";
				const posted = (() => {
					try {
						return request.postDataJSON() as Record<string, unknown>;
					} catch {
						return null;
					}
				})();
				const planIds = posted?.planIds;
				operations.push({
					order: requestOrder,
					kind: path.endsWith("/finalize") ? "finalize" : "start",
					teamId:
						path.match(
							/^\/api\/v1\/teams\/([^/]+)\/leave-rotation-plans(?:\/finalize)?$/,
						)?.[1] ?? null,
					operationId: body?.operationId ?? null,
					idempotencyKey: request.headers()["idempotency-key"] ?? null,
					requestPlanCount: Array.isArray(planIds) ? planIds.length : null,
					requestPlanSetExactEmpty: path.endsWith("/finalize")
						? Array.isArray(planIds) &&
							planIds.length === 0 &&
							Object.keys(posted ?? {}).length === 1
						: null,
					status: response.status(),
					responseDelivered: !suppressResponse,
					resultStatus: body?.result?.status ?? null,
					resultCode: body?.result?.code ?? null,
					bodyReadError,
					bodyKeys: body ? Object.keys(body) : null,
					planCount: body?.result?.plans?.length ?? null,
					rotationCount: body?.result?.rotations?.length ?? null,
					personalTeamId: body?.result?.personalTeamId ?? null,
				});
			} else if (isVaultPage) {
				let bodyReadError: string | null = null;
				const body = (await response.json().catch((error: unknown) => {
					bodyReadError = String(error).slice(0, 300);
					return null;
				})) as {
					vaultKeyVersionIncluded?: boolean;
				} | null;
				sync.push({
					order: requestOrder,
					kind: "vaultPage",
					status: response.status(),
					afterFinalize: requestAfterFinalize,
					accept: request.headers().accept ?? null,
					versionOptIn:
						request.headers().accept ===
						"application/vnd.bittery.sync-vault-key-version+json",
					versionIncluded: body?.vaultKeyVersionIncluded ?? null,
					bodyReadError,
				});
			} else if (isCatchUp) {
				sync.push({
					order: requestOrder,
					kind: "catchUp",
					status: response.status(),
					afterFinalize: requestAfterFinalize,
					accept: request.headers().accept ?? null,
					versionOptIn: false,
					versionIncluded: null,
					bodyReadError: null,
				});
			}
		} finally {
			if (suppressResponse) {
				finalizeResponseDropped = true;
				await route.abort("failed");
			} else {
				await route.fulfill({ response });
			}
		}
	};
	const observe = (route: Route) => {
		const task = handle(route);
		pending.push(task);
		return task;
	};
	const patterns = [
		"**/api/v1/sync/bootstrap?*",
		"**/api/v1/sync/changes**",
		"**/leave-rotation-plans**",
	];
	for (const pattern of patterns) await page.route(pattern, observe);
	return {
		operations,
		sync,
		markPostFinalize() {
			afterFinalize = true;
		},
		didDropFinalizeResponse() {
			return finalizeResponseDropped;
		},
		async settle() {
			for (;;) {
				const current = [...pending];
				await Promise.all(current);
				if (current.length === pending.length) return;
			}
		},
		async close() {
			for (const pattern of patterns) await page.unroute(pattern, observe);
		},
	};
}

for (const loseFinalizeResponse of [false, true]) {
	test(
		loseFinalizeResponse
			? "real invited Member recovers a lost finalize response without minting another Operation"
			: "real invited Member leaves a Team with Server-proved empty plans and retains personal Vault",
		async ({ page, browser }) => {
			test.setTimeout(480_000);
			if (fixtureDatabase && !privateDirectory)
				throw new Error(
					"An isolated fixture database requires a private directory",
				);
			let owner = generateTestUser();
			let member = generateTestUser();
			let ownerAccount: FixtureAccount | undefined;
			let memberAccount: FixtureAccount | undefined;
			let memberPage: Page | undefined;
			let ownerDeleted = false;
			let memberDeleted = false;
			const memberContext = await browser.newContext();
			try {
				owner = await signUp(page, owner, { plan: "team" });
				await persistRecovery("owner", owner, undefined);
				const ownerIdentity = await accountAndTeam(page, owner.email);
				ownerAccount = ownerIdentity.account;
				await persistRecovery("owner", owner, ownerAccount);
				expect(ownerIdentity.teamName).toBe(owner.organizationName);
				expect(ownerIdentity.teamRole).toBe("owner");
				const oldTeamId = ownerIdentity.teamId;
				if (!oldTeamId)
					throw new Error("Owner Team identity was not published");
				if (fixtureDatabase) {
					await waitForOwnedBilling(owner.email, oldTeamId);
				} else {
					activateTeamPlan(owner.email);
				}
				await openTeamPage(page);
				const invitation = await inviteMember(page, member.email);
				memberPage = await memberContext.newPage();
				member = await signUpFromInvite(
					memberPage,
					invitation,
					member,
					async (registered) =>
						persistRecovery("member", registered, undefined),
				);
				const memberIdentity = await accountAndTeam(memberPage, member.email);
				memberAccount = memberIdentity.account;
				await persistRecovery("member", member, memberAccount);
				expect(memberIdentity.userId).not.toBe(ownerIdentity.userId);
				expect(memberIdentity.teamId).toBe(oldTeamId);
				const personalVaults = await personalVaultIds(
					memberPage,
					memberAccount.accountId,
				);
				expect(personalVaults.length).toBeGreaterThan(0);

				const network = await observeRotation(
					memberPage,
					new URL(memberAccount.serverUrl).origin,
					loseFinalizeResponse,
				);
				try {
					const prepared = await memberPage.evaluate(
						async ({ accountId, teamId }) => {
							const cryptoModulePath = "/src/lib/crypto.ts";
							const { runtimeClient } = (await import(
								cryptoModulePath
							)) as typeof import("../../src/lib/crypto");
							return runtimeClient.prepareRotation({
								accountId,
								intent: { type: "teamLeave", teamId },
							});
						},
						{ accountId: memberAccount.accountId, teamId: oldTeamId },
					);
					const syncAtPreparation = Object.freeze(
						network.sync.map((item) => Object.freeze({ ...item })),
					);
					await network.settle();
					if (prepared.type !== "rotationPrepared") {
						console.log(
							JSON.stringify({
								kind: "rotation-start-rejection",
								response: prepared,
								operations: network.operations,
							}),
						);
					}
					expect(prepared.type).toBe("rotationPrepared");
					if (prepared.type !== "rotationPrepared")
						throw new Error("Rotation preparation did not finish");
					const selection = prepared.selection;
					const retainedStart = await retainedReplicaIdentity(
						memberPage,
						memberAccount.accountId,
						selection.startOperationId,
					);
					expect(selection.accountId).toBe(memberAccount.accountId);
					expect(retainedStart).toMatchObject({
						accountId: memberAccount.accountId,
						userId: memberIdentity.userId,
						incarnationId: selection.incarnationId,
						startOperationId: selection.startOperationId,
						phase: "prepared",
					});
					expect(selection.intent).toEqual({
						type: "teamLeave",
						teamId: oldTeamId,
					});
					expect(selection.plans).toEqual([]);
					expect(
						network.operations.find((item) => item.kind === "start"),
					).toMatchObject({
						teamId: oldTeamId,
						operationId: selection.startOperationId,
						idempotencyKey: selection.startOperationId,
						status: 200,
						resultStatus: "applied",
						planCount: 0,
					});
					const preflightPages = syncAtPreparation.filter(
						(item) => item.kind === "vaultPage" && !item.afterFinalize,
					);
					console.log(
						JSON.stringify({
							kind: "rotation-preflight-sync",
							sync: syncAtPreparation,
						}),
					);
					expect(
						preflightPages.some(
							(item) =>
								item.status === 200 &&
								item.versionOptIn &&
								item.versionIncluded,
						),
					).toBe(true);
					const preflightCatchUps = syncAtPreparation.filter(
						(item) => item.kind === "catchUp" && item.status === 200,
					).length;
					expect(preflightCatchUps).toBeGreaterThan(0);

					const completed = await memberPage.evaluate(
						async ({ accountId, selection }) => {
							const cryptoModulePath = "/src/lib/crypto.ts";
							const { runtimeClient } = (await import(
								cryptoModulePath
							)) as typeof import("../../src/lib/crypto");
							return runtimeClient.completeRotation({ accountId, selection });
						},
						{ accountId: memberAccount.accountId, selection },
					);
					await network.settle();
					network.markPostFinalize();
					expect([
						"rotationRefreshRequired",
						"rotationFinalizePending",
						"rotationCompleted",
					]).toContain(completed.type);
					const firstFinalize = network.operations.find(
						(item) => item.kind === "finalize",
					);
					const retainedBeforeRenewal = firstFinalize?.operationId
						? await retainedReplicaIdentity(
								memberPage,
								memberAccount.accountId,
								selection.startOperationId,
								firstFinalize.operationId,
							)
						: null;
					console.log(
						JSON.stringify({
							kind: "rotation-before-renewal",
							lostFinalizeResponse: loseFinalizeResponse,
							completed,
							retained: retainedBeforeRenewal,
						}),
					);
					const renewed = await memberPage.evaluate(
						async ({ accountId, masterPassword }) => {
							const cryptoModulePath = "/src/lib/crypto.ts";
							const { runtimeClient } = (await import(
								cryptoModulePath
							)) as typeof import("../../src/lib/crypto");
							await runtimeClient.lock(accountId);
							return runtimeClient.quickUnlock({ accountId, masterPassword });
						},
						{
							accountId: memberAccount.accountId,
							masterPassword: member.password,
						},
					);
					expect(renewed.accountId).toBe(memberAccount.accountId);
					expect(renewed.userId).toBe(memberIdentity.userId);
					const finalized = firstFinalize;
					console.log(
						JSON.stringify({
							kind: "rotation-finalize-observation",
							completed,
							finalized: finalized ?? null,
						}),
					);
					if (!finalized) throw new Error("Real finalize response missing");
					expect(finalized).toMatchObject({
						teamId: oldTeamId,
						status: 200,
						resultStatus: "applied",
						requestPlanCount: 0,
						requestPlanSetExactEmpty: true,
						rotationCount: 0,
						responseDelivered: !loseFinalizeResponse,
					});
					expect(network.didDropFinalizeResponse()).toBe(loseFinalizeResponse);
					if (loseFinalizeResponse) {
						expect(completed.type).toBe("rotationFinalizePending");
						expect(retainedBeforeRenewal).toMatchObject({
							accountId: memberAccount.accountId,
							userId: memberIdentity.userId,
							incarnationId: selection.incarnationId,
							startOperationId: selection.startOperationId,
							finalizeOperationId: finalized.operationId,
							phase: "finalizing",
							finalizeReceiptType: null,
						});
					}
					expect(finalized.operationId).toBeTruthy();
					if (!finalized.operationId)
						throw new Error("Finalize Operation identity was not returned");
					expect(finalized.idempotencyKey).toBe(finalized.operationId);
					if (
						completed.type === "rotationFinalizePending" ||
						completed.type === "rotationRefreshRequired"
					) {
						expect(completed.finalizeOperationId).toBe(finalized.operationId);
					}

					const inspected = await memberPage.evaluate(
						async ({ accountId, startOperationId }) => {
							const cryptoModulePath = "/src/lib/crypto.ts";
							const { runtimeClient } = (await import(
								cryptoModulePath
							)) as typeof import("../../src/lib/crypto");
							return runtimeClient.inspectRotation({
								accountId,
								startOperationId,
							});
						},
						{
							accountId: memberAccount.accountId,
							startOperationId: selection.startOperationId,
						},
					);
					const syncAtCompletion = Object.freeze(
						network.sync.map((item) => Object.freeze({ ...item })),
					);
					await network.settle();
					expect(inspected.type).toBe("rotationCompleted");
					if (inspected.type !== "rotationCompleted")
						throw new Error("Rotation did not converge");
					const startRequests = network.operations.filter(
						(item) => item.kind === "start",
					);
					expect(startRequests.length).toBeGreaterThan(0);
					expect(
						startRequests.every(
							(item) =>
								item.teamId === oldTeamId &&
								item.idempotencyKey === selection.startOperationId &&
								(item.operationId === null ||
									item.operationId === selection.startOperationId),
						),
					).toBe(true);
					const finalizeRequests = network.operations.filter(
						(item) => item.kind === "finalize",
					);
					expect(finalizeRequests.length).toBeGreaterThan(0);
					expect(
						finalizeRequests.every(
							(item) =>
								item.teamId === oldTeamId &&
								item.requestPlanSetExactEmpty === true &&
								item.idempotencyKey === finalized.operationId &&
								(item.operationId === null ||
									item.operationId === finalized.operationId),
						),
					).toBe(true);
					console.log(
						JSON.stringify({
							kind: "rotation-finalize-requests",
							operations: finalizeRequests,
						}),
					);
					const retainedFinal = await retainedReplicaIdentity(
						memberPage,
						memberAccount.accountId,
						selection.startOperationId,
						finalized.operationId,
					);
					expect(retainedFinal).toMatchObject({
						accountId: memberAccount.accountId,
						userId: memberIdentity.userId,
						incarnationId: selection.incarnationId,
						startOperationId: selection.startOperationId,
						finalizeOperationId: finalized.operationId,
						phase: "completed",
						finalizeReceiptType: "rotationFinalizeApplied",
					});
					const postTerminalPages = syncAtCompletion.filter(
						(item) =>
							item.kind === "vaultPage" &&
							item.afterFinalize &&
							item.order > finalized.order &&
							item.status === 200 &&
							item.versionOptIn &&
							item.versionIncluded,
					);
					expect(postTerminalPages.length).toBeGreaterThan(0);
					const finalVaultPageOrder = Math.max(
						...postTerminalPages.map((item) => item.order),
					);
					const postTerminalCatchUps = syncAtCompletion.filter(
						(item) =>
							item.kind === "catchUp" &&
							item.afterFinalize &&
							item.order > finalVaultPageOrder &&
							item.status === 200,
					);
					expect(postTerminalCatchUps.length).toBeGreaterThan(0);
					console.log(
						JSON.stringify({
							kind: "rotation-post-terminal-sync",
							syncAtCompletion,
							liveSync: network.sync,
						}),
					);
					expect(inspected.personalTeamId).toBe(finalized.personalTeamId);
					const after = await accountAndTeam(memberPage, member.email);
					expect(after.account.accountId).toBe(memberAccount.accountId);
					expect(after.userId).toBe(memberIdentity.userId);
					expect(after.teamId).toBe(inspected.personalTeamId);
					expect(after.teamId).not.toBe(oldTeamId);
					const survivingVaults = await personalVaultIds(
						memberPage,
						memberAccount.accountId,
					);
					expect(survivingVaults).toEqual(personalVaults);
					const ownerAfter = await accountAndTeam(page, owner.email);
					expect(ownerAfter.teamId).toBe(oldTeamId);
					console.log(
						JSON.stringify({
							kind: "real-zero-plan-team-leave",
							accountId: memberAccount.accountId,
							userId: memberIdentity.userId,
							oldTeamId,
							personalTeamId: inspected.personalTeamId,
							startOperationId: selection.startOperationId,
							finalizeOperationId: finalized.operationId,
							personalVaultIds: survivingVaults,
							preflightVersionPages: preflightPages.length,
							preflightCatchUps,
							postTerminalVersionPages: postTerminalPages.length,
							postTerminalCatchUps: postTerminalCatchUps.length,
							retainedIncarnationId: retainedFinal.incarnationId,
							initialCompletion: completed.type,
							lostFinalizeResponse: loseFinalizeResponse,
							finalizeRequestCount: finalizeRequests.length,
						}),
					);
				} finally {
					await network.close();
				}
			} finally {
				if (memberPage && memberAccount) {
					memberDeleted = await deleteFixtureUser(
						memberPage,
						memberAccount,
					).catch(() => false);
				}
				if (!memberDeleted && member.secretKey) {
					const recoveryContext = await browser.newContext();
					try {
						const recoveryPage = await recoveryContext.newPage();
						await signIn(recoveryPage, member);
						const recoveredAccount = await captureFixtureAccount(
							recoveryPage,
							member.email,
						);
						memberDeleted = await deleteFixtureUser(
							recoveryPage,
							recoveredAccount,
						);
					} catch {
						memberDeleted = false;
					} finally {
						await recoveryContext.close();
					}
				}
				if (ownerAccount) {
					ownerDeleted = await deleteFixtureUser(page, ownerAccount).catch(
						() => false,
					);
				}
				await memberContext.close();
				console.log(
					JSON.stringify({
						kind: "zero-plan-cleanup",
						ownerDeleted,
						memberDeleted,
					}),
				);
			}
			expect(memberDeleted).toBe(true);
			expect(ownerDeleted).toBe(true);
		},
	);
}
