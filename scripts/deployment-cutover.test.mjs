import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(repositoryRoot, path), "utf8");

for (const path of ["deploy/docker/Caddyfile", "deploy/railway/Caddyfile"]) {
	test(`${path} routes only the REST API and keeps SSE unbuffered`, () => {
		const caddyfile = read(path);
		assert.match(caddyfile, /handle \/api\/\*/);
		assert.match(caddyfile, /handle \/api\/v1\/sync\/events/);
		assert.match(caddyfile, /flush_interval -1/);
		assert.doesNotMatch(caddyfile, /handle \/rpc/);
		assert.doesNotMatch(caddyfile, /handle \/sync\/\*/);
		assert.match(caddyfile, /handle \/healthz/);
	});
}

test("recommended Compose deployment pins server and web as one release", () => {
	const compose = read("deploy/docker/docker-compose.yml");
	const pinnedImages = compose.match(
		/ghcr\.io\/bittery-org\/bittery-(?:server|web):\$\{BITTERY_RELEASE:[^}]+\}/g,
	);
	assert.equal(pinnedImages?.length, 2);
	assert.doesNotMatch(compose, /bittery-(?:server|web):latest/);
	assert.match(compose, /minio\/minio:latest/);
});

test("installer persists the exact coordinated release", () => {
	const installer = read("deploy/install.sh");
	assert.match(installer, /--release/);
	assert.match(installer, /BITTERY_RELEASE=\$\{BITTERY_RELEASE\}/);
	assert.match(installer, /\/v\$\{BITTERY_RELEASE\}/);
});
