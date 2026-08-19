import { describe, expect, it } from "bun:test";

describe("auth reveal transition", () => {
	it("delivers an unlock trigger across hot-reloaded module instances", async () => {
		type AuthRevealTransition = typeof import("./auth-reveal-transition");
		const loadInstance = (instance: string) =>
			import(
				`./auth-reveal-transition?instance=${instance}`
			) as Promise<AuthRevealTransition>;
		const subscribedModule = await loadInstance("subscribed");
		const triggeringModule = await loadInstance("triggering");
		let triggers = 0;
		const unsubscribe = subscribedModule.subscribeAuthRevealToVault(() => {
			triggers++;
		});

		triggeringModule.triggerAuthRevealToVault();

		expect(triggers).toBe(1);
		unsubscribe();
	});
});
