import { expect, test } from "bun:test";
import {
	LOADING_SESSION,
	type RuntimeSessionSnapshot,
} from "@bittery/client-runtime/client";
import { invitationAuthView, invitationSessionMode } from "./invite.$token";

function session(
	partial: Partial<RuntimeSessionSnapshot>,
): RuntimeSessionSnapshot {
	return { ...LOADING_SESSION, ...partial } as RuntimeSessionSnapshot;
}

test("an invitation link follows the Runtime Account access state", () => {
	expect(
		invitationSessionMode(
			session({ state: "unlocked", accountId: "account-1" }),
		),
	).toBe("signedIn");
	expect(
		invitationSessionMode(session({ state: "locked", accountId: "account-1" })),
	).toBe("locked");
	expect(invitationSessionMode(session({ state: "signedOut" }))).toBe(
		"signedOut",
	);
	expect(invitationSessionMode(LOADING_SESSION)).toBe("loading");
	expect(invitationSessionMode(session({ state: "unavailable" }))).toBe(
		"signIn",
	);
	expect(invitationSessionMode(session({ state: "missing" }))).toBe("signIn");
});

test("locked Accounts start at sign-in while signed-out visitors can sign up", () => {
	expect(invitationAuthView("locked", null)).toBe("signin");
	expect(invitationAuthView("signedOut", null)).toBe("signup");
	expect(invitationAuthView("locked", "signup")).toBe("signup");
});
