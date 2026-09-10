import { Button, Skeleton } from "@bittery/ui";
import {
	IconLock as Lock,
	IconTriangleAlert as TriangleAlert,
} from "@bittery/ui/icons";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { RuntimeItemsState } from "@/lib/runtime-items";
import { useI18n } from "@/providers/i18n-provider";

/**
 * What stands in for the Item list when the Runtime has no Items to show.
 *
 * A locked vault has to look locked. Before this, every state that was not `ready` fell
 * through to the empty-list copy, so a restart looked exactly like a vault someone had
 * emptied. The Rust `message` never reaches this component: it is diagnostic text and is
 * not localized, so the UI branches on the code and renders the catalogue.
 */
export function ItemListState({ state }: { state: RuntimeItemsState }) {
	const { m } = useI18n();
	const navigate = useNavigate();

	if (state === "loading") {
		return (
			<div className="space-y-2 p-2">
				{[1, 2, 3, 4, 5].map((row) => (
					<Skeleton key={row} className="h-16" />
				))}
			</div>
		);
	}

	if (state === "unavailable") {
		return (
			<Notice
				icon={<TriangleAlert className="size-6 text-muted-foreground" />}
				title={m.vaults_unavailable_title()}
				description={m.vaults_unavailable_description()}
			/>
		);
	}

	// `missing` is a pointer at an Account this Device no longer has, so the way back is the
	// same one a signed-out Account takes: the full ceremony.
	const locked = state === "locked";
	return (
		<Notice
			icon={<Lock className="size-6 text-muted-foreground" />}
			title={locked ? m.vaults_locked_title() : m.vaults_signed_out_title()}
			description={
				locked
					? m.vaults_locked_description()
					: m.vaults_signed_out_description()
			}
			action={
				<Button
					size="sm"
					className="mt-4"
					onClick={() => navigate({ to: "/login" })}
					data-testid="vault-unlock-button"
				>
					{locked
						? m.vaults_locked_action_unlock()
						: m.vaults_signed_out_action_sign_in()}
				</Button>
			}
		/>
	);
}

function Notice({
	icon,
	title,
	description,
	action,
}: {
	icon: ReactNode;
	title: string;
	description: string;
	action?: ReactNode;
}) {
	return (
		<div
			className="flex min-h-0 flex-1 flex-col items-center justify-center p-6 text-center"
			data-testid="vault-items-state"
		>
			<div className="mb-4 inline-flex rounded-full border bg-foreground/3 p-4">
				{icon}
			</div>
			<h3 className="mb-1 font-medium text-sm">{title}</h3>
			<p className="max-w-sm text-muted-foreground text-sm">{description}</p>
			{action}
		</div>
	);
}
