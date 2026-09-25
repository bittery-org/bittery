import type {
	ItemProjection,
	OperationsProjection,
} from "@bittery/client-runtime/protocol";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { useVaultImport } from "../../../apps/web/src/hooks/use-vault-import";
import type { ImportPreview } from "../../../apps/web/src/lib/import";
import { webRuntimeClient } from "../../../apps/web/src/lib/web-runtime-client";
import { createRuntimeClient, type RuntimeStore } from "../src/client";
import { RuntimeProvider } from "../src/react";
import { createWebClientRuntime } from "../src/web/composition";

export type JoinedImportScenario =
	| "new"
	| "existing"
	| "later-rejection"
	| "multi-account";
type ImportHook = ReturnType<typeof useVaultImport>;
interface ImportHookView {
	stage: ImportHook["progress"]["stage"];
	error: string | null;
	summary: ImportHook["summary"];
	targetVaultId: string | null;
}
export interface JoinedImportResult {
	scenario: JoinedImportScenario;
	existingVaultId: string | null;
	targetAccountId: string;
	activeAccountId: string | null;
	activeAccountUnchanged: boolean;
	sourceBefore: { items: ItemProjection[]; operations: OperationsProjection };
	sourceAfter: { items: ItemProjection[]; operations: OperationsProjection };
	operations: { state: "ready"; value: OperationsProjection };
	items: ItemProjection[];
	beforeRemount: ImportHookView;
	afterRemount: ImportHookView;
	legacyCalls: number;
}

declare global {
	var __joinedRuntimeClient: ReturnType<typeof createRuntimeClient>;
	var __runtimeImportActiveAccount: string | null;
	var __runtimeImportAccountListeners: Set<() => void>;
	var __runtimeImportParse: (file: File) => Promise<ImportPreview>;
	var __runtimeImportLegacyCalls: number;
	var exerciseJoinedRuntimeImportDefault: (
		scenario?: JoinedImportScenario,
	) => Promise<JoinedImportResult>;
}

const workerUrl = new URL("/create-vault-worker.js", location.href);
if (new URL(location.href).searchParams.get("secondAccount") === "1")
	workerUrl.searchParams.set("secondAccount", "1");
const composition = createWebClientRuntime({
	createWorker: () => new Worker(workerUrl, { type: "module" }),
});
globalThis.__joinedRuntimeClient = createRuntimeClient({
	transport: composition.runtime,
});
globalThis.__runtimeImportActiveAccount = "account-1";
globalThis.__runtimeImportAccountListeners = new Set();
globalThis.__runtimeImportLegacyCalls = 0;

