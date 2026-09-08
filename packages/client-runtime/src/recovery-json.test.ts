import { expect, test } from "bun:test";
import { assertRecoveryJsonBound, recoveryJson } from "./recovery-json";

test("preflight counts actual UTF-8 JSON escaping before serialization", () => {
	for (const value of [
		{ text: '\u0000"\\\n😀' },
		[null, true, 12.5, undefined],
		{ omitted: undefined, value: "é" },
	]) {
		const length = new TextEncoder().encode(JSON.stringify(value)).length;
		expect(() => assertRecoveryJsonBound(value, length)).not.toThrow();
		expect(() => assertRecoveryJsonBound(value, length - 1)).toThrow();
		expect(recoveryJson(value, length)).toBe(JSON.stringify(value));
	}
});
test("malformed metadata cannot run toJSON or accessors during preflight", () => {
	let invoked = false;
	const value = {
		get field() {
			invoked = true;
			return "secret";
		},
	};
	expect(() => recoveryJson(value)).toThrow();
	expect(invoked).toBe(false);
	const cycle: { self?: unknown } = {};
	cycle.self = cycle;
	expect(() => recoveryJson(cycle)).toThrow();
});

test("byte admission reports its exact typed bound while malformed Unicode stays corruption", () => {
	try {
		assertRecoveryJsonBound({ value: "abcdef" }, 3);
		throw new Error("expected refusal");
	} catch (error) {
		expect(error).toMatchObject({
			code: "SIZE_REJECTED",
			recoveryBound: "controlBytes",
		});
	}
});
