#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REQUIRED_ALIGNMENT = 16 * 1024;

export function parseLoadAlignments(readelfOutput) {
	return readelfOutput
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter(([type]) => type === "LOAD")
		.map((columns) => Number.parseInt(columns.at(-1), 16))
		.filter(Number.isFinite);
}

function newestVersionDirectory(parent) {
	if (!existsSync(parent)) return null;
	return readdirSync(parent, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort((left, right) =>
			left.localeCompare(right, undefined, { numeric: true }),
		)
		.at(-1);
}

function resolveReadelf() {
	if (process.env.LLVM_READELF) return process.env.LLVM_READELF;

	const sdk =
		process.env.ANDROID_HOME ??
		process.env.ANDROID_SDK_ROOT ??
		join(process.env.HOME ?? "", "Library", "Android", "sdk");
	const ndkRoot =
		process.env.ANDROID_NDK_HOME ??
		process.env.ANDROID_NDK_ROOT ??
		process.env.NDK_HOME ??
		join(sdk, "ndk", newestVersionDirectory(join(sdk, "ndk")) ?? "");
	const prebuiltRoot = join(ndkRoot, "toolchains", "llvm", "prebuilt");
	const host = newestVersionDirectory(prebuiltRoot);
	if (!host) throw new Error(`Could not find an Android NDK under ${ndkRoot}`);
	return join(prebuiltRoot, host, "bin", "llvm-readelf");
}

export function checkLibraryAlignment(name, readelfOutput) {
	const alignments = parseLoadAlignments(readelfOutput);
	if (alignments.length === 0) {
		throw new Error(`${name}: no ELF LOAD segments found`);
	}
	const incompatible = alignments.find(
		(alignment) => alignment < REQUIRED_ALIGNMENT,
	);
	if (incompatible !== undefined) {
		throw new Error(
			`${name}: ${incompatible / 1024} KB ELF alignment; expected at least 16 KB`,
		);
	}
}

function main() {
	const apk = process.argv[2];
	if (!apk) {
		throw new Error("Usage: check-android-page-size.mjs <path-to.apk>");
	}
	const entries = execFileSync("unzip", ["-Z1", apk], { encoding: "utf8" })
		.split("\n")
		.filter((entry) => /^lib\/[^/]+\/[^/]+\.so$/.test(entry));
	if (entries.length === 0)
		throw new Error(`${apk}: contains no native libraries`);

	const readelf = resolveReadelf();
	const temporaryDirectory = mkdtempSync(join(tmpdir(), "bittery-page-size-"));
	const failures = [];
	try {
		for (const entry of entries) {
			const library = join(temporaryDirectory, entry.replaceAll("/", "-"));
			writeFileSync(
				library,
				execFileSync("unzip", ["-p", apk, entry], {
					maxBuffer: 128 * 1024 * 1024,
				}),
			);
			const output = execFileSync(readelf, ["-lW", library], {
				encoding: "utf8",
			});
			try {
				checkLibraryAlignment(entry, output);
			} catch (error) {
				failures.push(error.message);
			}
		}
	} finally {
		rmSync(temporaryDirectory, { recursive: true });
	}

	if (failures.length > 0) throw new Error(failures.join("\n"));
	console.log(
		`16 KB ELF alignment verified for ${entries.length} native libraries.`,
	);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	try {
		main();
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
