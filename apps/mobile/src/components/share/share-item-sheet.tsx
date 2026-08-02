/**
 * Share Item Sheet
 * Bottom sheet modal for configuring and creating share links on mobile
 */

import {
	SHARE_EXPIRATION_OPTIONS,
	type ShareExpirationOption,
	useCreateShare,
} from "@bittery/core/hooks";
import type { DecryptedItem } from "@bittery/shared/types";
import * as Clipboard from "expo-clipboard";
import { Button, ControlField, Label, Switch, useToast } from "heroui-native";
import {
	Check,
	Copy,
	Link,
	Loader2,
	Share2,
	TriangleAlert,
	X,
} from "lucide-react-native";
import { useState } from "react";
import {
	Modal,
	Pressable,
	Share,
	Text,
	TouchableOpacity,
	View,
} from "react-native";
import { withUniwind } from "uniwind";

import { useI18n } from "@/providers/i18n-provider";

const StyledCheck = withUniwind(Check);
const StyledCopy = withUniwind(Copy);
const StyledLink = withUniwind(Link);
const StyledLoader2 = withUniwind(Loader2);
const StyledShare2 = withUniwind(Share2);
const StyledTriangleAlert = withUniwind(TriangleAlert);
const StyledX = withUniwind(X);

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
				description: error instanceof Error ? error.message : "Unknown error",
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

	return (
		<Modal
			visible={visible}
			transparent
			animationType="slide"
			onRequestClose={handleClose}
		>
			<View className="flex-1 justify-end bg-black/50">
				<Pressable className="flex-1" onPress={handleClose} />
				<View className="rounded-t-2xl bg-background px-4 pt-4 pb-8">
					{showCloseConfirm ? (
						<View>
							<View className="mb-2 flex-row items-center gap-2">
								<StyledTriangleAlert size={20} className="text-warning" />
								<Text className="font-semibold text-foreground text-lg">
									{m.mob_share_close_confirm_title()}
								</Text>
							</View>
							<Text className="mb-4 text-muted text-sm">
								{m.mob_share_close_confirm_description()}
							</Text>
							<View className="flex-row gap-3">
								<Button
									variant="secondary"
									className="flex-1"
									onPress={() => setShowCloseConfirm(false)}
								>
									<Button.Label>
										{m.mob_share_close_confirm_cancel()}
									</Button.Label>
								</Button>
								<Button
									variant="danger"
									className="flex-1"
									onPress={closeAndReset}
								>
									<Button.Label>
										{m.mob_share_close_confirm_confirm()}
									</Button.Label>
								</Button>
							</View>
						</View>
					) : (
						<>
							{/* Header */}
							<View className="mb-4 flex-row items-center justify-between">
								<Text className="font-semibold text-foreground text-lg">
									{m.mob_share_title()}
								</Text>
								<TouchableOpacity
									onPress={handleClose}
									disabled={createShare.isPending}
								>
									<StyledX size={24} className="text-muted" />
								</TouchableOpacity>
							</View>

							<Text className="mb-4 text-muted text-sm">
								{m.mob_share_description({ title: item.title })}
							</Text>

							{shareUrl && (
								<View className="mb-4 rounded-xl border border-border bg-surface-secondary p-3">
									<View className="mb-2 flex-row items-center gap-2">
										<StyledLink size={16} className="text-success" />
										<Text className="font-medium text-foreground text-sm">
											{m.mob_share_link_ready_label()}
										</Text>
									</View>
									<Text
										className="font-mono text-muted text-xs"
										numberOfLines={2}
										selectable
									>
										{shareUrl}
									</Text>
									<View className="mt-3 flex-row gap-2">
										<Button
											variant="secondary"
											className="flex-1"
											onPress={handleCopyLink}
										>
											{hasCopiedLink ? (
												<StyledCheck size={16} className="text-success" />
											) : (
												<StyledCopy size={16} className="text-foreground" />
											)}
											<Button.Label>{m.mob_share_copy_link()}</Button.Label>
										</Button>
										<Button
											variant="secondary"
											className="flex-1"
											onPress={() => openNativeShare(shareUrl)}
										>
											<StyledShare2 size={16} className="text-foreground" />
											<Button.Label>{m.mob_share_share_again()}</Button.Label>
										</Button>
									</View>
								</View>
							)}

							{/* Expiration Selection */}
							<View className="mb-4">
								<Text className="mb-2 font-medium text-foreground text-sm">
									{m.mob_share_expires_label()}
								</Text>
								<View className="flex-row flex-wrap gap-2">
									{SHARE_EXPIRATION_OPTIONS.map((option) => (
										<Button
											key={option}
											variant={expiresIn === option ? "primary" : "secondary"}
											size="sm"
											onPress={() => setExpiresIn(option)}
										>
											<Button.Label>{expirationLabels[option]}</Button.Label>
										</Button>
									))}
								</View>
							</View>

							{/* One-time use toggle */}
							<ControlField
								isSelected={isOneTimeUse}
								onSelectedChange={setIsOneTimeUse}
								className="mb-4 rounded-lg bg-card py-3"
							>
								<View className="flex-1">
									<Label>{m.mob_share_one_time_use()}</Label>
									<Text className="text-muted text-xs">
										{m.mob_share_one_time_use_description()}
									</Text>
								</View>
								<ControlField.Indicator>
									<Switch />
								</ControlField.Indicator>
							</ControlField>

							{/* Security notice */}
							<View className="mb-4 flex-row items-start rounded-lg bg-warning-soft p-3">
								<StyledLink size={16} className="mt-0.5 mr-2 text-warning" />
								<View className="flex-1">
									<Text className="text-warning-soft-foreground text-xs">
										{m.mob_share_security_notice()}
									</Text>
									<Text className="mt-1 text-warning-soft-foreground text-xs">
										{m.mob_share_copy_once_notice()}
									</Text>
								</View>
							</View>

							{/* Actions */}
							<View className="flex-row gap-3">
								<Button
									variant="secondary"
									className="flex-1"
									onPress={handleClose}
									isDisabled={createShare.isPending}
								>
									<Button.Label>{m.mob_share_cancel()}</Button.Label>
								</Button>
								<Button
									variant="primary"
									className="flex-1"
									onPress={handleCreateAndShare}
									isDisabled={createShare.isPending}
								>
									{createShare.isPending ? (
										<>
											<StyledLoader2
												size={18}
												className="animate-spin text-primary-foreground"
											/>
											<Button.Label>{m.mob_share_creating()}</Button.Label>
										</>
									) : (
										<>
											<StyledShare2
												size={18}
												className="text-primary-foreground"
											/>
											<Button.Label>{m.mob_share_create_button()}</Button.Label>
										</>
									)}
								</Button>
							</View>
						</>
					)}
				</View>
			</View>
		</Modal>
	);
}
