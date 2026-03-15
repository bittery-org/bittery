import { initTRPC, TRPCError } from "@trpc/server";
import type { Context } from "./context";

function shouldExposeTrpcErrorDetails(): boolean {
	return (
		process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test"
	);
}

export function formatTrpcErrorShape<
	TShape extends { data: Record<string, unknown> },
>(shape: TShape): TShape {
	if (shouldExposeTrpcErrorDetails()) {
		return shape;
	}

	return {
		...shape,
		data: {
			...shape.data,
			stack: undefined,
		},
	};
}

export const t = initTRPC.context<Context>().create({
	errorFormatter({ shape }) {
		return formatTrpcErrorShape(shape);
	},
});

export const router = t.router;

export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
	if (!ctx.session) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "Authentication required",
			cause: "No session",
		});
	}
	return next({
		ctx: {
			...ctx,
			session: ctx.session,
		},
	});
});

export { z } from "zod";
