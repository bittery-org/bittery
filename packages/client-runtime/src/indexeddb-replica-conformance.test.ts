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

describe("IndexedDB Replica conformance", () => {
	test("replays every Rust Domain history in an isolated database", async () => {
		const checked = requireCorpus(corpus);
		const forbiddenMarkers = checked.forbiddenDurableRowMarkers as string[];

		for (const repetition of ["first", "second"]) {
			for (const history of checked.histories) {
				const executor = createTestIndexedDbReplicaExecutor({
					databaseName: `replica-conformance-${repetition}-${history.name}`,
				});
				for (const step of history.steps) {
					expect(validateReplicaPersistenceRequest(step.request)).toBeTrue();
					expect(
						validateReplicaPersistenceResponse(step.expectedResponse),
					).toBeTrue();
					const response = await invoke(
						executor,
						step.request as ReplicaPersistenceRequest,
					);
					expect(canonicalize(response)).toEqual(
						canonicalize(step.expectedResponse as ReplicaPersistenceResponse),
					);

					for (const checkpoint of step.expectedLoadedState) {
						expect(
							validateReplicaPersistenceResponse(checkpoint.response),
						).toBeTrue();
						const loaded = await invoke(executor, {
							type: "load",
							accountId: checkpoint.accountId,
						});
						expect(canonicalize(loaded)).toEqual(
							canonicalize(checkpoint.response as ReplicaPersistenceResponse),
						);
						for (const marker of forbiddenMarkers) {
							expect(JSON.stringify(loaded)).not.toContain(marker);
						}
					}
				}
			}
		}
	});
});
