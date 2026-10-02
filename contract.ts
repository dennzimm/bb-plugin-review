import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const forgeSchema = z.enum(["gitlab", "github"]);

const repoInput = { repoPath: z.string().min(1) };
const remoteName = z.string().regex(/^[A-Za-z0-9._-]+$/);
const sha = z.string().regex(/^[0-9a-f]{7,64}$/);
const changeRequestInput = { ...repoInput, forge: forgeSchema, number: z.number().int().positive() };

export const changeRequestSchema = z.object({
  forge: forgeSchema,
  number: z.number().int().positive(),
  url: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  author: z.string().nullable(),
  sourceBranch: z.string().nullable(),
  targetBranch: z.string().nullable(),
});
export type ChangeRequest = z.infer<typeof changeRequestSchema>;

export const preparedReviewSchema = z.object({
  forge: forgeSchema.nullable(),
  remote: z.string(),
  /** Ref the review worktree is created from. */
  headRef: z.string(),
  headSha: z.string(),
  targetBranch: z.string(),
  targetRef: z.string(),
  mergeBaseSha: z.string(),
  commitCount: z.number().int().nonnegative(),
  shortStat: z.string(),
  changeRequest: changeRequestSchema.nullable(),
  warnings: z.array(z.string()),
});
export type PreparedReview = z.infer<typeof preparedReviewSchema>;

export const changeRequestSuggestionSchema = z.object({
  forge: forgeSchema,
  number: z.number().int().positive(),
  title: z.string(),
  author: z.string().nullable(),
  sourceBranch: z.string().nullable(),
  targetBranch: z.string().nullable(),
  draft: z.boolean(),
  headSha: z.string().nullable(),
  url: z.string().nullable(),
});
export type ChangeRequestSuggestion = z.infer<typeof changeRequestSuggestionSchema>;

export const branchSuggestionSchema = z.object({
  name: z.string(),
  committedAt: z.number(),
  author: z.string(),
});
export type BranchSuggestion = z.infer<typeof branchSuggestionSchema>;

export const reviewSuggestionsSchema = z.object({
  changeRequests: z.array(changeRequestSuggestionSchema),
  branches: z.array(branchSuggestionSchema),
});
export type ReviewSuggestions = z.infer<typeof reviewSuggestionsSchema>;

export const changedFileSchema = z.object({
  path: z.string(),
  added: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  binary: z.boolean(),
});
export type ChangedFile = z.infer<typeof changedFileSchema>;

const dependencyChangeSchema = z.object({
  name: z.string(),
  section: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  kind: z.enum(["added", "removed", "changed"]),
  major: z.boolean(),
});

export const dependencyReportSchema = z.object({
  manifests: z.array(z.object({ file: z.string(), changes: z.array(dependencyChangeSchema) })),
  lockfiles: z.array(
    z.object({
      file: z.string(),
      added: z.array(z.string()),
      removed: z.array(z.string()),
      linesChanged: z.number().int().nonnegative(),
    }),
  ),
  duplicates: z.array(z.object({ name: z.string(), specs: z.array(z.string()) })),
  installScripts: z.array(z.object({ package: z.string(), scripts: z.array(z.string()) })),
  osv: z.string().nullable(),
});
export type DependencyReport = z.infer<typeof dependencyReportSchema>;

export const changeAnalysisSchema = z.object({
  files: z.array(changedFileSchema),
  dependencies: dependencyReportSchema.nullable(),
  ruleFiles: z.array(z.object({ path: z.string(), content: z.string() })),
});
export type ChangeAnalysis = z.infer<typeof changeAnalysisSchema>;

