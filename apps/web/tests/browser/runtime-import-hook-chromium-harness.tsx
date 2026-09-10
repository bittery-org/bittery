import { RuntimeRequestError } from "@bittery/client-runtime/client";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { validateRuntimeRequest } from "../../../../packages/client-runtime/generated/runtime-protocol/validator.js";
import { useVaultImport } from "../../src/hooks/use-vault-import";
import type { ImportPreview } from "../../src/lib/import";

declare global {
	var __importClient: unknown;
	var __importVaults: unknown[];
	var __importParse: () => Promise<ImportPreview>;
	var __importAccount: string;
	var __importAccountListeners: Set<() => void>;
	var exerciseImport: (scenario: string) => Promise<unknown>;
}

let hook: ReturnType<typeof useVaultImport>;
function Probe() {
	hook = useVaultImport();
	return <output>{hook.preview?.sourceVaults[0]?.name ?? "none"}</output>;
}
const frame = () =>
	new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

Object.assign(globalThis, {
	__importAccount: "account-a",
	__importAccountListeners: new Set<() => void>(),
	async exerciseImport(scenario: string) {
		const calls: Array<{
			accountId: string;
			items: number;
			categories: string[];
			favorites: boolean[];
			drafts: Array<{ category: string; data: { title: string } }>;
		}> = [];
		const receipts: Array<{
			operationId: string;
			kind: string;
			resolution: string;
			importedCount: number | null;
		}> = [];
		const listeners = new Set<() => void>();
		let sequence = 0;
		let subscriptions = 0;
		const notify = () => {
			for (const listener of listeners) listener();
		};
		const store = {
			getSnapshot: () => ({ state: "ready", value: { operations: receipts } }),
			subscribe: (listener: () => void) => {
				subscriptions++;
				listeners.add(listener);
				return () => {
					subscriptions--;
					listeners.delete(listener);
				};
			},
		};
		globalThis.__importVaults = [
			{
				vaultId: "existing",
				accountId: "account-b",
				name: "Existing",
				role: "owner",
			},
		];
		globalThis.__importClient = {
			operations: () => store,
			async createVault() {
				const operationId = `vault-${++sequence}`;
				receipts.push({
					operationId,
					kind: "createVault",
					resolution: "applied",
					importedCount: null,
				});
				return { vaultId: operationId, operationId };
			},
			async importItems(input: {
				accountId: string;
				vaultId: string;
				items: Array<{
					draft: { category: string; data: { title: string } };
					favorite: boolean;
				}>;
			}) {
				calls.push({
					accountId: input.accountId,
					items: input.items.length,
					categories: input.items.map((item) => item.draft.category),
					favorites: input.items.map((item) => item.favorite),
					drafts: structuredClone(input.items.map((item) => item.draft)),
				});
				// Imported archive parser output may omit required fields. Exercise the actual
				// generated request validator, without allowing presentation to manufacture them.
				if (
					scenario.startsWith("sparse-") &&
					!validateRuntimeRequest({ type: "importItems", ...input })
				)
					throw new RuntimeRequestError(
						"INVARIANT_VIOLATION",
						"Runtime refused sparse Import data",
					);
				if (
					scenario === "size" &&
					input.items.some((item) => item.draft.data.title === "oversized")
				)
					throw new RuntimeRequestError("SIZE_REJECTED", "fixture byte bound");
				const operationId = `import-${++sequence}`;
				receipts.push({
					operationId,
					kind: "importItems",
					resolution: "pending",
					importedCount: null,
				});
				setTimeout(
					() => {
						const operation = receipts.find(
							(entry) => entry.operationId === operationId,
						);
						if (!operation) throw new Error("Missing accepted Operation");
						operation.resolution =
							scenario === "later-rejection" && calls.length > 1
								? "rejected"
								: "applied";
						operation.importedCount =
							operation.resolution === "applied" ? input.items.length : null;
						notify();
					},
					["detach", "switch"].includes(scenario) ? 80 : 5,
				);
				return {
					operationId,
					itemIds: input.items.map((_, index) => `${operationId}-${index}`),
				};
			},
		};
		const count = scenario.startsWith("sparse-")
			? 1
			: scenario === "later-rejection"
				? 201
				: 5;
		const categories = [
			"login",
			"secure-note",
			"credit-card",
			"identity",
			"totp",
		] as const;
		const preview: ImportPreview = {
			providerId: "chrome",
			sourceVaults: [
				{ id: "source", name: "Imported", itemCount: count, skippedCount: 0 },
				{ id: "empty", name: "Empty", itemCount: 0, skippedCount: 0 },
			],
			sourceItems: Array.from({ length: count }, (_, index) => ({
				providerId: "chrome",
				id: String(index),
				sourceVaultId: "source",
				title: "Item",
				category:
					scenario === "sparse-note"
						? "secure-note"
						: scenario === "sparse-totp"
							? "totp"
							: (categories[index % 5] ?? "login"),
				favorite: index === 0,
				data: {
					title:
						scenario === "size" && index === 2 ? "oversized" : `Item ${index}`,
				},
			})),
			warnings: [],
			errors: [],
			summary: {
				vaultCount: 2,
				itemCount: count,
				skippedCount: 0,
				warningCount: 0,
				errorCount: 0,
			},
		};
		globalThis.__importParse = async () => preview;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		flushSync(() => root.render(<Probe />));
		await hook.parseFile(new File(["fixture"], "fixture.csv"), "chrome");
		await frame();
		await frame();
		const filteredEmptyVaults = hook.skippedEmptyVaultCount;
		if (scenario === "existing") {
			flushSync(() => hook.setMappingTargetVaultId("source", "existing"));
		}
		const running = hook.executeImport();
		await new Promise((resolve) => setTimeout(resolve, 1));
		const beforeApplied = hook.summary;
		if (scenario === "detach") {
			root.unmount();
		} else if (scenario === "switch") {
			globalThis.__importAccount = "account-c";
			flushSync(() => {
				for (const listener of globalThis.__importAccountListeners) listener();
			});
			if (hook.preview !== null || hook.summary !== null)
				throw new Error("Previous Account plaintext remained visible");
		}
		const summary = await running;
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (scenario !== "detach") root.unmount();
		container.remove();
		return {
			summary,
			calls,
			filteredEmptyVaults,
			beforeApplied,
			subscriptions,
			applied: receipts.filter(
				(entry) =>
					entry.kind === "importItems" && entry.resolution === "applied",
			).length,
		};
	},
});
