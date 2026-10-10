// Only these local categories may cross the private startup subprocess boundary.
export const startupCategories: readonly string[] = [
	"invalid startup arguments",
	"startup deadline expired",
	"startup refuses existing invocation",
	"startup clock unavailable",
	"startup failed or restarted",
	"startup identity predates attempted start",
	"startup invocation changed",
	"startup exited",
	"startup lifecycle failure",
	"startup ready port invalid",
	"startup ready port mismatch",
	"startup changed during HTTP acceptance",
	"startup asset output limit",
	"startup asset returned HTML instead of a local asset",
	"startup HTML references unexpected asset origin/path",
	"startup inspection failed",
	"service identity: invalid response",
	"startup evidence: invalid JSON",
	"startup evidence: invalid record",
	...["service identity", "startup evidence", "start service"].flatMap((name) => [
		`${name}: inspection failed`,
		`${name}: command failed/timeout/output limit`,
	]),
];
export function startupCategory(value: string): string | undefined {
	return startupCategories.includes(value) ? value : undefined;
}
