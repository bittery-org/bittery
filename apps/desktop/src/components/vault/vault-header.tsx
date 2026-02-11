import { Button } from "@bittery/ui";
import { IconPlusOutlineDuo18 } from "@bittery/ui/icons";
// import { useSyncContextOptional } from "../../providers/sync-provider";
import { SearchCombobox } from "./search-combobox";

interface VaultHeaderProps {
	hasVaults: boolean;
	onNewItemClick: () => void;
}

export function VaultHeader({ hasVaults, onNewItemClick }: VaultHeaderProps) {
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
				New Item
			</Button>
		</header>
	);
}
