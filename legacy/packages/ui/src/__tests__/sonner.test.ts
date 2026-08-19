import { describe, expect, test } from "bun:test";
import { toast as sonnerToast } from "sonner";
import { toast } from "../components/sonner";

// Sonner's dismiss() notifies subscribers inside requestAnimationFrame,
// which bun's test runtime doesn't provide.
if (typeof globalThis.requestAnimationFrame === "undefined") {
	globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
		cb(0);
		return 0;
	};
}

describe("toast", () => {
	test("stores the toast under the id it returns", () => {
		const id = toast.success("Saved");
		const active = sonnerToast.getToasts();
		expect(active.some((t) => t.id === id)).toBe(true);
	});

	test("dismiss(id) removes the toast (close button path)", () => {
		// The X button calls sonnerToast.dismiss(id) with the id sonner passed
		// to the custom-toast render callback — it must match the stored toast.
		const id = toast.error("Something failed");
		expect(sonnerToast.getToasts().some((t) => t.id === id)).toBe(true);
		toast.dismiss(id);
		expect(sonnerToast.getToasts().some((t) => t.id === id)).toBe(false);
	});

	test("an explicit id updates the existing toast instead of adding one", () => {
		const id = toast.loading("Working");
		toast.success("Done", { id });
		const matching = sonnerToast.getToasts().filter((t) => t.id === id);
		expect(matching.length).toBe(1);
	});
});
