// Installability + Web Push shim. goblin is online-only — every byte comes
// from the live server, so this worker caches nothing and changes nothing.
// Network stays the single source of truth.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

self.addEventListener("push", (event) => {
	let data = {};
	try {
		const parsed = event.data === null ? null : event.data.json();
		data = parsed !== null && typeof parsed === "object" ? parsed : {};
	} catch {
		data = {};
	}
	const target = typeof data.url === "string" && data.url.startsWith("/app/") ? data.url : "/app/";
	event.waitUntil(
		self.registration.showNotification(
			typeof data.title === "string" && data.title !== "" ? data.title : "goblin",
			{
				body:
					typeof data.body === "string" && data.body !== ""
						? data.body
						: "A background turn needs your attention",
				icon: "/app/icon-192.png",
				badge: "/app/icon-192.png",
				tag: typeof data.tag === "string" ? data.tag : "goblin-attention",
				data: { url: target },
			},
		),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const target = event.notification.data?.url ?? "/app/";
	const url = new URL(target, self.location.origin);
	const targetUrl =
		url.origin === self.location.origin ? url.href : new URL("/app/", self.location.origin).href;
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			for (const client of windows) {
				const current = new URL(client.url, self.location.origin);
				if (current.origin !== self.location.origin || !current.pathname.startsWith("/app/"))
					continue;
				await client.focus();
				if (current.href !== targetUrl) await client.navigate(targetUrl);
				return;
			}
			await self.clients.openWindow(targetUrl);
		})(),
	);
});
