// Installability + Web Push shim + offline app shell. Each build stamps
// SHELL below with the dist file list and a content hash, so the shell is
// cached per build in `goblin-shell-<hash>`. The network wins whenever it
// answers within NAV_TIMEOUT_MS — even a 500 stays loud — and only the
// static shell is ever cached; data (/api/*) is never seen by this worker
// and never cached.
const SHELL = null; // replaced at build: { build, files }
const NAV_TIMEOUT_MS = 3000;
const CACHE_PREFIX = "goblin-shell-";
const CACHE_NAME = SHELL === null ? null : `${CACHE_PREFIX}${SHELL.build}`;

self.addEventListener("install", (event) => {
	if (SHELL === null || CACHE_NAME === null) {
		event.waitUntil(self.skipWaiting());
		return;
	}
	// A failed precache fails the install — no half-cached shell.
	event.waitUntil(
		caches
			.open(CACHE_NAME)
			.then((cache) =>
				cache.addAll(SHELL.files.map((url) => new Request(url, { cache: "reload" }))),
			)
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys
						.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
						.map((key) => caches.delete(key)),
				),
			)
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	if (SHELL === null || CACHE_NAME === null) return;
	const request = event.request;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin || !url.pathname.startsWith("/app/")) return;

	if (request.mode === "navigate") {
		event.respondWith(
			new Promise((resolve) => {
				const network = fetch(request);
				// Any response — 404, 500 — is returned as-is; server errors
				// stay loud. Only a rejection or a stall past the timeout
				// falls back to the cached shell.
				const fallback = () =>
					caches
						.open(CACHE_NAME)
						.then((cache) => cache.match("/app/index.html"))
						.then((cached) => {
							if (cached !== undefined) resolve(cached);
							else network.then(resolve, resolve);
						});
				const timer = setTimeout(fallback, NAV_TIMEOUT_MS);
				network.then(
					(response) => {
						clearTimeout(timer);
						resolve(response);
					},
					() => {
						clearTimeout(timer);
						fallback();
					},
				);
			}),
		);
		return;
	}

	if (SHELL.files.includes(url.pathname)) {
		event.respondWith(
			caches
				.open(CACHE_NAME)
				.then((cache) => cache.match(request))
				.then((cached) => cached ?? fetch(request)),
		);
	}
});

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
