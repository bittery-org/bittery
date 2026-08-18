/**
 * M3-C2 — shared item detail body for every "$itemId" route (`/vault/$id/$itemId`,
 * `/vault/all-items/$itemId`, `/vault/favorites/$itemId`, `/vault/tag/$tagName/$itemId`). Each
 * route file is just `<ItemDetailScreen itemId={...} onBack={...} />` — the vault a
 * cross-vault-list item lives in is not in any of those URLs, but `useItem` already resolves it
 * (`rawItem.vaultId`), so one component covers every entry point instead of four near-copies.
 *
 * The presentation is a port of `apps/mobile/src/components/item-details/*` (the React Native
 * app's detail screen) onto the WebView kit in `@/components/ui`: a brand-moment header, grouped
 * `ListCard` field sections, 44pt copy/reveal targets, and one overflow sheet instead of a row of
 * header icons. `@bittery/ui`'s desktop `ItemDetail` is deliberately no longer used — it is a
 * hover-driven, dense, mouse-shaped component.
 *
 * What still comes from `@bittery/ui`, because it is real shared logic rather than presentation:
 * `handleCopy` (clipboard + auto-clear + toast copy, see `clipboard-bridge.ts` for why that path
 * matters on Android) and `EditItemSheet`. The tag editor and the password history are local
 * sheets — desktop's are a Radix popover and a centred modal, neither of which survives a phone.
 */

import {
	useAvailableTags,
	useCreateItem,
	useDeleteItem,
	useItem,
	useItems,
	useToggleFavorite,
	useUpdateItem,
	useVaultInfo,
} from "@bittery/core/hooks";
import {
	detectCardBrand,
	formatCardNumber as formatCardNumberForBrand,
	getCardBrandDisplayName,
} from "@bittery/shared/credit-card";
import type { Address, PhoneNumber } from "@bittery/shared/identity";
import { formatAddress, formatPhoneNumber } from "@bittery/shared/identity";
import { generateTotp, type TotpResult } from "@bittery/shared/totp";
import type {
	CustomField,
	DecryptedItem,
	DecryptedItemData,
	ItemCategory,
	Passkey,
	TotpAlgorithm,
	TotpDigits,
} from "@bittery/shared/types";
import {
	EditItemSheet,
	getTagColorFromName,
	handleCopy,
	Skeleton,
	toast,
} from "@bittery/ui";
import {
	IconArrowLeftRight,
	IconCheck,
	IconCircleAlert,
	IconCopy,
	IconCreditCard,
	IconEllipsis,
	IconEye,
	IconEyeOff,
	IconGlobe,
	IconHistory,
	IconKey,
	IconMail,
	IconPasskey,
	IconPencil,
	IconPlus,
	IconSearch,
	IconShare,
	IconStar,
	IconTrash,
	IconTriangleAlert,
	IconUser,
	IconX,
} from "@bittery/ui/icons";
import { cn } from "@bittery/ui/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import {
	type ComponentType,
	type ReactNode,
	useCallback,
	useEffect,
	useState,
} from "react";
import { MobileScreen } from "@/components/mobile-screen";
import {
	BarButton,
	ConfirmSheet,
	EmptyState,
	iconClass,
	ListCard,
	MobileSheet,
	Pressable,
	SectionLabel,
	SheetAction,
	TextField,
} from "@/components/ui";
import { Favicon } from "@/components/vault/favicon";
import { ItemAttachments } from "@/components/vault/item-attachments";
import { MoveItemSheet } from "@/components/vault/move-item-sheet";
import { PasswordHistorySheet } from "@/components/vault/password-history-sheet";
import { ShareHistorySheet } from "@/components/vault/share-history-sheet";
import { ShareItemSheet } from "@/components/vault/share-item-sheet";
import { useI18n } from "@/providers/i18n-provider";

type Messages = ReturnType<typeof useI18n>["m"];

/** How long the copy action stays acknowledged before falling back to the copy glyph. */
const COPY_FEEDBACK_MS = 1600;

function getCategoryDisplayName(category: string, m: Messages) {
	switch (category) {
		case "secure-note":
			return m.vaults_detail_items_category_secure_note_title();
		case "credit-card":
			return m.vaults_detail_items_category_credit_card_title();
		case "identity":
			return m.vaults_detail_items_category_identity_title();
		case "totp":
			return m.vaults_detail_items_category_totp_title();
		default:
			return m.vaults_detail_items_category_login_title();
	}
}

// ---------------------------------------------------------------------------
// Field model
// ---------------------------------------------------------------------------

/**
 * One value on an item as the detail view shows it. Groups are built from arrays of these, so a
 * field with no value never reaches the card and the hairline dividers stay correct.
 */
interface FieldDefinition {
	/** Stable within its group; also keys the reveal state. */
	key: string;
	label: string;
	value: string | undefined;
	icon?: ComponentType<{ className?: string }>;
	/** Hides the value behind dots until the reveal action is used. */
	masked?: boolean;
	mono?: boolean;
	/** Lets the value wrap instead of truncating — notes and addresses. */
	multiline?: boolean;
	/** Small neutral chip after the label, e.g. a detected card brand. */
	badge?: string;
	/** Shown instead of the raw value once revealed, e.g. a grouped card number. */
	formattedValue?: string;
}

function maskValue(value: string, visibleChars = 4): string {
	if (value.length <= visibleChars) return "•".repeat(value.length);
	return "•".repeat(value.length - visibleChars) + value.slice(-visibleChars);
}

type CopyValue = (value: string, label: string) => Promise<void>;

// ---------------------------------------------------------------------------
// Row primitives
// ---------------------------------------------------------------------------

/** 44pt tap target for the reveal/copy affordances on a field row. */
function RowAction({
	icon: Icon,
	label,
	onPress,
	tone = "default",
	disabled,
}: {
	icon: ComponentType<{ className?: string }>;
	label: string;
	onPress: () => void;
	tone?: "default" | "success" | "danger";
	disabled?: boolean;
}) {
	return (
		<Pressable
			onClick={onPress}
			disabled={disabled}
			aria-label={label}
			className="flex size-11 shrink-0 items-center justify-center rounded-full"
		>
			<Icon
				className={cn(
					iconClass.row,
					tone === "success" && "text-success",
					tone === "danger" && "text-danger",
					tone === "default" && "text-muted-foreground",
				)}
			/>
		</Pressable>
	);
}

