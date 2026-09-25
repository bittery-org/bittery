import { RuntimeRequestError } from "@bittery/client-runtime/client";
import { useRuntimeClient } from "@bittery/client-runtime/react";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Label,
} from "@bittery/ui";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type RecipientPrompt,
	type VerifiedRecipientGesture,
	withVerifiedRecipientKeys,
} from "@/lib/recipient-key-verification";
import { useI18n } from "./i18n-provider";

interface Verification {
	run<T>(
		task: (gesture: VerifiedRecipientGesture) => Promise<T>,
		ownerSignal?: AbortSignal,
	): Promise<T>;
}
interface PendingPrompt {
	userId: string;
	label?: string;
	changed: boolean;
	verify(fingerprint: string): Promise<void>;
	finish(error?: Error): void;
}
const Context = createContext<Verification | null>(null);

export function RecipientKeyVerificationProvider({
	children,
}: {
	children: ReactNode;
}) {
	const client = useRuntimeClient();
	const { m } = useI18n();
	const [pending, setPending] = useState<PendingPrompt | null>(null);
	const [fingerprint, setFingerprint] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [verifying, setVerifying] = useState(false);
	const queue = useRef(Promise.resolve());
	const mounted = useRef(true);
	const active = useRef<PendingPrompt | null>(null);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			active.current?.finish(
				new RuntimeRequestError("CANCELLED", "Verification UI closed"),
			);
		};
	}, []);
	const prompt = useCallback<RecipientPrompt>(
		(recipient, changed, verify, signal) => {
			const next = queue.current.then(
				() =>
					new Promise<void>((resolve, reject) => {
						if (!mounted.current || signal.aborted) {
							reject(
								new RuntimeRequestError("CANCELLED", "Verification cancelled"),
							);
							return;
						}
						let settled = false;
						const value: PendingPrompt = {
							userId: recipient.recipientUserId,
							label: recipient.label,
							changed,
							verify,
							finish(failure) {
								if (settled) return;
								settled = true;
								signal.removeEventListener("abort", abort);
								if (active.current === value) {
									active.current = null;
									if (mounted.current) setPending(null);
								}
								if (failure) reject(failure);
								else resolve();
							},
						};
						const abort = () =>
							value.finish(
								new RuntimeRequestError("CANCELLED", "Verification cancelled"),
							);
						signal.addEventListener("abort", abort, { once: true });
						active.current = value;
						setFingerprint("");
						setError(null);
						setVerifying(false);
						setPending(value);
					}),
			);
			queue.current = next.catch(() => {});
			return next;
		},
		[],
	);
	const verification = useMemo<Verification>(
		() => ({
			run: (task, ownerSignal) =>
				withVerifiedRecipientKeys(client, prompt, task, ownerSignal),
		}),
		[client, prompt],
	);
	const cancel = () =>
		pending?.finish(
			new RuntimeRequestError("CANCELLED", "Verification cancelled"),
		);
	return (
		<Context.Provider value={verification}>
			{children}
			<Dialog
				open={pending !== null}
				onOpenChange={(open) => {
					if (!open) cancel();
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{m.recipient_key_verify_title()}</DialogTitle>
						<DialogDescription>
							{pending?.changed
								? m.recipient_key_changed_description()
								: m.recipient_key_verify_description()}
						</DialogDescription>
					</DialogHeader>
					<form
						onSubmit={async (event) => {
							event.preventDefault();
							if (!pending || verifying) return;
							const captured = pending;
							setVerifying(true);
							setError(null);
							try {
								await captured.verify(fingerprint);
								captured.finish();
							} catch (cause) {
								if (active.current === captured)
									setError(
										cause instanceof RuntimeRequestError &&
											cause.code === "RECIPIENT_FINGERPRINT_MISMATCH"
											? m.recipient_key_mismatch()
											: m.recipient_key_failed(),
									);
							} finally {
								if (active.current === captured) setVerifying(false);
							}
						}}
						className="space-y-4"
					>
						{pending?.label && (
							<p className="break-all font-medium text-sm">{pending.label}</p>
						)}
						<p className="break-all text-muted-foreground text-xs">
							{m.recipient_key_user_id({ userId: pending?.userId ?? "" })}
						</p>
						<div className="space-y-2">
							<Label htmlFor="recipient-fingerprint">
								{m.recipient_key_fingerprint_label()}
							</Label>
							<Input
								id="recipient-fingerprint"
								value={fingerprint}
								onChange={(event) => setFingerprint(event.target.value)}
								autoComplete="off"
								spellCheck={false}
								disabled={verifying}
							/>
						</div>
						{error && (
							<p role="alert" className="text-destructive text-sm">
								{error}
							</p>
						)}
						<DialogFooter>
							<Button type="button" variant="outline" onClick={cancel}>
								{m.recipient_key_cancel()}
							</Button>
							<Button type="submit" disabled={verifying || !fingerprint.trim()}>
								{m.recipient_key_verify_action()}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</Context.Provider>
	);
}

export function useRecipientKeyVerification(): Verification {
	const value = useContext(Context);
	if (!value) throw new Error("RecipientKeyVerificationProvider is required");
	return value;
}
