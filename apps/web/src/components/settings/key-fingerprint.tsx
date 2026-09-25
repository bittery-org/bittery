import {
	useRuntimeClient,
	useRuntimeSession,
} from "@bittery/client-runtime/react";
import { Button } from "@bittery/ui";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/providers/i18n-provider";
import { useRecipientKeyVerification } from "@/providers/recipient-key-verification-provider";

export function KeyFingerprint() {
	const client = useRuntimeClient();
	const session = useRuntimeSession();
	const verification = useRecipientKeyVerification();
	const { m } = useI18n();
	const [result, setResult] = useState<{
		accountId: string;
		userId: string;
		fingerprint: string;
	} | null>(null);
	const [loading, setLoading] = useState(false);
	const [failed, setFailed] = useState(false);
	const presentationRevision = useRef(0);
	useEffect(
		() =>
			client.session().subscribe(() => {
				presentationRevision.current++;
				setResult(null);
			}),
		[client],
	);
	const visible =
		session.state === "unlocked" && result?.accountId === session.accountId
			? result
			: null;
	return (
		<section className="space-y-3 rounded-lg border bg-card p-4">
			<h3 className="font-medium text-sm">{m.recipient_key_own_title()}</h3>
			<p className="text-muted-foreground text-sm">
				{m.recipient_key_own_description()}
			</p>
			<Button
				variant="outline"
				disabled={loading || session.state !== "unlocked"}
				onClick={async () => {
					const revision = presentationRevision.current;
					setLoading(true);
					setFailed(false);
					setResult(null);
					try {
						const value = await verification.run(async (gesture) => ({
							accountId: gesture.accountId,
							...(await client.ownKeyFingerprint(
								{ accountId: gesture.accountId },
								{ signal: gesture.signal },
							)),
						}));
						if (revision === presentationRevision.current) setResult(value);
					} catch {
						setFailed(true);
					} finally {
						setLoading(false);
					}
				}}
			>
				{m.recipient_key_show()}
			</Button>
			{visible && (
				<div className="space-y-2">
					<p className="text-muted-foreground text-xs">
						{m.recipient_key_user_id({ userId: visible.userId })}
					</p>
					<code
						data-testid="own-key-fingerprint"
						className="block select-all break-all text-sm"
					>
						{visible.fingerprint}
					</code>
				</div>
			)}
			{failed && (
				<p role="alert" className="text-destructive text-sm">
					{m.recipient_key_failed()}
				</p>
			)}
		</section>
	);
}