function FieldRow({
	field,
	onCopy,
	isRevealed,
	onToggleReveal,
}: {
	field: FieldDefinition;
	onCopy: CopyValue;
	isRevealed: boolean;
	onToggleReveal: () => void;
}) {
	const { m } = useI18n();
	const [hasCopied, setHasCopied] = useState(false);
	const value = field.value ?? "";
	const Icon = field.icon;
	const isHidden = Boolean(field.masked) && !isRevealed;
	const displayValue = isHidden
		? maskValue(value)
		: (field.formattedValue ?? value);

	const handleCopyValue = async () => {
		await onCopy(value, field.label);
		setHasCopied(true);
		// A plain timer in an event handler, not an effect — the acknowledgement is a
		// consequence of the tap, so it has no business re-running on render.
		setTimeout(() => setHasCopied(false), COPY_FEEDBACK_MS);
	};

	return (
		<div className="px-4 py-3">
			<div className="flex items-center gap-1.5">
				{Icon ? (
					<Icon
						className={cn(
							iconClass.chip,
							"shrink-0 text-muted-foreground opacity-70",
						)}
					/>
				) : null}
				<span className="truncate font-semibold text-2xs text-muted-foreground uppercase tracking-[0.06em]">
					{field.label}
				</span>
				{field.badge ? (
					<span className="shrink-0 rounded-lg bg-surface-tertiary px-1.5 py-0.5 font-medium text-2xs text-muted-foreground">
						{field.badge}
					</span>
				) : null}
			</div>
			<div className="mt-1 flex items-center gap-1">
				<span
					className={cn(
						"selectable min-w-0 flex-1 text-base text-foreground",
						field.mono && "font-mono",
						field.multiline && !isHidden
							? "whitespace-pre-wrap break-words"
							: "truncate",
					)}
				>
					{displayValue}
				</span>
				{field.masked ? (
					<RowAction
						icon={isRevealed ? IconEyeOff : IconEye}
						label={
							isRevealed
								? m.mob_a11y_hide_value({ label: field.label })
								: m.mob_a11y_reveal_value({ label: field.label })
						}
						onPress={onToggleReveal}
					/>
				) : null}
				<RowAction
					icon={hasCopied ? IconCheck : IconCopy}
					tone={hasCopied ? "success" : "default"}
					label={
						hasCopied
							? m.mob_a11y_copied()
							: m.mob_a11y_copy_value({ label: field.label })
					}
					onPress={() => void handleCopyValue()}
				/>
			</div>
		</div>
	);
}

/**
 * The grouped card every set of item values renders into. Empty fields are dropped before the
 * card is built so the hairline dividers never separate nothing from nothing.
 */
function FieldGroup({
	fields,
	onCopy,
	children,
}: {
	fields: ReadonlyArray<FieldDefinition>;
	onCopy: CopyValue;
	/** Extra rows appended inside the same card, e.g. a live TOTP block. */
	children?: ReactNode;
}) {
	const [revealedKeys, setRevealedKeys] = useState<Record<string, boolean>>({});
	const visibleFields = fields.filter((field) => Boolean(field.value));

	if (visibleFields.length === 0 && !children) return null;

	return (
		<ListCard>
			{visibleFields.map((field) => (
				<FieldRow
					key={field.key}
					field={field}
					onCopy={onCopy}
					isRevealed={Boolean(revealedKeys[field.key])}
					onToggleReveal={() =>
						setRevealedKeys((current) => ({
							...current,
							[field.key]: !current[field.key],
						}))
					}
				/>
			))}
			{children}
		</ListCard>
	);
}

/**
 * One labelled block of the detail scroll view. The spacing between sections comes from the
 * screen's gap, never from margins on the cards.
 */
function DetailSection({
	title,
	action,
	children,
}: {
	title?: string;
	/** Right-aligned control on the section label, e.g. "Edit". */
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div>
			{title ? <SectionLabel trailing={action}>{title}</SectionLabel> : null}
			{children}
		</div>
	);
}

// ---------------------------------------------------------------------------
// TOTP
// ---------------------------------------------------------------------------

/** Seconds left at which the ring escalates from primary to warning, then danger. */
const WARNING_THRESHOLD_SECONDS = 10;
const DANGER_THRESHOLD_SECONDS = 5;
const RING_SIZE = 40;
const RING_STROKE = 3;
const RING_RADIUS = RING_SIZE / 2 - RING_STROKE;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function CountdownRing({
	progress,
	remainingSeconds,
	toneClass,
}: {
	progress: number;
	remainingSeconds: number | null;
	toneClass: string;
}) {
	return (
		<div
			className="relative flex shrink-0 items-center justify-center"
			style={{ width: RING_SIZE, height: RING_SIZE }}
		>
			{/* Decorative: the seconds are also written out in the label below it. */}
			<svg
				aria-hidden="true"
				role="presentation"
				width={RING_SIZE}
				height={RING_SIZE}
				className="-rotate-90"
			>
				<circle
					cx={RING_SIZE / 2}
					cy={RING_SIZE / 2}
					r={RING_RADIUS}
					fill="none"
					strokeWidth={RING_STROKE}
					className="stroke-border"
				/>
				<circle
					cx={RING_SIZE / 2}
					cy={RING_SIZE / 2}
					r={RING_RADIUS}
					fill="none"
					strokeWidth={RING_STROKE}
					strokeLinecap="round"
					strokeDasharray={RING_CIRCUMFERENCE}
					strokeDashoffset={
						RING_CIRCUMFERENCE - (progress / 100) * RING_CIRCUMFERENCE
					}
					className={cn(
						"transition-[stroke-dashoffset] duration-500 ease-linear",
						toneClass,
					)}
				/>
			</svg>
			{remainingSeconds !== null ? (
				<span
					className={cn(
						"absolute font-medium font-mono text-2xs",
						toneClass.replace("stroke-", "text-"),
					)}
				>
					{remainingSeconds}
				</span>
			) : null}
		</div>
	);
}

/**
 * A live one-time code with its countdown ring.
 *
 * The 1s interval is the one sanctioned timer effect in this app: the code is a function of
 * wall-clock time, so nothing but a timer can derive it. Native's `TotpDisplay` uses
 * `useFocusEffect` for the same reason; a pushed WebView route is unmounted when it leaves, so
 * plain `useEffect` cleanup is the equivalent.
 *
 * The code comes from `@bittery/shared/totp` (Web Crypto), which is what `InlineTotpDisplay`
 * gives web and desktop, rather than from the crypto port. Both derive the same code; sharing
 * the helper keeps every web-tech client on one implementation and skips a wasm round trip on
 * a 1s timer.
 */
