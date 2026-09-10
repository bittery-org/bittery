import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { chromium } from "../../../apps/extension/node_modules/playwright/index.mjs";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const ACCESS_KEY = "chromium-access-key";
const SECRET_KEY = "chromium-secret-key";
const REGION = "auto";
const EXPECTED_SIGNED_HEADERS =
	"content-length;content-type;host;x-amz-checksum-sha256;x-amz-content-sha256";

afterAll(() => {
	for (const server of servers) server.stop(true);
});

function sha256(value: Uint8Array | string): Buffer {
	return createHash("sha256").update(value).digest();
}

function hmac(key: Uint8Array | string, value: string): Buffer {
	return createHmac("sha256", key).update(value).digest();
}

function awsEncode(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

async function verifySigV4Put(request: Request): Promise<void> {
	const url = new URL(request.url);
	const algorithm = url.searchParams.get("X-Amz-Algorithm");
	const credential = url.searchParams.get("X-Amz-Credential");
	const amzDate = url.searchParams.get("X-Amz-Date");
	const expires = url.searchParams.get("X-Amz-Expires");
	const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders");
	const suppliedSignature = url.searchParams.get("X-Amz-Signature");
	if (
		algorithm !== "AWS4-HMAC-SHA256" ||
		credential === null ||
		amzDate === null ||
		expires !== "300" ||
		signedHeaders !== EXPECTED_SIGNED_HEADERS ||
		suppliedSignature === null ||
		!/^[0-9a-f]{64}$/.test(suppliedSignature)
	) {
		throw new Error("invalid presign query contract");
	}
	const scope = credential.slice(credential.indexOf("/") + 1);
	const [date, region, service, terminal] = scope.split("/");
	if (
		credential !== `${ACCESS_KEY}/${scope}` ||
		region !== REGION ||
		service !== "s3" ||
		terminal !== "aws4_request" ||
		date !== amzDate.slice(0, 8)
	) {
		throw new Error("invalid credential scope");
	}
	const ageSeconds =
		(Date.now() -
			Date.UTC(
				Number(amzDate.slice(0, 4)),
				Number(amzDate.slice(4, 6)) - 1,
				Number(amzDate.slice(6, 8)),
				Number(amzDate.slice(9, 11)),
				Number(amzDate.slice(11, 13)),
				Number(amzDate.slice(13, 15)),
			)) /
		1000;
	if (ageSeconds < -30 || ageSeconds > 300) throw new Error("expired presign");

	const bytes = new Uint8Array(await request.arrayBuffer());
	const payloadHex = sha256(bytes).toString("hex");
	const payloadChecksum = sha256(bytes).toString("base64");
	if (
		request.headers.get("content-length") !== String(bytes.byteLength) ||
		request.headers.get("x-amz-content-sha256") !== payloadHex ||
		request.headers.get("x-amz-checksum-sha256") !== payloadChecksum
	) {
		throw new Error("invalid payload authority");
	}
	const canonicalHeaders = signedHeaders
		.split(";")
		.map((name) => {
			const value = request.headers.get(name);
			if (value === null) throw new Error(`missing signed header ${name}`);
			return `${name}:${value.trim().replace(/\s+/g, " ")}\n`;
		})
		.join("");
	const canonicalQuery = [...url.searchParams]
		.filter(([name]) => name !== "X-Amz-Signature")
		.map(([name, value]) => [awsEncode(name), awsEncode(value)] as const)
		.sort(([leftName, leftValue], [rightName, rightValue]) =>
			leftName === rightName
				? leftValue.localeCompare(rightValue)
				: leftName.localeCompare(rightName),
		)
		.map(([name, value]) => `${name}=${value}`)
		.join("&");
	const canonicalRequest = [
		"PUT",
		url.pathname,
		canonicalQuery,
		canonicalHeaders,
		signedHeaders,
		payloadHex,
	].join("\n");
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		sha256(canonicalRequest).toString("hex"),
	].join("\n");
	const dateKey = hmac(`AWS4${SECRET_KEY}`, date);
	const regionKey = hmac(dateKey, REGION);
	const serviceKey = hmac(regionKey, "s3");
	const signingKey = hmac(serviceKey, "aws4_request");
	const expectedSignature = hmac(signingKey, stringToSign);
	const actualSignature = Buffer.from(suppliedSignature, "hex");
	if (!timingSafeEqual(expectedSignature, actualSignature)) {
		throw new Error("invalid signature");
	}
}

