import { useRPC } from "@bittery/shared/rpc";
import {
	Avatar,
	AvatarFallback,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from "@bittery/ui";
import {
	IconChevronExpandYOutlineDuo18 as ChevronsUpDown,
	IconArrowDoorOutOutlineDuo18 as LogOut,
	IconGear3OutlineDuo18 as Settings,
} from "@bittery/ui/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ImportOnboardingCard } from "@/components/import/import-onboarding-card";
import { appNavItems, filterNavItems } from "@/components/layout/nav-config";
import {
	normalizeCloudPlanId,
	normalizeDeploymentMode,
	normalizeEntitlements,
	normalizeTeamRole,
} from "@/lib/rpc-normalizers";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

function getNavLabel(path: string, m: ReturnType<typeof useI18n>["m"]) {
	switch (path) {
		case "/home":
			return m.nav_item_dashboard();
		case "/security":
			return m.nav_item_sentinel();
		case "/billing":
			return m.nav_item_billing();
		case "/team":
			return m.nav_item_team();
		case "/admin":
			return m.nav_item_admin();
		case "/vaults":
			return m.nav_item_vaults();
		case "/settings":
			return m.nav_item_settings();
		default:
			return path;
	}
}

function UserNav() {
	const rpc = useRPC();
	const { m } = useI18n();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const { isMobile, setOpenMobile } = useSidebar();
	const userQuery = useQuery(rpc.auth.me.queryOptions());
	const user = userQuery.data;
	const initials = user?.name
		? user.name
				.split(" ")
				.map((n) => n[0])
				.join("")
				.toUpperCase()
				.slice(0, 2)
		: "??";

	const handleLogout = async () => {
		await storage.clearAllStoredData();
		queryClient.clear();
		navigate({ to: "/login" });
	};

	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<SidebarMenuButton
							size="lg"
							className="text-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-foreground"
						>
							<Avatar className="h-7 w-7 rounded-md">
								<AvatarFallback className="rounded-md bg-linear-to-br from-primary to-primary-deep font-semibold text-[10.5px] text-white shadow-[inset_0_0_0_1px_oklch(1_0_0/0.12)]">
									{initials}
								</AvatarFallback>
							</Avatar>
							<div className="grid flex-1 text-left text-sm leading-tight">
								<span className="truncate font-medium">
									{user?.name || m.nav_user_default_name()}
								</span>
								<span className="truncate text-muted-foreground text-xs">
									{user?.email || ""}
								</span>
							</div>
							<ChevronsUpDown className="ml-auto size-3.5 text-muted-foreground" />
						</SidebarMenuButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
						side={isMobile ? "bottom" : "right"}
						align="end"
						sideOffset={4}
					>
						<DropdownMenuItem asChild>
							<Link
								to="/settings"
								className="cursor-pointer"
								onClick={() => {
									if (isMobile) setOpenMobile(false);
								}}
							>
								<Settings className="mr-2 h-4 w-4" />
								{m.nav_menu_settings()}
							</Link>
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onClick={handleLogout}
							className="cursor-pointer text-destructive"
						>
							<LogOut className="mr-2 h-4 w-4" />
							{m.nav_menu_log_out()}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		</SidebarMenu>
	);
}

