import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { runtimeImportParking } from "../../../apps/web/src/hooks/runtime-import-parking";
import { useVaultImport } from "../../../apps/web/src/hooks/use-vault-import";
import { webRuntimeClient } from "../../../apps/web/src/lib/web-runtime-client";
import { createRuntimeClient } from "../src/client";
import { RuntimeProvider } from "../src/react";
import { createWebClientRuntime } from "../src/web/composition";

declare global {
	var __joinedRuntimeClient: ReturnType<typeof createRuntimeClient>;
	var __runtimeImportActiveAccount: string | null;
	var __runtimeImportAccountListeners: Set<() => void>;
	var __runtimeImportParse: (file: File) => Promise<unknown>;
	var __runtimeImportLegacyCalls: number;
	var exerciseJoinedRuntimeImportDefault: () => Promise<unknown>;
}

const composition = createWebClientRuntime({
	createWorker: () => new Worker("/create-vault-worker.js", { type: "module" }),
});
globalThis.__joinedRuntimeClient = createRuntimeClient({
	transport: composition.runtime,
});
globalThis.__runtimeImportActiveAccount = "account-1";
globalThis.__runtimeImportAccountListeners = new Set();
globalThis.__runtimeImportLegacyCalls = 0;
globalThis.__runtimeImportParse = async () => ({
	providerId: "chrome",
	sourceVaults: [
		{
			id: "source-default",
			name: "Imported default",
			itemCount: 1,
			skippedCount: 0,
		},
	],
	sourceItems: [],
	warnings: [],
	errors: [],
	summary: {
		vaultCount: 1,
		itemCount: 1,
		skippedCount: 0,
		warningCount: 0,
		errorCount: 0,
	},
});

type ImportHook = ReturnType<typeof useVaultImport>;
let latestHook: ImportHook | null = null;

function currentHook(): ImportHook {
	if (latestHook === null) throw new Error("Import hook is not mounted");
	return latestHook;
}

function Probe() {
	latestHook = useVaultImport();
	return <output data-testid="stage">{latestHook.progress.stage}</output>;
}

function mount(container: HTMLElement): Root {
	const root = createRoot(container);
	flushSync(() =>
		root.render(
			<RuntimeProvider client={webRuntimeClient}>
				<Probe />
			</RuntimeProvider>,
		),
	);
	return root;
}

async function paint(): Promise<void> {
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

Object.assign(globalThis, {
	async exerciseJoinedRuntimeImportDefault() {
		runtimeImportParking.retire("account-1");
		const container = document.createElement("div");
		document.body.append(container);
		let root = mount(container);
		await paint();
		await currentHook().parseFile(
			new File(["default"], "default.csv"),
			"chrome",
		);
		await paint();
		try {
			await currentHook().executeImport();
		} catch {
			// Ticket 54 truthfully parks after Runtime Vault acceptance.
		}
		await paint();
		const beforeRemount = {
			stage: currentHook().progress.stage,
			error: currentHook().error?.code ?? null,
			summary: currentHook().summary,
			targetVaultId:
				currentHook().mappings["source-default"]?.targetVaultId ?? null,
		};

		root.unmount();
		latestHook = null;
		root = mount(container);
		await paint();
		const afterRemount = {
			stage: currentHook().progress.stage,
			error: currentHook().error?.code ?? null,
			summary: currentHook().summary,
			targetVaultId:
				currentHook().mappings["source-default"]?.targetVaultId ?? null,
		};
		const result = {
			beforeRemount,
			afterRemount,
			legacyCalls: globalThis.__runtimeImportLegacyCalls,
		};
		runtimeImportParking.retire("account-1");
		root.unmount();
		container.remove();
		await composition.runtime.request("wipe-import", '{"type":"wipe"}');
		await composition.close();
		return result;
	},
});
