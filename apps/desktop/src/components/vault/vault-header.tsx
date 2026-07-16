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
			className="flex h-12 items-center gap-4 border-b px-3"
			data-tauri-drag-region
		>
			<div className="w-full max-w-[360px]">
				<SearchCombobox />
			</div>
			<div className="flex-1" data-tauri-drag-region />
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
