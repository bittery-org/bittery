import { protectedProcedure, publicProcedure, router } from "../index";
import { authRouter } from "./auth";
import { teamRouter } from "./team";
import { vaultRouter } from "./vault";

export const appRouter = router({
	healthCheck: publicProcedure.query(() => {
		return "OK";
	}),
	privateData: protectedProcedure.query(({ ctx }) => {
		return {
			message: "This is private",
			user: ctx.session,
		};
	}),
	auth: authRouter,
	team: teamRouter,
	vault: vaultRouter,
});
export type AppRouter = typeof appRouter;
