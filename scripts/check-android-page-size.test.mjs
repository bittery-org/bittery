import assert from "node:assert/strict";
import test from "node:test";
import {
	checkLibraryAlignment,
	parseLoadAlignments,
} from "./check-android-page-size.mjs";

const readelfOutput = (alignment) => `
Elf file type is DYN (Shared object file)
Program Headers:
  Type Offset VirtAddr PhysAddr FileSiz MemSiz Flg Align
  LOAD 0x000000 0x000000 0x000000 0x001000 0x001000 R E ${alignment}
  LOAD 0x002000 0x002000 0x002000 0x000100 0x000100 RW  ${alignment}
`;

test("extracts LOAD alignment values from llvm-readelf output", () => {
	assert.deepEqual(
		parseLoadAlignments(readelfOutput("0x4000")),
		[16384, 16384],
	);
});

test("accepts a 16 KB-compatible native library", () => {
	assert.doesNotThrow(() =>
		checkLibraryAlignment("libcompatible.so", readelfOutput("0x4000")),
	);
});

test("rejects a 4 KB-only native library", () => {
	assert.throws(
		() => checkLibraryAlignment("libold.so", readelfOutput("0x1000")),
		/libold\.so: 4 KB ELF alignment; expected at least 16 KB/,
	);
});
