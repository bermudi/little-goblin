/**
 * Compatibility bridge from the legacy `ChatLocator` + flags shape to the
 * canonical `Surface` value. This exists only to keep not-yet-migrated callers
 * compiling and behaving correctly during the phased Surface migration; it
 * is removed once all callers pass complete `Surface` values.
 */

import {
  dmSurface,
  guestSurface,
  supergroupSurface,
  topicSurface,
  type Surface,
} from "../surface.ts";
import type { ChatLocator } from "./types.ts";

export interface SurfaceCompatOpts {
  isSupergroup?: boolean;
  isGuest?: boolean;
}

/**
 * Convert a legacy `ChatLocator` and optional routing flags to a `Surface`.
 *
 * - DM: topicless, positive chat id, no guest/supergroup flag.
 * - Supergroup: topicless, `isSupergroup` flag or negative chat id.
 * - Guest: `isGuest` flag.
 * - Topic: `topicId` present; container is `private` when `loc.isPrivate` is
 *   true, otherwise `supergroup`.
 *
 * This helper intentionally does not produce `direct-messages` container
 * surfaces; legacy callers had no representation for that lane.
 */
export function surfaceFromLocatorCompat(loc: ChatLocator, opts?: SurfaceCompatOpts): Surface {
  if (opts?.isGuest) {
    return guestSurface(loc.chatId);
  }

  if (loc.topicId !== undefined) {
    const container = loc.isPrivate === true ? "private" : "supergroup";
    return topicSurface(container, loc.chatId, loc.topicId);
  }

  if (opts?.isSupergroup || loc.chatId < 0) {
    return supergroupSurface(loc.chatId);
  }

  return dmSurface(loc.chatId);
}
