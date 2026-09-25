/** Optional platform lifetime captured before an unlock ceremony begins.
 * External authentication and Travel verification run outside `run`; each
 * Account's actual material writes and local state publication run inside it. */
import type { LifecycleOutcome } from "./account-lifecycle";

export interface MaterialFailureCleanup {
	/** Null means a later publication or retirement owns this Account now. */
	run(
		cleanup: () => Promise<LifecycleOutcome>,
	): Promise<LifecycleOutcome | null>;
	/** Check the captured Account publication after an external wait. */
	isCurrent(): boolean;
}

export class MaterialPublicationSupersededError extends Error {
	constructor() {
		super("Account material publication superseded");
	}
}

export interface MaterialPublication {
	check(): void;
	/** Whether this captured delivery still owns projected state. */
	isCurrent?(): boolean;
	/** Capture cleanup authority before an external policy wait. */
	captureCleanup?(accountId: string): MaterialFailureCleanup;
	run<T>(
		accountId: string,
		publish: (check: () => void) => Promise<T>,
		installed?: (result: T) => boolean,
	): Promise<T>;
}

export interface MaterialPublicationSource {
	capture(): Promise<MaterialPublication>;
}
