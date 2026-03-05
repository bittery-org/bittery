export const RATE_LIMIT_NAMESPACE = {
	authLogin: "auth_login",
	authRecovery: "auth_recovery",
	shareCreateDaily: "share_create_daily",
} as const;

export function startOfLocalDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function formatLocalDateKey(date: Date): string {
	const year = date.getFullYear();
	const month = `${date.getMonth() + 1}`.padStart(2, "0");
	const day = `${date.getDate()}`.padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function secondsUntilNextLocalDay(now: Date): number {
	const tomorrow = new Date(
		now.getFullYear(),
		now.getMonth(),
		now.getDate() + 1,
	);
	return Math.max(1, Math.ceil((tomorrow.getTime() - now.getTime()) / 1000));
}
