import { useRuntimeSession } from "@bittery/client-runtime/react";
import { Button } from "@bittery/ui";
import type { ReactNode } from "react";
import { useI18n } from "@/providers/i18n-provider";
import { RecoveryEntryButton } from "./recovery-entry";

function retryStorage(): void {
	// Explicit host restart retries opening storage; accepted work remains in the Replica.
	window.location.reload();
}

export function StorageAvailabilityBoundary({
	children,
	retry = retryStorage,
}: {
	children: ReactNode;
	retry?: () => void;
}) {
	const session = useRuntimeSession();
	const { m } = useI18n();
	if (
		session.state !== "unavailable" ||
		session.code !== "STORAGE_UNAVAILABLE"
	) {
		return children;
	}
	return (
		<main className="flex min-h-dvh items-center justify-center bg-background p-6">
			<section
				aria-labelledby="storage-unavailable-title"
				className="max-w-md space-y-4 rounded-lg border bg-card p-6"
			>
				<h1 id="storage-unavailable-title" className="font-semibold text-lg">
					{m.runtime_storage_unavailable_title()}
				</h1>
				<p role="alert" className="text-muted-foreground text-sm">
					{m.runtime_storage_unavailable_description()}
				</p>
				<div className="flex flex-wrap gap-2">
					<Button onClick={retry}>
						{m.runtime_storage_unavailable_retry()}
					</Button>
					<RecoveryEntryButton />
				</div>
			</section>
		</main>
	);
}
