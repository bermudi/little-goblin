/**
 * Migration-only bridge from the legacy `ChatLocator` shape to the canonical
 * `Surface` value. It is used by `surface-migration.ts` when converting
 * topicless legacy locators (schedule entries that have no topicId) and is not
 * exposed in the public session API.
 */

import { dmSurface, supergroupSurface, type Surface } from "../surface.ts";
import type { ChatLocator } from "./types.ts";

/**
 * Convert a topicless legacy `ChatLocator` to a `Surface` using its explicit
 * private/supergroup metadata. Legacy locators could not represent guest or
 * direct-messages containers, and the caller is responsible for disambiguating
 * ambiguous topicless locators (no `isPrivate` flag) by matching the captured
 * session id against converted bindings.
 */
export function surfaceFromLocatorCompat(loc: ChatLocator): Surface {
  if (loc.isPrivate === true) {
    return dmSurface(loc.chatId);
  }
  if (loc.isPrivate === false) {
    return supergroupSurface(loc.chatId);
  }
  throw new Error(
    `Cannot migrate topicless locator for chat ${loc.chatId}: isPrivate metadata is missing. Resolve by matching the schedule's session against converted bindings or set isPrivate explicitly.`,
  );
}