function TotpDisplay({
	totpSecret,
	totpAlgorithm = "SHA1",
	totpDigits = 6,
	totpPeriod = 30,
	label,
	onCopy,
}: {
	totpSecret: string;
	totpAlgorithm?: TotpAlgorithm;
	totpDigits?: TotpDigits;
	totpPeriod?: number;
	label?: string;
	onCopy: CopyValue;
}) {
	const { m } = useI18n();
	const [totpResult, setTotpResult] = useState<TotpResult | null>(null);
	const [hasCopied, setHasCopied] = useState(false);

	const generateCode = useCallback(async () => {
		try {
			setTotpResult(
				await generateTotp({
					secret: totpSecret,
					algorithm: totpAlgorithm,
					digits: totpDigits,
					period: totpPeriod,
				}),
			);
		} catch (error) {
			console.error("[item-detail] failed to generate TOTP code", error);
			setTotpResult(null);
		}
	}, [totpSecret, totpAlgorithm, totpDigits, totpPeriod]);

	useEffect(() => {
		void generateCode();
		const interval = setInterval(() => void generateCode(), 1000);
		return () => clearInterval(interval);
	}, [generateCode]);

	const remainingSeconds = totpResult?.remainingSeconds ?? null;
	const toneClass =
		remainingSeconds === null
			? "stroke-muted-foreground"
			: remainingSeconds <= DANGER_THRESHOLD_SECONDS
				? "stroke-danger"
				: remainingSeconds <= WARNING_THRESHOLD_SECONDS
					? "stroke-warning"
					: "stroke-primary";

	// Split down the middle, the way an authenticator app groups a code for reading aloud.
	const code = totpResult?.code;
	const formattedCode = code
		? `${code.slice(0, Math.floor(code.length / 2))} ${code.slice(Math.floor(code.length / 2))}`
		: "--- ---";

	const handleCopyCode = async () => {
		if (!code) return;
		await onCopy(code, m.mob_totp_display_label());
		setHasCopied(true);
		setTimeout(() => setHasCopied(false), COPY_FEEDBACK_MS);
	};

	return (
		<div className="flex items-center gap-3 p-4">
			<CountdownRing
				progress={totpResult?.progress ?? 0}
				remainingSeconds={remainingSeconds}
				toneClass={toneClass}
			/>
			<div className="min-w-0 flex-1">
				<div className="selectable truncate font-mono text-2xl text-foreground tracking-widest">
					{formattedCode}
				</div>
				<div className="mt-0.5 truncate text-muted-foreground text-xs">
					{label ?? m.mob_totp_display_label()}
				</div>
			</div>
			<RowAction
				icon={hasCopied ? IconCheck : IconCopy}
				tone={hasCopied ? "success" : "default"}
				disabled={!code}
				label={hasCopied ? m.mob_a11y_copied() : m.mob_totp_a11y_copy_code()}
				onPress={() => void handleCopyCode()}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Category bodies
// ---------------------------------------------------------------------------

interface CategoryFieldsProps {
	data: DecryptedItemData;
	onCopy: CopyValue;
}

function LoginFields({ data, onCopy }: CategoryFieldsProps) {
	const { m } = useI18n();
	// `urls[0]` is the same value as `url`; only the extras are worth their own rows.
	const extraUrls = Array.isArray(data.urls) ? data.urls.slice(1) : [];

	const fields: FieldDefinition[] = [
		{
			key: "username",
			label: m.mob_detail_field_username(),
			value: data.username,
			icon: IconUser,
		},
		{
			key: "password",
			label: m.mob_detail_field_password(),
			value: data.password,
			icon: IconKey,
			masked: true,
			mono: true,
		},
		{
			key: "url",
			label: m.mob_detail_field_website(),
			value: data.url,
			icon: IconGlobe,
		},
		...extraUrls.map((url, index) => ({
			key: `url-${index + 2}`,
			label: m.mob_detail_field_website_n({ index: String(index + 2) }),
			value: url,
			icon: IconGlobe,
		})),
	];

	return (
		<>
			<DetailSection title={m.mob_detail_section_details()}>
				<FieldGroup fields={fields} onCopy={onCopy} />
			</DetailSection>

			{data.totpSecret ? (
				<DetailSection title={m.mob_detail_field_two_factor_code()}>
					<ListCard>
						<TotpDisplay
							totpSecret={data.totpSecret}
							totpAlgorithm={data.totpAlgorithm}
							totpDigits={data.totpDigits}
							totpPeriod={data.totpPeriod}
							label={data.totpIssuer || undefined}
							onCopy={onCopy}
						/>
					</ListCard>
				</DetailSection>
			) : null}
		</>
	);
}

function CreditCardFields({ data, onCopy }: CategoryFieldsProps) {
	const { m } = useI18n();

	const cardBrand = data.cardNumber ? detectCardBrand(data.cardNumber) : null;
	const brandDisplayName =
		cardBrand && cardBrand !== "unknown"
			? getCardBrandDisplayName(cardBrand)
			: undefined;

	const fields: FieldDefinition[] = [
		{
			key: "cardholderName",
			label: m.mob_detail_field_cardholder_name(),
			value: data.cardholderName,
			icon: IconUser,
		},
		{
			key: "cardNumber",
			label: m.mob_detail_field_card_number(),
			value: data.cardNumber,
			icon: IconCreditCard,
			masked: true,
			mono: true,
			badge: brandDisplayName,
			formattedValue:
				data.cardNumber && cardBrand
					? formatCardNumberForBrand(data.cardNumber, cardBrand)
					: undefined,
		},
		{
			key: "expiryDate",
			label: m.mob_detail_field_expiry_date(),
			value: data.expiryDate,
			mono: true,
		},
		{
			key: "cvv",
			label: m.mob_detail_field_cvv(),
			value: data.cvv,
			masked: true,
			mono: true,
		},
		{
			key: "billingAddress",
			label: m.mob_detail_field_billing_address(),
			value: data.billingAddress,
			multiline: true,
		},
	];

	return (
		<DetailSection title={m.mob_detail_section_details()}>
			<FieldGroup fields={fields} onCopy={onCopy} />
		</DetailSection>
	);
}

function IdentityFields({ data, onCopy }: CategoryFieldsProps) {
	const { m } = useI18n();

	const fullName = [data.firstName, data.middleName, data.lastName]
		.filter(Boolean)
		.join(" ");
	const addresses: Address[] = Array.isArray(data.addresses)
		? data.addresses
		: [];
	const phoneNumbers: PhoneNumber[] = Array.isArray(data.phoneNumbers)
		? data.phoneNumbers
		: [];

	const fields: FieldDefinition[] = [
		{
			key: "name",
			label: m.mob_detail_field_name(),
			value: fullName || undefined,
			icon: IconUser,
		},
		{
			key: "email",
			label: m.mob_detail_field_email(),
			value: data.email,
			icon: IconMail,
		},
		{
			key: "dateOfBirth",
			label: m.mob_detail_field_date_of_birth(),
			value: data.dateOfBirth,
		},
		{
			key: "ssn",
			label: m.mob_detail_field_ssn(),
			value: data.ssn,
			masked: true,
			mono: true,
		},
		{
			key: "passportNumber",
			label: m.mob_detail_field_passport_number(),
			value: data.passportNumber,
			masked: true,
			mono: true,
		},
		{
			key: "driversLicense",
			label: m.mob_detail_field_drivers_license(),
			value: data.driversLicense,
			masked: true,
			mono: true,
		},
		...addresses.map((address, index) => ({
			key: `address-${address.id ?? index}`,
			label:
				[address.city, address.country].filter(Boolean).join(", ") ||
				m.mob_detail_field_billing_address(),
			value: formatAddress(address) || undefined,
			multiline: true,
		})),
		...phoneNumbers.map((phone, index) => ({
			key: `phone-${phone.id ?? index}`,
			label: phone.label || m.mob_detail_field_phone(),
			value: phone.number ? formatPhoneNumber(phone.number) : undefined,
		})),
	];

	return (
		<DetailSection title={m.mob_detail_section_details()}>
			<FieldGroup fields={fields} onCopy={onCopy} />
		</DetailSection>
	);
}

function SecureNoteFields({ data, onCopy }: CategoryFieldsProps) {
	const { m } = useI18n();

	return (
		<DetailSection title={m.mob_detail_field_note()}>
			<FieldGroup
				fields={[
					{
						key: "note",
						label: m.mob_detail_field_note(),
						value: data.note || data.notes,
						multiline: true,
						mono: true,
					},
				]}
				onCopy={onCopy}
			/>
		</DetailSection>
	);
}

function TotpFields({ data, onCopy }: CategoryFieldsProps) {
	const { m } = useI18n();

	const fields: FieldDefinition[] = [
		{
			key: "secret",
			label: m.mob_detail_field_secret(),
			value: data.totpSecret,
			icon: IconPasskey,
			masked: true,
			mono: true,
		},
		{
			key: "issuer",
			label: m.mob_detail_field_issuer(),
			value: data.totpIssuer,
		},
		{
			key: "account",
			label: m.mob_detail_field_account(),
			value: data.totpAccountName,
			icon: IconUser,
		},
		// The defaults are noise on a detail screen; only a non-standard setting earns a row.
		{
			key: "algorithm",
			label: m.mob_detail_field_algorithm(),
			value:
				data.totpAlgorithm && data.totpAlgorithm !== "SHA1"
					? data.totpAlgorithm
					: undefined,
			mono: true,
		},
		{
			key: "digits",
			label: m.mob_detail_field_digits(),
			value:
				data.totpDigits && data.totpDigits !== 6
					? String(data.totpDigits)
					: undefined,
			mono: true,
		},
		{
			key: "period",
			label: m.mob_detail_field_period(),
			value:
				data.totpPeriod && data.totpPeriod !== 30
					? m.mob_detail_field_period_seconds({
							seconds: String(data.totpPeriod),
						})
					: undefined,
		},
	];

	return (
		<>
			{data.totpSecret ? (
				<DetailSection title={m.mob_detail_field_current_code()}>
					<ListCard>
						<TotpDisplay
							totpSecret={data.totpSecret}
							totpAlgorithm={data.totpAlgorithm}
							totpDigits={data.totpDigits}
							totpPeriod={data.totpPeriod}
							label={data.totpIssuer || undefined}
							onCopy={onCopy}
						/>
					</ListCard>
				</DetailSection>
			) : null}

			<DetailSection title={m.mob_detail_section_details()}>
				<FieldGroup fields={fields} onCopy={onCopy} />
			</DetailSection>
		</>
	);
}

const CATEGORY_FIELDS: Record<
	ItemCategory,
	ComponentType<CategoryFieldsProps>
> = {
	login: LoginFields,
	"credit-card": CreditCardFields,
	identity: IdentityFields,
	"secure-note": SecureNoteFields,
	totp: TotpFields,
};

// ---------------------------------------------------------------------------
// Passkeys
// ---------------------------------------------------------------------------

function formatPasskeyLastUsed(value: string | undefined, m: Messages): string {
	if (!value) {
		return m.vaults_detail_items_detail_login_passkeys_last_used_never();
	}

	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) {
		return m.vaults_detail_items_detail_login_passkeys_last_used_recently();
	}

	const deltaDays = Math.floor(
		(Date.now() - timestamp) / (24 * 60 * 60 * 1000),
	);

	if (deltaDays <= 0) {
		return m.vaults_detail_items_detail_login_passkeys_last_used_today();
	}
	if (deltaDays === 1) {
		return m.vaults_detail_items_detail_login_passkeys_last_used_yesterday();
	}
	if (deltaDays < 30) {
		return m.vaults_detail_items_detail_login_passkeys_last_used_days_ago_plural(
			{
				count: deltaDays,
			},
		);
	}

	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
		timestamp,
	);
}

