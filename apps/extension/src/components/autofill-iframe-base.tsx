import type { DecryptedItemWithContext } from "@bittery/shared/types";
import { Button } from "@bittery/ui";
import { IconLock, IconMonitor, IconTriangleAlert } from "@bittery/ui/icons";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getIframeNonceFromLocation } from "@/lib/iframe-nonce";
import { useI18n } from "@/providers/i18n-provider";
import {
	OverlayFooter,
	OverlayKbd,
	OverlayList,
	OverlayListHeader,
	OverlayNotice,
	OverlayRow,
	OverlaySurface,
	OverlayViewport,
} from "./overlay/overlay-surface";
import { useOverlayHeight } from "./overlay/use-overlay-height";

export interface AutofillIframeConfig {
	/** Message type for receiving items (e.g. "AUTOFILL_ITEMS") */
	itemsMessageType: string;
	/** Message type for filter queries (e.g. "FILTER_ITEMS") */
	filterMessageType: string;
	/** Message type to signal iframe readiness (e.g. "IFRAME_READY") */
	readyMessageType: string;
	/** Message type for item selection (e.g. "AUTOFILL_SELECT") */
	selectMessageType: string;
	/** Filter function for search queries */
	filterFn: (
		items: DecryptedItemWithContext[],
		query: string,
	) => DecryptedItemWithContext[];
	/** Optional preprocessing of items before storing (e.g. filter to category) */
	preprocessItems?: (
		items: DecryptedItemWithContext[],
	) => DecryptedItemWithContext[];
	/** Default field type for the iframe */
	defaultFieldType: string;
	/** Icon shown in the empty state */
	emptyIcon: ReactNode;
	/** Text shown when no items exist */
	emptyText: string;
	/** Text shown in the unlock required state */
	unlockText: string;
	/** Singular noun for items (e.g. "login") */
	itemNounSingular: string;
	/** Plural noun for items (e.g. "logins") */
	itemNounPlural: string;
	/** Leading visual for a row (favicon, card brand, avatar). */
	renderLeading: (item: DecryptedItemWithContext) => ReactNode;
	/** Row title. */
	renderTitle: (item: DecryptedItemWithContext) => ReactNode;
	/** Row subtitle. */
	renderSubtitle?: (item: DecryptedItemWithContext) => ReactNode;
	/** Trailing metadata for a row (e.g. a card-brand chip). */
	renderTrailing?: (item: DecryptedItemWithContext) => ReactNode;
}

type AuthState = "ready" | "unlock" | "reauth" | "desktop-unlock";