export const checkResultSchema = z.object({
  command: z.string(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number(),
  output: z.string(),
  timedOut: z.boolean(),
});
export type CheckResult = z.infer<typeof checkResultSchema>;

export const reviewRequestSchema = changeRequestSuggestionSchema.extend({ updatedAt: z.number().nullable() });
export type ReviewRequest = z.infer<typeof reviewRequestSchema>;

export const postedRefSchema = z.object({
  kind: z.enum(["gitlab-draft", "gitlab-discussion", "gitlab-note", "github-pending", "github-comment"]),
  id: z.string(),
  positioned: z.boolean(),
  url: z.string().nullable(),
});

export const postItemSchema = z.object({
  /** Hidden marker embedded in the comment so its thread can be found again. */
  marker: z.string().regex(/^bb-review:[A-Za-z0-9_:-]+$/),
  file: z.string().nullable(),
  startLine: z.number().int().positive().nullable(),
  endLine: z.number().int().positive().nullable(),
  body: z.string().min(1).max(60_000),
  suggestion: z.string().nullable(),
  suggestionStartLine: z.number().int().positive().nullable(),
  suggestionEndLine: z.number().int().positive().nullable(),
});
export type PostItem = z.infer<typeof postItemSchema>;

export const hostContract = defineRpcContract({
  prepareReview: {
    input: z
      .object({
        ...repoInput,
        source: z.string().min(1).max(2000),
        targetBranch: z.string().min(1).max(255).nullable(),
        remote: remoteName,
      })
      .strict(),
    output: preparedReviewSchema,
  },
  listSuggestions: {
    input: z.object({ ...repoInput, remote: remoteName }).strict(),
    output: reviewSuggestionsSchema,
  },
  listReviewRequests: {
    input: z.object({ ...repoInput, remote: remoteName }).strict(),
    output: z.object({ forge: forgeSchema.nullable(), items: z.array(reviewRequestSchema) }),
  },
  analyzeChange: {
    input: z.object({ ...repoInput, baseSha: sha, headSha: sha, inspectInstallScripts: z.boolean() }).strict(),
    output: changeAnalysisSchema,
  },
  listDiscussions: {
    input: z.object(changeRequestInput).strict(),
    output: z.object({
      comments: z.array(
        z.object({
          author: z.string(),
          body: z.string(),
          path: z.string().nullable(),
          line: z.number().nullable(),
          resolved: z.boolean().nullable(),
        }),
      ),
    }),
  },
  changeRequestStatus: {
    input: z.object({ ...changeRequestInput, markers: z.array(z.string()).max(500) }).strict(),
    output: z.object({
      state: z.enum(["opened", "merged", "closed", "unknown"]),
      headSha: z.string().nullable(),
      threads: z.array(z.object({ marker: z.string(), resolved: z.boolean(), url: z.string().nullable(), id: z.string() })),
      drafts: z.array(z.string()),
    }),
  },
  postFindings: {
    input: z
      .object({
        ...changeRequestInput,
        reviewedHeadSha: sha,
        mergeBaseSha: sha,
        summary: z.string().max(60_000).nullable(),
        items: z.array(postItemSchema).max(100),
        publish: z.boolean(),
      })
      .strict(),
    output: z.object({
      results: z.array(z.object({ marker: z.string(), ref: postedRefSchema.nullable(), error: z.string().nullable() })),
      warnings: z.array(z.string()),
    }),
  },
  publishDrafts: {
    input: z.object(changeRequestInput).strict(),
    output: z.object({ published: z.boolean(), detail: z.string() }),
  },
  resetWorktree: {
    input: z.object({ worktreePath: z.string().min(1), sha }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  guardWorktree: {
    input: z.object({ worktreePath: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  worktreeStatus: {
    input: z.object({ worktreePath: z.string().min(1) }).strict(),
    output: z.object({ dirty: z.array(z.string()) }),
  },
  runChecks: {
    input: z
      .object({
        worktreePath: z.string().min(1),
        commands: z.array(z.string().min(1).max(2000)).max(20),
        timeoutMs: z.number().int().positive().max(29 * 60_000),
      })
      .strict(),
    output: z.object({ results: z.array(checkResultSchema) }),
  },
  waitForUrl: {
    input: z.object({ url: z.string().url(), timeoutMs: z.number().int().positive().max(10 * 60_000) }).strict(),
    output: z.object({ ok: z.boolean(), status: z.number().nullable() }),
  },
});
