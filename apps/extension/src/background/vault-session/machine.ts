/**
 * The state cell and effect runner around the pure reducer.
 *
 * Two rules here are the security contract, not style:
 *
 * 1. `commit` happens before any effect, so the MUK leaves memory the instant
 *    the reducer says locked. `dispatchNow` therefore returns an already-locked
 *    snapshot while `clear_keys` is still in flight — that is what makes the
 *    synchronous `isUnlocked()` hot path honest.
 * 2. Effects run in emitted order. Awaited `dispatch` reports lifecycle failures;
 *    detached timer and `dispatchNow` paths log them after the reducer has already
 *    committed the locked state.
 */

import type { VaultSessionPorts } from "./ports";
import { createInitialState, projectSnapshot, reduce } from "./transitions";
import type {
	RefusalCode,
	VaultSessionEffect,
	VaultSessionEvent,
	VaultSessionSnapshot,
	VaultSessionState,
} from "./types";

export interface VaultSessionMachine {
	dispatch(event: VaultSessionEvent): Promise<VaultSessionSnapshot>;
	/** Synchronous form for the `isUnlocked()` hot path; effects run detached. */
	dispatchNow(event: VaultSessionEvent): VaultSessionSnapshot;
	getSnapshot(): VaultSessionSnapshot;
	/** Reads and clears the last `refuse` effect, for callers that must report it. */
	consumeRefusal(): RefusalCode | null;
}

export interface VaultSessionMachineOptions {
	initialState?: VaultSessionState;
}

export function createVaultSessionMachine(
	ports: VaultSessionPorts,
	options: VaultSessionMachineOptions = {},
): VaultSessionMachine {
	let state = options.initialState ?? createInitialState();
	let refusal: RefusalCode | null = null;
	let evaluating = false;

	/** Returns a promise only for the effects that can actually be pending. */
	function runEffect(effect: VaultSessionEffect): Promise<void> | void {
		switch (effect.kind) {
			case "set_lock_indicator":
				ports.chrome.setLockIndicator(effect.locked);
				return;
			case "arm_auto_lock":
				ports.chrome.armAutoLock(effect.delayMs, () => {
					void dispatch({
						type: "TIMEOUT_ELAPSED",
						at: ports.clock.now(),
					}).catch((error) => {
						console.error(
							"[vault-session] detached timeout lock failed:",
							error,
						);
					});
				});
				return;
			case "disarm_auto_lock":
				ports.chrome.disarmAutoLock();
				return;
			case "start_keepalive":
				ports.chrome.startKeepalive();
				return;
			case "stop_keepalive":
				ports.chrome.stopKeepalive();
				return;
			case "disconnect_sync":
				ports.sync.disconnect(effect.reason, effect.suppressReconnect);
				return;
			case "broadcast":
				ports.chrome.broadcast(effect.message);
				return;
			case "refuse":
				refusal = effect.code;
				return;
			case "clear_keys":
				return ports.lifecycle.lockAll();
			case "invalidate_session":
				return ports.lifecycle
					.invalidateSession(
						effect.sessionId ? { sessionId: effect.sessionId } : "active",
					)
					.then(() => undefined);
		}
	}

	function guarded(effect: VaultSessionEffect): Promise<void> | void {
		try {
			return runEffect(effect);
		} catch (error) {
			console.error(`[vault-session] effect ${effect.kind} threw:`, error);
		}
	}

	/**
	 * Synchronous effects stay synchronous — the lock indicator and the alarm are
	 * torn down inside `dispatchNow` itself, as `_lockInternal` did. Once an
	 * effect goes async everything after it queues behind it, preserving order.
	 */
	function runEffects(effects: VaultSessionEffect[]): Promise<void> {
		let chain: Promise<void> | null = null;
		for (const effect of effects) {
			if (chain) {
				const queued = effect;
				chain = chain.then(() => guarded(queued)).then(() => undefined);
				continue;
			}
			const pending = guarded(effect);
			if (pending) {
				chain = pending;
			}
		}
		return chain ?? Promise.resolve();
	}

	function apply(event: VaultSessionEvent): {
		snapshot: VaultSessionSnapshot;
		settled: Promise<void>;
	} {
		const { next, effects } = reduce(state, event);
		state = next;
		const snapshot = projectSnapshot(state, ports.clock.now());
		return { snapshot, settled: runEffects(effects) };
	}

	function dispatchNow(event: VaultSessionEvent): VaultSessionSnapshot {
		const { snapshot, settled } = apply(event);
		void settled.catch((error) => {
			console.error("[vault-session] detached dispatch failed:", error);
		});
		return snapshot;
	}

	async function dispatch(
		event: VaultSessionEvent,
	): Promise<VaultSessionSnapshot> {
		const { settled } = apply(event);
		await settled;
		return projectSnapshot(state, ports.clock.now());
	}

	/**
	 * Reading re-evaluates deliberately: without it a stale timer or a desktop
	 * that locked behind our back would keep serving autofill. `dispatchNow`
	 * keeps it synchronous, and `evaluating` stops an effect that reads back
	 * from recursing.
	 */
	function getSnapshot(): VaultSessionSnapshot {
		if (evaluating) {
			return projectSnapshot(state, ports.clock.now());
		}
		evaluating = true;
		try {
			const observed = ports.desktop.readCached();
			const connected = observed?.connected ?? false;
			const locked = connected && (observed?.locked ?? false);
			const timeoutMs = connected
				? (observed?.autoLockTimeoutMs ?? null)
				: null;
			if (
				connected !== state.desktopConnected ||
				locked !== state.desktopLocked ||
				timeoutMs !== state.desktopTimeoutMs
			) {
				dispatchNow({
					type: "DESKTOP_OBSERVED",
					status: observed,
					at: ports.clock.now(),
				});
			}

			const now = ports.clock.now();
			if (projectSnapshot(state, now).remainingMs === 0) {
				dispatchNow({ type: "TIMEOUT_ELAPSED", at: now });
			}

			return projectSnapshot(state, ports.clock.now());
		} finally {
			evaluating = false;
		}
	}

	function consumeRefusal(): RefusalCode | null {
		const code = refusal;
		refusal = null;
		return code;
	}

	return { dispatch, dispatchNow, getSnapshot, consumeRefusal };
}
