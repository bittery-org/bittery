import { AppBar, EmptyState, IconSearch, Screen } from "@/components/ui";
import { useI18n } from "@/providers/i18n-provider";

interface NotFoundStateProps {
	onBack: () => void;
}

export function NotFoundState({ onBack }: NotFoundStateProps) {
	const { m } = useI18n();

	return (
		<Screen>
			<AppBar showBack onBack={onBack} />
			<EmptyState
				icon={IconSearch}
				title={m.mob_detail_not_found()}
				actionLabel={m.mob_common_go_back()}
				onAction={onBack}
			/>
		</Screen>
	);
}
