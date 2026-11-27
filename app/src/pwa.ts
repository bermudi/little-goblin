const UPDATE_INTERVAL_MS = 5_000;

export function registerAppServiceWorker(
  serviceWorker: ServiceWorkerContainer,
  reload: () => void = () => window.location.reload(),
  updateIntervalMs = UPDATE_INTERVAL_MS,
): () => void {
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
  const registration = serviceWorker
    .register("/app/sw.js", { scope: "/app/" })
    .then((ready) => ready, () => null);
  let updating = false;
  const checkForUpdate = () => {
    if (updating) return;
    updating = true;
    void registration
      .then((ready) => ready?.update())
      .catch(() => {})
      .finally(() => {
        updating = false;
      });
  };
  checkForUpdate();
  const timer = setInterval(checkForUpdate, updateIntervalMs);
  return () => clearInterval(timer);
}