/**
 * Passkeys stored on a login, newest use first, each removable. Kept from the desktop detail
 * (`packages/ui/.../login-detail.tsx`) rather than from native, which has no passkey UI yet — the
 * suspect badge in particular is a security signal, not decoration.
 */
function PasskeysSection({
	passkeys,
	onRemovePasskey,
	onCopy,
}: {
	passkeys: Passkey[];
	onRemovePasskey: (credentialId: string) => Promise<void>;
	onCopy: CopyValue;
}) {
	const { m } = useI18n();
	const [pendingRemoval, setPendingRemoval] = useState<{
		credentialId: string;
		label: string;
	} | null>(null);
	const [isRemoving, setIsRemoving] = useState(false);

	const sorted = [...passkeys].sort((left, right) => {
		const leftTs = Date.parse(left.lastUsedAt ?? left.createdAt);
		const rightTs = Date.parse(right.lastUsedAt ?? right.createdAt);
		return rightTs - leftTs;
	});

	const confirmRemoval = async () => {
		if (!pendingRemoval) return;
		setIsRemoving(true);
		try {
			await onRemovePasskey(pendingRemoval.credentialId);
			setPendingRemoval(null);
		} finally {
			setIsRemoving(false);
		}
	};

	return (
		<DetailSection
			title={
				sorted.length === 1
					? m.vaults_detail_items_detail_login_passkeys_label_single({
							count: sorted.length,
						})
					: m.vaults_detail_items_detail_login_passkeys_label_plural({
							count: sorted.length,
						})
			}
		>
			<ListCard>
				{sorted.map((passkey) => {
					const displayName =
						passkey.userDisplayName ||
						passkey.userName ||
						m.vaults_detail_items_detail_login_passkeys_item_default_name();
					const isSuspect = passkey.status === "suspect";

					return (
						<div
							key={passkey.credentialId}
							className="flex items-center gap-2 px-4 py-3"
						>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<span className="truncate font-medium text-base text-foreground">
										{displayName}
									</span>
									{isSuspect ? (
										<span className="shrink-0 rounded-lg bg-danger-soft px-1.5 py-0.5 font-medium text-2xs text-danger">
											{m.vaults_detail_items_detail_login_passkeys_item_badge_suspect()}
										</span>
									) : null}
								</div>
								<div className="mt-0.5 truncate text-muted-foreground text-sm">
									{passkey.rpId}
									{" • "}
									{m.vaults_detail_items_detail_login_passkeys_meta_used({
										time: formatPasskeyLastUsed(
											passkey.lastUsedAt ?? passkey.createdAt,
											m,
										),
									})}
								</div>
								{isSuspect ? (
									<div className="mt-1 flex items-start gap-1 text-danger text-xs">
										<IconTriangleAlert className="mt-px size-3.5 shrink-0" />
										<span>
											{passkey.statusReason ||
												m.vaults_detail_items_detail_login_passkeys_item_reason_unknown()}
										</span>
									</div>
								) : null}
							</div>
							<RowAction
								icon={IconCopy}
								label={m.vaults_detail_items_detail_login_passkeys_action_copy_credential_id()}
								onPress={() =>
									void onCopy(
										passkey.credentialId,
										m.vaults_detail_items_copy_label_passkey_id(),
									)
								}
							/>
							<RowAction
								icon={IconTrash}
								tone="danger"
								label={m.vaults_detail_items_detail_login_passkeys_action_remove()}
								onPress={() =>
									setPendingRemoval({
										credentialId: passkey.credentialId,
										label: displayName,
									})
								}
							/>
						</div>
					);
				})}
			</ListCard>

			<ConfirmSheet
				open={Boolean(pendingRemoval)}
				onOpenChange={(open) => {
					if (!open && !isRemoving) setPendingRemoval(null);
				}}
				title={m.vaults_detail_items_detail_login_passkeys_remove_dialog_title()}
				description={m.vaults_detail_items_detail_login_passkeys_remove_dialog_description(
					{ label: pendingRemoval?.label ?? "" },
				)}
				confirmLabel={
					isRemoving
						? m.vaults_detail_items_detail_login_passkeys_remove_dialog_action_removing()
						: m.vaults_detail_items_detail_login_passkeys_remove_dialog_action_remove()
				}
				cancelLabel={m.vaults_detail_items_detail_action_cancel()}
				onConfirm={() => void confirmRemoval()}
				isPending={isRemoving}
			/>
		</DetailSection>
	);
}

