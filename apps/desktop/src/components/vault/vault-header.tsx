import { Button } from "@bittery/ui";
import { PlusIcon } from "lucide-react";
import { AccountSwitcher } from "../account-switcher";
import { SearchCombobox } from "./search-combobox";

interface VaultHeaderProps {
	hasVaults: boolean;
	onNewItemClick: () => void;
}

export function VaultHeader({ hasVaults, onNewItemClick }: VaultHeaderProps) {
	return (
		<header className="flex items-center space-x-2 border-b px-2 py-2">
			<AccountSwitcher />
			<div className="flex flex-1 items-center space-x-6 pl-2">
				<div className="flex-1">
					<SearchCombobox />
				</div>
				<Button onClick={onNewItemClick} disabled={!hasVaults}>
					<PlusIcon />
					New Item
				</Button>
			</div>
		</header>
	);
}