export function AppSidebar() {
	const rpc = useRPC();
	const { m } = useI18n();
	const routerState = useRouterState();
	const currentPath = routerState.location.pathname;
	const { state, isMobile, setOpenMobile } = useSidebar();

	const handleMobileLinkClick = () => {
		if (isMobile) setOpenMobile(false);
	};
	const entitlementQuery = useQuery(rpc.billing.entitlements.queryOptions());
	const meQuery = useQuery(rpc.auth.me.queryOptions());
	const navItems = filterNavItems(appNavItems, {
		mode: normalizeDeploymentMode(entitlementQuery.data?.mode),
		billingEnabled: entitlementQuery.data?.billingEnabled === true,
		entitlements: normalizeEntitlements(entitlementQuery.data?.entitlements),
		plan: normalizeCloudPlanId(entitlementQuery.data?.plan),
		role: meQuery.data?.role ? normalizeTeamRole(meQuery.data.role) : undefined,
	});

	return (
		<Sidebar collapsible="icon">
			<div
				aria-hidden
				className="pointer-events-none absolute inset-x-0 top-0 h-44 bg-[radial-gradient(120%_100%_at_30%_0%,color-mix(in_oklab,var(--color-primary-deep)_8%,transparent),transparent_65%)] dark:bg-[radial-gradient(120%_100%_at_30%_0%,color-mix(in_oklab,var(--color-primary-deep)_14%,transparent),transparent_65%)]"
			/>
			<SidebarHeader className="relative">
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton
							size="lg"
							className="group-data-[state=collapsed]:flex group-data-[state=collapsed]:items-center group-data-[state=collapsed]:justify-center"
							asChild
						>
							<Link to="/home" onClick={handleMobileLinkClick}>
								{state === "collapsed" ? (
									<svg
										xmlns="http://www.w3.org/2000/svg"
										fill="none"
										viewBox="0 0 516 625"
										className="fill-current text-primary"
									>
										<title>Bittery Icon</title>
										<path
											fill="#8366e4"
											d="M348.806 169.251c-65.824 0-128.745 37.79-172.628 95.284L213.93 0H89.38L0 625h124.551l13.874-95.93C165.852 586.886 218.77 625 284.918 625c108.417 0 211.026-102.067 228.45-227.713 17.747-125.646-56.145-227.713-164.562-227.713zm-9.68 246.447-2.581 112.403h-91.961l34.203-114.341c-17.102-12.92-27.104-35.53-23.232-62.662 5.808-40.697 39.043-73.966 74.214-73.966s59.048 32.946 53.24 73.966c-3.872 28.424-21.619 52.326-43.56 64.6z"
										/>
									</svg>
								) : (
									<svg
										xmlns="http://www.w3.org/2000/svg"
										viewBox="0 0 841.9 285.7"
										className="h-7.5! w-auto! fill-current text-primary"
									>
										<title>Bittery</title>
										<path d="m394.3 71.3-.2 2.7 2.5-2.7h-2.2Z" />
										<path d="m394.3 71.3-.2 2.7 2.5-2.7h-2.2Z" />
										<path d="M396.6 71.3h49.7c-4.9 2.7-9.6 6.2-13.8 10.1-6.7 6.4-12.6 13.8-17.1 22.2h-25.5l-15.6 110.2h-37.1l15.6-110.2h-48l-15.6 110.2h-37.1l15.6-110.2h-17.8l4.2-29.7.5-2.7h17.6l6.7-47.5H316l-6.7 47.5h48l6.7-47.5h37.1l-6.7 47.5M211.2 23.1l-4.4 31.4h37.6l4.4-31.4h-37.6Z" />
										<path d="M547.8 87.8c-5.7-6.2-13.3-10.6-22.7-13.3-4.7-1.7-10.1-2.7-15.8-3.2-3.5-.2-6.9-.5-10.6-.5s-7.4.2-10.9.5c-19.5 1.7-35.1 8.2-46.7 19.3-4.2 4-7.9 8.4-11.1 13.1-7.7 11.1-12.6 24.5-14.6 40-3.5 24.2 1.2 42.8 14.1 54.6 13.1 12.1 32.1 18 56.6 18s21.8-.7 31.4-2.2c8.7-1.2 16.6-3.5 23.5-6.2l3.7-26.7c-5.2 1.7-11.4 3-18.3 4.2-8.4 1.5-16.8 2.2-25 2.2-14.6 0-26-2-33.9-5.9-8.4-4-13.1-11.4-14.1-21.8l-.2-3h103.1l3.2-23.5c2.7-19-1.2-34.4-11.6-45.7Zm-25.9 46h-64.8l.2-2.7c1.5-10.6 5.2-18.8 11.1-24.2 1.5-1.2 3.2-2.5 4.9-3.2 5.7-3.2 13.3-4.7 22.7-4.7s15.1 1.5 19.5 4.7c1.2.7 2.2 1.5 3 2.5 4 4.4 5.7 10.9 4.4 18.5l-1.2 9.1Zm151.3-25.2c-4.2.7-17.8 1.7-23 2.7-6.7 1.2-13.1 3-18.8 4.7-6.2 1.7-11.4 3.7-16.1 5.9l-4.2 2-12.6 89.2h-37.6l6.9-50.2 4-27.9 8.7-61.8h37.6l-2.5 17.1 8.2-4.4c6.4-3.7 14.3-6.9 23.5-9.9 4.9-1.7 9.9-3 14.8-3.7l1 3 9.9 30.9.2 2.5Zm152.2-37.3L708 273h-39.3l45.5-78.9-39.6-122.8h42.8l22.5 84.8 45.5-84.8h40zm-693.9-.9c-20.4 0-39.9 11.7-53.5 29.5L89.7 18H51.1L23.4 211.5H62l4.3-29.7c8.5 17.9 24.9 29.7 45.4 29.7 33.6 0 65.4-31.6 70.8-70.5 5.5-38.9-17.4-70.5-51-70.5Zm-3 76.3-.8 34.8H99.2l10.6-35.4c-5.3-4-8.4-11-7.2-19.4 1.8-12.6 12.1-22.9 23-22.9s18.3 10.2 16.5 22.9c-1.2 8.8-6.7 16.2-13.5 20Zm113.6-74.4-4.5 31.4-15.8 111.2h-37.3l20.2-142.6h37.4z" />
									</svg>
								)}
							</Link>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarHeader>

			<SidebarContent className="relative">
				<SidebarGroup>
					<SidebarGroupLabel>{m.nav_group_navigation()}</SidebarGroupLabel>
					<SidebarGroupContent>
						<SidebarMenu>
							{navItems.map((item) => {
								const label = getNavLabel(item.path, m);
								const isActive = currentPath.startsWith(item.path);

								return (
									<SidebarMenuItem key={item.path}>
										{isActive && (
											<span
												aria-hidden
												className="absolute top-[6px] bottom-[6px] -left-2 z-10 w-0.5 rounded-full bg-primary shadow-[0_0_8px_color-mix(in_oklab,var(--color-primary)_80%,transparent)]"
											/>
										)}
										<SidebarMenuButton
											asChild
											isActive={isActive}
											tooltip={label}
										>
											<Link to={item.path} onClick={handleMobileLinkClick}>
												<item.icon />
												<span>{label}</span>
											</Link>
										</SidebarMenuButton>
									</SidebarMenuItem>
								);
							})}
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
			</SidebarContent>

			<SidebarFooter className="gap-1">
				<ImportOnboardingCard isCollapsed={state === "collapsed"} />
				<UserNav />
			</SidebarFooter>
		</Sidebar>
	);
}
