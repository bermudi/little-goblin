// Installability shim: a registered service worker with a fetch handler
// is what makes the PWA installable. goblin is online-only — every byte
// comes from the live server, so this worker caches nothing and changes
// nothing. Network stays the single source of truth.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
