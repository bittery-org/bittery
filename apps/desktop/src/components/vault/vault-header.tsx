import { Button } from "@bittery/ui";
import { IconPlusOutlineDuo18 } from "@bittery/ui/icons";
import { SearchCombobox } from "./search-combobox";

interface VaultHeaderProps {
	hasVaults: boolean;
	onNewItemClick: () => void;
}

export function VaultHeader({ hasVaults, onNewItemClick }: VaultHeaderProps) {
	return (
		<header
			className="flex items-center gap-4 border-b px-4 py-2.5"
			data-tauri-drag-region
		>
			<div className="flex-1">
				<SearchCombobox />
			</div>
			<Button onClick={onNewItemClick} disabled={!hasVaults}>
				<IconPlusOutlineDuo18 />
				New Item
			</Button>
		</header>
	);
}
