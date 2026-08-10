import {
	AppBar,
	ErrorState as ErrorStateBlock,
	IconTriangleAlert,
	Screen,
} from "@/components/ui";
import { useI18n } from "@/providers/i18n-provider";

interface ErrorStateProps {
	error: Error | unknown;
	onBack: () => void;
}

export function ErrorState({ error, onBack }: ErrorStateProps) {
	const { m } = useI18n();

	return (
		<Screen>
			<AppBar showBack onBack={onBack} />
			<ErrorStateBlock
				icon={IconTriangleAlert}
				title={m.mob_detail_error_title()}
				description={
					error instanceof Error ? error.message : m.mob_detail_error_unknown()
				}
				actionLabel={m.mob_common_go_back()}
				onAction={onBack}
			/>
		</Screen>
	);
}
