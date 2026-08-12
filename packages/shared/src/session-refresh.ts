export interface SessionSnapshot {
	token: string | null;
	issuedAt: number | null;
	expiresAt: number | null;
}

export interface RefreshResult {
	token: string;
	sessionId: string;
	expiresAt: string | Date;
}
