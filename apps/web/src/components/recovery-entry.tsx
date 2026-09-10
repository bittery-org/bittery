import { Button } from "@bittery/ui";
import { createContext, useContext } from "react";
import { useI18n } from "@/providers/i18n-provider";

export const RecoveryEntryContext = createContext<(() => void) | undefined>(
	undefined,
);
export function RecoveryEntryButton() {
	const open = useContext(RecoveryEntryContext);
	const { m } = useI18n();
	return (
		<Button variant="outline" onClick={open} disabled={open === undefined}>
			{m.replica_recovery_title()}
		</Button>
	);
}
