import { useI18n } from "@bittery/i18n/react";
import { IconHistory } from "@bittery/ui/icons";
import type { ComponentProps, ReactNode } from "react";
import { useState } from "react";
import { Button } from "../button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "../dialog";
import { ShareLinksList } from "./share-links-list";

interface ShareHistoryDialogProps {
	links: ComponentProps<typeof ShareLinksList>["links"];
	isLoading: boolean;
	onRevoke: ComponentProps<typeof ShareLinksList>["onRevoke"];
	onLoadAccessLogs: ComponentProps<typeof ShareLinksList>["onLoadAccessLogs"];
	trigger?: ReactNode;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}

export function ShareHistoryDialog({
	links,
	isLoading,
	onRevoke,
	onLoadAccessLogs,
	trigger,
	open: controlledOpen,
	onOpenChange: controlledOnOpenChange,
}: ShareHistoryDialogProps) {
	const { m } = useI18n();
	const [internalOpen, setInternalOpen] = useState(false);
	const isControlled = controlledOpen !== undefined;
	const open = isControlled ? controlledOpen : internalOpen;
	const setOpen = isControlled
		? (v: boolean) => controlledOnOpenChange?.(v)
		: setInternalOpen;

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			{!isControlled && (
				<DialogTrigger asChild>
					{trigger || (
						<Button size="sm" variant="outline">
							<IconHistory className="mr-2 size-4" />
							{m.sharing_history_dialog_trigger()}
						</Button>
					)}
				</DialogTrigger>
			)}
			<DialogContent
				className="flex max-h-[80vh] max-w-2xl flex-col overflow-hidden"
				data-testid="share-history-dialog"
			>
				<DialogHeader>
					<DialogTitle>{m.sharing_history_dialog_title()}</DialogTitle>
					<DialogDescription>
						{m.sharing_history_dialog_description()}
					</DialogDescription>
				</DialogHeader>
				<div className="flex-1 overflow-y-auto pr-2">
					<ShareLinksList
						links={links}
						isLoading={isLoading}
						onRevoke={onRevoke}
						onLoadAccessLogs={onLoadAccessLogs}
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}
