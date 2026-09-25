# Connected Extension Item read authority

Type: grilling
Status: resolved
Blocked by: 60, 64

## Question

With Extension-local durable Operations retained by decision 64, does a connected Extension render
its own Runtime Replica (including pending local writes), or preserve Desktop Item snapshots as its
read source while connected?

## Evidence and recommendation

Actual `apps/extension/src/background/desktop-snapshot.ts`, `desktop-sync.ts`, and
`native-messaging.ts` read Desktop snapshots but perform writes locally. Native Runtime migration
makes accepted offline writes visible in each Runtime's own projections; routing connected reads
to Desktop can omit the Extension's pending work and requires a separately specified composition
of source projections and local Operations.

Recommend Extension Runtime Item reads, with Desktop native messaging supplying Account/lock state
and generation-bound key authorization. This gives each Runtime one Item authority, but Desktop
changes reach the Extension after Server convergence. That observable timing choice is not assumed
from decision 64, which settled write ownership and transfer, not connected read presentation.

## Comments

2026-09-08: maintainer question pending. Transfer/read cutover specification cannot close this
frontier by silently removing Desktop snapshots or hiding pending Extension Operations.

2026-09-08: maintainer accepted Extension Runtime Item reads. The connected Extension renders its
own Replica and pending Operations. Native messaging supplies Desktop Account/lock state and key
authorization; Desktop changes become visible after Server convergence. Remove connected Desktop
Item-snapshot consumers during the Extension cutover, then delete the snapshot transport when no
remaining caller uses it. This does not move Extension Operations to Desktop or weaken lock authority.
