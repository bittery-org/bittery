import { afterEach, describe, expect, test } from "bun:test";
import { formatTrpcErrorShape } from "../index";

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
	if (originalNodeEnv === undefined) {
		delete process.env.NODE_ENV;
	} else {
		process.env.NODE_ENV = originalNodeEnv;
	}
});

describe("formatTrpcErrorShape", () => {
	test("redacts stack traces outside development and test", () => {
		process.env.NODE_ENV = "production";

		const formatted = formatTrpcErrorShape({
			message: "boom",
			data: {
				stack: "stack-trace",
			},
		});

		expect(formatted.message).toBe("boom");
		expect(formatted.data.stack).toBeUndefined();
	});

	test("keeps stack traces in test mode", () => {
		process.env.NODE_ENV = "test";

		const formatted = formatTrpcErrorShape({
			message: "boom",
			data: {
				stack: "stack-trace",
			},
		});

		expect(formatted.message).toBe("boom");
		expect(formatted.data.stack).toBe("stack-trace");
	});
});
