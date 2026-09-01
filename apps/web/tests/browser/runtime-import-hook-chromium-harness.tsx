import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { runtimeImportParking } from "../../src/hooks/runtime-import-parking";
import { useVaultImport } from "../../src/hooks/use-vault-import";
import { webRuntimeClient } from "../../src/lib/web-runtime-client";

declare global {
	var __runtimeImportActiveAccount: string | null;
	var __runtimeImportAccountListeners: Set<() => void>;
	var __runtimeImportParse: (file: File) => Promise<unknown>;
	var __runtimeImportCreateVault: (input: unknown) => Promise<unknown>;
	var exerciseDelayedRuntimeImportParseSwitch: () => Promise<unknown>;
	var exerciseDelayedRuntimeVaultAcceptanceSwitch: () => Promise<unknown>;
	var exercisePartialRuntimeVaultCreationSignOut: () => Promise<unknown>;
	var exercisePartialRuntimeVaultCreationRemount: () => Promise<unknown>;
	var exerciseRuntimeImportAcceptanceRetirementRaces: () => Promise<unknown>;
}

type ImportHook = ReturnType<typeof useVaultImport>;

let latestHook: ImportHook | null = null;

function currentHook(): ImportHook {
	if (latestHook === null) throw new Error("Import hook is not mounted");
	return latestHook;
}

function Probe() {
	latestHook = useVaultImport();
	return (
		<output data-testid="preview">
			{latestHook.preview?.sourceVaults[0]?.name ?? "none"}
		</output>
	);
}

function preview(
	vaultNames: readonly string[],
): Parameters<typeof runtimeImportParking.park>[1]["preview"] {
	return {
		providerId: "chrome",
		sourceVaults: vaultNames.map((name, index) => ({
			id: `source-${index + 1}`,
			name,
			itemCount: 1,
			skippedCount: 0,
		})),
		sourceItems: [],
		warnings: [],
		errors: [],
		summary: {
			vaultCount: vaultNames.length,
			itemCount: vaultNames.length,
			skippedCount: 0,
			warningCount: 0,
			errorCount: 0,
		},
	};
}

function parkDraft(
	draft: Parameters<typeof runtimeImportParking.park>[1],
): void {
	const lease = runtimeImportParking.capture(draft.accountId);
	try {
		runtimeImportParking.park(lease, draft);
	} finally {
		runtimeImportParking.release(lease);
	}
}

function switchAccount(accountId: string): void {
	globalThis.__runtimeImportActiveAccount = accountId;
	flushSync(() => {
		for (const listener of globalThis.__runtimeImportAccountListeners)
			listener();
	});
}

