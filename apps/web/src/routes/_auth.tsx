import {
	Button,
	Input,
	Popover,
	PopoverContent,
	PopoverTrigger,
	toast,
} from "@bittery/ui";
import {
	IconCheckOutlineDuo18 as Check,
	IconChevronDownOutlineDuo18 as ChevronDown,
	IconExternalLinkOutlineDuo18 as ExternalLink,
	IconLockOutlineDuo18,
	IconPlusOutlineDuo18 as Plus,
	IconConnectedDots3OutlineDuo18 as Server,
} from "@bittery/ui/icons";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import {
	readKnownServerUrls,
	resolveActiveAuthServerUrl,
	setActiveAuthServerUrl,
} from "@/lib/auth-server";

export const Route = createFileRoute("/_auth")({
	component: AuthLayout,
});

function getServerLabel(serverUrl: string): string {
	try {
		const parsed = new URL(serverUrl);
		return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
	} catch {
		return serverUrl;
	}
}

function AuthLayout() {
	const queryClient = useQueryClient();
	const [activeServerUrl, setActiveServerUrl] = useState("");
	const [knownServerUrls, setKnownServerUrls] = useState<string[]>([]);
	const [isServerPopoverOpen, setIsServerPopoverOpen] = useState(false);
	const [newServerUrl, setNewServerUrl] = useState("");

	useEffect(() => {
		let isMounted = true;

		const hydrateServerState = async () => {
			const currentServerUrl = await resolveActiveAuthServerUrl();
			if (!isMounted) {
				return;
			}

			setActiveServerUrl(currentServerUrl);
			setKnownServerUrls(readKnownServerUrls());
		};

		void hydrateServerState();

		return () => {
			isMounted = false;
		};
	}, []);

	const activeServerLabel = useMemo(
		() => getServerLabel(activeServerUrl),
		[activeServerUrl],
	);

	const applyServerChange = async (serverUrl: string) => {
		const nextServerUrl = await setActiveAuthServerUrl(serverUrl);
		if (!nextServerUrl) {
			toast.error("Please enter a valid server URL.");
			return false;
		}

		setActiveServerUrl(nextServerUrl);
		setKnownServerUrls(readKnownServerUrls());
		await queryClient.invalidateQueries();
		return true;
	};

	const handleAddServer = async (event: FormEvent) => {
		event.preventDefault();
		if (!(await applyServerChange(newServerUrl))) {
			return;
		}

		setNewServerUrl("");
		setIsServerPopoverOpen(false);
		toast.success("Server updated.");
	};

	const handleSelectServer = async (serverUrl: string) => {
		if (await applyServerChange(serverUrl)) {
			setIsServerPopoverOpen(false);
		}
	};

	return (
		<div className="flex min-h-svh flex-col md:h-svh md:flex-row md:overflow-hidden">
			{/* Left panel — branding sidebar */}
			<div className="relative hidden w-1/3 flex-col bg-sidebar md:flex lg:w-1/3">
				<div className="absolute top-4 left-4 sm:top-5 sm:left-6">
					<a
						href="https://bittery.com"
						target="_blank"
						rel="noopener noreferrer"
					>
						<img src="/logo.png" alt="Bittery" className="h-7 w-auto sm:h-10" />
					</a>
				</div>

				{/* Lock icon — sits on the right edge */}
				<div className="absolute top-1/4 right-0 z-10 translate-x-1/2">
					<div className="flex items-center justify-center rounded-full border border-border bg-white p-4 shadow-sm dark:bg-gray-900">
						<IconLockOutlineDuo18 className="size-7 text-primary" />
					</div>
				</div>

				{/* Separator line on the right edge */}
				<div className="absolute inset-y-0 right-0 w-px bg-black/10 dark:bg-white/10" />
			</div>

			{/* Right panel — content area */}
			<div className="flex min-h-svh flex-1 flex-col bg-white dark:bg-gray-900 md:h-svh md:min-h-0">
				{/* Mobile logo */}
				<div className="flex shrink-0 px-5 pt-5 sm:px-8 sm:pt-6 md:hidden">
					<a
						href="https://bittery.com"
						target="_blank"
						rel="noopener noreferrer"
					>
						<img src="/logo.png" alt="Bittery" className="h-10 w-auto" />
					</a>
				</div>

				{/* Main content */}
				<main
					id="auth-scroll-area"
					className="flex flex-1 flex-col px-4 py-8 sm:px-6 md:min-h-0 md:overflow-y-auto md:pt-12"
				>
					<div className="flex flex-1 items-center justify-center md:items-start">
						<div className="w-full max-w-110">
							<Outlet />
						</div>
					</div>
				</main>

				{/* Footer */}
				<footer className="shrink-0 px-4">
					<div className="mx-auto flex max-w-110 flex-col items-center gap-3 py-1.5 sm:flex-row sm:justify-between">
						<Popover
							open={isServerPopoverOpen}
							onOpenChange={setIsServerPopoverOpen}
						>
							<PopoverTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-7 gap-1 px-3 text-muted-foreground/70 text-xs hover:text-muted-foreground sm:px-4"
								>
									<Server size={12} />
									<span className="max-w-44 truncate">
										{activeServerLabel || "Loading server..."}
									</span>
									<ChevronDown size={12} className="opacity-60" />
								</Button>
							</PopoverTrigger>
							<PopoverContent align="start" className="w-72 p-2">
								<p className="px-1 pb-2 font-medium text-[0.65rem] text-muted-foreground uppercase tracking-[0.1em]">
									Server
								</p>
								<div className="space-y-1">
									{knownServerUrls.map((serverUrl) => (
										<Button
											key={serverUrl}
											type="button"
											variant="ghost"
											size="sm"
											onClick={() => {
												void handleSelectServer(serverUrl);
											}}
											className="h-8 w-full justify-between px-2 text-xs"
										>
											<span className="truncate">
												{getServerLabel(serverUrl)}
											</span>
											{serverUrl === activeServerUrl ? (
												<Check size={12} className="shrink-0 text-primary" />
											) : null}
										</Button>
									))}
								</div>
								<form
									onSubmit={handleAddServer}
									className="mt-2 flex gap-2 border-t pt-2"
								>
									<Input
										type="url"
										placeholder="https://your-server.com"
										value={newServerUrl}
										onChange={(event) => setNewServerUrl(event.target.value)}
										className="h-8 text-xs"
									/>
									<Button type="submit" size="sm" className="h-8 px-3">
										<Plus size={12} />
									</Button>
								</form>
							</PopoverContent>
						</Popover>
						<div className="flex items-center gap-4">
							<a
								href="https://github.com/bittery-org/bittery"
								target="_blank"
								rel="noopener noreferrer"
								className="flex items-center gap-1 text-muted-foreground/60 text-xs transition-colors hover:text-muted-foreground"
							>
								GitHub
								<ExternalLink size={10} />
							</a>
							<span className="text-muted-foreground/20">|</span>
							<a
								href="https://github.com/bittery-org/bittery/issues"
								target="_blank"
								rel="noopener noreferrer"
								className="flex items-center gap-1 text-muted-foreground/60 text-xs transition-colors hover:text-muted-foreground"
							>
								Help
								<ExternalLink size={10} />
							</a>
						</div>
					</div>
				</footer>
			</div>
		</div>
	);
}
