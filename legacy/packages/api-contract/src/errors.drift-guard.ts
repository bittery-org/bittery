/**
 * Compile-time pin between `./errors`' `ApiProblem` and the generated
 * `ProblemDetails` it mirrors.
 *
 * `ApiProblem` cannot simply alias the generated schema: everything past `code`
 * is optional here on purpose, because `normalizeApiError` also has to cope with
 * a proxy or gateway that returns a partial problem document. That leniency is
 * what hid the drift risk — rename `requestId` server-side and nothing failed,
 * the field just silently stopped being populated. ADR 0012 asks for a guard
 * wherever a package restates its generator's output, and `packages/api-contract`
 * had none at all.
 *
 * It is TYPE-ONLY by construction: every declaration is a `type` alias, so
 * nothing is emitted and no module imports this at runtime. The vocabulary
 * mirrors `packages/sync/src/types.drift-guard.ts`.
 *
 * A guard fails as `Type 'X' does not satisfy the constraint 'true'` where `X`
 * names the field that drifted.
 */

import type { ApiProblem, ApiProblemFieldError } from "./errors";
import type { components } from "./generated/schema";

type WireProblem = components["schemas"]["ProblemDetails"];
type WireProblemFieldError = components["schemas"]["ProblemFieldError"];

/** Fails as "Type 'false' does not satisfy the constraint 'true'", naming the guard. */
type Assert<Holds extends true> = Holds;

/** `true`, or the members that are on one side only — so the error names them. */
type SameMembers<Left, Right> = [
	Exclude<Left, Right> | Exclude<Right, Left>,
] extends [never]
	? true
	: Exclude<Left, Right> | Exclude<Right, Left>;

/** Field names only, ignoring optionality. Catches an added or removed field. */
type SameFields<Left, Right> = SameMembers<keyof Left, keyof Right>;

/**
 * The field lists still agree. A field the server adds lands here rather than
 * being invisible to every consumer; a field the server removes stops
 * `ApiProblem` from advertising something that can never arrive.
 */
export type ProblemFieldsMatchWire = Assert<
	SameFields<ApiProblem, WireProblem>
>;

export type ProblemFieldErrorFieldsMatchWire = Assert<
	SameFields<ApiProblemFieldError, WireProblemFieldError>
>;

/**
 * A problem document that came off the wire satisfies the client interface —
 * which is what `normalizeApiError` assumes when it casts a parsed body. This is
 * one-directional on purpose: the reverse does not hold, because the client type
 * is the lenient one.
 *
 * `code` is the generated `ErrorCode` union above the seam and a plain `string`
 * below it; a narrowing there is fine, a widening is not, and this catches the
 * widening.
 */
export type WireProblemSatisfiesClient = Assert<
	WireProblem extends ApiProblem ? true : false
>;

export type WireProblemFieldErrorSatisfiesClient = Assert<
	WireProblemFieldError extends ApiProblemFieldError ? true : false
>;
