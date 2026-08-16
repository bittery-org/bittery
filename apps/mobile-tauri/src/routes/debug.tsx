/**
 * MIGRATION SCAFFOLD — M1-C4a. Delete this route (and the `/` redirect that points at it in
 * `index.tsx`) before release.
 *
 * Proves the Tauri storage ports round-trip on a real device: a secret, a kv value in both
 * scopes, and 501 SQLite records through `@tauri-apps/plugin-store` and `@tauri-apps/plugin-sql`
 * respectively. Nothing here goes through `AccountStore` / `ItemCache` policy — it constructs
 * its own port instances so it tests the port, not the policy above it. `initializeStorage()`
 * from `../lib/storage` is still exercised once, so the app's real singleton wiring is proven
 * too.
 *
 * Runs automatically on mount (so `adb`, which cannot tap a button, still exercises it) and
 * also from the button, and logs the full JSON result to the console — Tauri's Android WebView
 * forwards `console.log`/`console.error` to logcat under the **`Tauri/Console`** tag, not
 * `chromium`. Grep for the wrong one and the run looks silent.
 *
 * The copy here stays untranslated English on purpose: it names step identifiers a developer
 * greps for in logcat, and this route never ships.
 */

import {
	createTauriMobilePlatformPort,
	createTauriMobileRecordPort,
} from "@bittery/storage/adapters/tauri-mobile";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { checkPermissions as checkCameraPermissions } from "@tauri-apps/plugin-barcode-scanner";
import { getCurrent as getCurrentDeepLink } from "@tauri-apps/plugin-deep-link";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useEffect, useState } from "react";
import { MobileScreen } from "@/components/mobile-screen";
import {
	BrandButton,
	ListCard,
	Pressable,
	SectionLabel,
} from "@/components/ui";
import { useI18n } from "@/providers/i18n-provider";
import { scanTotpSetupToClipboard } from "../lib/barcode-scanner";
import {
	credentialProvider,
	credentialProviderUnavailableReason,
} from "../lib/credential-provider";
import { shareText } from "../lib/share";
import { initializeStorage } from "../lib/storage";

export const Route = createFileRoute("/debug")({
	component: DebugComponent,
});

type StepResult =
	| { name: string; ok: true; detail: unknown }
	| { name: string; ok: false; error: string; stack: string | null };

interface SelfTestReport {
	startedAt: string;
	finishedAt: string;
	ok: boolean;
	steps: StepResult[];
}

/** ~8000 chars, multi-byte throughout, to exercise real UTF-8 encoding through the plugin IPC. */
function buildMultiByteSecretValue(): string {
	const unit = "🔐日本語Ünïcödé-";
	let value = "";
	while (value.length < 8000) {
		value += unit;
	}
	return value;
}

async function step(
	name: string,
	fn: () => Promise<unknown>,
): Promise<StepResult> {
	try {
		const detail = await fn();
		return { name, ok: true, detail };
	} catch (cause) {
		return {
			name,
			ok: false,
			error: cause instanceof Error ? cause.message : String(cause),
			stack: cause instanceof Error ? (cause.stack ?? null) : null,
		};
	}
}

