import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
	Badge,
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
	Input,
	Label,
	Skeleton,
	toast,
} from "@bittery/ui";
import {
	IconPen2OutlineDuo18 as Edit2,
	IconEarthOutlineDuo18 as Globe,
	IconArrowDoorOutOutlineDuo18 as LogOut,
	IconMobileOutlineDuo18 as Smartphone,
	IconSquareTerminalOutlineDuo18 as Monitor,
	IconConnectedDots3OutlineDuo18 as Extension,
} from "@bittery/ui/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useI18n } from "@/providers/i18n-provider";

type Messages = ReturnType<typeof useI18n>["m"];

// Platform icons
function getPlatformIcon(platform?: string | null) {
	switch (platform) {
		case "ios":
		case "android":
			return <Smartphone className="h-4 w-4" />;
		case "desktop":
			return <Monitor className="h-4 w-4" />;
		case "extension":
			return <Extension className="h-4 w-4" />;
		default:
			return <Globe className="h-4 w-4" />;
	}
}

function getPlatformLabel(platform: string | null | undefined, m: Messages) {
	switch (platform) {
		case "web":
			return m["settings.devices.platform.web"]();
		case "desktop":
			return m["settings.devices.platform.desktop"]();
		case "extension":
			return m["settings.devices.platform.extension"]();
		case "ios":
			return m["settings.devices.platform.ios"]();
		case "android":
			return m["settings.devices.platform.android"]();
		default:
			return m["settings.devices.platform.unknown"]();
	}
}

function formatDeviceDisplayLocalized(
	device: DeviceSession,
	m: Messages,
): { title: string; subtitle: string } {
	const title =
		device.deviceName ?? m["settings.devices.common.unknown_device"]();

	const parts: string[] = [];
	if (device.osName) {
		parts.push(
			device.osVersion ? `${device.osName} ${device.osVersion}` : device.osName,
		);
	}
	if (device.browserName && device.browserVersion) {
		parts.push(`${device.browserName} ${device.browserVersion}`);
	}

	const subtitle =
		parts.length > 0 ? parts.join(" - ") : getPlatformLabel(device.platform, m);

	return { title, subtitle };
}

function formatLastActiveLocalized(
	date: Date | string,
	locale: string,
	m: Messages,
): string {
	const now = new Date();
	const lastActive = typeof date === "string" ? new Date(date) : date;
	const diffMs = now.getTime() - lastActive.getTime();
	const diffMins = Math.floor(diffMs / 60_000);
	const diffHours = Math.floor(diffMs / 3_600_000);
	const diffDays = Math.floor(diffMs / 86_400_000);

	if (Number.isNaN(lastActive.getTime()) || diffMins < 1) {
		return m["settings.devices.last_active.just_now"]();
	}
	if (diffMins < 60) {
		return diffMins === 1
			? m["settings.devices.last_active.minutes.single"]({ count: diffMins })
			: m["settings.devices.last_active.minutes.plural"]({ count: diffMins });
	}
	if (diffHours < 24) {
		return diffHours === 1
			? m["settings.devices.last_active.hours.single"]({ count: diffHours })
			: m["settings.devices.last_active.hours.plural"]({ count: diffHours });
	}
	if (diffDays < 7) {
		return diffDays === 1
			? m["settings.devices.last_active.days.single"]({ count: diffDays })
			: m["settings.devices.last_active.days.plural"]({ count: diffDays });
	}

	return new Intl.DateTimeFormat(locale, {
		month: "short",
		day: "numeric",
		year:
			lastActive.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
	}).format(lastActive);
}

interface DeviceSession {
	id: string;
	deviceName: string | null;
	platform: string | null;
	browserName: string | null;
	browserVersion: string | null;
	osName: string | null;
	osVersion: string | null;
	ipAddress: string | null;
	lastActiveAt: Date | string;
	createdAt: Date | string;
	isCurrentSession: boolean;
}

