import { useTRPC } from "@bittery/shared/trpc";
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
	IconSortObjTopToBottomOutlineDuo18 as ChevronsUpDown,
	IconGrid2OutlineDuo18 as Home,
	IconLockOutlineDuo18 as Lock,
	IconArrowDoorOutOutlineDuo18 as LogOut,
	IconGear3OutlineDuo18 as Settings,
	IconMagicShieldOutlineDuo18 as ShieldCheck,
	IconUsers6OutlineDuo18 as Users,
} from "@bittery/ui/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { storage } from "@/lib/storage";

const navItems = [
	{ path: "/home", icon: Home, label: "Dashboard" },
	{ path: "/security", icon: ShieldCheck, label: "Sentinel" },
	{ path: "/team", icon: Users, label: "Team" },
	{ path: "/vaults", icon: Lock, label: "Vaults" },
	{ path: "/settings", icon: Settings, label: "Settings" },
] as const;

function UserNav() {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const { isMobile } = useSidebar();
	const userQuery = useQuery(trpc.auth.me.queryOptions());
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
							className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
						>
							<Avatar className="h-8 w-8 rounded-lg">
								<AvatarFallback className="rounded-lg text-xs">
									{initials}
								</AvatarFallback>
							</Avatar>
							<div className="grid flex-1 text-left text-sm leading-tight">
								<span className="truncate font-medium">
									{user?.name || "User"}
								</span>
								<span className="truncate text-muted-foreground text-xs">
									{user?.email || ""}
								</span>
							</div>
							<ChevronsUpDown className="ml-auto size-4" />
						</SidebarMenuButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
						side={isMobile ? "bottom" : "right"}
						align="end"
						sideOffset={4}
					>
						<DropdownMenuItem asChild>
							<Link to="/settings" className="cursor-pointer">
								<Settings className="mr-2 h-4 w-4" />
								Settings
							</Link>
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onClick={handleLogout}
							className="cursor-pointer text-destructive"
						>
							<LogOut className="mr-2 h-4 w-4" />
							Log out
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		</SidebarMenu>
	);
}

export function AppSidebar() {
	const routerState = useRouterState();
	const currentPath = routerState.location.pathname;

	return (
		<Sidebar variant="inset">
			<SidebarHeader>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton size="lg" asChild>
							<Link to="/home">
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
							</Link>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarHeader>

			<SidebarContent>
				<SidebarGroup>
					<SidebarGroupLabel>Navigation</SidebarGroupLabel>
					<SidebarGroupContent>
						<SidebarMenu>
							{navItems.map((item) => (
								<SidebarMenuItem key={item.path}>
									<SidebarMenuButton
										asChild
										isActive={currentPath.startsWith(item.path)}
										tooltip={item.label}
									>
										<Link to={item.path}>
											<item.icon />
											<span>{item.label}</span>
										</Link>
									</SidebarMenuButton>
								</SidebarMenuItem>
							))}
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
			</SidebarContent>

			<SidebarFooter>
				<UserNav />
			</SidebarFooter>
		</Sidebar>
	);
}
