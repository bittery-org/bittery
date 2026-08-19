import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
	getAttachmentRenameInitialValue,
	shouldRenameAttachment,
} from "../components/vault/item-detail/item-attachments";

const packageRoot = path.resolve(import.meta.dir, "../..");

describe("presentation package dependency seam", () => {
	test("does not import product runtime packages", async () => {
		const forbiddenImport =
			/from\s+["']@bittery\/(?:core|storage|sync)(?:\/[^"']*)?["']/;
		const violations: string[] = [];

		for await (const relativePath of new Bun.Glob("src/**/*.{ts,tsx}").scan({
			cwd: packageRoot,
		})) {
			const source = await readFile(
				path.join(packageRoot, relativePath),
				"utf8",
			);
			if (forbiddenImport.test(source)) violations.push(relativePath);
		}

		expect(violations).toEqual([]);
	});

	test("does not declare a product runtime dependency", async () => {
		const manifest = JSON.parse(
			await readFile(path.join(packageRoot, "package.json"), "utf8"),
		) as { dependencies?: Record<string, string> };

		expect(manifest.dependencies?.["@bittery/core"]).toBeUndefined();
		expect(manifest.dependencies?.["@bittery/storage"]).toBeUndefined();
		expect(manifest.dependencies?.["@bittery/sync"]).toBeUndefined();
	});
});

describe("attachment presentation state", () => {
	test("starts rename with the asynchronously loaded decrypted name", () => {
		expect(getAttachmentRenameInitialValue("decrypted.txt")).toBe(
			"decrypted.txt",
		);
	});

	test("does not rename when the loaded decrypted name is unchanged", () => {
		expect(shouldRenameAttachment("decrypted.txt", "decrypted.txt")).toBe(
			false,
		);
	});
});
