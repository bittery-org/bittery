import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { IDBFactory } from "fake-indexeddb";
import type {
	ReplicaPersistenceRequest,
	ReplicaPersistenceResponse,
	StoredReplicaRow,
} from "../generated/persistence/contract.ts";
import {
	validateReplicaPersistenceRequest,
	validateReplicaPersistenceResponse,
} from "../generated/persistence/validator.js";
import {
	createTestIndexedDbReplicaExecutor,
	type TestIndexedDbReplicaExecutor,
} from "./testing/index.ts";
import {
	type LoadedCheckpoint,
	legacyCanRepresent,
	readLegacyReplica,
	seedLegacyReplica,
} from "./testing/legacy-replica-database.ts";

const corpus: unknown = JSON.parse(
	readFileSync(
		new URL(
			"../generated/replica-conformance/history-corpus.json",
			import.meta.url,
		),
		"utf8",
	),
);

type CorpusStep = {
	label: string;
	request: unknown;
	expectedResponse: unknown;
	expectedLoadedState: Array<{ accountId: string; response: unknown }>;
};

type Corpus = {
	formatVersion: unknown;
	oracle: unknown;
	forbiddenDurableRowMarkers: unknown;
	histories: Array<{ name: string; steps: CorpusStep[] }>;
};

beforeEach(() => {
	Object.defineProperty(globalThis, "indexedDB", {
		configurable: true,
		value: new IDBFactory(),
	});
});

afterEach(() => {
	Reflect.deleteProperty(globalThis, "indexedDB");
});

function requireCorpus(value: unknown): Corpus {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Replica conformance corpus must be an object");
	}
	const candidate = value as Partial<Corpus>;
	expect(candidate.formatVersion).toBe(1);
	expect(candidate.oracle).toBe("rustDomainLogicalSnapshots");
	expect(candidate.histories).toBeArray();
	expect(candidate.forbiddenDurableRowMarkers).toBeArray();
	return candidate as Corpus;
}

function canonicalize(response: ReplicaPersistenceResponse) {
	if (response.type !== "loaded") return response;
	return {
		...response,
		rows: [...response.rows].sort(compareRows),
	};
}

function compareRows(left: StoredReplicaRow, right: StoredReplicaRow): number {
	return `${left.store}\0${left.key.accountId}\0${left.key.recordId}`.localeCompare(
		`${right.store}\0${right.key.accountId}\0${right.key.recordId}`,
	);
}

async function invoke(
	executor: TestIndexedDbReplicaExecutor,
	request: ReplicaPersistenceRequest,
): Promise<ReplicaPersistenceResponse> {
	const response: unknown = JSON.parse(
		await executor.invoke(JSON.stringify(request)),
	);
	expect(validateReplicaPersistenceResponse(response)).toBeTrue();
	return response as ReplicaPersistenceResponse;
}

async function assertLoadedState(
	executor: TestIndexedDbReplicaExecutor,
	checkpoints: CorpusStep["expectedLoadedState"],
	forbiddenMarkers: readonly string[],
): Promise<void> {
	for (const checkpoint of checkpoints) {
		expect(validateReplicaPersistenceResponse(checkpoint.response)).toBeTrue();
		const loaded = await invoke(executor, {
			type: "load",
			accountId: checkpoint.accountId,
		});
		expect(canonicalize(loaded)).toEqual(
			canonicalize(checkpoint.response as ReplicaPersistenceResponse),
		);
		const serialized = JSON.stringify(loaded);
		for (const marker of forbiddenMarkers) {
			expect(serialized).not.toContain(marker);
		}
	}
}

async function assertStep(
	executor: TestIndexedDbReplicaExecutor,
	step: CorpusStep,
	forbiddenMarkers: readonly string[],
): Promise<void> {
	expect(validateReplicaPersistenceRequest(step.request)).toBeTrue();
	expect(validateReplicaPersistenceResponse(step.expectedResponse)).toBeTrue();
	const response = await invoke(
		executor,
		step.request as ReplicaPersistenceRequest,
	);
	expect(canonicalize(response)).toEqual(
		canonicalize(step.expectedResponse as ReplicaPersistenceResponse),
	);
	await assertLoadedState(executor, step.expectedLoadedState, forbiddenMarkers);
}

describe("IndexedDB Replica conformance", () => {
	test("populated historical v5/v6 checkpoints survive every migration boundary and continue their histories", async () => {
		const checked = requireCorpus(corpus);
		const forbiddenMarkers = checked.forbiddenDurableRowMarkers as string[];
		for (const version of [5, 6] as const) {
			let operationCheckpoints = 0;
			let receiptCheckpoints = 0;
			for (const history of checked.histories) {
				for (let split = 0; split < history.steps.length - 1; split += 1) {
					const checkpoints = history.steps[split]
						?.expectedLoadedState as LoadedCheckpoint[];
					if (
						!checkpoints.some(({ response }) => response.head !== null) ||
						!legacyCanRepresent(version, checkpoints)
					)
						continue;
					const stores = new Set(
						checkpoints.flatMap(({ response }) =>
							response.rows.map((row) => row.store),
						),
					);
					if (stores.has("operations")) operationCheckpoints += 1;
					if (stores.has("operationReceipts")) receiptCheckpoints += 1;
					const databaseName = `migration-v${version}-${history.name}-${split}`;
					await seedLegacyReplica(
						indexedDB,
						databaseName,
						version,
						checkpoints,
					);
					const assertOld = async () => {
						for (const checkpoint of checkpoints) {
							expect(
								canonicalize(
									await readLegacyReplica(
										indexedDB,
										databaseName,
										version,
										checkpoint.accountId,
									),
								),
							).toEqual(canonicalize(checkpoint.response));
						}
					};
					await assertOld();
					// v5 adds two stores and indexes; v6 adds only the Share-capability store/index.
					for (
						let boundary = 1;
						boundary <= (version === 5 ? 4 : 2);
						boundary += 1
					) {
						const failing = createTestIndexedDbReplicaExecutor({
							databaseName,
							failAfterMigrationWrite: boundary,
						});
						await expect(
							failing.invoke(
								JSON.stringify({
									type: "load",
									accountId: checkpoints[0]?.accountId,
								}),
							),
						).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
						await assertOld();
					}
					const executor = createTestIndexedDbReplicaExecutor({ databaseName });
					await assertLoadedState(executor, checkpoints, forbiddenMarkers);
					for (const step of history.steps.slice(split + 1)) {
						await assertStep(executor, step, forbiddenMarkers);
					}
				}
			}
			expect(operationCheckpoints).toBeGreaterThan(0);
			expect(receiptCheckpoints).toBeGreaterThan(0);
		}
	}, 20_000);
	test("replays every Rust Domain history in an isolated database", async () => {
		const checked = requireCorpus(corpus);
		const forbiddenMarkers = checked.forbiddenDurableRowMarkers as string[];

		for (const repetition of ["first", "second"]) {
			for (const history of checked.histories) {
				const databaseName = `replica-conformance-${repetition}-${history.name}`;
				const executor = createTestIndexedDbReplicaExecutor({
					databaseName,
				});
				for (const step of history.steps) {
					await assertStep(executor, step, forbiddenMarkers);
				}
			}
		}
	});
});