async function runSelfTest(): Promise<SelfTestReport> {
	const startedAt = new Date().toISOString();
	const steps: StepResult[] = [];

	steps.push(
		await step("initializeStorage (app singletons)", () => initializeStorage()),
	);

	const platformPort = createTauriMobilePlatformPort();
	const recordPort = createTauriMobileRecordPort();

	steps.push(
		await step("initialize direct ports", async () => {
			await platformPort.initialize();
			await recordPort.initialize();
			return "initialized";
		}),
	);

	steps.push(
		await step("platform port self-description", async () => ({
			platform: platformPort.platform,
			sessionSurvivesRestart: platformPort.sessionSurvivesRestart,
			tiers: platformPort.tiers,
			secretBacking: platformPort.secretBacking,
			recordKeyPrefix: platformPort.recordKeyPrefix,
		})),
	);

	// M1-C9. The Keystore plugin is asked directly, not through the port, so the probe's own
	// answer is on the record next to the port's `secretBacking` — a port that quietly fell
	// back would otherwise look identical to one that was never offered a Keystore.
	steps.push(
		await step("bittery-keystore secret_available (raw probe)", async () => {
			const { invoke } = await import("@tauri-apps/api/core");
			return await invoke("plugin:bittery-keystore|secret_available");
		}),
	);

	steps.push(
		await step("live secretBacking (which backend won)", async () => ({
			secretBacking: platformPort.secretBacking,
			keystoreInUse: platformPort.secretBacking.includes(
				"tauri-plugin-bittery-keystore",
			),
		})),
	);

	steps.push(
		await step("secret round-trip", async () => {
			const value = buildMultiByteSecretValue();
			await platformPort.secretSet("selftest", value);
			const got = await platformPort.secretGet("selftest");
			if (got !== value) {
				throw new Error(
					`secret mismatch: wrote ${value.length} chars, read back ${got?.length ?? "null"}`,
				);
			}
			await platformPort.secretDelete("selftest");
			const afterDelete = await platformPort.secretGet("selftest");
			if (afterDelete !== null) {
				throw new Error(
					`secret still present after delete: ${JSON.stringify(afterDelete)}`,
				);
			}
			return { valueLength: value.length };
		}),
	);

	steps.push(
		await step("kv round-trip (device vs session scope)", async () => {
			await platformPort.kvSet("selftest_kv", "device-value", "device");
			await platformPort.kvSet("selftest_kv", "session-value", "session");
			const deviceValue = await platformPort.kvGet("selftest_kv", "device");
			const sessionValue = await platformPort.kvGet("selftest_kv", "session");
			// Checked before the per-scope literal checks below: those narrow each variable to
			// its own expected literal type, which would make this comparison a compile-time
			// tautology instead of a real runtime assertion.
			if (deviceValue === sessionValue) {
				throw new Error("device and session scopes aliased");
			}
			if (deviceValue !== "device-value") {
				throw new Error(
					`device scope mismatch: ${JSON.stringify(deviceValue)}`,
				);
			}
			if (sessionValue !== "session-value") {
				throw new Error(
					`session scope mismatch: ${JSON.stringify(sessionValue)}`,
				);
			}
			await platformPort.kvDelete("selftest_kv", "device");
			await platformPort.kvDelete("selftest_kv", "session");
			return { deviceValue, sessionValue };
		}),
	);

	steps.push(
		await step(
			"record round-trip (put, putMany x500, list, clear)",
			async () => {
				const collection = "selftest:records";
				await recordPort.recordPut(collection, "single", "single-value");
				const single = await recordPort.recordGet(collection, "single");
				if (single !== "single-value") {
					throw new Error(`recordGet mismatch: ${JSON.stringify(single)}`);
				}

				const bulk = Array.from({ length: 500 }, (_unused, index) => ({
					id: `bulk-${index}`,
					value: `bulk-value-${index}`,
				}));
				await recordPort.recordPutMany(collection, bulk);

				const listed = await recordPort.recordList(collection);
				const expectedCount = bulk.length + 1;
				if (listed.length !== expectedCount) {
					throw new Error(
						`recordList expected ${expectedCount} rows, got ${listed.length}`,
					);
				}

				await recordPort.recordClear(collection);
				const afterClear = await recordPort.recordList(collection);
				if (afterClear.length !== 0) {
					throw new Error(
						`recordList expected 0 rows after clear, got ${afterClear.length}`,
					);
				}

				return {
					putManyCount: bulk.length,
					listedBeforeClear: listed.length,
					listedAfterClear: afterClear.length,
				};
			},
		),
	);

	steps.push(
		await step(
			"biometric (isAvailable/getDetails/getType — no authenticate)",
			async () => ({
				isAvailable: await platformPort.biometric.isAvailable(),
				details: await platformPort.biometric.getDetails(),
				type: await platformPort.biometric.getType(),
			}),
		),
	);

	// M2-C2. Read-only, side-effect-free commands only. Nothing here may touch MUK
	// state, the escrow or the database: this runs against a live signed-in session,
	// and a stray `clearAllMasterUnlockKeys` would lock the user out mid-run.
	steps.push(
		await step("credential provider (read-only surface)", async () => ({
			isAvailable: await credentialProvider.isAvailable(),
			isBiometricAvailable: await credentialProvider.isBiometricAvailable(),
			isVaultUnlocked: await credentialProvider.isVaultUnlocked(),
			hasValidEscrow: await credentialProvider.hasValidEscrow(),
			getEscrowRemainingTime: await credentialProvider.getEscrowRemainingTime(),
			isMasterPasswordReentryRequired:
				await credentialProvider.isMasterPasswordReentryRequired(),
			canUseBiometricUnlock: await credentialProvider.canUseBiometricUnlock(),
			getLastMasterPasswordEntry:
				await credentialProvider.getLastMasterPasswordEntry(),
			getPendingPasskeyMutations:
				await credentialProvider.getPendingPasskeyMutations(),
			isSupported: await credentialProvider.isSupported(),
			unavailableReason: credentialProviderUnavailableReason(),
		})),
	);

	// M3-C4. Non-interactive only: `barcode-scanner`'s `checkPermissions` and
	// `deep-link`'s `getCurrent` answer without raising any UI, so they run
	// automatically like everything else above. `share_text` (always opens the
	// Android chooser) and the dialog/fs file-pick pair (always opens the SAF picker)
	// cannot run unattended — they are the "Peripherals (interactive)" buttons below,
	// and were exercised by hand on-device; see the chunk report for what that found.
	steps.push(
		await step("peripherals: barcode-scanner checkPermissions", async () => ({
			cameraPermission: await checkCameraPermissions(),
		})),
	);

	steps.push(
		await step(
			"peripherals: deep-link getCurrent (cold-start URL, if any)",
			async () => ({
				startUrls: await getCurrentDeepLink(),
			}),
		),
	);

	const report: SelfTestReport = {
		startedAt,
		finishedAt: new Date().toISOString(),
		ok: steps.every((s) => s.ok),
		steps,
	};
	return report;
}

