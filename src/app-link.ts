// The app channel's deep link (design/app.md → Spin-off → Links):
// {publicUrl}/app/c/<appId> opens one conversation in the client. The
// one builder — shared by the delegate tool's moved_to_app render and
// the bell's Open-in-app button so the shape can never drift.
// appId is the id without the "app/" prefix.

export function appLink(publicUrl: string, appId: string): string {
	return `${publicUrl.replace(/\/+$/, "")}/app/c/${appId}`;
}
