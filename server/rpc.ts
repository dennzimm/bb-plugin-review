import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { reviewSuggestionsSchema } from "../contract.ts";
import type { Finding, ReviewReport } from "../shared/findings.ts";
import type { Learning, LearningsStore } from "./learnings.ts";
import { startReviewSchema, type QueueItem, type ReviewService, type ReviewSummary, type StartedReview } from "./service.ts";
import type { ReviewMetadata, ReviewStore } from "./store.ts";

export interface ReviewDetail {
  threadId: string;
  projectId: string;
  environmentId: string | null;
  title: string;
  status: string;
  label: string;
  url: string | null;
  forge: ReviewMetadata["forge"];
  depth: ReviewMetadata["depth"];
  round: number;
  headSha: string;
  targetRef: string;
  allowPosting: boolean;
  findings: Finding[];
  report: ReviewReport | null;
  ticket: ReviewMetadata["ticket"];
  risk: ReviewMetadata["risk"];
  dependencies: ReviewMetadata["dependencies"];
  rules: string[];
  checks: { status: string; results: Array<{ command: string; exitCode: number | null; durationMs: number; timedOut: boolean }> } | null;
  preview: ReviewMetadata["preview"];
  secondOpinion: ReviewMetadata["secondOpinion"];
  readOnlyViolations: string[];
  newCommits: ReviewMetadata["newCommits"];
  mrState: ReviewMetadata["mrState"];
}

const threadInput = z.object({ threadId: z.string().min(1) });

export const rpcContract = defineRpcContract({
  review_start: { input: startReviewSchema, output: z.custom<StartedReview>() },
  review_list: {
    input: z.object({ projectId: z.string().min(1).nullable(), includeArchived: z.boolean().default(false) }),
    output: z.object({ reviews: z.array(z.custom<ReviewSummary>()) }),
  },
  review_get: { input: threadInput, output: z.object({ review: z.custom<ReviewDetail>().nullable() }) },
  review_suggestions: {
    input: z.object({ projectId: z.string().min(1), refresh: z.boolean().default(false) }),
    output: reviewSuggestionsSchema,
  },
  review_again: { input: threadInput, output: z.object({ headSha: z.string(), round: z.number() }) },
  review_post: {
    input: threadInput.extend({ findingIds: z.array(z.string()).nullable().default(null), publish: z.boolean().default(false) }),
    output: z.object({
      posted: z.array(z.string()),
      failed: z.array(z.object({ id: z.string(), error: z.string().nullable() })),
      warnings: z.array(z.string()),
      published: z.boolean(),
    }),
  },
  review_publish: { input: threadInput, output: z.object({ published: z.boolean(), detail: z.string() }) },
  review_dismiss: {
    input: threadInput.extend({ findingId: z.string().min(1), reason: z.string().max(1000).default(""), remember: z.boolean().default(false) }),
    output: z.object({ ok: z.literal(true) }),
  },
  review_reopen: { input: threadInput.extend({ findingId: z.string().min(1) }), output: z.object({ ok: z.literal(true) }) },
  review_sync: { input: threadInput, output: z.object({ ok: z.literal(true) }) },
  review_stop_preview: { input: threadInput, output: z.object({ ok: z.literal(true) }) },
  review_second_opinion: { input: threadInput, output: z.object({ ok: z.literal(true) }) },
  queue_list: { input: z.object({ refresh: z.boolean().default(false) }), output: z.object({ fetchedAt: z.number(), items: z.array(z.custom<QueueItem>()) }) },
  stats_get: {
    input: z.null(),
    output: z.object({
      reviews: z.number(),
      reported: z.number(),
      posted: z.number(),
      accepted: z.number(),
      dismissed: z.number(),
      acceptanceRate: z.number().nullable(),
    }),
  },
  learnings_list: { input: z.null(), output: z.object({ learnings: z.array(z.custom<Learning>()) }) },
  learnings_add: {
    input: z.object({ projectId: z.string().nullable(), text: z.string().trim().min(1).max(1000) }),
    output: z.custom<Learning>(),
  },
  learnings_remove: { input: z.object({ id: z.string().min(1) }), output: z.object({ removed: z.boolean() }) },
  projects_list: { input: z.null(), output: z.object({ projects: z.array(z.object({ id: z.string(), name: z.string() })) }) },
});

