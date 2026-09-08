import "../../../../packages/client-runtime/src/testing/jsdom-preload";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createRuntimeClient } from "@bittery/client-runtime/client";
import { createFakeRuntimeTransport } from "@bittery/client-runtime/testing";
import type { WebClientRuntime } from "@bittery/client-runtime/web";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { I18nProvider } from "@/providers/i18n-provider";
import { RecoveryEntryButton } from "./recovery-entry";
import { ReplicaRecoveryProvider } from "./replica-recovery-provider";

const domGlobals = [
	"Event",
	"CustomEvent",
	"HTMLInputElement",
	"NodeFilter",
] as const;
const originals = new Map(
	domGlobals.map((key) => [
		key,
		Object.getOwnPropertyDescriptor(globalThis, key),
	]),
);
beforeEach(() => {
	for (const key of domGlobals)
		Object.defineProperty(globalThis, key, {
			configurable: true,
			value: window[key],
		});
});
afterEach(async () => {
	cleanup();
	// Radix releases its focus scope on a timer; keep DOM globals until that cleanup settles.
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	for (const key of domGlobals) {
		const original = originals.get(key);
		if (original) Object.defineProperty(globalThis, key, original);
		else Reflect.deleteProperty(globalThis, key);
	}
});
const diagnostics = {
	maintenance: "available" as const,
	schema: "supported" as const,
	device: "knownAccounts" as const,
	failure: null,
	accounts: [
		{
			accountId: "a",
			email: "member@example.test",
			serverUrl: "https://example.test",
			userId: "user",
			state: "ready" as const,
			operationCount: 1,
			receiptCount: 0,
			missingArtifacts: 0,
			canExport: true,
			canRepair: true,
			canRebootstrap: true,
		},
	],
};
function setup(retained = false) {
	const transport = createFakeRuntimeTransport();
	const client = createRuntimeClient({ transport });
	const query = new QueryClient();
	const file = new File([new Uint8Array([1, 2, 3])], "prepared.btrrec");
	let released = 0;
	let downloads = 0;
	let discarded = 0;
	const files: WebClientRuntime["recoveryFiles"] = {
		grantSource: () => "source",
		grantSink: () => "sink",
		listRetained: async () => ({
			files: retained
				? [
						{
							capabilityId: "sink",
							byteLength: "3",
							state: "prepared" as const,
						},
					]
				: [],
			limited: false,
		}),
		discardGrant: () => {
			discarded++;
		},
		prepared: () => ({ file, state: "prepared" }),
		downloadRequested: () => {
			downloads++;
		},
		release: async () => {
			released++;
		},
	};
	const view = render(
		<I18nProvider>
			<QueryClientProvider client={query}>
				<ReplicaRecoveryProvider client={client} files={files} retry={() => {}}>
					<RecoveryEntryButton />
				</ReplicaRecoveryProvider>
			</QueryClientProvider>
		</I18nProvider>,
	);
	fireEvent.click(view.getByRole("button", { name: "Local data recovery" }));
	return {
		view,
		transport,
		client,
		query,
		released: () => released,
		downloads: () => downloads,
		discarded: () => discarded,
	};
}
async function inspect(value: ReturnType<typeof setup>) {
	fireEvent.click(
		value.view.getByRole("button", { name: "Pause and inspect" }),
	);
	await act(async () => {
		await value.transport.settled();
	});
	await act(async () => {
		value.transport.answer({
			type: "succeeded",
			value: { type: "recoveryDiagnosed", diagnostics },
		});
		await value.transport.settled();
	});
}
test("recovery entry waits for explicit all-Account pause and preserves unknown/busy diagnostics", async () => {
	const value = setup();
	expect(value.transport.pendingRequests()).toHaveLength(0);
	fireEvent.click(
		value.view.getByRole("button", { name: "Pause and inspect" }),
	);
	await act(async () => {
		await value.transport.settled();
	});
	await act(async () => {
		value.transport.answer({
			type: "succeeded",
			value: {
				type: "recoveryDiagnosed",
				diagnostics: { ...diagnostics, maintenance: "busy", accounts: [] },
			},
		});
		await value.transport.settled();
	});
	expect(
		value.view.getByText(
			"Another Bittery tab still owns local storage. Close it, then inspect again.",
		),
	).not.toBeNull();
	expect(
		value.view.queryByRole("button", { name: "Prepare protected export" }),
	).toBeNull();
	await value.client.close();
});
test("export clears password inputs and never retains them in mutation cache or claims a browser download was saved", async () => {
	const value = setup();
	await inspect(value);
	fireEvent.change(
		value.view.getByLabelText("Separate recovery export password"),
		{ target: { value: "separate protected password" } },
	);
	fireEvent.click(
		value.view.getByRole("button", { name: "Prepare protected export" }),
	);
	await act(async () => {
		await value.transport.settled();
	});
	expect(
		(
			value.view.getByLabelText(
				"Separate recovery export password",
			) as HTMLInputElement
		).value,
	).toBe("");
	expect(value.query.getMutationCache().getAll()).toEqual([]);
	await act(async () => {
		value.transport.answer({
			type: "succeeded",
			value: {
				type: "recoveryExported",
				accountId: "a",
				classification: "complete",
				byteLength: "3",
			},
		});
		await value.transport.settled();
	});
	expect(
		value.view.getByText(
			"Encrypted file prepared in this browser. It has not yet been downloaded.",
		),
	).not.toBeNull();
	expect(value.released()).toBe(0);
	await act(async () => {
		fireEvent.click(
			value.view.getByRole("button", { name: "Remove prepared browser file" }),
		);
	});
	expect(value.released()).toBe(1);
	expect(value.view.queryByTestId("recovery-prepared-file")).toBeNull();
	await value.client.close();
});
test("unknown local counts stay unknown and repair eligibility remains in Core", async () => {
	const value = setup();
	fireEvent.click(
		value.view.getByRole("button", { name: "Pause and inspect" }),
	);
	await act(async () => {
		await value.transport.settled();
	});
	await act(async () => {
		value.transport.answer({
			type: "succeeded",
			value: {
				type: "recoveryDiagnosed",
				diagnostics: {
					...diagnostics,
					accounts: [
						{
							...diagnostics.accounts[0]!,
							state: "unknown",
							operationCount: null,
							receiptCount: null,
							missingArtifacts: null,
							canRepair: false,
							canRebootstrap: false,
						},
					],
				},
			},
		});
		await value.transport.settled();
	});
	expect(
		value.view
			.getByRole("button", { name: "Repair from file" })
			.hasAttribute("disabled"),
	).toBe(true);
	expect(
		value.view
			.getByRole("button", { name: "Rebuild Server data" })
			.hasAttribute("disabled"),
	).toBe(true);
	expect(
		value.view.getByTestId("recovery-account-diagnostics").textContent,
	).toContain("Unknown");
	await value.client.close();
});

