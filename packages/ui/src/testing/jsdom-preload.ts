import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
	pretendToBeVisual: true,
	url: "https://ui.test/",
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
	"HTMLFormElement",
	"HTMLInputElement",
	"HTMLButtonElement",
	"SVGElement",
	"DocumentFragment",
	"DOMRect",
	"Element",
	"Node",
	"NodeFilter",
	"EventTarget",
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
	if (name === "window") continue;
	if (
		target[name] !== undefined &&
		name !== "Event" &&
		name !== "CustomEvent" &&
		name !== "EventTarget"
	)
		continue;
	target[name] = source[name];
}
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