describe("Vault image signed PUT in actual Chromium", () => {
	test("accepts only a production-generated exact SigV4 upload authority", async () => {
		const built = await Bun.build({
			entrypoints: [
				new URL("./web-vault-image-http-chromium-harness.ts", import.meta.url)
					.pathname,
			],
			target: "browser",
			format: "iife",
		});
		expect(built.success).toBe(true);
		const script = await built.outputs[0].text();
		let accepted = 0;
		const rejected: string[] = [];
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				if (request.method === "GET")
					return new Response(`<script>${script}</script>`, {
						headers: { "content-type": "text/html" },
					});
				const cors = {
					"access-control-allow-origin": "*",
					"access-control-allow-methods": "PUT,OPTIONS",
					"access-control-allow-headers":
						"content-type,x-amz-content-sha256,x-amz-checksum-sha256",
				};
				if (request.method === "OPTIONS")
					return new Response(null, { headers: cors });
				try {
					await verifySigV4Put(request);
					accepted += 1;
					return new Response(null, { status: 200, headers: cors });
				} catch (error) {
					rejected.push(error instanceof Error ? error.message : "rejected");
					return new Response(null, { status: 403, headers: cors });
				}
			},
		});
		servers.push(server);
		const endpoint = `http://127.0.0.1:${server.port}`;
		const generated = spawnSync(
			"cargo",
			[
				"run",
				"--quiet",
				"--manifest-path",
				resolve(import.meta.dirname, "../../../apps/server/Cargo.toml"),
				"--features",
				"acceptance-adapter",
				"--bin",
				"presign-exact-upload-acceptance",
				"--",
				endpoint,
			],
			{ encoding: "utf8" },
		);
		expect(generated.status, generated.stderr).toBe(0);
		const grant = JSON.parse(generated.stdout) as {
			uploadUrl: string;
			requiredHeaders: Array<{ name: string; value: string }>;
		};
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage();
			await page.goto(`${endpoint}/`);
			await page.evaluate(
				async ({ url, headers }) =>
					window.runVaultImageHttpHarness(url, headers),
				{ url: grant.uploadUrl, headers: grant.requiredHeaders },
			);
			const signedUrl = new URL(grant.uploadUrl);
			const signature = signedUrl.searchParams.get("X-Amz-Signature") ?? "";
			signedUrl.searchParams.set(
				"X-Amz-Signature",
				`${signature[0] === "0" ? "1" : "0"}${signature.slice(1)}`,
			);
			for (const [url, headers] of [
				[signedUrl.toString(), grant.requiredHeaders],
				[
					grant.uploadUrl,
					grant.requiredHeaders.map((header) =>
						header.name.toLowerCase() === "content-type"
							? { ...header, value: "image/webp" }
							: header,
					),
				],
				[
					grant.uploadUrl,
					grant.requiredHeaders.map((header) =>
						header.name.toLowerCase() === "x-amz-checksum-sha256"
							? {
									...header,
									value: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
								}
							: header,
					),
				],
			] as const) {
				await expect(
					page.evaluate(
						async ({ url, headers }) =>
							window.runVaultImageHttpHarness(url, headers),
						{ url, headers },
					),
				).rejects.toThrow();
			}
			expect(accepted).toBe(1);
			expect(rejected).toEqual(["invalid signature", "invalid signature"]);
		} finally {
			await browser.close();
		}
	}, 120_000);
});
