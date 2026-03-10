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

interface SessionRefreshManagerOptions {
	getSessionSnapshot: () => Promise<SessionSnapshot>;
	refreshSession: () => Promise<RefreshResult>;
	onRefreshSuccess?: (result: RefreshResult) => Promise<void> | void;
	thresholdRatio?: number;
	now?: () => number;
}

function parseExpiry(value: string | Date): number | null {
	const parsed =
		typeof value === "string" ? new Date(value).getTime() : value.getTime();
	return Number.isFinite(parsed) ? parsed : null;
}

export class SessionRefreshManager {
	private readonly thresholdRatio: number;
	private readonly now: () => number;
	private token: string | null = null;
	private issuedAt: number | null = null;
	private expiresAt: number | null = null;
	private refreshPromise: Promise<string | null> | null = null;

	constructor(private readonly options: SessionRefreshManagerOptions) {
		this.thresholdRatio = options.thresholdRatio ?? 0.75;
		this.now = options.now ?? (() => Date.now());
	}

	recordSessionExpiry(expiresAt: string | Date): void {
		const parsedExpiry = parseExpiry(expiresAt);
		if (!parsedExpiry) {
			return;
		}

		this.expiresAt = parsedExpiry;
		if (!this.issuedAt) {
			this.issuedAt = this.now();
		}
	}

	private syncState(snapshot: SessionSnapshot): void {
		if (snapshot.token !== this.token) {
			this.token = snapshot.token;
			this.issuedAt = snapshot.issuedAt;
			this.expiresAt = snapshot.expiresAt;
			return;
		}

		if (snapshot.issuedAt && !this.issuedAt) {
			this.issuedAt = snapshot.issuedAt;
		}

		if (snapshot.expiresAt && !this.expiresAt) {
			this.expiresAt = snapshot.expiresAt;
		}
	}

	private shouldRefresh(): boolean {
		if (!this.token || !this.issuedAt || !this.expiresAt) {
			return false;
		}

		const lifetime = this.expiresAt - this.issuedAt;
		if (lifetime <= 0) {
			return false;
		}

		const refreshAt = this.issuedAt + lifetime * this.thresholdRatio;
		return this.now() >= refreshAt;
	}

	async getToken(): Promise<string | null> {
		const snapshot = await this.options.getSessionSnapshot();
		this.syncState(snapshot);

		if (!snapshot.token) {
			return null;
		}

		if (!this.shouldRefresh()) {
			return snapshot.token;
		}

		if (!this.refreshPromise) {
			this.refreshPromise = this.refresh(snapshot.token);
		}

		return this.refreshPromise;
	}

	private async refresh(fallbackToken: string): Promise<string> {
		try {
			const result = await this.options.refreshSession();
			const expiresAt = parseExpiry(result.expiresAt);
			const now = this.now();

			this.token = result.token;
			this.issuedAt = now;
			if (expiresAt) {
				this.expiresAt = expiresAt;
			}

			await this.options.onRefreshSuccess?.(result);
			return result.token;
		} catch {
			return fallbackToken;
		} finally {
			this.refreshPromise = null;
		}
	}
}
