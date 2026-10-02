import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { QueueItem, ReviewDetail, ReviewSummary, rpcContract } from "../server";
import { REVIEWS_CHANGED } from "../shared/findings.ts";

export type Rpc = ReturnType<typeof useReviewRpc>;

export function useReviewRpc() {
  return useRpc<typeof rpcContract>();
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

interface RealtimePayload {
  threadId?: string;
  kind?: string;
}

/** Loads data and reloads it on every Reviews realtime signal that concerns it. */
function useLive<T>(load: () => Promise<T>, relevant: (payload: RealtimePayload) => boolean, deps: readonly unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const refetch = useCallback(() => {
    const current = ++generation.current;
    load().then(
      (value) => {
        if (current !== generation.current) return;
        setData(value);
        setLoaded(true);
        setError(null);
      },
      (cause) => {
        if (current === generation.current) setError(errorMessage(cause));
      },
    );
  }, deps);
  useEffect(refetch, [refetch]);
  useRealtime(REVIEWS_CHANGED, (payload) => {
    if (relevant((payload ?? {}) as RealtimePayload)) refetch();
  });
  return { data, loaded, error, refetch };
}

export function useReview(threadId: string) {
  const rpc = useReviewRpc();
  return useLive<ReviewDetail | null>(
    async () => (await rpc.call("review_get", { threadId })).review,
    (payload) => payload.threadId === undefined || payload.threadId === threadId,
    [rpc, threadId],
  );
}

export function useReviews(includeArchived: boolean) {
  const rpc = useReviewRpc();
  return useLive<ReviewSummary[]>(async () => (await rpc.call("review_list", { projectId: null, includeArchived })).reviews, () => true, [rpc, includeArchived]);
}

export function useQueue() {
  const rpc = useReviewRpc();
  return useLive<{ fetchedAt: number; items: QueueItem[] }>(
    () => rpc.call("queue_list", { refresh: false }),
    (payload) => payload.kind === "queue" || payload.kind === "started",
    [rpc],
  );
}

export function useStats() {
  const rpc = useReviewRpc();
  return useLive(() => rpc.call("stats_get", null), (payload) => payload.kind !== "queue", [rpc]);
}

export function useLearnings() {
  const rpc = useReviewRpc();
  return useLive(async () => (await rpc.call("learnings_list", null)).learnings, (payload) => payload.kind === "learnings", [rpc]);
}

export function useProjects() {
  const rpc = useReviewRpc();
  return useLive(async () => (await rpc.call("projects_list", null)).projects, () => false, [rpc]);
}

/** Runs one action at a time and keeps its error for display. */
export function useAction() {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(name: string, action: () => Promise<T>): Promise<T | null> => {
    setPending(name);
    setError(null);
    try {
      return await action();
    } catch (cause) {
      setError(errorMessage(cause));
      return null;
    } finally {
      setPending(null);
    }
  }, []);
  return { pending, error, run, setError };
}

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function timeAgo(timestamp: number): string {
  const minutes = Math.round((timestamp - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return relativeTime.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return relativeTime.format(hours, "hour");
  return relativeTime.format(Math.round(hours / 24), "day");
}