// ---------------------------------------------------------------------------
// Shared sections
// ---------------------------------------------------------------------------

function NotesSection({
	notes,
	onCopy,
}: {
	notes: string | undefined;
	onCopy: CopyValue;
}) {
	const { m } = useI18n();
	if (!notes) return null;

	return (
		<DetailSection title={m.mob_detail_field_notes()}>
			<FieldGroup
				fields={[
					{
						key: "notes",
						label: m.mob_detail_field_notes(),
						value: notes,
						multiline: true,
					},
				]}
				onCopy={onCopy}
			/>
		</DetailSection>
	);
}

function CustomFieldsSection({
	fields,
	onCopy,
}: {
	fields: CustomField[] | undefined;
	onCopy: CopyValue;
}) {
	const { m } = useI18n();
	if (!fields || fields.length === 0) return null;

	const definitions: FieldDefinition[] = fields.map((field) => ({
		key: field.id,
		label: field.label,
		value: field.value,
		masked: field.type === "password",
		mono: field.type === "password",
		multiline: field.type !== "password",
	}));

	return (
		<DetailSection title={m.mob_detail_section_custom_fields()}>
			<FieldGroup fields={definitions} onCopy={onCopy} />
		</DetailSection>
	);
}

/** Suggestions shown at once. Beyond this the field is the faster way to find a tag. */
const TAG_SUGGESTION_LIMIT = 8;

/**
 * Tags, resting as tappable chips (each one navigates to its tag list) and editing in place.
 *
 * Neither desktop shape survives a phone. `TagInput` is a Radix `Popover`, which portals out and
 * positions against the viewport. A bottom sheet is no better: the editor's own field sits in the
 * lower half of the screen, which is exactly where the keyboard opens.
 *
 * In-place has neither problem. The card *is* the editor, so the WebView scrolls the focused
 * field into view the way it does for every other field on this screen, and the item stays
 * visible above it. Edits apply as they are made, so "Done" only collapses the card back.
 */
function TagsSection({
	tags,
	availableTags,
	onTagsChange,
	onTagClick,
	isUpdatingTags,
}: {
	tags: string[];
	availableTags: string[];
	onTagsChange: (tags: string[]) => void;
	onTagClick: (tagName: string) => void;
	isUpdatingTags: boolean;
}) {
	const { m } = useI18n();
	const [isEditing, setIsEditing] = useState(false);
	const [search, setSearch] = useState("");

	const query = search.trim();
	const selected = new Set(tags);

	const toggle = (tag: string) => {
		onTagsChange(
			selected.has(tag) ? tags.filter((t) => t !== tag) : [...tags, tag],
		);
	};

	const matches = availableTags.filter((tag) =>
		tag.toLowerCase().includes(query.toLowerCase()),
	);
	const shown = matches.slice(0, TAG_SUGGESTION_LIMIT);
	const hiddenCount = matches.length - shown.length;

	// A name that already exists — in any casing — is a selection, never a second tag.
	const canCreate =
		query.length > 0 &&
		!availableTags.some((tag) => tag.toLowerCase() === query.toLowerCase());

	const create = () => {
		if (!canCreate) return;
		onTagsChange([...tags, query]);
		setSearch("");
	};

	const stopEditing = () => {
		setIsEditing(false);
		setSearch("");
	};

	return (
		<DetailSection
			title={m.mob_detail_field_tags()}
			action={
				<Pressable
					onClick={isEditing ? stopEditing : () => setIsEditing(true)}
					className="-my-1 rounded-lg px-2 py-1 font-medium text-primary text-sm"
				>
					{isEditing
						? m.mob_tags_action_done()
						: m.vaults_detail_items_detail_action_edit()}
				</Pressable>
			}
		>
			<ListCard>
				{tags.length > 0 ? (
					<div className="flex flex-wrap gap-2 p-3">
						{tags.map((tag) => (
							<Pressable
								key={tag}
								onClick={() => (isEditing ? toggle(tag) : onTagClick(tag))}
								disabled={isEditing && isUpdatingTags}
								aria-label={
									isEditing ? m.mob_tags_a11y_remove({ tag }) : undefined
								}
								className="flex items-center gap-2 rounded-full border border-border bg-surface-tertiary py-1.5 pr-2.5 pl-3"
							>
								<span
									aria-hidden
									className="size-1.5 shrink-0 rounded-full"
									style={{ backgroundColor: getTagColorFromName(tag) }}
								/>
								<span className="font-medium text-foreground text-sm">
									{tag}
								</span>
								{isEditing ? (
									<IconX className="size-3.5 shrink-0 text-muted-foreground" />
								) : null}
							</Pressable>
						))}
					</div>
				) : isEditing ? null : (
					<div className="px-4 py-3 text-muted-foreground text-sm">
						{m.vaults_detail_items_detail_tags_empty()}
					</div>
				)}

				{isEditing ? (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							create();
						}}
						className="p-3"
					>
						<TextField
							icon={IconSearch}
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder={m.vaults_detail_items_tag_input_search_placeholder()}
							disabled={isUpdatingTags}
							autoCapitalize="none"
							autoCorrect="off"
							enterKeyHint="done"
							aria-label={m.vaults_detail_items_tag_input_search_placeholder()}
						/>
					</form>
				) : null}

				{isEditing && canCreate ? (
					<Pressable
						onClick={create}
						disabled={isUpdatingTags}
						className="flex h-13 w-full items-center gap-3 px-4"
					>
						<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-soft">
							<IconPlus className={`${iconClass.chip} text-primary`} />
						</span>
						<span className="min-w-0 flex-1 truncate text-left font-medium text-base text-primary">
							{m.vaults_detail_items_tag_input_action_create({ tag: query })}
						</span>
					</Pressable>
				) : null}

				{isEditing
					? shown.map((tag) => {
							const isSelected = selected.has(tag);
							return (
								<Pressable
									key={tag}
									onClick={() => toggle(tag)}
									disabled={isUpdatingTags}
									aria-pressed={isSelected}
									className="flex h-13 w-full items-center gap-3 px-4"
								>
									<span
										aria-hidden
										className="size-2 shrink-0 rounded-full"
										style={{ backgroundColor: getTagColorFromName(tag) }}
									/>
									<span className="min-w-0 flex-1 truncate text-left font-medium text-base text-foreground">
										{tag}
									</span>
									{isSelected ? (
										<IconCheck
											className={`${iconClass.row} shrink-0 text-primary`}
										/>
									) : null}
								</Pressable>
							);
						})
					: null}

				{isEditing && hiddenCount > 0 ? (
					<p className="px-4 py-2.5 text-muted-foreground text-xs">
						{m.mob_tags_more_matches({ count: String(hiddenCount) })}
					</p>
				) : null}

				{isEditing && matches.length === 0 && !canCreate ? (
					<p className="px-4 py-3 text-muted-foreground text-sm">
						{availableTags.length === 0
							? m.mob_tags_empty_hint()
							: m.vaults_detail_items_tag_input_empty()}
					</p>
				) : null}
			</ListCard>
		</DetailSection>
	);
}

