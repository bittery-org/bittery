import type { Context as HonoContext } from "hono";
export type CreateContextOptions = {
    context: HonoContext;
};
export interface DeviceContext {
    userAgent: string;
    ipAddress: string | null;
    appPlatform: string | null;
}
type TrustProxyMode = "none" | "cloudflare" | "forwarded";
export declare function getTrustProxyMode(rawMode?: string | undefined): TrustProxyMode;
export declare function resolveTrustedSourceIpFromHeaders(input: {
    mode?: TrustProxyMode;
    forwardedForHeader?: string | null;
    realIpHeader?: string | null;
    cfConnectingIpHeader?: string | null;
}): string | null;
export declare function createContext({ context }: CreateContextOptions): Promise<{
    session: import("@bittery/auth").SessionPayload | null;
    authToken: string | null;
    clientId: string | null;
    device: DeviceContext;
}>;
export type Context = Awaited<ReturnType<typeof createContext>>;
export {};