export function AutofillIframeBase({
	config,
}: {
	config: AutofillIframeConfig;
}) {
	const { m } = useI18n();
	const nonce = getIframeNonceFromLocation() ?? "";
	const [allItems, setAllItems] = useState<DecryptedItemWithContext[]>([]);
	const [filteredItems, setFilteredItems] = useState<
		DecryptedItemWithContext[]
	>([]);
	const [filterQuery, setFilterQuery] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [authState, setAuthState] = useState<AuthState>("ready");
	const allItemsRef = useRef<DecryptedItemWithContext[]>([]);

	useOverlayHeight(nonce);

	// Listen for items from parent — uses allItemsRef to avoid infinite loop
	// (do NOT put allItems in the dependency array)
	useEffect(() => {
		const reset = () => {
			allItemsRef.current = [];
			setAllItems([]);
			setFilteredItems([]);
			setFilterQuery("");
			setSelectedIndex(0);
		};

		const handleMessage = (event: MessageEvent) => {
			if (event.data?.nonce !== nonce) {
				return;
			}

			if (event.data.type === config.itemsMessageType) {
				const items = config.preprocessItems
					? config.preprocessItems(event.data.items || [])
					: event.data.items || [];
				allItemsRef.current = items;
				setAllItems(items);
				setFilteredItems(items);
				setFilterQuery("");
				setSelectedIndex(0);
				setAuthState("ready");
			} else if (event.data.type === "NEEDS_UNLOCK") {
				setAuthState("unlock");
				reset();
			} else if (event.data.type === "NEEDS_REAUTH") {
				setAuthState("reauth");
				reset();
			} else if (event.data.type === "NEEDS_DESKTOP_UNLOCK") {
				setAuthState("desktop-unlock");
				reset();
			} else if (event.data.type === "OVERLAY_CLEAR") {
				// The overlay was hidden. Drop the decrypted items rather than keeping
				// them alive in a pooled frame.
				setAuthState("ready");
				reset();
			} else if (event.data.type === config.filterMessageType) {
				const query = event.data.query || "";
				setFilterQuery(query);
				setFilteredItems(config.filterFn(allItemsRef.current, query));
				setSelectedIndex(0);
			}
		};

		window.addEventListener("message", handleMessage);
		window.parent.postMessage({ type: config.readyMessageType, nonce }, "*");

		return () => window.removeEventListener("message", handleMessage);
	}, [
		config.filterFn,
		config.filterMessageType,
		config.itemsMessageType,
		nonce,
		config.preprocessItems,
		config.readyMessageType,
	]);

	const handleSelect = useCallback(
		(item: DecryptedItemWithContext) => {
			window.parent.postMessage(
				{ type: config.selectMessageType, item, nonce },
				"*",
			);
		},
		[config.selectMessageType, nonce],
	);

	const handleOpenPopup = useCallback(() => {
		window.parent.postMessage({ type: "OPEN_POPUP", nonce }, "*");
	}, [nonce]);

	const handleUnlockDesktop = useCallback(() => {
		window.parent.postMessage({ type: "UNLOCK_DESKTOP", nonce }, "*");
	}, [nonce]);

	// Keyboard navigation via native keydown and forwarded KEYBOARD_NAV messages
	useEffect(() => {
		const navigate = (key: string) => {
			if (filteredItems.length === 0) return;
			switch (key) {
				case "ArrowDown":
					setSelectedIndex((prev) => (prev + 1) % filteredItems.length);
					break;
				case "ArrowUp":
					setSelectedIndex(
						(prev) => (prev - 1 + filteredItems.length) % filteredItems.length,
					);
					break;
				case "Enter":
					if (filteredItems[selectedIndex]) {
						handleSelect(filteredItems[selectedIndex]);
					}
					break;
			}
		};

		const handleKeyDown = (event: KeyboardEvent) => {
			if (
				event.key === "ArrowDown" ||
				event.key === "ArrowUp" ||
				event.key === "Enter"
			) {
				event.preventDefault();
				navigate(event.key);
			}
		};

		const handleMessage = (event: MessageEvent) => {
			if (event.data?.nonce !== nonce) {
				return;
			}
			if (event.data.type === "KEYBOARD_NAV") {
				navigate(event.data.key);
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		window.addEventListener("message", handleMessage);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			window.removeEventListener("message", handleMessage);
		};
	}, [filteredItems, selectedIndex, handleSelect, nonce]);

	if (authState !== "ready") {
		// The desktop-locked state deliberately does not offer the popup: the popup
		// can't unlock a locked desktop app, it can only forward the same request.
		const notice = {
			unlock: {
				icon: <IconLock className="size-3.5" />,
				title: m.ext_autofill_unlock_required(),
				description: config.unlockText,
				actionLabel: m.ext_autofill_open_bittery(),
				onAction: handleOpenPopup,
			},
			reauth: {
				icon: <IconTriangleAlert className="size-3.5" />,
				title: m.ext_autofill_reauth_required(),
				description: m.ext_autofill_reauth_description(),
				actionLabel: m.ext_autofill_open_bittery(),
				onAction: handleOpenPopup,
			},
			"desktop-unlock": {
				icon: <IconMonitor className="size-3.5" />,
				title: m.ext_autofill_desktop_locked_title(),
				description: m.ext_autofill_desktop_locked_description(),
				actionLabel: m.ext_autofill_unlock_desktop(),
				onAction: handleUnlockDesktop,
			},
		}[authState];

		return (
			<OverlayViewport>
				<OverlaySurface>
					<OverlayNotice
						tone="primary"
						icon={notice.icon}
						title={notice.title}
						description={notice.description}
						action={
							<Button
								size="sm"
								className="h-7 w-full"
								onClick={notice.onAction}
							>
								{notice.actionLabel}
							</Button>
						}
					/>
				</OverlaySurface>
			</OverlayViewport>
		);
	}

	if (allItems.length === 0) {
		return (
			<OverlayViewport>
				<OverlaySurface>
					<OverlayNotice icon={config.emptyIcon} title={config.emptyText} />
				</OverlaySurface>
			</OverlayViewport>
		);
	}

	if (filteredItems.length === 0) {
		return (
			<OverlayViewport>
				<OverlaySurface>
					<OverlayNotice
						icon={config.emptyIcon}
						title={m.ext_autofill_no_matches({ query: filterQuery })}
						description={`${allItems.length} ${
							allItems.length === 1
								? config.itemNounSingular
								: config.itemNounPlural
						} ${m.ext_autofill_available()}`}
					/>
				</OverlaySurface>
			</OverlayViewport>
		);
	}

	const isFiltered =
		filterQuery.length > 0 && filteredItems.length < allItems.length;

	return (
		<OverlayViewport>
			<OverlaySurface>
				<OverlayListHeader
					label={
						allItems.length === 1
							? config.itemNounSingular
							: config.itemNounPlural
					}
					meta={
						isFiltered
							? m.ext_autofill_showing({
									shown: String(filteredItems.length),
									total: String(allItems.length),
								})
							: String(allItems.length)
					}
				/>

				<OverlayList>
					{filteredItems.map((item, index) => (
						<OverlayRow
							key={item.id}
							selected={index === selectedIndex}
							rowRef={
								index === selectedIndex
									? (el) => el?.scrollIntoView({ block: "nearest" })
									: undefined
							}
							leading={config.renderLeading(item)}
							title={config.renderTitle(item)}
							subtitle={config.renderSubtitle?.(item)}
							trailing={config.renderTrailing?.(item)}
							onSelect={() => handleSelect(item)}
							onHover={() => setSelectedIndex(index)}
						/>
					))}
				</OverlayList>

				<OverlayFooter>
					<OverlayKbd>↑↓</OverlayKbd>
					<span>{m.ext_autofill_hint_navigate()}</span>
					<span aria-hidden className="opacity-40">
						·
					</span>
					<OverlayKbd>↵</OverlayKbd>
					<span>{m.ext_autofill_hint_fill()}</span>
					<span aria-hidden className="opacity-40">
						·
					</span>
					<OverlayKbd>esc</OverlayKbd>
					<span>{m.ext_autofill_hint_close()}</span>
				</OverlayFooter>
			</OverlaySurface>
		</OverlayViewport>
	);
}
