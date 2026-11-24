import { describe, expect, test } from "bun:test";
import { openingRoute, pathOfRoute, routeFromPath, sameRoute, type Route } from "./routing.ts";

describe("route conversion", () => {
	test.each([
		"/app/",
		"/app/c/abc",
		"/app/c/abc/window",
		"/app/p/abc",
		"/app/n/abc",
		"/app/settings",
		"/app/archive",
		"/app/rolling",
	])("round trips %s", (path) => {
		expect(pathOfRoute(routeFromPath(path))).toBe(path);
	});

	test.each(["/app/nope", "/app/c/abc/extra"])("normalizes invalid path %s", (path) => {
		expect(routeFromPath(path)).toEqual({ kind: "home", composing: false });
	});

	test("accepts page paths through the Telegram door", () => {
		expect(routeFromPath("/t/settings")).toEqual({ kind: "page", page: "settings" });
	});

	test("rolling chat is a PWA-only page", () => {
		expect(routeFromPath("/app/rolling")).toEqual({ kind: "page", page: "rolling" });
		expect(routeFromPath("/t/rolling")).toEqual({ kind: "home", composing: false });
	});

	test.each([
		["/app/", null, { kind: "page", page: "rolling" }],
		["/app/nope", { other: 1 }, { kind: "page", page: "rolling" }],
		["/app/", { goblinIndex: 0, goblinSegment: "a" }, { kind: "home", composing: false }],
		["/app/settings", null, { kind: "page", page: "settings" }],
		["/app/c/abc", null, { kind: "home", composing: false }],
	] as const)("opens %s with history %j as %j", (path, state, route) => {
		expect(openingRoute(path, state)).toEqual(route);
	});

	test("conversation and window ids include their channel prefix", () => {
		expect(routeFromPath("/app/c/abc")).toEqual({ kind: "conversation", id: "app/abc" });
		expect(routeFromPath("/app/c/abc/window")).toEqual({ kind: "window", id: "app/abc" });
	});

	test("home equality includes staged composer state", () => {
		const staged: Route = { kind: "home", composing: true };
		const idle: Route = { kind: "home", composing: false };
		expect(sameRoute(staged, idle)).toBe(false);
		expect(sameRoute(staged, staged)).toBe(true);
	});
});
