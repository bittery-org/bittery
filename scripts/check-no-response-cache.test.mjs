import assert from "node:assert/strict";
import { test } from "node:test";
import { callsResponseCache } from "./check-no-response-cache.mjs";

test("inventory finds calls while ignoring assertions, raw strings and nested comments", () => {
	assert.equal(
		callsResponseCache('assert!(!source.contains("idempotency::execute("));'),
		false,
	);
	assert.equal(
		callsResponseCache(
			'let fixture = r##"idempotency::execute(foo)"##; /* /* nested */ idempotency::execute(foo) */',
		),
		false,
	);
	assert.equal(
		callsResponseCache(
			"let result = crate::http::idempotency /* comment */ :: execute (pool).await;",
		),
		true,
	);
	assert.equal(
		callsResponseCache(
			"// idempotency::execute(foo)\nlet result = idempotency::execute(pool).await;",
		),
		true,
	);
});