test("a late export after presentation unmount retires its grant without a cached result", async () => {
	const value = setup();
	await inspect(value);
	fireEvent.change(
		value.view.getByLabelText("Separate recovery export password"),
		{ target: { value: "private password" } },
	);
	fireEvent.click(
		value.view.getByRole("button", { name: "Prepare protected export" }),
	);
	await act(async () => {
		await value.transport.settled();
	});
	value.view.unmount();
	await act(async () => {
		value.transport.answer({
			type: "succeeded",
			value: {
				type: "recoveryExported",
				accountId: "a",
				classification: "complete",
				byteLength: "3",
			},
		});
		await value.transport.settled();
	});
	expect(value.discarded()).toBe(1);
	expect(value.released()).toBe(0);
	expect(value.query.getMutationCache().getAll()).toEqual([]);
	await value.client.close();
});
test("Core error details and password material never enter visible recovery diagnostics", async () => {
	const value = setup();
	await inspect(value);
	fireEvent.change(
		value.view.getByLabelText("Separate recovery export password"),
		{ target: { value: "private password" } },
	);
	fireEvent.click(
		value.view.getByRole("button", { name: "Prepare protected export" }),
	);
	await act(async () => {
		await value.transport.settled();
		value.transport.answer({
			type: "failed",
			value: {
				code: "STORAGE_UNAVAILABLE",
				message: "private diagnostic payload",
			},
		});
		await value.transport.settled();
	});
	expect(value.view.getByRole("alert").textContent).toBe(
		"Local storage could not be read or written. Close other Bittery tabs, then retry.",
	);
	expect(value.view.baseElement.textContent).not.toContain(
		"private diagnostic payload",
	);
	expect(value.query.getMutationCache().getAll()).toEqual([]);
	expect(value.discarded()).toBe(1);
	await value.client.close();
});

test("unsupported stored schema is distinct from unsupported browser coordination", async () => {
	const value = setup();
	fireEvent.click(
		value.view.getByRole("button", { name: "Pause and inspect" }),
	);
	await act(async () => {
		await value.transport.settled();
		value.transport.answer({
			type: "succeeded",
			value: {
				type: "recoveryDiagnosed",
				diagnostics: {
					...diagnostics,
					maintenance: "unavailable",
					schema: "unsupported",
					accounts: [],
				},
			},
		});
		await value.transport.settled();
	});
	expect(
		value.view.getByText(
			"This local database uses an unsupported layout or version. Its stored data has been preserved. Use a compatible Bittery version before retrying recovery.",
		),
	).not.toBeNull();
	expect(
		value.view.queryByText(
			"This browser cannot safely coordinate recovery. Ordinary Bittery remains available after restarting.",
		),
	).toBeNull();
	await value.client.close();
});