export async function reviewDetail(bb: BbPluginApi, store: ReviewStore, threadId: string): Promise<ReviewDetail | null> {
  const meta = await store.read(threadId);
  if (meta === null) return null;
  const thread = await bb.sdk.threads.get({ threadId });
  return {
    threadId,
    projectId: thread.projectId,
    environmentId: thread.environmentId,
    title: thread.title ?? thread.titleFallback ?? threadId,
    status: thread.status,
    label: meta.number !== null ? `${meta.forge === "github" ? "#" : "!"}${meta.number}` : meta.headRef,
    url: meta.url,
    forge: meta.forge,
    depth: meta.depth,
    round: meta.round,
    headSha: meta.headSha,
    targetRef: meta.targetRef,
    allowPosting: meta.allowPosting,
    findings: meta.findings,
    report: meta.report,
    ticket: meta.ticket,
    risk: meta.risk,
    dependencies: meta.dependencies,
    rules: meta.rules,
    checks:
      meta.checks === null
        ? null
        : {
            status: meta.checks.status,
            results: meta.checks.results.map(({ command, exitCode, durationMs, timedOut }) => ({ command, exitCode, durationMs, timedOut })),
          },
    preview: meta.preview,
    secondOpinion: meta.secondOpinion,
    readOnlyViolations: meta.readOnlyViolations,
    newCommits: meta.newCommits,
    mrState: meta.mrState,
  };
}

export function registerRpc(bb: BbPluginApi, service: ReviewService, store: ReviewStore, learnings: LearningsStore) {
  bb.rpc.register(rpcContract, {
    review_start: (input) => service.startReview(input),
    review_list: async ({ projectId, includeArchived }) => ({ reviews: await service.listReviews(projectId, includeArchived) }),
    review_get: async ({ threadId }) => ({ review: await reviewDetail(bb, store, threadId) }),
    review_suggestions: ({ projectId, refresh }) => service.suggestions(projectId, refresh),
    review_again: ({ threadId }) => service.reReview(threadId),
    review_post: ({ threadId, findingIds, publish }) => service.postFindings(threadId, { findingIds, publish }),
    review_publish: ({ threadId }) => service.publishDrafts(threadId),
    review_dismiss: async ({ threadId, findingId, reason, remember }) => {
      await service.dismissFinding(threadId, findingId, reason, remember);
      return { ok: true as const };
    },
    review_reopen: async ({ threadId, findingId }) => {
      await service.reopenFinding(threadId, findingId);
      return { ok: true as const };
    },
    review_sync: async ({ threadId }) => {
      await service.syncReview(threadId);
      return { ok: true as const };
    },
    review_second_opinion: async ({ threadId }) => {
      await service.retrySecondOpinion(threadId);
      return { ok: true as const };
    },
    review_stop_preview: async ({ threadId }) => {
      await service.stopPreview(threadId);
      return { ok: true as const };
    },
    queue_list: async ({ refresh }) => {
      if (refresh) await service.sweep();
      return service.readQueue();
    },
    stats_get: () => service.stats(),
    learnings_list: async () => ({ learnings: await learnings.all() }),
    learnings_add: async ({ projectId, text }) => {
      const learning = await learnings.add({ projectId, text, origin: null });
      service.publish({ kind: "learnings" });
      return learning;
    },
    learnings_remove: async ({ id }) => {
      const removed = await learnings.remove(id);
      service.publish({ kind: "learnings" });
      return { removed };
    },
    projects_list: async () => ({
      projects: (await bb.sdk.projects.list()).filter((project) => project.kind === "standard").map((project) => ({ id: project.id, name: project.name })),
    }),
  });
}
