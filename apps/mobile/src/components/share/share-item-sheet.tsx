/**
 * Share Item Sheet
 * Bottom sheet modal for configuring and creating share links on mobile
 */

import { useCreateShare } from "@bittery/core/hooks";
import {
	SHARE_EXPIRATION_OPTIONS,
	type ShareExpirationOption,
} from "@bittery/core/services/share-service";
import type { DecryptedItem } from "@bittery/shared/types";
import * as Clipboard from "expo-clipboard";
import {
	ControlField,
	PressableFeedback,
	Switch,
	useToast,
} from "heroui-native";
import { useState } from "react";
import { ScrollView, Share, Text, View } from "react-native";
import {
	BrandButton,
	ChipRail,
	IconCheck,
	IconCopy,
	IconLink,
	IconShare,
	IconTriangleAlert,
	iconSize,
	ListCard,
	SectionLabel,
} from "@/components/ui";
import { useI18n } from "@/providers/i18n-provider";
import { SheetModal } from "../sheet-modal";

interface ShareItemSheetProps {
	item: DecryptedItem;
	visible: boolean;
	onClose: () => void;
}

export function ShareItemSheet({
	item,
	visible,
	onClose,
}: ShareItemSheetProps) {
	const { m } = useI18n();
	const [expiresIn, setExpiresIn] = useState<ShareExpirationOption>("7days");
	const [isOneTimeUse, setIsOneTimeUse] = useState(false);
	const [shareUrl, setShareUrl] = useState<string | null>(null);
	const [hasSharedLink, setHasSharedLink] = useState(false);
	const [hasCopiedLink, setHasCopiedLink] = useState(false);
	const [showCloseConfirm, setShowCloseConfirm] = useState(false);

	const createShare = useCreateShare();
	const { toast } = useToast();

	const expirationLabels: Record<ShareExpirationOption, string> = {
		"1hour": m.mob_share_expiry_1hour(),
		"1day": m.mob_share_expiry_1day(),
		"7days": m.mob_share_expiry_7days(),
		"14days": m.mob_share_expiry_14days(),
		"30days": m.mob_share_expiry_30days(),
	};

	const closeAndReset = () => {
		setShareUrl(null);
		setHasSharedLink(false);
		setHasCopiedLink(false);
		setShowCloseConfirm(false);
		onClose();
	};

	const openNativeShare = async (url: string) => {
		try {
			const shareResult = await Share.share({
				message: url,
				title: `${m.mob_share_title()}: ${item.title}`,
			});

			if (shareResult.action === Share.sharedAction) {
				setHasSharedLink(true);
				toast.show({
					variant: "accent",
					label: m.mob_share_toast_shared(),
					description: m.mob_share_toast_shared_description(),
					placement: "bottom",
				});
				closeAndReset();
			}
		} catch {
			// A dismissed or failed native sheet is recoverable: the link-ready
			// state stays on screen so the key is never silently lost.
		}
	};

	const handleCreateAndShare = async () => {
		let createdUrl: string;
		try {
			const result = await createShare.mutateAsync({
				item,
				accessMode: "anyone",
				expiresIn,
				isOneTimeUse,
			});
			createdUrl = result.shareUrl;
		} catch (error) {
			toast.show({
				variant: "danger",
				label: m.mob_share_toast_failed(),
				description:
					error instanceof Error ? error.message : m.mob_detail_error_unknown(),
				placement: "bottom",
			});
			return;
		}

		setShareUrl(createdUrl);
		setHasSharedLink(false);
		setHasCopiedLink(false);

		await openNativeShare(createdUrl);
	};

	const handleCopyLink = async () => {
		if (!shareUrl) return;

		// Unlike a password, a share link must survive long enough to be pasted
		// somewhere, so the clipboard is deliberately never auto-cleared here.
		await Clipboard.setStringAsync(shareUrl);
		setHasCopiedLink(true);
		toast.show({
			variant: "success",
			label: m.mob_share_toast_link_copied(),
			placement: "bottom",
		});
	};

	// The share key lives only in this URL — an unshared, uncopied link is lost
	// the moment the sheet unmounts.
	const isLinkAtRisk = shareUrl !== null && !hasSharedLink && !hasCopiedLink;

	const handleClose = () => {
		if (createShare.isPending) return;

		if (isLinkAtRisk) {
			setShowCloseConfirm(true);
			return;
		}

		closeAndReset();
	};

	if (showCloseConfirm) {
		return (
			<SheetModal
				visible={visible}
				onClose={() => setShowCloseConfirm(false)}
				icon={IconTriangleAlert}
				title={m.mob_share_close_confirm_title()}
				description={m.mob_share_close_confirm_description()}
			>
				<View className="flex-row gap-3 px-4 pt-2">
					<PressableFeedback
						onPress={() => setShowCloseConfirm(false)}
						accessibilityRole="button"
						accessibilityLabel={m.mob_share_close_confirm_cancel()}
						className="h-11 flex-1 items-center justify-center rounded-xl border border-border bg-surface"
					>
						<PressableFeedback.Highlight />
						<Text className="font-medium text-base text-foreground">
							{m.mob_share_close_confirm_cancel()}
						</Text>
					</PressableFeedback>
					<PressableFeedback
						onPress={closeAndReset}
						accessibilityRole="button"
						accessibilityLabel={m.mob_share_close_confirm_confirm()}
						className="h-11 flex-1 items-center justify-center rounded-xl bg-danger-soft"
					>
						<PressableFeedback.Highlight />
						<Text className="font-medium text-base text-danger">
							{m.mob_share_close_confirm_confirm()}
						</Text>
					</PressableFeedback>
				</View>
			</SheetModal>
		);
	}

	return (
		<SheetModal
			visible={visible}
			onClose={handleClose}
			isBusy={createShare.isPending}
			icon={IconShare}
			title={m.mob_share_title()}
			description={m.mob_share_description({ title: item.title })}
		>
			<ScrollView
				contentContainerClassName="gap-5 pb-4"
				keyboardShouldPersistTaps="handled"
			>
				{shareUrl ? (
					<View className="px-4">
						<View className="rounded-2xl border border-success/25 bg-success-soft p-4">
							<View className="flex-row items-center gap-2">
								<IconLink size={iconSize.chip} className="text-success" />
								<Text className="font-medium text-sm text-success-soft-foreground">
									{m.mob_share_link_ready_label()}
								</Text>
							</View>
							<Text
								className="mt-2 font-mono text-muted text-xs"
								numberOfLines={2}
								selectable
							>
								{shareUrl}
							</Text>
							<View className="mt-3 flex-row gap-2">
								<PressableFeedback
									onPress={handleCopyLink}
									accessibilityRole="button"
									accessibilityLabel={m.mob_share_copy_link()}
									className="h-11 flex-1 flex-row items-center justify-center gap-2 rounded-xl border border-border bg-surface"
								>
									<PressableFeedback.Highlight />
									{hasCopiedLink ? (
										<IconCheck size={iconSize.chip} className="text-success" />
									) : (
										<IconCopy
											size={iconSize.chip}
											className="text-foreground"
										/>
									)}
									<Text className="font-medium text-foreground text-sm">
										{m.mob_share_copy_link()}
									</Text>
								</PressableFeedback>
								<PressableFeedback
									onPress={() => openNativeShare(shareUrl)}
									accessibilityRole="button"
									accessibilityLabel={m.mob_share_share_again()}
									className="h-11 flex-1 flex-row items-center justify-center gap-2 rounded-xl border border-border bg-surface"
								>
									<PressableFeedback.Highlight />
									<IconShare size={iconSize.chip} className="text-foreground" />
									<Text className="font-medium text-foreground text-sm">
										{m.mob_share_share_again()}
									</Text>
								</PressableFeedback>
							</View>
						</View>
					</View>
				) : null}

				<View>
					<View className="px-4">
						<SectionLabel>{m.mob_share_expires_label()}</SectionLabel>
					</View>
					<ChipRail
						chips={SHARE_EXPIRATION_OPTIONS.map((option) => ({
							value: option,
							label: expirationLabels[option],
						}))}
						value={expiresIn}
						onChange={setExpiresIn}
					/>
				</View>

				<View className="px-4">
					<ListCard>
						<ControlField
							isSelected={isOneTimeUse}
							onSelectedChange={setIsOneTimeUse}
							className="px-4 py-3"
						>
							<View className="min-w-0 flex-1">
								<Text className="font-medium text-base text-foreground">
									{m.mob_share_one_time_use()}
								</Text>
								<Text className="mt-0.5 text-muted text-sm">
									{m.mob_share_one_time_use_description()}
								</Text>
							</View>
							<ControlField.Indicator>
								<Switch />
							</ControlField.Indicator>
						</ControlField>
					</ListCard>
				</View>

				<View className="px-4">
					<View className="flex-row items-start gap-2.5 rounded-2xl bg-warning-soft p-3.5">
						<IconTriangleAlert
							size={iconSize.chip}
							className="mt-0.5 text-warning"
						/>
						<View className="min-w-0 flex-1">
							<Text className="text-warning-soft-foreground text-xs">
								{m.mob_share_security_notice()}
							</Text>
							<Text className="mt-1.5 text-warning-soft-foreground text-xs">
								{m.mob_share_copy_once_notice()}
							</Text>
						</View>
					</View>
				</View>

				<View className="flex-row gap-3 px-4">
					<PressableFeedback
						onPress={handleClose}
						isDisabled={createShare.isPending}
						accessibilityRole="button"
						accessibilityLabel={m.mob_share_cancel()}
						className="h-11 flex-1 items-center justify-center rounded-xl border border-border bg-surface"
					>
						<PressableFeedback.Highlight />
						<Text className="font-medium text-base text-foreground">
							{m.mob_share_cancel()}
						</Text>
					</PressableFeedback>
					<BrandButton
						label={
							createShare.isPending
								? m.mob_share_creating()
								: m.mob_share_create_button()
						}
						onPress={handleCreateAndShare}
						isLoading={createShare.isPending}
						fullWidth={false}
						leading={
							<IconShare
								size={iconSize.chip}
								className="text-accent-foreground"
							/>
						}
						className="h-11 flex-1"
					/>
				</View>
			</ScrollView>
		</SheetModal>
	);
}
