/**
 * A DOM for the React entrypoint's tests. Bun has no DOM, and React 19 needs one to
 * commit, so `bunfig.toml` preloads this before any test module is imported: a global
 * assigned after `react-dom/client` loads is already too late.
 *
 * Only the globals a React client render reads are copied. `globalThis` keeps whatever
 * Bun already defines, so a test that installs `fake-indexeddb` still wins.
 */

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
	pretendToBeVisual: true,
	url: "https://runtime.test/",
});

const copied = [
	"window",
	"document",
	"navigator",
	"location",
	"history",
	"localStorage",
	"sessionStorage",
	"HTMLElement",
	"Element",
	"Node",
	"Event",
	"CustomEvent",
	"MutationObserver",
	"getComputedStyle",
	"requestAnimationFrame",
	"cancelAnimationFrame",
] as const;

const source = dom.window as unknown as Record<string, unknown>;
const target = globalThis as unknown as Record<string, unknown>;
target.window = dom.window;
for (const name of copied) {
	if (name === "window" || target[name] !== undefined) continue;
	target[name] = source[name];
}
// React reads this to pick its production warnings path; Testing Library reads it to
// decide whether `act` is required.
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
