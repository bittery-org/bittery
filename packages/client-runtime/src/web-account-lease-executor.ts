const ACCOUNT_LEASE_PREFIX = "bittery:attachment-move:account:";

export interface WebAccountLeaseHandle {
	isLive(): boolean;
	lost(): Promise<void>;
	release(): void;
}

/** Fixed browser-wide Account writer lease used by the Runtime Worker. */
export class WebAccountLeaseExecutor {
	readonly acquire = (
		accountId: string,
	): Promise<WebAccountLeaseHandle | null> => {
		let settleAcquired!: (handle: WebAccountLeaseHandle | null) => void;
		let rejectAcquired!: (error: unknown) => void;
		let acquiredSettled = false;
		const acquired = new Promise<WebAccountLeaseHandle | null>(
			(resolve, reject) => {
				settleAcquired = (handle) => {
					acquiredSettled = true;
					resolve(handle);
				};
				rejectAcquired = (error) => {
					acquiredSettled = true;
					reject(error);
				};
			},
		);
		let releaseHeld!: () => void;
		const held = new Promise<void>((resolve) => {
			releaseHeld = resolve;
		});
		let reportLost!: () => void;
		const lost = new Promise<void>((resolve) => {
			reportLost = resolve;
		});
		let live = false;
		let released = false;
		const handle = Object.freeze({
			isLive: () => live && !released,
			lost: () => lost,
			release: () => {
				if (released) return;
				released = true;
				live = false;
				releaseHeld();
			},
		}) satisfies WebAccountLeaseHandle;

		const request = navigator.locks.request(
			`${ACCOUNT_LEASE_PREFIX}${accountId}`,
			{ ifAvailable: true, mode: "exclusive" },
			(lock) => {
				if (lock === null) {
					settleAcquired(null);
					return;
				}
				live = true;
				settleAcquired(handle);
				return held;
			},
		);
		void request.then(
			() => {
				if (!acquiredSettled) settleAcquired(null);
				if (live) live = false;
				reportLost();
			},
			(error: unknown) => {
				if (!acquiredSettled) rejectAcquired(error);
				if (live) live = false;
				reportLost();
			},
		);
		return acquired;
	};
}
