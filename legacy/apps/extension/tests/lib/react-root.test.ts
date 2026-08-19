import { describe, expect, test } from "bun:test";
import { getOrCreateRoot, REACT_ROOT_KEY } from "../../src/lib/react-root";

const container = () => ({}) as unknown as Element;

describe("one React root per container", () => {
	test("a second mount on the same container reuses the first root", () => {
		const target = container();
		let created = 0;
		const create = () => ({ id: ++created });

		const first = getOrCreateRoot(target, create);
		const second = getOrCreateRoot(target, create);

		expect(second).toBe(first);
		expect(created).toBe(1);
	});

	test("a second container gets a root of its own", () => {
		let created = 0;
		const create = () => ({ id: ++created });

		const first = getOrCreateRoot(container(), create);
		const second = getOrCreateRoot(container(), create);

		expect(second).not.toBe(first);
		expect(created).toBe(2);
	});

	// The whole point: a second evaluation of the entry module is a separate module
	// instance with separate scope, so module-level bookkeeping would not see the
	// first root. The container and the global symbol registry are what they share.
	test("records the root on the container, not in module scope", () => {
		const target = container();

		getOrCreateRoot(target, () => ({}));

		expect(Object.getOwnPropertySymbols(target)).toContain(REACT_ROOT_KEY);
		expect(REACT_ROOT_KEY).toBe(Symbol.for("bittery.react-root"));
	});
});
