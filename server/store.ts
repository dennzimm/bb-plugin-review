import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { JsonObject } from "./json.ts";
export type { JsonObject };
import { z } from "zod";
import { checkResultSchema, dependencyReportSchema, forgeSchema, postedRefSchema } from "../contract.ts";
import {
  complianceStatuses,
  findingCategories,
  findingSeverities,
  findingStatuses,
  verdicts,
  type Finding,
  type ReviewReport,
} from "../shared/findings.ts";
import { depths } from "./settings.ts";

const findingSchema = z.object({
  id: z.string(),
  round: z.number().int().positive(),
  severity: z.enum(findingSeverities),
  title: z.string(),
  file: z.string().nullable(),
  startLine: z.number().int().nullable(),
  endLine: z.number().int().nullable(),
  body: z.string(),
  suggestion: z.string().nullable(),
  suggestionStartLine: z.number().int().nullable().catch(null),
  suggestionEndLine: z.number().int().nullable().catch(null),
  confidence: z.number().nullable(),
  evidence: z.string().nullable(),
  category: z.enum(findingCategories).nullable(),
  status: z.enum(findingStatuses),
  statusNote: z.string().nullable(),
  posted: postedRefSchema.nullable(),
}) satisfies z.ZodType<Finding>;

const reportSchema = z.object({
  verdict: z.enum(verdicts).nullable(),
  summary: z.string().nullable(),
  walkthrough: z.string().nullable(),
  questions: z.array(z.string()),
  limitations: z.array(z.string()),
  compliance: z.object({ status: z.enum(complianceStatuses), notes: z.string() }).nullable(),
  source: z.enum(["tool", "text"]),
  round: z.number().int().positive(),
  reportedAt: z.number(),
}) satisfies z.ZodType<ReviewReport>;

const riskSchema = z.object({
  level: z.enum(["low", "medium", "high"]),
  score: z.number(),
  reasons: z.array(z.string()),
  splitSuggested: z.boolean(),
  reviewedLines: z.number(),
  files: z.number(),
  areas: z.array(z.string()),
});
export type Risk = z.infer<typeof riskSchema>;

const stageSchema = z.enum(["pending", "running", "passed", "failed", "skipped", "ready", "stopped"]);

/**
 * Everything the plugin knows about one review thread. Every field defaults,
 * so reviews created by older plugin versions still parse.
 */
export const reviewMetadataSchema = z.object({
  /** 1 for reviews created before structured findings; their worktrees are left as they are. */
  version: z.number().int().catch(1),
  role: z.enum(["primary", "second-opinion"]).catch("primary"),
  primaryThreadId: z.string().nullable().catch(null),
  source: z.string(),
  forge: forgeSchema.nullable().catch(null),
  number: z.number().int().nullable().catch(null),
  url: z.string().nullable().catch(null),
  title: z.string().nullable().catch(null),
  headRef: z.string(),
  headSha: z.string(),
  previousHeadSha: z.string().nullable().catch(null),
  targetRef: z.string(),
  mergeBaseSha: z.string().nullable().catch(null),
  mergeBaseApplied: z.boolean().catch(false),
  guarded: z.boolean().catch(false),
  depth: z.enum(depths).catch("standard"),
  round: z.number().int().positive().catch(1),
  allowPosting: z.boolean().catch(false),
  findings: z.array(findingSchema).catch([]),
  report: reportSchema.nullable().catch(null),
  ticket: z.object({ key: z.string(), summary: z.string().nullable(), status: z.string().nullable(), url: z.string().nullable() }).nullable().catch(null),
  risk: riskSchema.nullable().catch(null),
  dependencies: dependencyReportSchema.nullable().catch(null),
  rules: z.array(z.string()).catch([]),
  checks: z.object({ status: stageSchema, results: z.array(checkResultSchema), startedAt: z.number().nullable() }).nullable().catch(null),
  preview: z.object({ status: stageSchema, url: z.string(), terminalId: z.string().nullable() }).nullable().catch(null),
  secondOpinion: z
    .object({ threadId: z.string().nullable(), status: z.enum(["running", "delivered", "failed"]), error: z.string().nullable().catch(null) })
    .nullable()
    .catch(null),
  readOnlyViolations: z.array(z.string()).catch([]),
  newCommits: z.object({ headSha: z.string(), seenAt: z.number() }).nullable().catch(null),
  mrState: z.enum(["opened", "merged", "closed", "unknown"]).nullable().catch(null),
  /** Verdict and counts written by plugin versions before structured findings. */
  outcome: z
    .object({ verdict: z.enum(verdicts).nullable(), findings: z.record(z.string(), z.number()) })
    .nullable()
    .catch(null),
});
export type ReviewMetadata = z.infer<typeof reviewMetadataSchema>;

export function toJson(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

export function reviewStore(bb: BbPluginApi) {
  async function read(threadId: string): Promise<ReviewMetadata | null> {
    const raw = await bb.sdk.threads.getPluginMetadata({ threadId }).catch(() => null);
    const parsed = reviewMetadataSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  async function patch(threadId: string, set: Partial<ReviewMetadata>): Promise<ReviewMetadata> {
    const updated = await bb.sdk.threads.updatePluginMetadata({ threadId, set: toJson(set) });
    return reviewMetadataSchema.parse(updated);
  }

  /** Read-modify-write of one review; serialized per thread so concurrent events cannot drop updates. */
  const locks = new Map<string, Promise<unknown>>();
  async function update(threadId: string, change: (current: ReviewMetadata) => Partial<ReviewMetadata> | null): Promise<ReviewMetadata | null> {
    const previous = locks.get(threadId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const current = await read(threadId);
      if (current === null) return null;
      const set = change(current);
      return set === null ? current : patch(threadId, set);
    });
    const tail: Promise<unknown> = next
      .catch(() => undefined)
      .finally(() => {
        if (locks.get(threadId) === tail) locks.delete(threadId);
      });
    locks.set(threadId, tail);
    return next;
  }

  return { read, patch, update };
}
export type ReviewStore = ReturnType<typeof reviewStore>;
