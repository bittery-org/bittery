import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");

describe("deployment hardening config", () => {
	test("server dockerfile runs as a non-root user", () => {
		const dockerfile = readFileSync(
			resolve(repoRoot, "apps/server/Dockerfile"),
			"utf8",
		);

		expect(dockerfile).toContain("USER 10001:10001");
	});

	test("web dockerfile uses the unprivileged nginx image", () => {
		const dockerfile = readFileSync(
			resolve(repoRoot, "apps/web/Dockerfile"),
			"utf8",
		);

		expect(dockerfile).toContain(
			"FROM nginxinc/nginx-unprivileged:1.27-alpine",
		);
	});

	test("compose requires MINIO_ROOT_PASSWORD for the storage profile", () => {
		const composeFile = readFileSync(
			resolve(repoRoot, "deploy/docker/docker-compose.yml"),
			"utf8",
		);

		expect(composeFile).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: its fine
			"MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}",
		);
	});
});
