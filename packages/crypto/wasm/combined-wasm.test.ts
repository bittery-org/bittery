import { readFile } from "node:fs/promises";
import { expect, test } from "bun:test";
import {
  generateUuid,
  uniffiInitAsync,
  validateSecretKey,
  WebClientRuntime,
} from "./index";

test("the shared initializer creates one crypto and Runtime module", async () => {
  const wasm = await readFile(
    new URL("./generated/wasm-bindgen/index_bg.wasm", import.meta.url),
  );
  const first = uniffiInitAsync({ module_or_path: wasm });
  const second = uniffiInitAsync({ module_or_path: wasm });
  expect(second).toBe(first);
  await first;

  expect(WebClientRuntime).toBeFunction();
  expect(await generateUuid()).toMatch(/^[0-9a-f-]{36}$/);
  expect(await validateSecretKey("not-a-secret-key")).toBe(false);
});

test("the combined Runtime facade exposes the Rust Account email normalizer", async () => {
  const wasm = await readFile(
    new URL("./generated/wasm-bindgen/index_bg.wasm", import.meta.url),
  );
  await uniffiInitAsync({ module_or_path: wasm });

  expect(
    WebClientRuntime.normalizeAccountEmail(
      "  ＭＵ̈ＬＬＥＲ＠ＥＸＡＭＰＬＥ．ＣＯＭ  ",
    ),
  ).toBe("müller@example.com");
  expect(() =>
    WebClientRuntime.normalizeAccountEmail(`${"é".repeat(122)}@example.com`),
  ).toThrow();
});