Object.assign(globalThis, {
	__runtimeImportActiveAccount: null,
	__runtimeImportAccountListeners: new Set<() => void>(),
	__runtimeImportCreateVault: async () => {
		throw new Error("unexpected createVault");
	},
	async exerciseDelayedRuntimeImportParseSwitch() {
		const container = document.createElement("div");
		document.body.append(container);
		const root: Root = createRoot(container);
		switchAccount("account-a");
		flushSync(() => root.render(<Probe />));

		let resolveParse: (value: unknown) => void = () => {
			throw new Error("parse did not start");
		};
		globalThis.__runtimeImportParse = () =>
			new Promise((resolve) => {
				resolveParse = resolve;
			});
		const parsing = currentHook().parseFile(
			new File(["account-a"], "account-a.csv"),
			"chrome",
		);
		switchAccount("account-b");
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		resolveParse(preview(["Account A plaintext"]));
		await parsing;
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);

		const result = {
			visiblePreview: document.querySelector('[data-testid="preview"]')
				?.textContent,
			providerId: currentHook().providerId ?? null,
			stage: currentHook().progress.stage,
		};
		root.unmount();
		container.remove();
		return result;
	},
	async exercisePartialRuntimeVaultCreationRemount() {
		runtimeImportParking.retire("account-a");
		const container = document.createElement("div");
		document.body.append(container);
		let root: Root = createRoot(container);
		switchAccount("account-a");
		globalThis.__runtimeImportParse = async () =>
			preview(["First target", "Second target"]);
		let createCalls = 0;
		globalThis.__runtimeImportCreateVault = async () => {
			createCalls += 1;
			if (createCalls === 1) {
				return {
					operationId: "operation-1",
					vaultId: "accepted-vault-1",
					replicaRevision: 1,
				};
			}
			throw new Error("second target rejected");
		};
		flushSync(() => root.render(<Probe />));
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		await currentHook().parseFile(new File(["two"], "two.csv"), "chrome");
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		try {
			await currentHook().executeImport();
		} catch {
			// The public hook reports the parked state after an accepted partial prefix.
		}
		root.unmount();

		latestHook = null;
		root = createRoot(container);
		flushSync(() => root.render(<Probe />));
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		const result = {
			createCalls,
			stage: currentHook().progress.stage,
			error: currentHook().error?.code ?? null,
			summary: currentHook().summary ?? null,
			firstTargetVaultId:
				currentHook().mappings["source-1"]?.targetVaultId ?? null,
			secondTargetVaultId:
				currentHook().mappings["source-2"]?.targetVaultId ?? null,
		};
		runtimeImportParking.retire("account-a");
		root.unmount();
		container.remove();
		return result;
	},
	async exercisePartialRuntimeVaultCreationSignOut() {
		runtimeImportParking.retire("account-a");
		runtimeImportParking.retire("account-b");
		const container = document.createElement("div");
		document.body.append(container);
		const root: Root = createRoot(container);
		switchAccount("account-a");
		globalThis.__runtimeImportParse = async () =>
			preview(["First target", "Second target"]);
		let createCalls = 0;
		globalThis.__runtimeImportCreateVault = async () => {
			createCalls += 1;
			if (createCalls === 1) {
				return {
					operationId: "operation-1",
					vaultId: "accepted-vault-1",
					replicaRevision: 1,
				};
			}
			throw new Error("second target rejected");
		};
		flushSync(() => root.render(<Probe />));
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		await currentHook().parseFile(new File(["two"], "two.csv"), "chrome");
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		try {
			await currentHook().executeImport();
		} catch {
			// The first accepted target remains visibly parked after the second fails.
		}
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		const beforeSignOut = {
			stage: currentHook().progress.stage,
			error: currentHook().error?.code ?? null,
			summary: currentHook().summary ?? null,
			firstTargetVaultId:
				currentHook().mappings["source-1"]?.targetVaultId ?? null,
			secondTargetVaultId:
				currentHook().mappings["source-2"]?.targetVaultId ?? null,
		};

		parkDraft({
			...(runtimeImportParking.read("account-a") as NonNullable<
				ReturnType<typeof runtimeImportParking.read>
			>),
			accountId: "account-b",
		});
		globalThis.__runtimeImportLifecycleCalls = [];
		await webRuntimeClient.signOut("account-a");
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		const afterSignOut = {
			preview: currentHook().preview,
			mappings: currentHook().mappings,
			stage: currentHook().progress.stage,
			error: currentHook().error?.code ?? null,
			accountADraft: runtimeImportParking.read("account-a"),
			accountBDraft: runtimeImportParking.read("account-b")?.accountId ?? null,
		};

		runtimeImportParking.retire("account-b");
		root.unmount();
		container.remove();
		return {
			createCalls,
			calls: globalThis.__runtimeImportLifecycleCalls,
			beforeSignOut,
			afterSignOut,
		};
	},
	async exerciseDelayedRuntimeVaultAcceptanceSwitch() {
		runtimeImportParking.retire("account-a");
		runtimeImportParking.retire("account-b");
		const container = document.createElement("div");
		document.body.append(container);
		const root: Root = createRoot(container);
		switchAccount("account-a");
		globalThis.__runtimeImportParse = async () => preview(["Account A target"]);
		let resolveCreate: (value: unknown) => void = () => {
			throw new Error("create did not start");
		};
		globalThis.__runtimeImportCreateVault = () =>
			new Promise((resolve) => {
				resolveCreate = resolve;
			});
		flushSync(() => root.render(<Probe />));
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		await currentHook().parseFile(new File(["one"], "one.csv"), "chrome");
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		const executing = currentHook().executeImport();
		switchAccount("account-b");
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		resolveCreate({
			operationId: "operation-a",
			vaultId: "accepted-vault-a",
			replicaRevision: 1,
		});
		const outcome = await executing;
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		const result = {
			outcome,
			visiblePreview: document.querySelector('[data-testid="preview"]')
				?.textContent,
			accountATarget:
				runtimeImportParking.read("account-a")?.mappings["source-1"]
					?.targetVaultId ?? null,
			accountBDraft: runtimeImportParking.read("account-b")?.accountId ?? null,
		};
		runtimeImportParking.retire("account-a");
		root.unmount();
		container.remove();
		return result;
	},
	async exerciseRuntimeImportAcceptanceRetirementRaces() {
		globalThis.__runtimeImportLifecycleCalls = [];
		const results = [];
		for (const action of ["signOut", "removeAccount", "wipe"] as const) {
			runtimeImportParking.retire("account-a");
			runtimeImportParking.retire("account-b");
			const container = document.createElement("div");
			document.body.append(container);
			const root: Root = createRoot(container);
			switchAccount("account-a");
			globalThis.__runtimeImportParse = async () =>
				preview([`Account A ${action} target`]);
			let resolveCreate: (value: unknown) => void = () => {
				throw new Error("create did not start");
			};
			globalThis.__runtimeImportCreateVault = () =>
				new Promise((resolve) => {
					resolveCreate = resolve;
				});
			flushSync(() => root.render(<Probe />));
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => resolve()),
			);
			await currentHook().parseFile(
				new File([action], `${action}.csv`),
				"chrome",
			);
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => resolve()),
			);
			const executing = currentHook().executeImport();
			parkDraft({
				accountId: "account-b",
				providerId: "chrome",
				preview: preview(["Account B retained"]),
				mappings: {},
				progress: {
					stage: "awaiting-runtime-import",
					totalItems: 1,
					processedItems: 0,
					totalVaults: 1,
					processedVaults: 0,
				},
				skippedEmptyVaultCount: 0,
				parkedRuntimeTargets: {},
			});

			if (action === "wipe") await webRuntimeClient.wipe();
			else await webRuntimeClient[action]("account-a");
			resolveCreate({
				operationId: `accepted-${action}`,
				vaultId: `accepted-vault-${action}`,
				replicaRevision: 1,
			});
			const outcome = await executing;
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => resolve()),
			);
			results.push({
				action,
				outcome,
				stage: currentHook().progress.stage,
				summary: currentHook().summary,
				error: currentHook().error?.code ?? null,
				accountADraft: runtimeImportParking.read("account-a"),
				accountBDraft:
					runtimeImportParking.read("account-b")?.accountId ?? null,
				acceptedVaultId: `accepted-vault-${action}`,
			});
			root.unmount();
			container.remove();
		}
		return {
			results,
			lifecycleCalls: globalThis.__runtimeImportLifecycleCalls,
		};
	},
});