test("restart-discovered encrypted files stay unverified and are removed only by an explicit action", async () => {
	const value = setup(true);
	const create = URL.createObjectURL;
	const revoke = URL.revokeObjectURL;
	const click = window.HTMLAnchorElement.prototype.click;
	let revoked = 0;
	URL.createObjectURL = () => "blob:retained-recovery";
	URL.revokeObjectURL = () => {
		revoked++;
	};
	window.HTMLAnchorElement.prototype.click = () => {};
	try {
		await act(async () => {
			fireEvent.click(
				value.view.getByRole("button", {
					name: "Find retained encrypted files",
				}),
			);
		});
		expect(value.transport.calls).toEqual([]);
		expect(
			value.view.getByText(
				"Retained encrypted file — completion and previous download status are unknown",
			),
		).not.toBeNull();
		expect(value.view.queryByText("Complete recovery export")).toBeNull();
		expect(
			value.view.queryByText(
				"Encrypted file prepared in this browser. It has not yet been downloaded.",
			),
		).toBeNull();
		fireEvent.click(
			value.view.getByRole("button", { name: "Download encrypted file" }),
		);
		expect(value.downloads()).toBe(1);
		expect(value.released()).toBe(0);
		expect(revoked).toBe(0);
		expect(
			value.view.getByText(
				"Download requested. Bittery cannot confirm when your browser finishes saving the file.",
			),
		).not.toBeNull();
		await act(async () => {
			fireEvent.click(
				value.view.getByRole("button", {
					name: "Remove prepared browser file",
				}),
			);
		});
		expect(value.released()).toBe(1);
		expect(revoked).toBe(1);
		expect(value.view.queryByTestId("recovery-prepared-file")).toBeNull();
	} finally {
		URL.createObjectURL = create;
		URL.revokeObjectURL = revoke;
		window.HTMLAnchorElement.prototype.click = click;
		await value.client.close();
	}
});

test("copies only selected Account diagnostic metadata and excludes payload extensions", async () => {
	const value = setup();
	const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
	let copied = "";
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			writeText: async (text: string) => {
				copied = text;
			},
		},
	});
	try {
		fireEvent.click(
			value.view.getByRole("button", { name: "Pause and inspect" }),
		);
		await act(async () => {
			await value.transport.settled();
		});
		const metadata = {
			...diagnostics,
			password: "private-password",
			accounts: [
				{ ...diagnostics.accounts[0]!, payloadJson: "private-body" },
				{
					...diagnostics.accounts[0]!,
					accountId: "other",
					email: "other@example.test",
				},
			],
		};
		await act(async () => {
			value.transport.answer({
				type: "succeeded",
				value: { type: "recoveryDiagnosed", diagnostics: metadata },
			});
			await value.transport.settled();
		});
		await act(async () => {
			fireEvent.click(
				value.view.getByRole("button", { name: "Copy diagnostic report" }),
			);
		});
		expect(JSON.parse(copied)).toEqual({
			maintenance: diagnostics.maintenance,
			schema: diagnostics.schema,
			device: diagnostics.device,
			failure: null,
			account: diagnostics.accounts[0],
		});
		expect(copied).not.toContain("private-");
		expect(copied).not.toContain("other@example.test");
		expect(value.view.getByText("Diagnostic report copied.")).not.toBeNull();
		expect(value.transport.pendingRequests()).toHaveLength(0);
		await value.client.close();
	} finally {
		if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
		else Reflect.deleteProperty(navigator, "clipboard");
	}
});
test("actual client recovery errors display typed quota and bound messages without raw details", async () => {
	const value = setup();
	await inspect(value);
	for (const failure of [
		{
			code: "SIZE_REJECTED" as const,
			recoveryBound: "archiveBytes" as const,
			expected: "Recovery stopped at a safety limit: archive size.",
		},
		{
			code: "QUOTA_EXCEEDED" as const,
			expected:
				"Local storage is full or rejected a write. Free space, then retry.",
		},
	]) {
		fireEvent.change(
			value.view.getByLabelText("Separate recovery export password"),
			{ target: { value: "private-password" } },
		);
		fireEvent.click(
			value.view.getByRole("button", { name: "Prepare protected export" }),
		);
		await act(async () => {
			await value.transport.settled();
		});
		await act(async () => {
			value.transport.answer({
				type: "failed",
				value: {
					code: failure.code,
					...(failure.code === "SIZE_REJECTED"
						? { recoveryBound: failure.recoveryBound }
						: {}),
					message: "private-body private-password",
				},
			});
			await value.transport.settled();
		});
		expect(value.view.getByRole("alert").textContent).toBe(failure.expected);
		expect(value.view.container.textContent).not.toContain("private-");
		expect(value.query.getMutationCache().getAll()).toEqual([]);
	}
	await value.client.close();
});
