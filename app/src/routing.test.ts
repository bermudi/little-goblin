import { describe, expect, test } from "bun:test";
import { pathOfRoute, routeFromPath, sameRoute, type Route } from "./routing.ts";

describe("route conversion", () => {
	test.each([
		"/app/",
		"/app/c/abc",
		"/app/c/abc/window",
		"/app/p/abc",
		"/app/n/abc",
		"/app/settings",
		"/app/archive",
	])("round trips %s", (path) => {
		expect(pathOfRoute(routeFromPath(path))).toBe(path);
	});

	test.each(["/app/nope", "/app/c/abc/extra"])("normalizes invalid path %s", (path) => {
		expect(routeFromPath(path)).toEqual({ kind: "home", composing: false });
	});

	test("accepts page paths through the Telegram door", () => {
		expect(routeFromPath("/t/settings")).toEqual({ kind: "page", page: "settings" });
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
