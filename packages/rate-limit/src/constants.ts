export const RATE_LIMIT_NAMESPACE = {
	authLoginAccount: "auth_login_account",
	authLoginSource: "auth_login_source",
	authRecovery: "auth_recovery",
	authSignupSource: "auth_signup_source",
	authInviteSignupSource: "auth_invite_signup_source",
	authRefreshSession: "auth_refresh_session",
	authRefreshSource: "auth_refresh_source",
	authAnonymousGlobal: "auth_anonymous_global",
	syncConnectSource: "sync_connect_source",
	faviconFetchSource: "favicon_fetch_source",
	shareCreateDaily: "share_create_daily",
} as const;

export function startOfLocalDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
