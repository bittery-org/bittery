import { useQuery } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	Outlet,
	useParams,
} from "@tanstack/react-router";
import { useTRPC } from "@bittery/shared/trpc";
import { Favicon } from "../../../components/vault/favicon";

export const Route = createFileRoute("/vault/$id")({
	component: RouteComponent,
});

interface ItemOverview {
	title: string;
	url?: string;
	username?: string;
}

interface Item {
	id: string;
	vaultId: string;
	category: "login" | "secure-note";
	overview: ItemOverview;
	encryptedData: string;
	encryptionIv: string;
	encryptionAlgorithm: string;
	createdAt: string;
	updatedAt: string;
	deletedAt: string | null;
}

function RouteComponent() {
	const trpc = useTRPC();

	const { id, itemId } = useParams({ strict: false });

	// Fetch items for the selected vault
	const { data: rawItems = [] } = useQuery({
		...trpc.vault.listItems.queryOptions({
			vaultId: id || "",
		}),
		enabled: !!id,
	});

	// Convert raw items to Item type
	const items: Item[] = rawItems.map((item) => ({
		...item,
		overview: item.overview as ItemOverview,
	}));

	return (
		<>
			<div className="flex w-96 flex-col border-r bg-background">
				<div className="flex-1 overflow-y-auto">
					{items.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center p-8 text-center">
							<h3 className="mb-2 font-semibold">No items yet</h3>
							<p className="text-muted-foreground text-sm">
								Create your first item
							</p>
						</div>
					) : (
						<div className="flex flex-col p-2">
							{id &&
								items.map((item) => (
									<Link
										to="/vault/$id/$itemId"
										params={{ id: id, itemId: item.id }}
										key={item.id}
										className={`mb-1 w-full rounded-md px-3 py-2.5 text-left transition-colors ${
											itemId === item.id ? "bg-muted/60" : "hover:bg-muted/30"
										}`}
									>
										<div className="flex min-w-0 items-center gap-3">
											<Favicon
												url={item.overview.url}
												title={item.overview.title}
												category={item.category}
												size="sm"
											/>
											<div className="min-w-0 flex-1">
												<div className="truncate font-medium text-sm">
													{item.overview.title}
												</div>
												{item.overview.username && (
													<div className="mt-0.5 truncate text-muted-foreground text-xs">
														{item.overview.username}
													</div>
												)}
											</div>
										</div>
									</Link>
								))}
						</div>
					)}
				</div>
			</div>

			<div className="flex h-full flex-1 flex-col">
				<div className="flex flex-1 flex-col overflow-y-auto">
					<Outlet />
				</div>
			</div>
		</>
	);
}
