import { Button } from "@bittery/ui";
import { IconPlusOutlineDuo18 } from "@bittery/ui/icons";
// import { useSyncContextOptional } from "../../providers/sync-provider";
import { useI18n } from "../../providers/i18n-provider";
import { SearchCombobox } from "./search-combobox";

interface VaultHeaderProps {
	hasVaults: boolean;
	onNewItemClick: () => void;
}

export function VaultHeader({ hasVaults, onNewItemClick }: VaultHeaderProps) {
	const { m } = useI18n();
	// const syncContext = useSyncContextOptional();

	return (
		<header
			className="flex items-center gap-4 border-b px-4 py-2.5"
			data-tauri-drag-region
		>
			<div className="flex-1">
				<SearchCombobox />
			</div>
			{/* {syncContext ? (
				<SyncStatusIndicator status={syncContext.status.connectionStatus} />
			) : null} */}
			<Button onClick={onNewItemClick} disabled={!hasVaults}>
				<IconPlusOutlineDuo18 />
				{m.vaults_detail_action_new_item()}
			</Button>
		</header>
	);
}
