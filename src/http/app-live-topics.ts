export const APP_LIVE_TOPICS = [
	"conversations",
	"notes",
	"attention",
	"approvals",
	"activity",
	"programs",
	"delegations",
	"skills",
] as const;

export type AppLiveTopic = (typeof APP_LIVE_TOPICS)[number];

export type AppLiveVersions = Record<AppLiveTopic, string>;

export interface AppLiveEvent {
	type: "versions";
	versions: AppLiveVersions;
}

export const APP_LIVE_VERSION_HEADER = "x-goblin-version";
