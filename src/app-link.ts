// The one app deep-link builder — shared by the delegate tool and the
// bell so the shape can't drift. appId is the id without the "app/" prefix.

export function appLink(publicUrl: string, appId: string): string {
	return `${publicUrl.replace(/\/+$/, "")}/app/c/${appId}`;
}