/** Closing footnote of the detail view — never a card, never emphasised. */
function ItemMetadata({
	createdAt,
	updatedAt,
}: {
	createdAt: string;
	updatedAt: string;
}) {
	const { m } = useI18n();

	return (
		<div className="flex flex-col items-center gap-1 pt-2">
			<span className="text-muted-foreground text-xs">
				{m.mob_detail_field_created({
					date: new Date(createdAt).toLocaleString(),
				})}
			</span>
			<span className="text-muted-foreground text-xs">
				{m.mob_detail_field_updated({
					date: new Date(updatedAt).toLocaleString(),
				})}
			</span>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/**
 * The item-detail brand moment (DESIGN-NATIVE.md § Brand moments #5): a radial `primary-deep`
 * wash behind the title, dimmer than the screen aurora so the header reads as a halo rather than
 * a banner, plus the accent glow on the tile.
 *
 * The tile is the same `Favicon` the list rows use, so an item looks like itself on both
 * screens; it falls back to the hashed gradient and category glyph when the site has no icon.
 */
function ItemDetailHeader({
	title,
	category,
	url,
	serverUrl,
	isFavorite,
}: {
	title: string;
	category: ItemCategory;
	url?: string;
	serverUrl?: string;
	isFavorite: boolean;
}) {
	const { m } = useI18n();

	return (
		<div className="relative pt-2 pb-6">
			{/* 6% in light, 9% in dark — two elements rather than one, because a token cannot
			    carry a per-theme alpha and an arbitrary value owes light mode its own story. */}
			<div
				aria-hidden
				className="pointer-events-none absolute inset-x-0 top-0 h-[180px] dark:hidden"
				style={{
					background:
						"radial-gradient(70% 90% at 50% 18%, color-mix(in oklab, var(--primary-deep) 6%, transparent) 0%, transparent 100%)",
				}}
			/>
			<div
				aria-hidden
				className="pointer-events-none absolute inset-x-0 top-0 hidden h-[180px] dark:block"
				style={{
					background:
						"radial-gradient(70% 90% at 50% 18%, color-mix(in oklab, var(--primary-deep) 9%, transparent) 0%, transparent 100%)",
				}}
			/>
			<div className="relative flex flex-col items-center px-2">
				<Favicon
					title={title}
					category={category}
					url={url}
					serverUrl={serverUrl}
					size="lg"
					glow
				/>
				<div className="mt-4 flex items-center gap-2">
					<h1 className="line-clamp-2 text-center font-semibold text-2xl text-foreground tracking-tight">
						{title}
					</h1>
					{isFavorite ? (
						<IconStar
							aria-label={m.mob_a11y_favorite()}
							className="size-4 shrink-0 text-warning"
							fill="currentColor"
						/>
					) : null}
				</div>
				<p className="mt-1 text-muted-foreground text-sm">
					{getCategoryDisplayName(category, m)}
				</p>
			</div>
		</div>
	);
}

function ItemDetailSkeleton() {
	return (
		<div className="flex flex-col items-center gap-4 px-4 pt-6">
			<Skeleton className="size-14 rounded-2xl" />
			<Skeleton className="h-6 w-44" />
			<Skeleton className="h-4 w-20" />
			<Skeleton className="mt-4 h-40 w-full rounded-2xl" />
			<Skeleton className="h-28 w-full rounded-2xl" />
		</div>
	);
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

interface ItemDetailScreenProps {
	itemId: string;
	onBack: () => void;
}

export function ItemDetailScreen({ itemId, onBack }: ItemDetailScreenProps) {
	const { m } = useI18n();
	const navigate = useNavigate();
	const { rawItem, decryptedData, isLoading } = useItem(itemId);
	const { vaultInfo } = useVaultInfo(rawItem?.vaultId ?? "");
	const { items: allItems } = useItems();
	const availableTags = useAvailableTags(allItems);

	const [isActionsOpen, setIsActionsOpen] = useState(false);
	const [isEditOpen, setIsEditOpen] = useState(false);
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	const [isMoveOpen, setIsMoveOpen] = useState(false);
	const [isPasswordHistoryOpen, setIsPasswordHistoryOpen] = useState(false);
	const [isShareOpen, setIsShareOpen] = useState(false);
	const [isShareHistoryOpen, setIsShareHistoryOpen] = useState(false);
	const [isUpdatingTags, setIsUpdatingTags] = useState(false);

	const updateItem = useUpdateItem();
	const deleteItem = useDeleteItem();
	const toggleFavorite = useToggleFavorite();
	const createItem = useCreateItem();

	const itemAccountId = rawItem?.accountId ?? rawItem?.account?.accountId;
	const canRender = !isLoading && rawItem && decryptedData;

	/** The one copy path: `@bittery/ui`'s clipboard + 30s auto-clear + toast, unchanged. */
	const copyValue: CopyValue = async (value, label) => {
		await handleCopy(value, label, m);
	};

	const handleTagsChange = (newTags: string[]) => {
		if (!rawItem || !decryptedData || !itemAccountId) return;
		const updatedData: DecryptedItemData = {
			...decryptedData,
			tags: newTags.length > 0 ? newTags : undefined,
		};
		setIsUpdatingTags(true);
		updateItem.mutate(
			{
				itemId: rawItem.id,
				vaultId: rawItem.vaultId,
				data: updatedData,
				accountId: itemAccountId,
			},
			{ onSettled: () => setIsUpdatingTags(false) },
		);
	};

	const handleTagClick = (tagName: string) => {
		navigate({
			to: "/vault/tag/$tagName",
			params: { tagName: encodeURIComponent(tagName) },
		});
	};

	const handleRemovePasskey = async (credentialId: string) => {
		if (
			!rawItem ||
			!decryptedData ||
			!itemAccountId ||
			rawItem.category !== "login"
		) {
			return;
		}
		const nextPasskeys = (decryptedData.passkeys ?? []).filter(
			(passkey) => passkey.credentialId !== credentialId,
		);
		try {
			await updateItem.mutateAsync({
				itemId: rawItem.id,
				vaultId: rawItem.vaultId,
				data: {
					...decryptedData,
					passkeys: nextPasskeys.length > 0 ? nextPasskeys : undefined,
				},
				accountId: itemAccountId,
			});
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: m.vaults_detail_items_detail_login_passkeys_remove_dialog_title(),
			);
		}
	};

	const handleToggleFavorite = async () => {
		if (!rawItem || !itemAccountId) return;
		try {
			await toggleFavorite.mutateAsync({
				itemId: rawItem.id,
				vaultId: rawItem.vaultId,
				favorite: !rawItem.favorite,
				accountId: itemAccountId,
			});
			toast.success(
				!rawItem.favorite
					? m.vaults_detail_items_detail_page_toast_favorite_added()
					: m.vaults_detail_items_detail_page_toast_favorite_removed(),
			);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: m.vaults_detail_items_list_toast_favorite_update_failed(),
			);
		}
	};

	const confirmDelete = async () => {
		if (!rawItem || !itemAccountId) return;
		try {
			await deleteItem.mutateAsync({
				itemId: rawItem.id,
				vaultId: rawItem.vaultId,
				accountId: itemAccountId,
			});
			toast.success(m.mob_item_detail_toast_deleted());
			setIsDeleteOpen(false);
			onBack();
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: m.mob_item_detail_toast_delete_failed(),
			);
		}
	};

	const handleDuplicate = async () => {
		if (!rawItem || !decryptedData || !itemAccountId) return;
		try {
			const titleForDuplicate =
				decryptedData.title ||
				m.vaults_detail_items_detail_page_duplicate_default_title();
			const result = await createItem.mutateAsync({
				vaultId: rawItem.vaultId,
				category: rawItem.category,
				data: {
					...decryptedData,
					title: m.vaults_detail_items_detail_page_duplicate_title({
						title: titleForDuplicate,
					}),
				},
				accountId: itemAccountId,
			});
			toast.success(m.vaults_detail_items_detail_page_toast_item_duplicated());
			navigate({
				to: "/vault/$id/$itemId",
				params: { id: rawItem.vaultId, itemId: result.itemId },
				replace: true,
			});
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: m.vaults_detail_items_detail_page_toast_item_duplicate_error(),
			);
		}
	};

	const handleRestorePassword = async (password: string) => {
		if (!rawItem || !itemAccountId) return;
		try {
			await updateItem.mutateAsync({
				itemId: rawItem.id,
				vaultId: rawItem.vaultId,
				data: { password },
				accountId: itemAccountId,
			});
			toast.success(m.mob_item_detail_toast_password_restored());
			setIsPasswordHistoryOpen(false);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: m.mob_item_detail_toast_password_restore_failed(),
			);
		}
	};

	/**
	 * Closes the overflow sheet, then runs the action once it has finished animating out. Radix
	 * keeps a scroll lock and a `pointer-events: none` on the body for the length of the exit
	 * transition, so opening the next sheet in the same tick leaves the app briefly untappable.
	 */
	const runAction = (action: () => void) => {
		setIsActionsOpen(false);
		setTimeout(action, 220);
	};

	const CategoryBody = rawItem ? CATEGORY_FIELDS[rawItem.category] : null;
	const passkeys = decryptedData?.passkeys ?? [];

	/**
	 * The flattened item shape the share and move sheets both take. `DecryptedItem` is the
	 * repository row's identity fields spread over its decrypted payload, and neither sheet
	 * carries the repository's own `accountId` — `useCreateShare` and `useMoveItem` resolve
	 * that from the repository themselves.
	 */
	const decryptedItem =
		rawItem && decryptedData
			? ({
					id: rawItem.id,
					vaultId: rawItem.vaultId,
					category: rawItem.category,
					favorite: rawItem.favorite,
					createdAt: rawItem.createdAt,
					updatedAt: rawItem.updatedAt,
					...decryptedData,
				} as DecryptedItem)
			: null;

	return (
		<MobileScreen
			// No bar title: the item's name is the header's own brand moment, and repeating it in
			// the bar would spend the row twice on the same word.
			title={null}
			backLabel={m.mob_common_go_back()}
			onBack={onBack}
			headerEnd={
				canRender ? (
					<>
						<BarButton
							onClick={() => setIsEditOpen(true)}
							aria-label={m.mob_item_header_action_edit()}
						>
							<IconPencil className={iconClass.bar} />
						</BarButton>
						<BarButton
							onClick={() => setIsActionsOpen(true)}
							aria-label={m.mob_a11y_more_actions()}
						>
							<IconEllipsis className={iconClass.bar} />
						</BarButton>
					</>
				) : undefined
			}
			overlay={
				<>
					{canRender ? (
						<MobileSheet
							open={isActionsOpen}
							onOpenChange={setIsActionsOpen}
							title={m.mob_a11y_more_actions()}
							hideTitle
						>
							<div className="flex flex-col gap-0.5 px-3 pt-1 pb-4">
								<SheetAction
									icon={IconPencil}
									label={m.mob_item_header_action_edit()}
									onPress={() => runAction(() => setIsEditOpen(true))}
								/>
								<SheetAction
									icon={IconStar}
									label={
										rawItem.favorite
											? m.vaults_detail_items_list_item_action_remove_favorite()
											: m.vaults_detail_items_list_item_action_add_favorite()
									}
									disabled={toggleFavorite.isPending}
									onPress={() => runAction(() => void handleToggleFavorite())}
								/>
								<SheetAction
									icon={IconShare}
									label={m.mob_item_header_action_share()}
									onPress={() => runAction(() => setIsShareOpen(true))}
								/>
								<SheetAction
									icon={IconCopy}
									label={m.vaults_detail_items_detail_page_action_duplicate()}
									disabled={createItem.isPending}
									onPress={() => runAction(() => void handleDuplicate())}
								/>
								<SheetAction
									icon={IconArrowLeftRight}
									label={m.vaults_detail_items_move_dialog_action_open()}
									onPress={() => runAction(() => setIsMoveOpen(true))}
								/>
								<SheetAction
									icon={IconHistory}
									label={m.mob_share_history_title()}
									onPress={() => runAction(() => setIsShareHistoryOpen(true))}
								/>
								{rawItem.category === "login" ? (
									<SheetAction
										icon={IconHistory}
										label={m.mob_item_header_action_password_history()}
										onPress={() =>
											runAction(() => setIsPasswordHistoryOpen(true))
										}
									/>
								) : null}
								<SheetAction
									icon={IconTrash}
									tone="danger"
									label={
										deleteItem.isPending
											? m.mob_item_header_action_deleting()
											: m.mob_item_header_action_delete()
									}
									disabled={deleteItem.isPending}
									onPress={() => runAction(() => setIsDeleteOpen(true))}
								/>
							</div>
						</MobileSheet>
					) : null}

					{rawItem && decryptedData ? (
						<EditItemSheet
							open={isEditOpen}
							onOpenChange={setIsEditOpen}
							item={{
								...decryptedData,
								category: rawItem.category,
								vaultId: rawItem.vaultId,
							}}
							description={m.vaults_detail_items_detail_page_edit_dialog_description(
								{ category: getCategoryDisplayName(rawItem.category, m) },
							)}
							onUpdateItem={async (data) => {
								if (!itemAccountId) return;
								try {
									await updateItem.mutateAsync({
										itemId: rawItem.id,
										vaultId: rawItem.vaultId,
										data,
										accountId: itemAccountId,
									});
									toast.success(m.mob_edit_item_toast_success());
									setIsEditOpen(false);
								} catch (error) {
									toast.error(
										error instanceof Error
											? error.message
											: m.mob_edit_item_toast_failed(),
									);
								}
							}}
							isSubmitting={updateItem.isPending}
							dataTestId="edit-item-sheet"
							side="bottom"
						/>
					) : null}

					<ConfirmSheet
						open={isDeleteOpen}
						onOpenChange={setIsDeleteOpen}
						title={m.vaults_detail_delete_item_dialog_title()}
						description={m.vaults_detail_delete_item_dialog_description()}
						cancelLabel={m.vaults_detail_delete_item_dialog_action_cancel()}
						confirmLabel={m.vaults_detail_delete_item_dialog_action_confirm()}
						onConfirm={() => void confirmDelete()}
						isPending={deleteItem.isPending}
					/>

					{rawItem?.category === "login" && decryptedData ? (
						<PasswordHistorySheet
							open={isPasswordHistoryOpen}
							onOpenChange={setIsPasswordHistoryOpen}
							passwordHistory={decryptedData.passwordHistory}
							currentPassword={decryptedData.password}
							onCopy={copyValue}
							onRestorePassword={handleRestorePassword}
							isRestoring={updateItem.isPending}
						/>
					) : null}

					{decryptedItem ? (
						<ShareItemSheet
							open={isShareOpen}
							onOpenChange={setIsShareOpen}
							item={decryptedItem}
						/>
					) : null}

					{rawItem && itemAccountId ? (
						<ShareHistorySheet
							open={isShareHistoryOpen}
							onOpenChange={setIsShareHistoryOpen}
							itemId={rawItem.id}
							accountId={itemAccountId}
						/>
					) : null}

					{rawItem && decryptedItem ? (
						<MoveItemSheet
							open={isMoveOpen}
							onOpenChange={setIsMoveOpen}
							item={decryptedItem}
							currentVaultId={rawItem.vaultId}
							onMoved={(targetVaultId) =>
								navigate({
									to: "/vault/$id/$itemId",
									params: { id: targetVaultId, itemId },
									replace: true,
								})
							}
						/>
					) : null}
				</>
			}
		>
			{!canRender ? (
				isLoading ? (
					<ItemDetailSkeleton />
				) : (
					<EmptyState icon={IconCircleAlert} title={m.mob_detail_not_found()} />
				)
			) : (
				<div className="px-4">
					<ItemDetailHeader
						title={
							decryptedData.title ??
							vaultInfo?.vaultName ??
							m.mob_vault_items_fallback_title()
						}
						category={rawItem.category}
						url={decryptedData.url}
						serverUrl={rawItem.serverUrl ?? rawItem.account?.serverUrl}
						isFavorite={rawItem.favorite}
					/>

					{/* Sections are separated by the 24px rhythm, never by margins on the cards. */}
					<div className="flex flex-col gap-6">
						{CategoryBody ? (
							<CategoryBody data={decryptedData} onCopy={copyValue} />
						) : null}

						{rawItem.category === "login" && passkeys.length > 0 ? (
							<PasskeysSection
								passkeys={passkeys}
								onRemovePasskey={handleRemovePasskey}
								onCopy={copyValue}
							/>
						) : null}

						{/* A secure note already renders its body as the item's main field. */}
						<NotesSection
							notes={
								rawItem.category === "secure-note"
									? undefined
									: decryptedData.notes
							}
							onCopy={copyValue}
						/>

						<CustomFieldsSection
							fields={decryptedData.customFields}
							onCopy={copyValue}
						/>

						{/* Below the item's own values and above tags, matching desktop's order.
						    `itemAccountId` is required by every attachment call, so the section
						    is simply absent until the item's account is known. */}
						{itemAccountId ? (
							<ItemAttachments
								itemId={rawItem.id}
								vaultId={rawItem.vaultId}
								accountId={itemAccountId}
								canEdit={vaultInfo?.role !== "read-only"}
							/>
						) : null}

						<TagsSection
							tags={decryptedData.tags ?? []}
							availableTags={availableTags}
							onTagsChange={handleTagsChange}
							onTagClick={handleTagClick}
							isUpdatingTags={isUpdatingTags}
						/>

						<ItemMetadata
							createdAt={rawItem.createdAt}
							updatedAt={rawItem.updatedAt}
						/>
					</div>
				</div>
			)}
		</MobileScreen>
	);
}
