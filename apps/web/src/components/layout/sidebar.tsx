import { useTRPC } from "@bittery/shared/trpc";
import {
	Avatar,
	AvatarFallback,
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	ScrollArea,
	Separator,
	Sheet,
	SheetContent,
	SheetTrigger,
} from "@bittery/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
	Home,
	KeyRound,
	Lock,
	LogOut,
	Menu,
	Settings,
	ShieldCheck,
	Users,
} from "lucide-react";
import { storage } from "@/lib/storage";

const navItems = [
	{ path: "/home", icon: Home, label: "Dashboard" },
	{ path: "/security", icon: ShieldCheck, label: "Security" },
	{ path: "/teams", icon: Users, label: "Teams" },
	{ path: "/vaults", icon: Lock, label: "Vaults" },
	{ path: "/settings", icon: Settings, label: "Settings" },
] as const;

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
	const routerState = useRouterState();
	const currentPath = routerState.location.pathname;

	return (
		<nav className="flex flex-col gap-1">
			{navItems.map((item) => {
				const isActive = currentPath.startsWith(item.path);
				return (
					<Link
						key={item.path}
						to={item.path}
						onClick={onNavigate}
						className={`flex items-center gap-3 rounded-lg px-3 py-2 font-medium text-sm transition-colors ${
							isActive
								? "bg-primary text-primary-foreground"
								: "text-muted-foreground hover:bg-muted hover:text-foreground"
						}`}
					>
						<item.icon className="h-4 w-4" />
						{item.label}
					</Link>
				);
			})}
		</nav>
	);
}

function UserNav() {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
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
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" className="w-full justify-start gap-3 px-3">
					<Avatar className="h-8 w-8">
						<AvatarFallback className="text-xs">{initials}</AvatarFallback>
					</Avatar>
					<div className="flex flex-col items-start text-left">
						<span className="font-medium text-sm">{user?.name || "User"}</span>
						<span className="max-w-[140px] truncate text-muted-foreground text-xs">
							{user?.email || ""}
						</span>
					</div>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-56">
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
	);
}

export function Sidebar() {
	return (
		<aside className="hidden w-64 flex-col border-r bg-background lg:flex">
			<div className="flex h-14 items-center gap-2 border-b px-4">
				<div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
					<KeyRound className="h-4 w-4" />
				</div>
				<span className="font-bold text-lg">Bittery</span>
			</div>
			<ScrollArea className="flex-1 px-3 py-4">
				<NavLinks />
			</ScrollArea>
			<Separator />
			<div className="p-3">
				<UserNav />
			</div>
		</aside>
	);
}

export function MobileNav() {
	return (
		<Sheet>
			<SheetTrigger asChild>
				<Button variant="ghost" size="icon" className="lg:hidden">
					<Menu className="h-5 w-5" />
					<span className="sr-only">Toggle menu</span>
				</Button>
			</SheetTrigger>
			<SheetContent side="left" className="w-64 p-0">
				<div className="flex h-14 items-center gap-2 border-b px-4">
					<div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
						<KeyRound className="h-4 w-4" />
					</div>
					<span className="font-bold text-lg">Bittery</span>
				</div>
				<ScrollArea className="flex-1 px-3 py-4">
					<NavLinks />
				</ScrollArea>
				<Separator />
				<div className="p-3">
					<UserNav />
				</div>
			</SheetContent>
		</Sheet>
	);
}
