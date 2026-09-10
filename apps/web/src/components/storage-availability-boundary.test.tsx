import "../../../../packages/client-runtime/src/testing/jsdom-preload";
import { afterEach, expect, test } from "bun:test";
import { createRuntimeClient } from "@bittery/client-runtime/client";
import { RuntimeProvider } from "@bittery/client-runtime/react";
import { createFakeRuntimeTransport } from "@bittery/client-runtime/testing";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { I18nProvider } from "../providers/i18n-provider";
import { StorageAvailabilityBoundary } from "./storage-availability-boundary";

afterEach(cleanup);

test("storage startup failure is visible and only an explicit click retries", async () => {
	const fake = createFakeRuntimeTransport();
	const client = createRuntimeClient({
		transport: {
			...fake,
			async observe() {
				throw Object.assign(new Error("PRIVATE_DATABASE_DETAIL"), {
					code: "STORAGE_UNAVAILABLE",
				});
			},
		},
	});
	let retries = 0;
	const view = render(
		<I18nProvider>
			<RuntimeProvider client={client}>
				<StorageAvailabilityBoundary
					retry={() => {
						retries += 1;
					}}
				>
					<p>Vault contents</p>
				</StorageAvailabilityBoundary>
			</RuntimeProvider>
		</I18nProvider>,
	);
	await act(async () => {
		await fake.settled();
	});
	expect(view.getByRole("heading").textContent).toBe(
		"Local storage unavailable",
	);
	expect(view.queryByText("Vault contents")).toBeNull();
	expect(view.container.textContent).not.toContain("PRIVATE_DATABASE_DETAIL");
	expect(retries).toBe(0);
	fireEvent.click(view.getByRole("button", { name: "Retry" }));
	expect(retries).toBe(1);
	expect(fake.calls.filter((call) => call.type === "request")).toHaveLength(0);
	view.unmount();
	await client.close();
});

test("other Runtime states preserve the host's existing rendering", async () => {
	const fake = createFakeRuntimeTransport();
	const client = createRuntimeClient({ transport: fake });
	const view = render(
		<I18nProvider>
			<RuntimeProvider client={client}>
				<StorageAvailabilityBoundary>
					<p>Vault contents</p>
				</StorageAvailabilityBoundary>
			</RuntimeProvider>
		</I18nProvider>,
	);
	expect(view.getByText("Vault contents")).not.toBeNull();
	view.unmount();
	await client.close();
});
