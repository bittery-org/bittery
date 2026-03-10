import { isPublicStorageKeyAllowed } from "@bittery/api/storage/public-access";

export async function servePublicStorageKey(
	key: string,
	deps: {
		createPresignedDownload: (input: {
			key: string;
			expiresInSeconds?: number;
		}) => Promise<string>;
		fetchFn?: (input: string) => Promise<Response>;
	},
): Promise<Response> {
	if (!key || !isPublicStorageKeyAllowed(key)) {
		return new Response("Not Found", { status: 404 });
	}

	let signedUrl: string;
	try {
		signedUrl = await deps.createPresignedDownload({ key });
	} catch {
		return new Response("Storage not configured", { status: 500 });
	}

	const response = await (deps.fetchFn ?? fetch)(signedUrl);
	if (!response.ok) {
		const status = response.status === 403 ? 404 : response.status;
		return new Response("Not Found", { status });
	}

	const headers = new Headers(response.headers);
	headers.delete("set-cookie");
	headers.set("Cache-Control", "public, max-age=3600");

	return new Response(response.body, {
		status: response.status,
		headers,
	});
}
