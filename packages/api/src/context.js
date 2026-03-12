import { verifySession } from "@bittery/auth";
export function getTrustProxyMode(rawMode = process.env.TRUST_PROXY_MODE) {
    const normalizedMode = rawMode?.trim().toLowerCase();
    if (normalizedMode === "cloudflare" ||
        normalizedMode === "forwarded" ||
        normalizedMode === "none") {
        return normalizedMode;
    }
    return "none";
}
function normalizeHeaderIp(value) {
    if (!value) {
        return null;
    }
    const normalized = value.trim();
    return normalized || null;
}
export function resolveTrustedSourceIpFromHeaders(input) {
    const mode = input.mode ?? getTrustProxyMode();
    if (mode === "cloudflare") {
        return normalizeHeaderIp(input.cfConnectingIpHeader);
    }
    if (mode === "forwarded") {
        return (normalizeHeaderIp(input.forwardedForHeader?.split(",")[0]) ||
            normalizeHeaderIp(input.realIpHeader));
    }
    return null;
}
function resolveContextSourceIp(context) {
    return resolveTrustedSourceIpFromHeaders({
        mode: getTrustProxyMode(),
        forwardedForHeader: context.req.header("X-Forwarded-For"),
        realIpHeader: context.req.header("X-Real-IP"),
        cfConnectingIpHeader: context.req.header("CF-Connecting-IP"),
    });
}
export async function createContext({ context }) {
    // Extract session token from Authorization header
    const authHeader = context.req.header("Authorization");
    const token = authHeader?.replace("Bearer ", "");
    let session = null;
    if (token) {
        session = await verifySession(token);
    }
    if (session) {
        context.header("X-Session-Expires", session.expiresAt.toISOString());
    }
    // Extract device information from request headers
    const userAgent = context.req.header("User-Agent") || "";
    const ipAddress = resolveContextSourceIp(context);
    const clientId = context.req.header("X-Client-Id") ?? null;
    const appPlatform = context.req.header("X-App-Platform") ?? null;
    return {
        session,
        authToken: token ?? null,
        clientId,
        device: {
            userAgent,
            ipAddress,
            appPlatform,
        },
    };
}
