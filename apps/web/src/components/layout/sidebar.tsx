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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
	ChevronsUpDown,
	Home,
	Lock,
	LogOut,
	Settings,
	ShieldCheck,
	Users,
} from "lucide-react";
import { storage } from "@/lib/storage";

const navItems = [
	{ path: "/home", icon: Home, label: "Dashboard" },
	{ path: "/security", icon: ShieldCheck, label: "Security" },
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
								<img src="/logo.png" alt="Bittery" className="h-10 w-auto" />
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
