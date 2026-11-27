export function registerAppServiceWorker(
  serviceWorker: ServiceWorkerContainer,
  reload: () => void = () => window.location.reload(),
): void {
  let controlled = serviceWorker.controller !== null;
  let reloading = false;
  serviceWorker.addEventListener("controllerchange", () => {
    if (!controlled) {
      controlled = true;
      return;
    }
    if (reloading) return;
    reloading = true;
    reload();
  });
  void serviceWorker.register("/app/sw.js", { scope: "/app/" });
}