function preview(count: number): ImportPreview {
	const categories = [
		"login",
		"secure-note",
		"credit-card",
		"identity",
		"totp",
	] as const;
	return {
		providerId: "chrome",
		sourceVaults: [
			{
				id: "source-default",
				name: "Imported default",
				itemCount: count,
				skippedCount: 0,
			},
		],
		sourceItems: Array.from({ length: count }, (_, index) => {
			const category = categories[index % categories.length] ?? "login";
			const title = `Imported ${index}`;
			return {
				providerId: "chrome",
				id: `source-${index}`,
				sourceVaultId: "source-default",
				title,
				category,
				favorite: index === 0,
				data: {
					title,
					...(category === "secure-note" ? { note: "secret note" } : {}),
					...(category === "totp" ? { totpSecret: "JBSWY3DPEHPK3PXP" } : {}),
				},
			};
		}),
		warnings: [],
		errors: [],
		summary: {
			vaultCount: 1,
			itemCount: count,
			skippedCount: 0,
			warningCount: 0,
			errorCount: 0,
		},
	};
}
globalThis.__runtimeImportParse = async () => preview(5);
let latestHook: ImportHook | null = null;
function currentHook(): ImportHook {
	if (latestHook === null) throw new Error("Import hook is not mounted");
	return latestHook;
}
function hookView(): ImportHookView {
	const hook = currentHook();
	return {
		stage: hook.progress.stage,
		error: hook.error?.code ?? null,
		summary: hook.summary,
		targetVaultId: hook.mappings["source-default"]?.targetVaultId ?? null,
	};
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
async function waitUntil(
	predicate: () => boolean,
	message: string,
): Promise<void> {
	for (let attempt = 0; attempt < 600; attempt++) {
		if (predicate()) return;
		await paint();
	}
	throw new Error(message);
}
async function readProjection<T>(
	store: RuntimeStore<T>,
	predicate: (value: T) => boolean = () => true,
): Promise<T> {
	const release = store.subscribe(() => {});
	try {
		let value: T | undefined;
		await waitUntil(() => {
			const snapshot = store.getSnapshot();
			if (snapshot.state === "failed")
				throw new Error(`Runtime projection failed: ${snapshot.code}`);
			if (snapshot.state !== "ready" || !predicate(snapshot.value))
				return false;
			value = snapshot.value;
			return true;
		}, "Runtime projection did not reach the expected authority").catch(
			async (error: unknown) => {
				const observation = await fetch("/create-vault-observation").then(
					(response) => response.json(),
				);
				throw new Error(
					`${String(error)}: ${JSON.stringify({ projection: store.getSnapshot(), hook: hookView(), routes: observation.routes })}`,
				);
			},
		);
		if (value === undefined) throw new Error("Runtime projection was empty");
		return value;
	} finally {
		release();
	}
}
async function sourceSnapshot() {
	return {
		items: (await readProjection(webRuntimeClient.items("account-1"))).items,
		operations: await readProjection(webRuntimeClient.operations("account-1")),
	};
}

Object.assign(globalThis, {
	async exerciseJoinedRuntimeImportDefault(
		scenario: JoinedImportScenario = "new",
	): Promise<JoinedImportResult> {
		const count = scenario === "later-rejection" ? 201 : 5;
		globalThis.__runtimeImportParse = async () => preview(count);
		const targetAccountId =
			scenario === "multi-account" ? "account-2" : "account-1";
		const container = document.createElement("div");
		document.body.append(container);
		let root: Root | null = mount(container);
		try {
			// With multiple installed Accounts, the Runtime intentionally makes no implicit selection.
			webRuntimeClient.selectAccount("account-1");
			await waitUntil(() => {
				const session = webRuntimeClient.session().getSnapshot();
				return (
					session.state === "unlocked" &&
					session.accounts.some(
						(account) =>
							account.accountId === targetAccountId &&
							account.access === "unlocked",
					)
				);
			}, "Seeded Runtime Accounts did not unlock");
			const sourceBefore = await sourceSnapshot();
			let existingVaultId: string | null = null;
			if (scenario === "existing" || scenario === "multi-account") {
				const accepted = await webRuntimeClient.createVault({
					accountId: targetAccountId,
					name: "Existing target",
					vaultType: "personal",
					icon: "lock",
				});
				existingVaultId = accepted.vaultId;
				await readProjection(webRuntimeClient.writableVaults(), (catalog) =>
					catalog.vaults.some(
						(vault) =>
							vault.vaultId === existingVaultId &&
							vault.accountId === targetAccountId,
					),
				);
			}
			await paint();
			await paint();
			await currentHook().parseFile(
				new File(["default"], "default.csv"),
				"chrome",
			);
			await paint();
			await paint();
			if (existingVaultId !== null) {
				flushSync(() =>
					currentHook().setMappingMode("source-default", "existing"),
				);
				flushSync(() =>
					currentHook().setMappingTargetVaultId(
						"source-default",
						existingVaultId,
					),
				);
			}
			await currentHook().executeImport();
			await paint();
			const beforeRemount = hookView();
			root.unmount();
			root = null;
			latestHook = null;
			root = mount(container);
			await paint();
			const afterRemount = hookView();
			const expectedCount = scenario === "later-rejection" ? 200 : 5;
			if (beforeRemount.summary?.importedCount !== expectedCount)
				throw new Error(
					`Import presentation did not complete the expected batch: ${JSON.stringify(beforeRemount)}`,
				);
			const itemProjection = await readProjection(
				webRuntimeClient.items(targetAccountId),
				(value) =>
					value.items.filter(
						(item) => item.vaultId === beforeRemount.targetVaultId,
					).length === expectedCount,
			);
			const items = itemProjection.items.filter(
				(item) => item.vaultId === beforeRemount.targetVaultId,
			);
			const operations = await readProjection(
				webRuntimeClient.operations(targetAccountId),
			);
			const sourceAfter = await sourceSnapshot();
			const activeAccountId = webRuntimeClient
				.session()
				.getSnapshot().accountId;
			return {
				scenario,
				existingVaultId,
				targetAccountId,
				activeAccountId,
				activeAccountUnchanged:
					activeAccountId === "account-1" &&
					JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter),
				sourceBefore,
				sourceAfter,
				operations: { state: "ready", value: operations },
				items,
				beforeRemount,
				afterRemount,
				legacyCalls: globalThis.__runtimeImportLegacyCalls,
			};
		} finally {
			root?.unmount();
			latestHook = null;
			container.remove();
			await composition.runtime.request("wipe-import", '{"type":"wipe"}');
			await composition.close();
		}
	},
});
