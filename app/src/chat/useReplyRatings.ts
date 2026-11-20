import { useEffect, useState } from "react";
import { rateReply } from "../api.ts";
import type {
  AppRatedReply,
  AppReplyRating,
} from "../../../src/http/app-wire.ts";

export function useReplyRatings(
  token: string | null,
  conversationId: string,
  initialRatings: AppRatedReply[],
  initialRateableIds: string[],
) {
  const [ratings, setRatings] = useState<Record<string, AppRatedReply>>(() =>
    Object.fromEntries(initialRatings.map((rating) => [rating.messageId, rating])),
  );
  const [ratingPending, setRatingPending] = useState<string | null>(null);
  const [ratingErrors, setRatingErrors] = useState<Record<string, string>>({});
  const [rateableIds, setRateableIds] = useState<ReadonlySet<string>>(
    () => new Set(initialRateableIds),
  );

  const applyRatingSnapshot = (next: AppRatedReply[], nextIds: string[]) => {
    setRatings(
      Object.fromEntries(next.map((rating) => [rating.messageId, rating])),
    );
    setRateableIds(new Set(nextIds));
  };

  useEffect(() => {
    setRatings(Object.fromEntries(initialRatings.map((r) => [r.messageId, r])));
    setRatingPending(null);
    setRatingErrors({});
    setRateableIds(new Set(initialRateableIds));
  }, [initialRatings, initialRateableIds]);

  const rate = (messageId: string, rating: AppReplyRating) => {
    if (ratingPending !== null) return;
    setRatingPending(messageId);
    setRatingErrors((errors) => {
      const next = { ...errors };
      delete next[messageId];
      return next;
    });
    void rateReply(token, conversationId, messageId, rating)
      .then(
        (res) =>
          setRatings((current) => ({ ...current, [messageId]: res.rating })),
        (err: unknown) =>
          setRatingErrors((errors) => ({
            ...errors,
            [messageId]: err instanceof Error ? err.message : "rating failed",
          })),
      )
      .finally(() => setRatingPending(null));
  };

  return {
    ratings,
    ratingPending,
    ratingErrors,
    rateableIds,
    rate,
    applyRatingSnapshot,
  };
}