function PeripheralsPanel() {
	const [log, setLog] = useState<string[]>([]);

	const record = (label: string, detail: unknown) => {
		setLog((prev) => [
			...prev,
			`${new Date().toISOString()} ${label}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`,
		]);
	};

	const runScan = async () => {
		try {
			const result = await scanTotpSetupToClipboard();
			record("scan ok", result);
		} catch (error) {
			record(
				"scan failed/cancelled",
				error instanceof Error ? error.message : String(error),
			);
		}
	};

	const runShare = async () => {
		try {
			await shareText({
				text: "https://example.com/s/debug-share-test",
				title: "Bittery debug share test",
			});
			record("share_text resolved (chooser shown)", "ok");
		} catch (error) {
			record(
				"share_text failed",
				error instanceof Error ? error.message : String(error),
			);
		}
	};

	const runFilePick = async () => {
		try {
			const path = await openFileDialog({ multiple: false, directory: false });
			if (!path) {
				record("dialog.open", "cancelled (null)");
				return;
			}
			record("dialog.open picked path", path);
			try {
				const contents = await readTextFile(path);
				record("fs.readTextFile ok, length", contents.length);
			} catch (fsError) {
				record(
					"fs.readTextFile FAILED on dialog-picked path",
					fsError instanceof Error ? fsError.message : String(fsError),
				);
			}
		} catch (error) {
			record(
				"dialog.open failed",
				error instanceof Error ? error.message : String(error),
			);
		}
	};

	return (
		<div>
			<SectionLabel>Peripherals (interactive)</SectionLabel>
			<ListCard className="p-4">
				<p className="text-muted-foreground text-sm">
					These raise real UI (camera, share chooser, file picker) and cannot
					run unattended — tap each and read the log below.
				</p>
				<div className="mt-3 flex flex-wrap gap-2">
					<DebugButton label="Scan QR" onPress={() => void runScan()} />
					<DebugButton label="Share text" onPress={() => void runShare()} />
					<DebugButton
						label="Pick file (dialog+fs)"
						onPress={() => void runFilePick()}
					/>
				</div>
				<LogPane
					className="mt-3 max-h-40"
					text={
						log.length === 0 ? "no interactive test run yet" : log.join("\n")
					}
				/>
			</ListCard>
		</div>
	);
}

/** Neutral secondary button. The one purple button on this screen is "run the self-test". */
function DebugButton({
	label,
	onPress,
	disabled,
}: {
	label: string;
	onPress: () => void;
	disabled?: boolean;
}) {
	return (
		<Pressable
			onClick={onPress}
			disabled={disabled}
			className="flex h-11 items-center justify-center rounded-xl bg-surface-tertiary px-4 font-medium text-base text-foreground"
		>
			{label}
		</Pressable>
	);
}

function LogPane({ text, className }: { text: string; className?: string }) {
	return (
		<pre
			className={`native-scroll selectable whitespace-pre-wrap break-words rounded-xl bg-field p-3 font-mono text-muted-foreground text-xs leading-relaxed ${className ?? ""}`}
		>
			{text}
		</pre>
	);
}

function DebugComponent() {
	const { m } = useI18n();
	const navigate = useNavigate();
	const [report, setReport] = useState<SelfTestReport | null>(null);
	const [running, setRunning] = useState(false);
	const [fatal, setFatal] = useState<string | null>(null);

	const execute = async () => {
		setRunning(true);
		setFatal(null);
		try {
			const result = await runSelfTest();
			setReport(result);
			console.log("[debug] storage self-test result", JSON.stringify(result));
			if (!result.ok) {
				console.error(
					"[debug] storage self-test FAILED",
					JSON.stringify(result),
				);
			}
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			const stack = cause instanceof Error ? (cause.stack ?? "") : "";
			setFatal(`${message}\n${stack}`);
			console.error("[debug] storage self-test threw fatally", message, stack);
		} finally {
			setRunning(false);
		}
	};

	// This route is a temporary migration scaffold, not shipped UI: it must run once on
	// mount so `adb`, which cannot tap a button, still exercises the self-test end to end.
	// biome-ignore lint/correctness/useExhaustiveDependencies: run exactly once on mount, deliberately.
	useEffect(() => {
		void execute();
	}, []);

	return (
		<MobileScreen
			title="Storage self-test"
			subtitle="Migration scaffold for M1-C4a — delete before release."
			backLabel={m.mob_common_go_back()}
			onBack={() => navigate({ to: "/vault" })}
		>
			<div className="flex flex-col gap-6 px-4 py-4">
				<BrandButton
					label={running ? "Running…" : "Run storage self-test"}
					onClick={() => void execute()}
					disabled={running}
					isLoading={running}
				/>

				<LogPane
					className="max-h-[55dvh]"
					text={
						fatal
							? `FATAL\n${fatal}`
							: report
								? JSON.stringify(report, null, 2)
								: running
									? "running…"
									: "idle"
					}
				/>

				<PeripheralsPanel />
			</div>
		</MobileScreen>
	);
}
