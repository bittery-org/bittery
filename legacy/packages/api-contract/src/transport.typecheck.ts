import type { ApiTransport, ApiTransportResponse } from "./transport.ts";

declare const transport: ApiTransport;

transport.request("GET", "/api/meta");
transport.request("POST", "/api/v1/auth/email-checks", {
	body: { email: "test@example.com" },
});
transport.request("GET", "/api/v1/items/{itemId}", {
	params: { path: { itemId: "item_1" } },
});

// @ts-expect-error POST is not defined for this generated path.
transport.request("POST", "/api/meta");

// @ts-expect-error This path is not part of the generated contract.
transport.request("GET", "/api/v1/not-a-route");

// @ts-expect-error The generated request body requires an email.
transport.request("POST", "/api/v1/auth/email-checks", { body: {} });

// @ts-expect-error Path parameters are generated and required.
transport.request("GET", "/api/v1/items/{itemId}");

// @ts-expect-error The successful response is derived, not caller-selected.
const wrongResponse: Promise<ApiTransportResponse<{ wrong: true }>> =
	transport.request("GET", "/api/meta");

void transport;
void wrongResponse;
