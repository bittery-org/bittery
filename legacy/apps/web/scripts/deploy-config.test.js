// Static lint over the web container's deployment configuration.
//
// SCOPE — read before trusting this file:
//
// This is a *text* assertion over apps/web/Dockerfile, deploy/docker/docker-compose.yml
// and apps/web/nginx.conf. It does NOT build the image, start a container, or
// observe a real health status: CI has no Docker build job, which is exactly why
// the "container is permanently unhealthy" bug shipped unnoticed. Everything
// that only shows up at runtime — nginx actually starting, the entrypoint's IPv6
// patch being skipped, busybox wget's address selection, the probe returning 200
// — is still uncovered here and needs a job that builds and runs the image.
//
// What it does buy: the specific config regressions that caused the outage
// (probing `localhost` from a busybox image, port/path drift between the probe
// and the nginx server block, an unconditional IPv6 listener) fail in an
// existing CI job instead of silently in production.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");

const dockerfile = readFileSync(
	resolve(repoRoot, "apps/web/Dockerfile"),
	"utf8",
);
const nginxTemplate = readFileSync(
	resolve(repoRoot, "apps/web/nginx.conf"),
	"utf8",
);
const composeFile = readFileSync(
	resolve(repoRoot, "deploy/docker/docker-compose.yml"),
	"utf8",
);

/** Joins a HEALTHCHECK instruction and its backslash continuation lines. */
function readHealthcheckInstruction(contents) {
	const lines = contents.split("\n");
	const start = lines.findIndex((line) => line.startsWith("HEALTHCHECK"));
	if (start === -1) {
		throw new Error("apps/web/Dockerfile has no HEALTHCHECK instruction");
	}

	const parts = [];
	for (let index = start; index < lines.length; index += 1) {
		const line = lines[index];
		parts.push(line.replace(/\\\s*$/, ""));
		if (!line.trimEnd().endsWith("\\")) {
			break;
		}
	}

	return parts.join(" ");
}

/** Extracts the port nginx is configured to listen on. */
function readNginxListenPort(contents) {
	const match = contents.match(/^\s*listen\s+(\d+);/m);
	if (!match) {
		throw new Error("apps/web/nginx.conf has no `listen <port>;` directive");
	}
	return match[1];
}

/** Extracts the path of the nginx location that returns a 200 health response. */
function readNginxHealthPath(contents) {
	const match = contents.match(/location\s*=\s*(\S+)\s*\{[^}]*return\s+200/);
	if (!match) {
		throw new Error("apps/web/nginx.conf has no health-check location");
	}
	return match[1];
}

const healthcheckInstruction = readHealthcheckInstruction(dockerfile);
const listenPort = readNginxListenPort(nginxTemplate);
const healthPath = readNginxHealthPath(nginxTemplate);

describe("web container health probe", () => {
	// nginx serves IPv4 only (the base image's 10-listen-on-ipv6-by-default.sh
	// declines to patch a replaced default.conf), and the runtime image's busybox
	// wget tries only the first address getaddrinfo returns — [::1] for
	// `localhost`. Probing `localhost` therefore fails forever.
	test("Dockerfile probes an IPv4 literal instead of localhost", () => {
		expect(healthcheckInstruction).not.toContain("localhost");
		expect(healthcheckInstruction).toContain("http://127.0.0.1:");
	});

	test("Dockerfile probe targets the port and path nginx serves", () => {
		expect(healthcheckInstruction).toContain(
			`http://127.0.0.1:${listenPort}${healthPath}`,
		);
	});

	test("compose web probe matches the image probe", () => {
		const probeLines = composeFile
			.split("\n")
			.filter((line) => line.includes(healthPath));

		expect(probeLines.length).toBeGreaterThan(0);
		for (const line of probeLines) {
			expect(line).not.toContain("localhost");
			expect(line).toContain(`http://127.0.0.1:${listenPort}${healthPath}`);
		}
	});

	// An unconditional `listen [::]:<port>;` makes nginx exit at startup with
	// "Address family not supported by protocol" in any container without an
	// IPv6 stack, which is strictly worse than a wrong health flag. If IPv6 is
	// ever genuinely required, add the listener from an entrypoint script that
	// checks /proc/net/if_inet6 first (as the base image does) rather than
	// hardcoding it here.
	test("nginx.conf does not hardcode an IPv6 listener", () => {
		expect(nginxTemplate).not.toMatch(/listen\s+\[::\]/);
	});
});
