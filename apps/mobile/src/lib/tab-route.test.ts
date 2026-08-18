/// <reference types="bun" />
/**
 * Tab roots vs pushed vault screens, and the view-transition type each
 * navigation should request. The tab bar only stays mounted across these
 * three paths; everything else is a stack screen without a bar.
 */

import { describe, expect, test } from "bun:test";
import { routeTransitionTypes, tabKeyForPath } from "./tab-route";

describe("tabKeyForPath", () => {
	test("the three tab roots map to their keys, with or without a trailing slash", () => {
		expect(tabKeyForPath("/vault/all-items")).toBe("items");
		expect(tabKeyForPath("/vault/all-items/")).toBe("items");
		expect(tabKeyForPath("/vault")).toBe("browse");
		expect(tabKeyForPath("/vault/")).toBe("browse");
		expect(tabKeyForPath("/vault/settings")).toBe("settings");
		expect(tabKeyForPath("/vault/settings/")).toBe("settings");
	});

	test("pushed vault screens and auth routes are not tab roots", () => {
		expect(tabKeyForPath("/vault/all-items/item-1")).toBeNull();
		expect(tabKeyForPath("/vault/abc-vault-id")).toBeNull();
		expect(tabKeyForPath("/vault/search")).toBeNull();
		expect(tabKeyForPath("/vault/trash")).toBeNull();
		expect(tabKeyForPath("/vault/tags")).toBeNull();
		expect(tabKeyForPath("/vault/favorites")).toBeNull();
		expect(tabKeyForPath("/vault/tag/work")).toBeNull();
		expect(tabKeyForPath("/login")).toBeNull();
		expect(tabKeyForPath("/unlock")).toBeNull();
		expect(tabKeyForPath("/")).toBeNull();
	});
});

function loc(pathname: string, index: number) {
	return { pathname, state: { __TSR_index: index } };
}

const still = { reducedMotion: false, lowEnd: false };

describe("routeTransitionTypes", () => {
	test("skips the first paint — there is no previous screen to animate from", () => {
		expect(
			routeTransitionTypes({ toLocation: loc("/vault/all-items", 0) }, still),
		).toBe(false);
	});

	test("switching between tab roots is a tab fade, never a slide", () => {
		expect(
			routeTransitionTypes(
				{
					fromLocation: loc("/vault/all-items", 1),
					toLocation: loc("/vault", 2),
				},
				still,
			),
		).toEqual(["tab"]);
		expect(
			routeTransitionTypes(
				{
					fromLocation: loc("/vault/", 2),
					toLocation: loc("/vault/settings", 3),
				},
				still,
			),
		).toEqual(["tab"]);
	});

	test("re-selecting the same tab does not animate", () => {
		expect(
			routeTransitionTypes(
				{
					fromLocation: loc("/vault/all-items", 1),
					toLocation: loc("/vault/all-items", 1),
				},
				still,
			),
		).toBe(false);
	});

	test("opening a pushed screen from a tab slides forward", () => {
		expect(
			routeTransitionTypes(
				{
					fromLocation: loc("/vault/all-items", 1),
					toLocation: loc("/vault/all-items/item-1", 2),
				},
				still,
			),
		).toEqual(["push"]);
		expect(
			routeTransitionTypes(
				{
					fromLocation: loc("/vault/all-items", 1),
					toLocation: loc("/vault/search", 2),
				},
				still,
			),
		).toEqual(["push"]);
	});

	test("the system back button from a pushed screen slides backward", () => {
		expect(
			routeTransitionTypes(
				{
					fromLocation: loc("/vault/all-items/item-1", 2),
					toLocation: loc("/vault/all-items", 1),
				},
				still,
			),
		).toEqual(["pop"]);
	});

	test("tapping a tab from a pushed screen fades, even though history still pushes", () => {
		expect(
			routeTransitionTypes(
				{
					fromLocation: loc("/vault/all-items/item-1", 2),
					toLocation: loc("/vault/settings", 3),
				},
				still,
			),
		).toEqual(["tab"]);
	});

	test("auth routes fade rather than slide into the vault", () => {
		expect(
			routeTransitionTypes(
				{
					fromLocation: loc("/login", 0),
					toLocation: loc("/vault/all-items", 1),
				},
				still,
			),
		).toEqual(["fade"]);
		expect(
			routeTransitionTypes(
				{
					fromLocation: loc("/vault/settings", 2),
					toLocation: loc("/unlock", 3),
				},
				still,
			),
		).toEqual(["fade"]);
	});

	test("reduced motion skips the snapshot entirely", () => {
		expect(
			routeTransitionTypes(
				{
					fromLocation: loc("/vault/all-items", 1),
					toLocation: loc("/vault/all-items/item-1", 2),
				},
				{ ...still, reducedMotion: true },
			),
		).toBe(false);
	});

	test("a low-end device keeps the tab fade but will not slide a full-screen snapshot", () => {
		expect(
			routeTransitionTypes(
				{
					fromLocation: loc("/vault/all-items", 1),
					toLocation: loc("/vault", 2),
				},
				{ ...still, lowEnd: true },
			),
		).toEqual(["tab"]);
		expect(
			routeTransitionTypes(
				{
					fromLocation: loc("/vault/all-items", 1),
					toLocation: loc("/vault/all-items/item-1", 2),
				},
				{ ...still, lowEnd: true },
			),
		).toEqual(["fade"]);
	});
});
