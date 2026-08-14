import type { ReactNode } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "./alert-dialog";

/**
 * The "are you sure?" shape, once.
 *
 * Ten files across web and desktop hand-assembled the same
 * AlertDialog → Content → Header(Title, Description) → Footer(Cancel, Action)
 * tree, and they had drifted in exactly the ways an unshared pattern drifts:
 * some disabled Cancel while the action was in flight and some did not, and the
 * destructive styling was pasted in as a raw className string at each site
 * rather than being a property of the dialog.
 *
 * Deliberately narrow. It takes labels and callbacks, owns no state and no data
 * fetching, and does not try to model every dialog in the app — a confirmation
 * that needs its own body (a typed-confirmation field, a list of consequences)
 * passes it as `children`, and one that must stay open while a mutation runs
 * still wants a hand-written footer, because `AlertDialogAction` closes on
 * click. That is not a gap to close later; it is where this component stops.
 */
export interface ConfirmDialogProps {
	/**
	 * Both optional so a row-level "remove this member" dialog can stay
	 * uncontrolled and let its own trigger open it, which is how two of the call
	 * sites already worked. Radix reads an undefined `open` as uncontrolled.
	 */
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	/** Renders inside `AlertDialogTrigger`. Omit for a controlled dialog. */
	trigger?: ReactNode;
	title: ReactNode;
	description: ReactNode;
	/** Extra body between the header and the footer — a confirmation field, say. */
	children?: ReactNode;
	cancelLabel: ReactNode;
	confirmLabel: ReactNode;
	onConfirm: () => void;
	/**
	 * Blocks confirmation without hiding it — an in-flight mutation, or a
	 * typed-confirmation field that does not match yet. Also disables Cancel,
	 * so the dialog cannot be dismissed out from under a running action.
	 *
	 * This is the normalization, and it is a behaviour change at four of the
	 * adopting sites: leave-team, delete-team, team member removal and vault
	 * member removal all previously left Cancel live during the request, while
	 * delete-vault did not. Disabling is the safer of the two, because every one
	 * of those actions is mid-flight against the server when the dialog closes.
	 */
	busy?: boolean;
	/** Independent of `busy`: the action is invalid, but Cancel stays live. */
	confirmDisabled?: boolean;
	/** Paints the confirm action as destructive. */
	destructive?: boolean;
	testId?: string;
	cancelTestId?: string;
	confirmTestId?: string;
}

export function ConfirmDialog({
	open,
	onOpenChange,
	trigger,
	title,
	description,
	children,
	cancelLabel,
	confirmLabel,
	onConfirm,
	busy = false,
	confirmDisabled = false,
	destructive = false,
	testId,
	cancelTestId,
	confirmTestId,
}: ConfirmDialogProps) {
	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			{trigger ? (
				<AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
			) : null}
			<AlertDialogContent data-testid={testId}>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>{description}</AlertDialogDescription>
				</AlertDialogHeader>
				{children}
				<AlertDialogFooter>
					<AlertDialogCancel disabled={busy} data-testid={cancelTestId}>
						{cancelLabel}
					</AlertDialogCancel>
					<AlertDialogAction
						onClick={onConfirm}
						disabled={busy || confirmDisabled}
						variant={destructive ? "destructive" : "default"}
						data-testid={confirmTestId}
					>
						{confirmLabel}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
