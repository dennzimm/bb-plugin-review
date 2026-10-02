import { PluginCliError, cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { formatLocation, formatOutcome } from "../shared/findings.ts";
import { REVIEW_GUIDELINES } from "../shared/guidelines.ts";
import type { LearningsStore } from "./learnings.ts";
import type { ReviewService, StartedReview } from "./service.ts";
import { depths, type defineSettings } from "./settings.ts";
import type { ReviewStore } from "./store.ts";

const reasoningLevels = ["low", "medium", "high", "xhigh", "max"] as const;

function failure(error: unknown, code: string): PluginCliError {
  return error instanceof PluginCliError ? error : new PluginCliError(error instanceof Error ? error.message : String(error), { code });
}

export function registerCli(
  bb: BbPluginApi,
  deps: { service: ReviewService; store: ReviewStore; learnings: LearningsStore; settings: ReturnType<typeof defineSettings> },
) {
  const { service, store, learnings, settings } = deps;

  async function resolveProjectId(value: string | undefined, contextProjectId: string | undefined): Promise<string> {
    const projects = (await bb.sdk.projects.list()).filter((project) => project.kind === "standard");
    const known = projects.map((project) => `${project.name} (${project.id})`).join(", ");
    if (value !== undefined) {
      const match = projects.find((project) => project.id === value || project.name === value);
      if (match === undefined) throw new PluginCliError(`No project "${value}".`, { code: "project_not_found", hint: `Known projects: ${known}` });
      return match.id;
    }
    if (contextProjectId !== undefined && projects.some((project) => project.id === contextProjectId)) return contextProjectId;
    throw new PluginCliError("Name the project to review in.", { code: "project_required", hint: `Add --project <id-or-name>. Known projects: ${known}` });
  }

  async function resolveThread(positional: string | undefined, contextThreadId: string | undefined): Promise<string> {
    const threadId = positional ?? contextThreadId;
    if (threadId === undefined) {
      throw new PluginCliError("Name the review thread.", { code: "thread_required", hint: "Pass the review thread id, or run this inside the review thread. `bb review list` shows ids." });
    }
    if ((await store.read(threadId)) === null) {
      throw new PluginCliError(`${threadId} is not a review started by this plugin.`, { code: "not_a_review", hint: "`bb review list` shows review threads." });
    }
    return threadId;
  }

  const threadPositional = [{ name: "thread", description: "Review thread id; defaults to the current thread" }] as const;
  const json = { type: "boolean", description: "Print machine-readable JSON" } as const;

  bb.cli.register(
    defineCli({
      name: "review",
      summary: "Review branches, merge requests, and pull requests in read-only worktree threads",
      commands: {
        start: cliCommand({
          summary: "Fetch a branch or merge request and start a review thread for it",
          description:
            "Accepts a branch name, a GitLab merge request (!123 or URL), a GitHub pull request (#123 or URL), or a bare number. The review runs in a new worktree at the change's head commit.",
          positionals: [{ name: "source", description: "Branch, !MR, #PR, number, or URL", required: true }],
          options: {
            project: { type: "string", description: "Project id or name; defaults to the current thread's project", aliases: ["p"] },
            into: { type: "string", description: "Target branch; defaults to the merge request target, then the remote default branch", aliases: ["target", "target-branch", "base"] },
            focus: { type: "string", description: "What the reviewer should pay particular attention to (max 4000 chars)", stdin: true },
            depth: { type: "enum", values: depths, description: "quick, standard, or deep; defaults to the plugin setting" },
            post: { type: "boolean", description: "Allow the reviewer to save its findings as a draft review", aliases: ["comment", "post-comments"] },
            provider: { type: "string", description: "Agent provider id (default: project default)" },
            model: { type: "string", description: "Model id (default: project default)" },
            reasoning: { type: "enum", values: reasoningLevels, description: "Reasoning level", aliases: ["reasoning-level"] },
            json,
          },
          async run({ options, positionals }, ctx) {
            const projectId = await resolveProjectId(options.project, ctx.projectId);
            let started: StartedReview;
            try {
              started = await service.startReview(
                {
                  projectId,
                  source: positionals.source,
                  targetBranch: options.into ?? null,
                  focus: options.focus ?? null,
                  depth: options.depth ?? null,
                  allowPosting: options.post,
                  providerId: options.provider,
                  model: options.model,
                  reasoningLevel: options.reasoning,
                },
                ctx.signal,
              );
            } catch (error) {
              throw failure(error, "review_start_failed");
            }
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(started) };
            return {
              exitCode: 0,
              stdout: [
                `Started @thread:${started.threadId} — ${started.title} (${started.depth})`,
                `  ${started.headRef} → ${started.targetRef}: ${started.commitCount} commit(s), ${started.shortStat || "no file changes"}`,
                ...started.warnings.map((warning) => `  warning: ${warning}`),
              ].join("\n"),
            };
          },
        }),
        again: cliCommand({
          summary: "Re-review a review thread's merge request after new commits",
          positionals: threadPositional,
          options: {
            since: { type: "string", description: "Review only what changed after this commit SHA, even without new commits" },
            json,
          },
          async run({ positionals, options }, ctx) {
            const threadId = await resolveThread(positionals.thread, ctx.threadId);
            const result = await service.reReview(threadId, { since: options.since ?? null }).catch((error: unknown) => {
              throw failure(error, "rereview_failed");
            });
            return { exitCode: 0, stdout: options.json ? JSON.stringify(result) : `Round ${result.round} started at ${result.headSha.slice(0, 9)} in @thread:${threadId}.` };
          },
        }),
        findings: cliCommand({
          summary: "List a review's findings with their status",
          positionals: threadPositional,
          options: { json },
          async run({ positionals, options }, ctx) {
            const threadId = await resolveThread(positionals.thread, ctx.threadId);
            const meta = (await store.read(threadId))!;
            if (options.json) return { exitCode: 0, stdout: JSON.stringify({ report: meta.report, findings: meta.findings }) };
            if (meta.findings.length === 0) return { exitCode: 0, stdout: meta.report ? `No findings. ${meta.report.verdict ?? ""}` : "No report yet." };
            return {
              exitCode: 0,
              stdout: meta.findings
                .map((finding) => `${finding.id.padEnd(4)} ${finding.status.padEnd(9)} [${finding.severity}] ${finding.title}${formatLocation(finding) ? ` — ${formatLocation(finding)}` : ""}`)
                .join("\n"),
            };
          },
        }),
        post: cliCommand({
          summary: "Save a review's findings as a draft review on its merge request",
          description: "Posts every open finding (or --findings) as GitLab draft notes, or a pending GitHub review, which you publish after checking it. --publish posts immediately.",
          positionals: threadPositional,
          options: {
            findings: { type: "string", repeatable: true, split: ",", description: "Finding ids such as F1,F3; defaults to every open finding" },
            publish: { type: "boolean", description: "Publish immediately instead of leaving drafts" },
            "no-summary": { type: "boolean", description: "Do not add a summary comment" },
            json,
          },
          async run({ positionals, options }, ctx) {
            const threadId = await resolveThread(positionals.thread, ctx.threadId);
            const result = await service
              .postFindings(threadId, {
                findingIds: options.findings.length > 0 ? options.findings : null,
                publish: options.publish,
                ...(options["no-summary"] ? { summary: false } : {}),
              })
              .catch((error: unknown) => {
                throw failure(error, "post_failed");
              });
            if (options.json) return { exitCode: result.failed.length > 0 ? 1 : 0, stdout: JSON.stringify(result) };
            return {
              exitCode: result.failed.length > 0 ? 1 : 0,
              stdout: [
                `${result.published ? "Published" : "Saved as drafts"}: ${result.posted.join(", ") || "none"}`,
                ...result.failed.map((entry) => `failed ${entry.id}: ${entry.error}`),
                ...result.warnings.map((warning) => `warning: ${warning}`),
                ...(result.published ? [] : ["Publish with `bb review publish` or from the merge request page."]),
              ].join("\n"),
            };
          },
        }),
        publish: cliCommand({
          summary: "Publish your draft review on the merge request",
          positionals: threadPositional,
          async run({ positionals }, ctx) {
            const threadId = await resolveThread(positionals.thread, ctx.threadId);
            const result = await service.publishDrafts(threadId).catch((error: unknown) => {
              throw failure(error, "publish_failed");
            });
            return { exitCode: result.published ? 0 : 1, stdout: result.detail };
          },
        }),
        dismiss: cliCommand({
          summary: "Dismiss a finding, optionally remembering why for future reviews",
          positionals: [{ name: "finding", description: "Finding id such as F2", required: true }, ...threadPositional],
          options: {
            reason: { type: "string", description: "Why the finding is wrong or not wanted" },
            remember: { type: "boolean", description: "Add the reason to the learnings every future review sees" },
          },
          async run({ positionals, options }, ctx) {
            const threadId = await resolveThread(positionals.thread, ctx.threadId);
            await service.dismissFinding(threadId, positionals.finding, options.reason ?? "", options.remember).catch((error: unknown) => {
              throw failure(error, "dismiss_failed");
            });
            return { exitCode: 0, stdout: `Dismissed ${positionals.finding.toUpperCase()}${options.remember ? " and saved it as a learning" : ""}.` };
          },
        }),
        sync: cliCommand({
          summary: "Refresh review requests, posted comment status, and new commits",
          positionals: threadPositional,
          async run({ positionals }, ctx) {
            if (positionals.thread === undefined && (ctx.threadId === undefined || (await store.read(ctx.threadId)) === null)) {
              await service.sweep();
              return { exitCode: 0, stdout: "Synced review requests and open reviews." };
            }
            const threadId = await resolveThread(positionals.thread, ctx.threadId);
            const meta = await service.syncReview(threadId);
            return { exitCode: 0, stdout: `Synced ${threadId}: ${meta?.mrState ?? "unknown state"}${meta?.newCommits ? ", new commits since the review" : ""}.` };
          },
        }),
        queue: cliCommand({
          summary: "List merge requests waiting for your review",
          options: { refresh: { type: "boolean", description: "Query the forges now instead of using the last sweep" }, json },
          async run({ options }) {
            if (options.refresh) await service.sweep();
            const queue = await service.readQueue();
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(queue) };
            if (queue.items.length === 0) return { exitCode: 0, stdout: queue.fetchedAt === 0 ? "No queue yet; run `bb review queue --refresh`." : "Nothing is waiting for your review." };
            return {
              exitCode: 0,
              stdout: queue.items
                .map((item) => {
                  const reference = `${item.forge === "gitlab" ? "!" : "#"}${item.number}`;
                  const state = item.reviewThreadId === null ? "not reviewed" : item.headSha && item.headSha !== item.reviewedHeadSha ? `new commits since @thread:${item.reviewThreadId}` : `reviewed in @thread:${item.reviewThreadId}`;
                  return `${item.projectName} ${reference} ${item.title} — ${item.author ?? "unknown"} — ${state}`;
                })
                .join("\n"),
            };
          },
        }),
        list: cliCommand({
          summary: "List review threads started by this plugin",
          options: {
            project: { type: "string", description: "Only reviews in this project (id or name)" },
            archived: { type: "boolean", description: "Include archived reviews" },
            json,
          },
          async run({ options }, ctx) {
            const projectId = options.project === undefined ? null : await resolveProjectId(options.project, ctx.projectId);
            const reviews = await service.listReviews(projectId, options.archived);
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(reviews) };
            if (reviews.length === 0) return { exitCode: 0, stdout: "No review threads." };
            return {
              exitCode: 0,
              stdout: reviews
                .map((review) => {
                  const outcome = formatOutcome(review.verdict, review.counts);
                  const flags = [review.round > 1 ? `round ${review.round}` : null, review.newCommits ? "new commits" : null, review.archived ? "archived" : null].filter(Boolean).join(", ");
                  return `${review.threadId}  ${review.status.padEnd(8)}  ${review.title}${outcome ? `  [${outcome}]` : ""}${flags ? `  (${flags})` : ""}`;
                })
                .join("\n"),
            };
          },
        }),
        stats: cliCommand({
          summary: "Show how often findings were accepted",
          options: { json },
          async run({ options }) {
            const stats = await service.stats();
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(stats) };
            const rate = stats.acceptanceRate === null ? "n/a" : `${Math.round(stats.acceptanceRate * 100)}%`;
            return {
              exitCode: 0,
              stdout: `${stats.reviews} reviews, ${stats.reported} findings (pre-existing excluded), ${stats.posted} posted, ${stats.accepted} fixed or resolved, ${stats.dismissed} dismissed. Acceptance: ${rate}.`,
            };
          },
        }),
        "learnings list": cliCommand({
          summary: "List what future reviews are told not to report",
          options: { json },
          async run({ options }) {
            const all = await learnings.all();
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(all) };
            return { exitCode: 0, stdout: all.length === 0 ? "No learnings." : all.map((learning) => `${learning.id}  ${learning.projectId ?? "all projects"}  ${learning.text}`).join("\n") };
          },
        }),
        "learnings add": cliCommand({
          summary: "Add a learning",
          positionals: [{ name: "text", description: "What not to report, and why", required: true, variadic: true }],
          options: { project: { type: "string", description: "Limit to this project (id or name)" } },
          async run({ positionals, options }, ctx) {
            const projectId = options.project === undefined ? null : await resolveProjectId(options.project, ctx.projectId);
            const learning = await learnings.add({ projectId, text: positionals.text.join(" "), origin: null });
            return { exitCode: 0, stdout: `Added ${learning.id}.` };
          },
        }),
        "learnings remove": cliCommand({
          summary: "Remove a learning",
          positionals: [{ name: "id", description: "Learning id from `bb review learnings list`", required: true }],
          async run({ positionals }) {
            const removed = await learnings.remove(positionals.id);
            if (!removed) throw new PluginCliError(`No learning ${positionals.id}.`, { code: "not_found" });
            return { exitCode: 0, stdout: `Removed ${positionals.id}.` };
          },
        }),
        guidelines: cliCommand({
          summary: "Print the review method, for reviewing changes inside the current thread",
          async run() {
            const { teamGuidelines } = await settings.get();
            const team = teamGuidelines.trim() === "" ? "" : `\n## Team review criteria\n\n${teamGuidelines.trim()}\n`;
            return { exitCode: 0, stdout: REVIEW_GUIDELINES + team };
          },
        }),
      },
    }),
  );
}
