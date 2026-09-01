import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import {
	type RuntimeImportParkingDraft,
	runtimeImportParking,
	useParkedRuntimeImportDraft,
} from "../../src/hooks/runtime-import-parking";
import { webRuntimeClient } from "../../src/lib/web-runtime-client";

declare global {
	var exerciseRuntimeImportParkingLifecycle: () => Promise<unknown>;
	var exerciseRuntimeImportProductionLifecycle: () => Promise<unknown>;
	var exerciseRuntimeImportRetiredLeaseFencing: () => Promise<unknown>;
	var __runtimeImportLifecycleCalls: string[];
}

function draft(
	accountId: string,
	vaultName: string,
): RuntimeImportParkingDraft {
	return {
		accountId,
		providerId: "chrome",
		preview: {
			providerId: "chrome",
			sourceVaults: [
				{
					id: `source-${accountId}`,
					name: vaultName,
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
		},
		mappings: {
			[`source-${accountId}`]: {
				sourceVaultId: `source-${accountId}`,
				mode: "create",
				targetVaultName: vaultName,
				targetVaultId: null,
			},
		},
		progress: {
			stage: "awaiting-runtime-import",
			totalItems: 1,
			processedItems: 0,
			totalVaults: 1,
			processedVaults: 0,
		},
		skippedEmptyVaultCount: 0,
		parkedRuntimeTargets: {},
	};
}

function parkDraft(value: RuntimeImportParkingDraft): void {
	const lease = runtimeImportParking.capture(value.accountId);
	try {
		runtimeImportParking.park(lease, value);
	} finally {
		runtimeImportParking.release(lease);
	}
}

function VisibleDraft({ accountId }: { accountId: string }) {
	const parked = useParkedRuntimeImportDraft(accountId);
	return (
		<output data-testid="parked-draft">
			{parked?.mappings[`source-${accountId}`]?.targetVaultName ?? "none"}
		</output>
	);
}

function readVisibleDraft(): string {
	return (
		document.querySelector('[data-testid="parked-draft"]')?.textContent ??
		"missing"
	);
}

async function nextPaint(): Promise<void> {
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

Object.assign(globalThis, {
	async exerciseRuntimeImportRetiredLeaseFencing() {
		runtimeImportParking.retireAll();
		const scopedLease = runtimeImportParking.capture("account-a");
		runtimeImportParking.park(
			scopedLease,
			draft("account-a", "Scoped plaintext"),
		);
		runtimeImportParking.retire("account-a");
		const scopedAttempt = runtimeImportParking.park(
			scopedLease,
			draft("account-a", "Must stay retired"),
		);
		runtimeImportParking.release(scopedLease);

		const globalA = runtimeImportParking.capture("account-a");
		const globalB = runtimeImportParking.capture("account-b");
		runtimeImportParking.park(globalA, draft("account-a", "Global A"));
		runtimeImportParking.park(globalB, draft("account-b", "Global B"));
		runtimeImportParking.retireAll();
		const globalAttempts = [
			runtimeImportParking.park(globalA, draft("account-a", "Retired A")),
			runtimeImportParking.park(globalB, draft("account-b", "Retired B")),
		];
		runtimeImportParking.release(globalA);
		runtimeImportParking.release(globalB);
		return {
			scopedAttempt,
			globalAttempts,
			afterScoped: runtimeImportParking.read("account-a"),
			afterGlobal: runtimeImportParking.read("account-b"),
		};
	},
	async exerciseRuntimeImportParkingLifecycle() {
		const container = document.createElement("div");
		document.body.append(container);
		let root: Root = createRoot(container);

		parkDraft(draft("account-a", "Account A draft"));
		flushSync(() => root.render(<VisibleDraft accountId="account-a" />));
		await nextPaint();
		const firstMount = readVisibleDraft();

		root.unmount();
		root = createRoot(container);
		flushSync(() => root.render(<VisibleDraft accountId="account-a" />));
		await nextPaint();
		const remount = readVisibleDraft();

		parkDraft(draft("account-b", "Account B draft"));
		flushSync(() => root.render(<VisibleDraft accountId="account-b" />));
		await nextPaint();
		const switchedToB = readVisibleDraft();
		const accountAAfterBPark =
			runtimeImportParking.read("account-a")?.mappings["source-account-a"]
				?.targetVaultName;

		runtimeImportParking.retire("account-b");
		await nextPaint();
		const clearedB = readVisibleDraft();
		flushSync(() => root.render(<VisibleDraft accountId="account-a" />));
		await nextPaint();
		const switchedBackToA = readVisibleDraft();

		runtimeImportParking.retire("account-a");
		root.unmount();
		container.remove();
		return {
			firstMount,
			remount,
			switchedToB,
			accountAAfterBPark,
			clearedB,
			switchedBackToA,
		};
	},
	async exerciseRuntimeImportProductionLifecycle() {
		globalThis.__runtimeImportLifecycleCalls = [];
		const client = webRuntimeClient;

		parkDraft(draft("account-a", "Account A draft"));
		parkDraft(draft("account-b", "Account B draft"));
		await client.signOut("account-a");
		const afterSignOut = {
			a: runtimeImportParking.read("account-a")?.accountId ?? null,
			b: runtimeImportParking.read("account-b")?.accountId ?? null,
		};

		parkDraft(draft("account-a", "Account A draft"));
		await client.deleteServerAccount({
			accountId: "account-b",
			requestId: "request-1",
			confirmEmail: "b@example.com",
		});
		const afterServerDeleteBeforeLocalRemoval =
			runtimeImportParking.read("account-b")?.accountId ?? null;
		await client.removeAccount("account-b");
		const afterDeleteRemoval = {
			a: runtimeImportParking.read("account-a")?.accountId ?? null,
			b: runtimeImportParking.read("account-b")?.accountId ?? null,
		};

		parkDraft(draft("account-b", "Account B draft"));
		await client.wipe();
		return {
			calls: globalThis.__runtimeImportLifecycleCalls,
			afterSignOut,
			afterServerDeleteBeforeLocalRemoval,
			afterDeleteRemoval,
			afterWipe: {
				a: runtimeImportParking.read("account-a")?.accountId ?? null,
				b: runtimeImportParking.read("account-b")?.accountId ?? null,
			},
		};
	},
});