function RenameDeviceDialog({
	session,
	onSuccess,
}: {
	session: DeviceSession;
	onSuccess: () => void;
}) {
	const { m } = useI18n();
	const [open, setOpen] = useState(false);
	const [deviceName, setDeviceName] = useState(session.deviceName || "");
	const trpcClient = useTRPCClient();

	const renameMutation = useMutation({
		mutationFn: (input: { sessionId: string; deviceName: string }) =>
			trpcClient.auth.renameDevice.mutate(input),
		onSuccess: () => {
			toast.success(m["settings.devices.toast.rename_success"]());
			setOpen(false);
			onSuccess();
		},
		onError: () => {
			toast.error(m["settings.devices.toast.rename_failed"]());
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!deviceName.trim()) {
			toast.error(m["settings.devices.toast.device_name_required"]());
			return;
		}
		renameMutation.mutate({
			sessionId: session.id,
			deviceName: deviceName.trim(),
		});
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="ghost" size="icon" className="h-8 w-8">
					<Edit2 className="h-4 w-4" />
				</Button>
			</DialogTrigger>
			<DialogContent>
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle>
							{m["settings.devices.rename_dialog.title"]()}
						</DialogTitle>
						<DialogDescription>
							{m["settings.devices.rename_dialog.description"]()}
						</DialogDescription>
					</DialogHeader>
					<div className="py-4">
						<Label htmlFor="deviceName">
							{m["settings.devices.rename_dialog.field.device_name"]()}
						</Label>
						<Input
							id="deviceName"
							value={deviceName}
							onChange={(e) => setDeviceName(e.target.value)}
							placeholder={m[
								"settings.devices.rename_dialog.placeholder.device_name"
							]()}
							className="mt-2"
							autoFocus
						/>
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setOpen(false)}
						>
							{m["settings.common.action.cancel"]()}
						</Button>
						<Button type="submit" disabled={renameMutation.isPending}>
							{renameMutation.isPending
								? m["settings.devices.rename_dialog.action.saving"]()
								: m["settings.devices.rename_dialog.action.submit"]()}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function RevokeDeviceDialog({
	session,
	onSuccess,
}: {
	session: DeviceSession;
	onSuccess: () => void;
}) {
	const { m } = useI18n();
	const [open, setOpen] = useState(false);
	const trpcClient = useTRPCClient();

	const revokeMutation = useMutation({
		mutationFn: (sessionId: string) =>
			trpcClient.auth.revokeDevice.mutate({ sessionId }),
		onSuccess: () => {
			toast.success(m["settings.devices.toast.revoke_success"]());
			setOpen(false);
			onSuccess();
		},
		onError: () => {
			toast.error(m["settings.devices.toast.revoke_failed"]());
		},
	});

	const { title } = formatDeviceDisplayLocalized(session, m);

	return (
		<AlertDialog open={open} onOpenChange={setOpen}>
			<AlertDialogTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="h-8 w-8 text-destructive hover:text-destructive"
				>
					<LogOut className="h-4 w-4" />
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{m["settings.devices.revoke_dialog.title"]()}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{m["settings.devices.revoke_dialog.description.prefix"]()}{" "}
						<strong>{title}</strong>{" "}
						{m["settings.devices.revoke_dialog.description.suffix"]()}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>
						{m["settings.common.action.cancel"]()}
					</AlertDialogCancel>
					<Button
						variant="destructive"
						onClick={() => revokeMutation.mutate(session.id)}
						disabled={revokeMutation.isPending}
					>
						{revokeMutation.isPending
							? m["settings.devices.revoke_dialog.action.revoking"]()
							: m["settings.devices.revoke_dialog.action.submit"]()}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

function DeviceCard({
	session,
	onUpdate,
}: {
	session: DeviceSession;
	onUpdate: () => void;
}) {
	const { m, locale } = useI18n();
	const { title, subtitle } = formatDeviceDisplayLocalized(session, m);
	const lastActive = formatLastActiveLocalized(session.lastActiveAt, locale, m);

	return (
		<div
			className={`flex items-center gap-3 rounded-xl border bg-card p-4 ${session.isCurrentSession ? "border-primary/40" : ""}`}
		>
			<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
				{getPlatformIcon(session.platform)}
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="truncate font-medium text-sm">{title}</span>
					{session.isCurrentSession && (
						<Badge variant="secondary" className="text-[10px]">
							{m["settings.devices.badge.current"]()}
						</Badge>
					)}
				</div>
				<p className="truncate text-muted-foreground text-xs">{subtitle}</p>
				<div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
					<span>{lastActive}</span>
					{session.ipAddress && (
						<>
							<span className="opacity-40">·</span>
							<span className="font-mono">{session.ipAddress}</span>
						</>
					)}
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-0.5">
				<RenameDeviceDialog session={session} onSuccess={onUpdate} />
				{!session.isCurrentSession && (
					<RevokeDeviceDialog session={session} onSuccess={onUpdate} />
				)}
			</div>
		</div>
	);
}

function DeviceListSkeleton() {
	return (
		<div className="space-y-2">
			{[1, 2, 3].map((i) => (
				<div key={i} className="flex items-center gap-3 rounded-xl border bg-card p-4">
					<Skeleton className="h-9 w-9 shrink-0 rounded-lg" />
					<div className="flex-1 space-y-1.5">
						<Skeleton className="h-4 w-32" />
						<Skeleton className="h-3 w-48" />
						<Skeleton className="h-3 w-20" />
					</div>
				</div>
			))}
		</div>
	);
}

export function DeviceManagement() {
	const { m } = useI18n();
	const trpc = useTRPC();

	const devicesQuery = useQuery(trpc.auth.listDevices.queryOptions());

	const handleUpdate = () => {
		devicesQuery.refetch();
	};

	if (devicesQuery.isLoading) {
		return <DeviceListSkeleton />;
	}

	if (devicesQuery.error) {
		return (
			<div className="py-8 text-center text-muted-foreground">
				{m["settings.devices.list.error"]()}
			</div>
		);
	}

	const devices = devicesQuery.data || [];

	if (devices.length === 0) {
		return (
			<div className="py-8 text-center text-muted-foreground">
				{m["settings.devices.list.empty"]()}
			</div>
		);
	}

	// Sort to show current session first
	const sortedDevices = [...devices].sort((a, b) => {
		if (a.isCurrentSession) return -1;
		if (b.isCurrentSession) return 1;
		return (
			new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
		);
	});

	return (
		<div className="space-y-2">
			{sortedDevices.map((session) => (
				<DeviceCard
					key={session.id}
					session={session}
					onUpdate={handleUpdate}
				/>
			))}
		</div>
	);
}
