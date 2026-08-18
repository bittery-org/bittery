/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { QR_SCANNER_OVERLAY_CLASS, QR_SCANNING_CLASS } from "./qr-scanner-mode";

const styles = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "../../styles.css"),
	"utf8",
);

describe("scanner overlay class names", () => {
	test("the CSS hole-punch selectors use the same class names as the overlay", () => {
		expect(styles).toContain(`html.${QR_SCANNING_CLASS}`);
		expect(styles).toContain(`.${QR_SCANNER_OVERLAY_CLASS}`);
	});
});
