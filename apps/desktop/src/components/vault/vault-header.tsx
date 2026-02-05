import { Button } from "@bittery/ui";
import { PlusIcon } from "lucide-react";
import { SearchCombobox } from "./search-combobox";

interface VaultHeaderProps {
	hasVaults: boolean;
	onNewItemClick: () => void;
}

export function VaultHeader({ hasVaults, onNewItemClick }: VaultHeaderProps) {
	return (
		<header className="flex items-center gap-4 border-b px-4 py-2.5" data-tauri-drag-region>
			<div className="flex-1">
				<SearchCombobox />
			</div>
			<Button onClick={onNewItemClick} disabled={!hasVaults}>
				<PlusIcon />
				New Item
			</Button>
		</header>
	);
}
