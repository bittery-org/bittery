import { formatDeviceDisplay, formatLastActive } from "@bittery/shared/device";
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
	Card,
	CardContent,
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
import { useMutation, useQuery } from "@tanstack/react-query";
import {
	Chrome,
	Edit2,
	Globe,
	LogOut,
	Monitor,
	Smartphone,
} from "lucide-react";
import { useState } from "react";

// Platform icons
function getPlatformIcon(platform?: string | null) {
	switch (platform) {
		case "ios":
		case "android":
			return <Smartphone className="h-5 w-5" />;
		case "desktop":
			return <Monitor className="h-5 w-5" />;
		case "extension":
			return <Chrome className="h-5 w-5" />;
		default:
			return <Globe className="h-5 w-5" />;
	}
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
	const [open, setOpen] = useState(false);
	const [deviceName, setDeviceName] = useState(session.deviceName || "");
	const trpcClient = useTRPCClient();

	const renameMutation = useMutation({
		mutationFn: (input: { sessionId: string; deviceName: string }) =>
			trpcClient.auth.renameDevice.mutate(input),
		onSuccess: () => {
			toast.success("Device renamed successfully");
			setOpen(false);
			onSuccess();
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!deviceName.trim()) {
			toast.error("Please enter a device name");
			return;
		}
		renameMutation.mutate({ sessionId: session.id, deviceName: deviceName.trim() });
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
						<DialogTitle>Rename Device</DialogTitle>
						<DialogDescription>
							Give this device a custom name to easily identify it.
						</DialogDescription>
					</DialogHeader>
					<div className="py-4">
						<Label htmlFor="deviceName">Device Name</Label>
						<Input
							id="deviceName"
							value={deviceName}
							onChange={(e) => setDeviceName(e.target.value)}
							placeholder="My Laptop"
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
							Cancel
						</Button>
						<Button type="submit" disabled={renameMutation.isPending}>
							{renameMutation.isPending ? "Saving..." : "Save"}
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
	const [open, setOpen] = useState(false);
	const trpcClient = useTRPCClient();

	const revokeMutation = useMutation({
		mutationFn: (sessionId: string) =>
			trpcClient.auth.revokeDevice.mutate({ sessionId }),
		onSuccess: () => {
			toast.success("Device session revoked");
			setOpen(false);
			onSuccess();
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const { title } = formatDeviceDisplay(session);

	return (
		<AlertDialog open={open} onOpenChange={setOpen}>
			<AlertDialogTrigger asChild>
				<Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive">
					<LogOut className="h-4 w-4" />
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Revoke Device Access</AlertDialogTitle>
					<AlertDialogDescription>
						Are you sure you want to revoke access for{" "}
						<strong>{title}</strong>? This will log out that device
						immediately. The device will need to sign in again to access your
						account.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<Button
						variant="destructive"
						onClick={() => revokeMutation.mutate(session.id)}
						disabled={revokeMutation.isPending}
					>
						{revokeMutation.isPending ? "Revoking..." : "Revoke Access"}
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
	const { title, subtitle } = formatDeviceDisplay(session);

	return (
		<Card className={session.isCurrentSession ? "border-primary" : ""}>
			<CardContent className="flex items-center gap-4 p-4">
				<div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
					{getPlatformIcon(session.platform)}
				</div>
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2">
						<span className="font-medium truncate">{title}</span>
						{session.isCurrentSession && (
							<Badge variant="secondary" className="text-xs">
								This device
							</Badge>
						)}
					</div>
					<p className="text-sm text-muted-foreground truncate">{subtitle}</p>
					<div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
						<span>Last active: {formatLastActive(session.lastActiveAt)}</span>
						{session.ipAddress && (
							<>
								<span>•</span>
								<span>{session.ipAddress}</span>
							</>
						)}
					</div>
				</div>
				<div className="flex items-center gap-1">
					<RenameDeviceDialog session={session} onSuccess={onUpdate} />
					{!session.isCurrentSession && (
						<RevokeDeviceDialog session={session} onSuccess={onUpdate} />
					)}
				</div>
			</CardContent>
		</Card>
	);
}

function DeviceListSkeleton() {
	return (
		<div className="space-y-3">
			{[1, 2, 3].map((i) => (
				<Card key={i}>
					<CardContent className="flex items-center gap-4 p-4">
						<Skeleton className="h-10 w-10 rounded-full" />
						<div className="flex-1 space-y-2">
							<Skeleton className="h-4 w-32" />
							<Skeleton className="h-3 w-48" />
							<Skeleton className="h-3 w-24" />
						</div>
					</CardContent>
				</Card>
			))}
		</div>
	);
}

export function DeviceManagement() {
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
			<div className="text-center text-muted-foreground py-8">
				Failed to load devices. Please try again.
			</div>
		);
	}

	const devices = devicesQuery.data || [];

	if (devices.length === 0) {
		return (
			<div className="text-center text-muted-foreground py-8">
				No active sessions found.
			</div>
		);
	}

	// Sort to show current session first
	const sortedDevices = [...devices].sort((a, b) => {
		if (a.isCurrentSession) return -1;
		if (b.isCurrentSession) return 1;
		return new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime();
	});

	return (
		<div className="space-y-3">
			{sortedDevices.map((session) => (
				<DeviceCard key={session.id} session={session} onUpdate={handleUpdate} />
			))}
		</div>
	);
}
