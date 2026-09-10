import { WebAccountLeaseExecutor } from "../src/web-account-lease-executor";

const executor = new WebAccountLeaseExecutor();
const held = new Map<
	string,
	Awaited<ReturnType<WebAccountLeaseExecutor["acquire"]>>
>();

Object.assign(globalThis, {
	async acquireAccountLease(accountId: string) {
		const handle = await executor.acquire(accountId);
		if (handle === null) return false;
		held.set(accountId, handle);
		return true;
	},
	isAccountLeaseLive(accountId: string) {
		return held.get(accountId)?.isLive() ?? false;
	},
	releaseAccountLease(accountId: string) {
		held.get(accountId)?.release();
		held.delete(accountId);
	},
});
