import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { JsonObject } from "./json.ts";
import { z } from "zod";
import { hostContract, type PreparedReview, type ReviewRequest, type ReviewSuggestions } from "../contract.ts";
import {
  REVIEWS_CHANGED,
  countFindings,
  parseReportText,
  isActive,
  PRE_EXISTING,
  type DraftFinding,
  type Finding,
  type FindingCounts,
  type PreviousFindingStatus,
  type ReviewReport,
  type Verdict,
} from "../shared/findings.ts";
import {
  changeLabel,
  checksMessage,
  previewMessage,
  reReviewBrief,
  reviewBrief,
  secondOpinionMessage,
} from "./brief.ts";
import { fetchTicket, findTicketKey, type Ticket } from "./jira.ts";
import type { LearningsStore } from "./learnings.ts";
import { assessRisk, DEFAULT_RISKY_PATHS } from "./risk.ts";
import { routesFromFiles } from "./routes.ts";
import { matchRules } from "./rules.ts";
import { enabledFor, projectConfigFor, type Depth, type defineSettings } from "./settings.ts";
import { toJson, type ReviewMetadata, type ReviewStore } from "./store.ts";

export const startReviewSchema = z.object({
  projectId: z.string().min(1),
  source: z.string().trim().min(1).max(2000),
  targetBranch: z.string().trim().min(1).max(255).nullable().default(null),
  focus: z.string().trim().max(4000).nullable().default(null),
  allowPosting: z.boolean().default(false),
  depth: z.enum(["quick", "standard", "deep"]).nullable().default(null),
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoningLevel: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
});
export type StartReviewRequest = z.input<typeof startReviewSchema>;

export interface StartedReview {
  threadId: string;
  title: string;
  headRef: string;
  targetRef: string;
  commitCount: number;
  shortStat: string;
  depth: Depth;
  warnings: string[];
}

export interface ToolReport {
  verdict: Verdict;
  summary: string;
  findings: Array<Partial<DraftFinding> & Pick<DraftFinding, "severity" | "title" | "body"> & { id?: string | null }>;
  previousFindings?: Array<{ id: string; status: PreviousFindingStatus; note?: string | null }>;
  compliance?: ReviewReport["compliance"];
  walkthrough?: string | null;
  questions?: string[];
  limitations?: string[];
}

export interface ReviewSummary {
  threadId: string;
  projectId: string;
  title: string;
  status: string;
  archived: boolean;
  createdAt: number;
  url: string | null;
  label: string;
  depth: Depth;
  round: number;
  verdict: Verdict | null;
  counts: FindingCounts;
  riskLevel: "low" | "medium" | "high" | null;
  newCommits: boolean;
  checks: string | null;
  preview: string | null;
  secondOpinion: string | null;
  readOnlyViolations: number;
  mrState: string | null;
}

export interface QueueItem extends ReviewRequest {
  projectId: string;
  projectName: string;
  reviewThreadId: string | null;
  reviewedHeadSha: string | null;
}

const PLAN_COMMAND = "/plan";

/** Same structured input the composer's Plan action sends. */
function planCommandText(text: string) {
  return {
    type: "text" as const,
    text: `${PLAN_COMMAND} ${text}`,
    mentions: [
      {
        start: 0,
        end: PLAN_COMMAND.length,
        resource: {
          kind: "command" as const,
          trigger: "/" as const,
          name: "plan",
          source: "command" as const,
          origin: "builtin" as const,
          label: "plan",
          argumentHint: null,
        },
      },
    ],
  };
}

function agentOnly(text: string) {
  return { type: "text" as const, text, mentions: [], visibility: "agent-only" as const };
}

function visible(text: string) {
  return { type: "text" as const, text, mentions: [] };
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function sameFinding(a: Pick<Finding, "title" | "file">, b: Pick<DraftFinding, "title" | "file">): boolean {
  return normalizeTitle(a.title) === normalizeTitle(b.title) && (a.file ?? null) === (b.file ?? null);
}

function nextFindingId(findings: readonly Finding[]): () => string {
  let max = findings.reduce((highest, finding) => Math.max(highest, Number(finding.id.replace(/^F/, "")) || 0), 0);
  return () => `F${(max += 1)}`;
}

function toFinding(draft: Partial<DraftFinding> & Pick<DraftFinding, "severity" | "title" | "body">, id: string, round: number): Finding {
  return {
    id,
    round,
    severity: draft.severity,
    title: draft.title.trim(),
    file: draft.file ?? null,
    startLine: draft.startLine ?? null,
    endLine: draft.endLine ?? draft.startLine ?? null,
    body: draft.body.trim(),
    suggestion: draft.suggestion ?? null,
    suggestionStartLine: draft.suggestion ? (draft.suggestionStartLine ?? null) : null,
    suggestionEndLine: draft.suggestion ? (draft.suggestionEndLine ?? null) : null,
    confidence: draft.confidence ?? null,
    evidence: draft.evidence ?? null,
    category: draft.category ?? null,
    status: "open",
    statusNote: null,
    posted: null,
  };
}

function commentBody(finding: Finding): string {
  return [`**[${finding.severity}] ${finding.title}**`, "", finding.body].join("\n");
}

function summaryComment(meta: ReviewMetadata, marker: string): string {
  const counts = countFindings(meta.findings);
  const tally = Object.entries(counts)
    .map(([severity, count]) => `${count} ${severity}`)
    .join(", ");
  const parts = [
    `**Review summary**${meta.report?.verdict ? ` — ${meta.report.verdict}` : ""}`,
    // The reviewer's summary already opens with a tally line.
    meta.report?.summary ? meta.report.summary : tally === "" ? "No blocking issues." : tally,
    meta.report?.compliance ? `**Requirements:** ${meta.report.compliance.status} — ${meta.report.compliance.notes}` : "",
    meta.report?.questions.length ? `**Questions**\n\n${meta.report.questions.map((question) => `- ${question}`).join("\n")}` : "",
    meta.report?.walkthrough ? `<details><summary>Walkthrough</summary>\n\n${meta.report.walkthrough}\n\n</details>` : "",
  ].filter((part) => part !== "");
  return `${parts.join("\n\n")}\n\n<!-- ${marker} -->`;
}

export function createReviewService(
  bb: BbPluginApi,
  deps: {
    settings: ReturnType<typeof defineSettings>;
    store: ReviewStore;
    learnings: LearningsStore;
  },
) {
  const { settings, store, learnings } = deps;
  const host = bb.hosts.experimental_client({ contract: hostContract });

  const publish = (payload: JsonObject = {}) => bb.realtime.publish(REVIEWS_CHANGED, payload);
  const log = (message: string, error: unknown) => bb.log.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`);

  async function projectCheckout(projectId: string, signal?: AbortSignal) {
    const project = await bb.sdk.projects.get({ projectId, signal });
    if (project.kind !== "standard") throw new Error("Reviews need a project backed by a Git repository.");
    const projectSource = project.sources.find((candidate) => candidate.isDefault) ?? project.sources[0];
    if (projectSource === undefined) throw new Error(`Project ${project.name} has no checkout to fetch into.`);
    return { project, projectSource };
  }

  async function environmentOf(threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.environmentId === null) return null;
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    if (environment.path === null || environment.status !== "ready") return null;
    return { thread, environmentId: environment.id, path: environment.path, hostId: environment.hostId };
  }

  async function requireReview(threadId: string): Promise<ReviewMetadata> {
    const meta = await store.read(threadId);
    if (meta === null) throw new Error(`Thread ${threadId} is not a review started by this plugin.`);
    return meta;
  }

  async function sendToThread(threadId: string, text: string, options: { visibleText?: string } = {}) {
    await bb.sdk.threads.send({
      threadId,
      mode: "queue-if-active",
      input: options.visibleText === undefined ? [visible(text)] : [visible(options.visibleText), agentOnly(text)],
    });
  }

  // ---------------------------------------------------------------- starting

  const SUGGESTIONS_TTL_MS = 60_000;
  const suggestionsCache = new Map<string, { at: number; value: Promise<ReviewSuggestions> }>();

  function suggestions(projectId: string, refresh = false): Promise<ReviewSuggestions> {
    const cached = suggestionsCache.get(projectId);
    if (!refresh && cached !== undefined && Date.now() - cached.at < SUGGESTIONS_TTL_MS) return cached.value;
    const value = (async () => {
      const { remote } = await settings.get();
      const { projectSource } = await projectCheckout(projectId);
      return host.call("listSuggestions", { repoPath: projectSource.path, remote }, { hostId: projectSource.hostId, timeoutMs: 45_000 });
    })();
    suggestionsCache.set(projectId, { at: Date.now(), value });
    value.catch(() => suggestionsCache.delete(projectId));
    return value;
  }

  async function lookupTicket(key: string | null): Promise<{ ticket: Ticket | null; error: string | null }> {
    if (key === null) return { ticket: null, error: null };
    const current = await settings.get();
    try {
      return { ticket: await fetchTicket({ baseUrl: current.jiraBaseUrl, email: current.jiraEmail, apiToken: current.jiraApiToken as string | undefined }, key), error: null };
    } catch (error) {
      return { ticket: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function startReview(input: StartReviewRequest, signal?: AbortSignal): Promise<StartedReview> {
    const request = startReviewSchema.parse(input);
    const current = await settings.get();
    const { project, projectSource } = await projectCheckout(request.projectId, signal);
    const config = projectConfigFor(current, project);
    const depth: Depth = request.depth ?? (current.defaultDepth as Depth);
    const on = (timeoutMs: number) => ({ hostId: projectSource.hostId, signal, timeoutMs });

    const prepared = await host.call(
      "prepareReview",
      { repoPath: projectSource.path, source: request.source, targetBranch: request.targetBranch, remote: current.remote },
      on(6 * 60_000),
    );
    const changeRequest = prepared.changeRequest;
    const ticketKey = findTicketKey(current.ticketPattern, changeRequest?.sourceBranch, prepared.headRef, changeRequest?.title, changeRequest?.description);
    const warnings = [...prepared.warnings];

    const [analysis, discussions, ticketLookup] = await Promise.all([
      host.call(
        "analyzeChange",
        { repoPath: projectSource.path, baseSha: prepared.mergeBaseSha, headSha: prepared.headSha, inspectInstallScripts: current.inspectInstallScripts },
        on(3 * 60_000),
      ).catch((error: unknown) => {
        warnings.push(`Change analysis failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }),
      changeRequest === null
        ? Promise.resolve({ comments: [] })
        : host
            .call("listDiscussions", { repoPath: projectSource.path, forge: changeRequest.forge, number: changeRequest.number }, on(60_000))
            .catch(() => ({ comments: [] })),
      lookupTicket(ticketKey),
    ]);
    if (ticketLookup.error !== null) warnings.push(`Jira: ${ticketLookup.error}`);

    const risk = analysis === null ? null : assessRisk(analysis.files, analysis.dependencies, config.riskyPaths ?? DEFAULT_RISKY_PATHS);
    const rules = analysis === null ? [] : matchRules(analysis, config);
    const checksPlanned = enabledFor(current.runChecksWhen, depth) && config.checks.length > 0;
    const previewPlanned = enabledFor(current.previewWhen, depth) && config.preview !== undefined;
    const secondOpinionPlanned = enabledFor(current.secondOpinionWhen, depth) && current.secondOpinionProvider.trim() !== "";
    const planMode = current.readOnlyMode === "plan";
    const label = changeLabel(prepared.forge, changeRequest?.number ?? null, prepared.headRef);
    const titleSuffix = changeRequest?.title ? ` ${changeRequest.title}` : "";
    const title = `Review: ${label}${titleSuffix}`.slice(0, 120);

    const brief = reviewBrief({
      prepared,
      depth,
      focus: request.focus,
      allowPosting: request.allowPosting,
      planMode,
      teamCriteria: [current.teamGuidelines.trim(), config.criteria.trim()].filter((entry) => entry !== ""),
      rules,
      risk,
      dependencies: analysis?.dependencies ?? null,
      ticket: ticketLookup.ticket,
      ticketKey,
      ticketError: ticketLookup.error,
      discussions: discussions.comments,
      learnings: await learnings.forBrief(project.id),
      checksPlanned,
      previewPlanned,
      secondOpinionPlanned,
      role: "primary",
    });
    const visibleRequest = `Review ${label} against ${prepared.targetRef} without changing any code (${depth} review).`;
    const metadata: Partial<ReviewMetadata> & Pick<ReviewMetadata, "source" | "headRef" | "headSha" | "targetRef"> = {
      version: 2,
      role: "primary",
      source: request.source,
      forge: prepared.forge,
      number: changeRequest?.number ?? null,
      url: changeRequest?.url ?? null,
      title: changeRequest?.title ?? null,
      headRef: prepared.headRef,
      headSha: prepared.headSha,
      targetRef: prepared.targetRef,
      mergeBaseSha: prepared.mergeBaseSha,
      depth,
      round: 1,
      allowPosting: request.allowPosting,
      findings: [],
      ticket: ticketLookup.ticket
        ? { key: ticketLookup.ticket.key, summary: ticketLookup.ticket.summary, status: ticketLookup.ticket.status, url: ticketLookup.ticket.url }
        : ticketKey
          ? { key: ticketKey, summary: null, status: null, url: null }
          : null,
      risk,
      dependencies: analysis?.dependencies ?? null,
      rules: rules.map((rule) => rule.name),
      checks: checksPlanned ? { status: "pending", results: [], startedAt: null } : null,
      preview: previewPlanned && config.preview ? { status: "pending", url: config.preview.url, terminalId: null } : null,
    };

    const thread = await bb.sdk.threads.spawn({
      projectId: project.id,
      title,
      environment: {
        type: "host",
        hostId: projectSource.hostId,
        workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: prepared.headRef } },
      },
      input: [planMode ? planCommandText(visibleRequest) : visible(visibleRequest), agentOnly(brief)],
      ...(request.providerId ? { providerId: request.providerId } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.reasoningLevel ? { reasoningLevel: request.reasoningLevel } : depth === "deep" ? { reasoningLevel: "high" as const } : {}),
      pluginMetadata: {
        ...toJson(metadata),
        ...(secondOpinionPlanned ? { plannedSecondOpinion: true } : {}),
      },
    });
    publish({ threadId: thread.id, kind: "started" });
    void onEnvironmentReady(thread.id).catch(() => undefined);

    return {
      threadId: thread.id,
      title,
      headRef: prepared.headRef,
      targetRef: prepared.targetRef,
      commitCount: prepared.commitCount,
      shortStat: prepared.shortStat,
      depth,
      warnings,
    };
  }

  // ------------------------------------------------- after provisioning

  const preparing = new Set<string>();

  /** Idempotent: each stage records that it ran, so repeated thread.active events do nothing. */
  async function onEnvironmentReady(threadId: string): Promise<void> {
    if (preparing.has(threadId)) return;
    preparing.add(threadId);
    try {
      const meta = await store.read(threadId);
      if (meta === null) return;
      const environment = await environmentOf(threadId);
      if (environment === null) return;

      if (!meta.mergeBaseApplied) {
        await bb.sdk.environments.update({ environmentId: environment.environmentId, mergeBaseBranch: meta.targetRef });
        await store.patch(threadId, { mergeBaseApplied: true });
      }
      if (!meta.guarded && meta.role === "primary" && meta.version >= 2) {
        await host.call("guardWorktree", { worktreePath: environment.path }, { hostId: environment.hostId });
        await store.patch(threadId, { guarded: true });
      }
      if (meta.role !== "primary") return;
      if (meta.checks?.status === "pending") void runChecks(threadId).catch((error) => log("checks failed", error));
      else if (meta.preview?.status === "pending" && meta.checks === null) void startPreview(threadId).catch((error) => log("preview failed", error));
      const raw = await bb.sdk.threads.getPluginMetadata({ threadId });
      if (raw.plannedSecondOpinion === true && meta.secondOpinion === null) {
        await bb.sdk.threads.updatePluginMetadata({ threadId, remove: ["plannedSecondOpinion"] });
        void startSecondOpinion(threadId).catch((error) => recordSecondOpinionFailure(threadId, error));
      }
    } finally {
      preparing.delete(threadId);
    }
  }

  async function runChecks(threadId: string): Promise<void> {
    const meta = await requireReview(threadId);
    const environment = await environmentOf(threadId);
    if (environment === null) return;
    const { project } = await projectCheckout(environment.thread.projectId);
    const config = projectConfigFor(await settings.get(), project);
    const commands = config.checks.map((command) =>
      command.replaceAll("{base}", meta.mergeBaseSha ?? meta.targetRef).replaceAll("{head}", meta.headSha),
    );
    await store.patch(threadId, { checks: { status: "running", results: [], startedAt: Date.now() } });
    publish({ threadId });
    const timeoutMs = config.checkTimeoutMinutes * 60_000;
    let results;
    try {
      ({ results } = await host.call(
        "runChecks",
        { worktreePath: environment.path, commands, timeoutMs },
        { hostId: environment.hostId, timeoutMs: timeoutMs + 60_000 },
      ));
    } catch (error) {
      await store.patch(threadId, { checks: { status: "failed", results: [], startedAt: null } });
      await sendToThread(threadId, `# Check results\n\nThe configured checks could not run: ${error instanceof Error ? error.message : String(error)}. Mention this in the limitations.`, {
        visibleText: "Checks could not run.",
      });
      publish({ threadId });
      return;
    }
    const passed = results.every((result) => result.exitCode === 0);
    await store.patch(threadId, { checks: { status: passed ? "passed" : "failed", results, startedAt: null } });
    await sendToThread(threadId, checksMessage(results, results.some((result) => result.timedOut)), {
      visibleText: passed ? "All configured checks passed." : `${results.filter((result) => result.exitCode !== 0).length} configured check(s) failed.`,
    });
    publish({ threadId });
    const fresh = await store.read(threadId);
    if (fresh?.preview?.status === "pending") await startPreview(threadId);
  }

  async function startPreview(threadId: string): Promise<void> {
    const environment = await environmentOf(threadId);
    if (environment === null) return;
    const { project } = await projectCheckout(environment.thread.projectId);
    const preview = projectConfigFor(await settings.get(), project).preview;
    if (preview === undefined) return;
    const terminal = await bb.sdk.terminals.create({
      scope: { kind: "environment", environmentId: environment.environmentId },
      cols: 160,
      rows: 40,
      title: "Review preview",
      start: { mode: "command", command: preview.command },
    });
    const terminalId = (terminal as { id?: string; terminalId?: string }).id ?? (terminal as { terminalId?: string }).terminalId ?? null;
    await store.patch(threadId, { preview: { status: "running", url: preview.url, terminalId } });
    publish({ threadId });
    const ready = await host.call(
      "waitForUrl",
      { url: preview.url, timeoutMs: preview.readyTimeoutSeconds * 1000 },
      { hostId: environment.hostId, timeoutMs: preview.readyTimeoutSeconds * 1000 + 30_000 },
    );
    if (!ready.ok) {
      await store.patch(threadId, { preview: { status: "failed", url: preview.url, terminalId } });
      await sendToThread(
        threadId,
        `# Preview\n\nThe preview command did not serve ${preview.url} within ${preview.readyTimeoutSeconds}s, so UI verification is not available. Mention this in the limitations.`,
        { visibleText: "The preview did not start." },
      );
      publish({ threadId });
      return;
    }
    const meta = await requireReview(threadId);
    const changed = await changedPaths(threadId, meta).catch(() => [] as string[]);
    await store.patch(threadId, { preview: { status: "ready", url: preview.url, terminalId } });
    await sendToThread(
      threadId,
      previewMessage({ url: preview.url, baselineUrl: preview.baselineUrl ?? null, hostId: environment.hostId, routesHint: routesFromFiles(changed) }),
      { visibleText: `Preview running at ${preview.url}.` },
    );
    publish({ threadId });
  }

  async function changedPaths(threadId: string, meta: ReviewMetadata): Promise<string[]> {
    const environment = await environmentOf(threadId);
    if (environment === null || meta.mergeBaseSha === null) return [];
    const analysis = await host.call(
      "analyzeChange",
      { repoPath: environment.path, baseSha: meta.mergeBaseSha, headSha: meta.headSha, inspectInstallScripts: false },
      { hostId: environment.hostId },
    );
    return analysis.files.map((file) => file.path);
  }

  async function stopPreview(threadId: string): Promise<void> {
    const meta = await requireReview(threadId);
    if (meta.preview?.terminalId) await bb.sdk.terminals.close({ terminalId: meta.preview.terminalId, mode: "force" }).catch(() => undefined);
    if (meta.preview !== null) await store.patch(threadId, { preview: { ...meta.preview, status: "stopped" } });
    publish({ threadId });
  }

  async function recordSecondOpinionFailure(primaryThreadId: string, error: unknown) {
    log("second opinion failed", error);
    await store.patch(primaryThreadId, {
      secondOpinion: { threadId: null, status: "failed", error: error instanceof Error ? error.message : String(error) },
    });
    publish({ threadId: primaryThreadId });
  }

  async function retrySecondOpinion(primaryThreadId: string): Promise<void> {
    const meta = await requireReview(primaryThreadId);
    if (meta.secondOpinion?.status === "running") throw new Error("A second opinion is already running.");
    if ((await settings.get()).secondOpinionProvider.trim() === "") throw new Error("Set the second reviewer provider in the plugin settings first.");
    await startSecondOpinion(primaryThreadId).catch(async (error: unknown) => {
      await recordSecondOpinionFailure(primaryThreadId, error);
      throw error;
    });
  }

  async function startSecondOpinion(primaryThreadId: string): Promise<void> {
    const meta = await requireReview(primaryThreadId);
    const current = await settings.get();
    const provider = current.secondOpinionProvider.trim();
    if (provider === "") return;
    const environment = await environmentOf(primaryThreadId);
    if (environment === null) return;
    const primary = environment.thread;
    const { project } = await projectCheckout(primary.projectId);
    const targetBranch = meta.targetRef.slice(meta.targetRef.indexOf("/") + 1);
    const prepared: PreparedReview = {
      forge: meta.forge,
      remote: current.remote,
      headRef: meta.headRef,
      headSha: meta.headSha,
      targetBranch,
      targetRef: meta.targetRef,
      mergeBaseSha: meta.mergeBaseSha ?? meta.headSha,
      commitCount: 0,
      shortStat: meta.risk ? `${meta.risk.files} files, ${meta.risk.reviewedLines} reviewable lines` : "",
      changeRequest:
        meta.forge !== null && meta.number !== null
          ? { forge: meta.forge, number: meta.number, url: meta.url, title: meta.title, description: null, author: null, sourceBranch: null, targetBranch }
          : null,
      warnings: [],
    };
    const brief = reviewBrief({
      prepared,
      depth: meta.depth,
      focus: null,
      allowPosting: false,
      planMode: current.readOnlyMode === "plan",
      teamCriteria: [current.teamGuidelines.trim(), projectConfigFor(current, project).criteria.trim()].filter((entry) => entry !== ""),
      rules: [],
      risk: meta.risk,
      dependencies: meta.dependencies,
      ticket: null,
      ticketKey: null,
      ticketError: null,
      discussions: [],
      learnings: await learnings.forBrief(project.id),
      checksPlanned: false,
      previewPlanned: false,
      secondOpinionPlanned: false,
      role: "second-opinion",
    });
    const request = `Independently review ${changeLabel(meta.forge, meta.number, meta.headRef)} as a second opinion, without changing any code.`;
    const child = await bb.sdk.threads.spawn({
      projectId: primary.projectId,
      parentThreadId: primaryThreadId,
      title: `Second opinion: ${primary.title ?? meta.headRef}`.slice(0, 120),
      environment: { type: "reuse", environmentId: environment.environmentId },
      providerId: provider,
      ...(current.secondOpinionModel.trim() ? { model: current.secondOpinionModel.trim() } : {}),
      input: [current.readOnlyMode === "plan" ? planCommandText(request) : visible(request), agentOnly(brief)],
      pluginMetadata: toJson({
        version: 2,
        role: "second-opinion",
        primaryThreadId,
        source: meta.source,
        forge: meta.forge,
        number: meta.number,
        headRef: meta.headRef,
        headSha: meta.headSha,
        targetRef: meta.targetRef,
        mergeBaseSha: meta.mergeBaseSha,
        mergeBaseApplied: true,
        guarded: true,
        depth: meta.depth,
      }),
    });
    await store.patch(primaryThreadId, { secondOpinion: { threadId: child.id, status: "running", error: null } });
    publish({ threadId: primaryThreadId });
  }

  // ----------------------------------------------------------- reports

  function mergeReport(
    meta: ReviewMetadata,
    incoming: { verdict: Verdict | null; findings: ToolReport["findings"]; previous: NonNullable<ToolReport["previousFindings"]> },
    source: "tool" | "text",
  ): Finding[] {
    const nextId = nextFindingId(meta.findings);
    const findings = meta.findings.map((finding) => ({ ...finding }));
    for (const entry of incoming.previous) {
      const finding = findings.find((candidate) => candidate.id === entry.id.toUpperCase());
      if (finding === undefined || !isActive(finding)) continue;
      if (entry.status === "fixed" || entry.status === "obsolete") {
        finding.status = entry.status;
        finding.statusNote = entry.note ?? `Re-review round ${meta.round}`;
      }
    }
    for (const draft of incoming.findings) {
      const byId = draft.id ? findings.find((candidate) => candidate.id === String(draft.id).toUpperCase()) : undefined;
      const existing = byId ?? findings.find((candidate) => candidate.round === meta.round && sameFinding(candidate, { title: draft.title, file: draft.file ?? null }));
      if (existing !== undefined) {
        const keep = { id: existing.id, round: existing.round, status: existing.status, statusNote: existing.statusNote, posted: existing.posted };
        Object.assign(existing, toFinding(draft, existing.id, existing.round), keep);
        // A text report has no suggestions or evidence; keep what the tool reported earlier.
        if (source === "text") {
          existing.suggestion = existing.suggestion ?? null;
        }
        continue;
      }
      findings.push(toFinding(draft, nextId(), meta.round));
    }
    return findings;
  }

  async function recordToolReport(threadId: string, report: ToolReport): Promise<{ meta: ReviewMetadata; added: number }> {
    let added = 0;
    const updated = await store.update(threadId, (meta) => {
      const findings = mergeReport(meta, { verdict: report.verdict, findings: report.findings, previous: report.previousFindings ?? [] }, "tool");
      added = findings.length - meta.findings.length;
      const reportValue: ReviewReport = {
        verdict: report.verdict,
        summary: report.summary,
        walkthrough: report.walkthrough ?? null,
        questions: report.questions ?? [],
        limitations: report.limitations ?? [],
        compliance: report.compliance ?? null,
        source: "tool",
        round: meta.round,
        reportedAt: Date.now(),
      };
      return { findings, report: reportValue };
    });
    if (updated === null) throw new Error("This thread is not a review started by the Review plugin.");
    publish({ threadId, kind: "report" });
    return { meta: updated, added };
  }

  /** Text fallback: only used when the round has no tool report, and only for messages that look like a report. */
  async function recordTextReport(threadId: string, text: string, parse: (text: string) => { verdict: Verdict | null; findings: DraftFinding[]; previous: Array<{ id: string; status: PreviousFindingStatus }> } | null) {
    const parsed = parse(text);
    if (parsed === null) return null;
    const updated = await store.update(threadId, (meta) => {
      if (meta.report?.source === "tool" && meta.report.round === meta.round) return null;
      if (parsed.verdict === null && meta.report === null && parsed.findings.length === 0) return null;
      const findings = mergeReport(meta, { verdict: parsed.verdict, findings: parsed.findings, previous: parsed.previous }, "text");
      return {
        findings,
        report: {
          verdict: parsed.verdict ?? meta.report?.verdict ?? null,
          summary: meta.report?.summary ?? null,
          walkthrough: null,
          questions: [],
          limitations: [],
          compliance: null,
          source: "text",
          round: meta.round,
          reportedAt: Date.now(),
        },
      };
    });
    return updated;
  }

  async function deliverSecondOpinion(childThreadId: string): Promise<void> {
    const child = await store.read(childThreadId);
    if (child === null || child.role !== "second-opinion" || child.primaryThreadId === null) return;
    const primary = await store.read(child.primaryThreadId);
    if (primary === null || primary.secondOpinion?.status !== "running") return;
    const candidates = child.findings;
    const provider = (await bb.sdk.threads.get({ threadId: childThreadId })).providerId;
    await store.patch(child.primaryThreadId, { secondOpinion: { threadId: childThreadId, status: "delivered", error: null } });
    await sendToThread(
      child.primaryThreadId,
      candidates.length === 0
        ? `# Second opinion\n\nThe second reviewer (${provider}) reported no candidate findings. No action needed beyond noting it in your summary.`
        : secondOpinionMessage(provider, candidates),
      { visibleText: `Second opinion from ${provider}: ${candidates.length} candidate finding(s).` },
    );
    publish({ threadId: child.primaryThreadId });
  }

  // ---------------------------------------------------------- re-review

  /** `since` re-reviews only what changed after that commit, even when the head has not moved. */
  async function reReview(threadId: string, options: { since?: string | null } = {}): Promise<{ headSha: string; round: number }> {
    const meta = await requireReview(threadId);
    const since = options.since?.trim() || null;
    if (since !== null && !/^[0-9a-f]{7,40}$/i.test(since)) throw new Error("--since takes a commit SHA.");
    if (meta.role !== "primary") throw new Error("Re-review the primary review thread, not the second opinion.");
    const current = await settings.get();
    const environment = await environmentOf(threadId);
    if (environment === null) throw new Error("The review worktree is not available; the thread may be archived.");
    const { projectSource } = await projectCheckout(environment.thread.projectId);
    const source = meta.number !== null ? changeLabel(meta.forge, meta.number, meta.headRef) : meta.source;
    const prepared = await host.call(
      "prepareReview",
      { repoPath: projectSource.path, source, targetBranch: meta.targetRef.replace(/^[^/]+\//, ""), remote: current.remote },
      { hostId: projectSource.hostId, timeoutMs: 6 * 60_000 },
    );
    if (prepared.headSha === meta.headSha && since === null) throw new Error("There are no new commits since the last review round.");
    if (prepared.headSha !== meta.headSha) {
      await host.call("resetWorktree", { worktreePath: environment.path, sha: prepared.headSha }, { hostId: environment.hostId });
    }
    const previousHeadSha = since ?? meta.headSha;
    const round = meta.round + 1;
    const { project } = await projectCheckout(environment.thread.projectId);
    const config = projectConfigFor(current, project);
    const rerunChecks = meta.checks !== null && config.checks.length > 0;
    await store.patch(threadId, {
      previousHeadSha,
      headSha: prepared.headSha,
      mergeBaseSha: prepared.mergeBaseSha,
      round,
      newCommits: null,
      readOnlyViolations: [],
      ...(rerunChecks ? { checks: { status: "pending", results: [], startedAt: null } } : {}),
    });
    const label = changeLabel(meta.forge, meta.number, meta.headRef);
    await sendToThread(
      threadId,
      reReviewBrief({
        round,
        label,
        previousHeadSha,
        headSha: prepared.headSha,
        mergeBaseSha: prepared.mergeBaseSha,
        findings: meta.findings,
      }),
      {
        visibleText:
          prepared.headSha === meta.headSha
            ? `Re-review ${label}: round ${round}, changes after ${previousHeadSha.slice(0, 9)}.`
            : `Re-review ${label}: round ${round}, new head ${prepared.headSha.slice(0, 9)}.`,
      },
    );
    if (rerunChecks) void runChecks(threadId).catch((error) => log("checks failed", error));
    publish({ threadId });
    return { headSha: prepared.headSha, round };
  }

  // ------------------------------------------------------------ posting

  async function changeRequestTarget(threadId: string, meta: ReviewMetadata) {
    if (meta.forge === null || meta.number === null) throw new Error("This review has no merge request or pull request to post to.");
    const thread = await bb.sdk.threads.get({ threadId });
    const { projectSource } = await projectCheckout(thread.projectId);
    return { repoPath: projectSource.path, hostId: projectSource.hostId, forge: meta.forge, number: meta.number };
  }

  const marker = (threadId: string, id: string) => `bb-review:${threadId}:${id}`;

  async function postFindings(threadId: string, options: { findingIds?: string[] | null; publish?: boolean; summary?: boolean }) {
    const meta = await requireReview(threadId);
    const target = await changeRequestTarget(threadId, meta);
    const wanted = options.findingIds?.map((id) => id.toUpperCase()) ?? null;
    const selected = meta.findings.filter((finding) =>
      wanted !== null ? wanted.includes(finding.id) : finding.status === "open" && finding.severity !== PRE_EXISTING,
    );
    if (selected.length === 0) throw new Error(wanted ? `No findings match ${wanted.join(", ")}.` : "There are no open findings to post.");
    const alreadyPosted = selected.filter((finding) => finding.posted !== null);
    if (alreadyPosted.length > 0) throw new Error(`${alreadyPosted.map((finding) => finding.id).join(", ")} already posted.`);
    const includeSummary = options.summary ?? !meta.findings.some((finding) => finding.posted !== null);
    const result = await host.call(
      "postFindings",
      {
        repoPath: target.repoPath,
        forge: target.forge,
        number: target.number,
        reviewedHeadSha: meta.headSha,
        mergeBaseSha: meta.mergeBaseSha ?? meta.headSha,
        summary: includeSummary ? summaryComment(meta, marker(threadId, "summary")) : null,
        items: selected.map((finding) => ({
          marker: marker(threadId, finding.id),
          file: finding.file,
          startLine: finding.startLine,
          endLine: finding.endLine,
          body: commentBody(finding),
          suggestion: finding.suggestion,
          suggestionStartLine: finding.suggestionStartLine,
          suggestionEndLine: finding.suggestionEndLine,
        })),
        publish: options.publish ?? false,
      },
      { hostId: target.hostId, timeoutMs: 5 * 60_000 },
    );
    const byMarker = new Map(result.results.map((entry) => [entry.marker, entry]));
    await store.update(threadId, (current) => ({
      findings: current.findings.map((finding) => {
        const entry = byMarker.get(marker(threadId, finding.id));
        if (entry === undefined) return finding;
        if (entry.ref === null) return { ...finding, statusNote: `Posting failed: ${entry.error}` };
        const published = entry.ref.kind !== "gitlab-draft" && entry.ref.kind !== "github-pending";
        return { ...finding, status: published ? "posted" : "drafted", statusNote: null, posted: entry.ref };
      }),
    }));
    publish({ threadId });
    return {
      posted: result.results.filter((entry) => entry.ref !== null).map((entry) => entry.marker.split(":").pop()!),
      failed: result.results.filter((entry) => entry.ref === null).map((entry) => ({ id: entry.marker.split(":").pop()!, error: entry.error })),
      warnings: result.warnings,
      published: options.publish ?? false,
    };
  }

  async function publishDrafts(threadId: string) {
    const meta = await requireReview(threadId);
    const target = await changeRequestTarget(threadId, meta);
    const result = await host.call("publishDrafts", { repoPath: target.repoPath, forge: target.forge, number: target.number }, { hostId: target.hostId });
    if (result.published) {
      await store.update(threadId, (current) => ({
        findings: current.findings.map((finding) =>
          finding.status === "drafted" && finding.posted
            ? {
                ...finding,
                status: "posted",
                posted: {
                  ...finding.posted,
                  kind: finding.posted.kind === "github-pending" ? "github-comment" : finding.posted.positioned ? "gitlab-discussion" : "gitlab-note",
                },
              }
            : finding,
        ),
      }));
    }
    publish({ threadId });
    return result;
  }

  async function dismissFinding(threadId: string, findingId: string, reason: string, remember: boolean) {
    const id = findingId.toUpperCase();
    let dismissed: Finding | undefined;
    const meta = await store.update(threadId, (current) => ({
      findings: current.findings.map((finding) => {
        if (finding.id !== id) return finding;
        dismissed = { ...finding, status: "dismissed", statusNote: reason.trim() || null };
        return dismissed;
      }),
    }));
    if (meta === null || dismissed === undefined) throw new Error(`No finding ${id} in this review.`);
    if (remember) {
      const thread = await bb.sdk.threads.get({ threadId });
      await learnings.add({
        projectId: thread.projectId,
        text: `${dismissed.title}${dismissed.file ? ` (${dismissed.file})` : ""}${reason.trim() ? `: ${reason.trim()}` : ""}`.slice(0, 1000),
        origin: { threadId, findingId: id, title: dismissed.title },
      });
    }
    publish({ threadId });
  }

  async function reopenFinding(threadId: string, findingId: string) {
    const id = findingId.toUpperCase();
    await store.update(threadId, (current) => ({
      findings: current.findings.map((finding) =>
        finding.id === id ? { ...finding, status: finding.posted ? (finding.posted.kind.endsWith("pending") || finding.posted.kind === "gitlab-draft" ? "drafted" : "posted") : "open", statusNote: null } : finding,
      ),
    }));
    publish({ threadId });
  }

  // ------------------------------------------------------- status sync

  async function syncReview(threadId: string): Promise<ReviewMetadata | null> {
    const meta = await store.read(threadId);
    if (meta === null || meta.role !== "primary" || meta.forge === null || meta.number === null) return meta;
    const target = await changeRequestTarget(threadId, meta);
    const markers = meta.findings.filter((finding) => finding.posted !== null).map((finding) => marker(threadId, finding.id));
    const status = await host.call(
      "changeRequestStatus",
      { repoPath: target.repoPath, forge: target.forge, number: target.number, markers },
      { hostId: target.hostId },
    );
    const threads = new Map(status.threads.map((entry) => [entry.marker, entry]));
    const drafts = new Set(status.drafts);
    const updated = await store.update(threadId, (current) => ({
      mrState: status.state,
      newCommits: status.headSha !== null && status.headSha !== current.headSha ? { headSha: status.headSha, seenAt: Date.now() } : null,
      findings: current.findings.map((finding) => {
        if (finding.posted === null || ["dismissed", "fixed", "obsolete"].includes(finding.status)) return finding;
        const key = marker(threadId, finding.id);
        const thread = threads.get(key);
        if (thread !== undefined) {
          return {
            ...finding,
            status: thread.resolved ? "resolved" : "posted",
            posted: { ...finding.posted, id: thread.id, url: thread.url ?? finding.posted.url, kind: finding.posted.kind === "github-pending" ? "github-comment" : finding.posted.kind === "gitlab-draft" ? "gitlab-discussion" : finding.posted.kind },
          };
        }
        if (drafts.has(key)) return finding;
        // Published general notes have no thread to resolve; keep them posted.
        if (finding.status === "posted" && !finding.posted.positioned) return finding;
        return finding.status === "drafted" ? { ...finding, status: "discarded", statusNote: "The draft was deleted on the forge." } : finding;
      }),
    }));
    publish({ threadId });
    return updated;
  }

  async function checkReadOnly(threadId: string): Promise<void> {
    const environment = await environmentOf(threadId);
    if (environment === null) return;
    const { dirty } = await host.call("worktreeStatus", { worktreePath: environment.path }, { hostId: environment.hostId });
    await store.update(threadId, (current) =>
      JSON.stringify(current.readOnlyViolations) === JSON.stringify(dirty) ? null : { readOnlyViolations: dirty },
    );
    if (dirty.length > 0) publish({ threadId });
  }

  // ------------------------------------------------------- lists and queue

  async function reviewThreads(options: { projectId?: string | null; includeArchived?: boolean } = {}) {
    const base = { originPluginId: bb.pluginId, ...(options.projectId ? { projectId: options.projectId } : {}), limit: 100 };
    const active = await bb.sdk.threads.list(base);
    const archived = options.includeArchived ? await bb.sdk.threads.list({ ...base, archived: true }) : [];
    return [...active, ...archived];
  }

  const backfilled = new Set<string>();

  /** Reviews that finished before structured findings existed get them from their final report, once. */
  async function backfillReport(threadId: string): Promise<ReviewMetadata | null> {
    if (backfilled.has(threadId)) return null;
    backfilled.add(threadId);
    const output = await bb.sdk.threads.output({ threadId }).catch(() => null);
    if (!output?.output) return null;
    return recordTextReport(threadId, output.output, parseReportText).catch((error: unknown) => {
      log(`backfilling ${threadId} failed`, error);
      return null;
    });
  }

  async function listReviews(projectId: string | null, includeArchived = false): Promise<ReviewSummary[]> {
    const threads = await reviewThreads({ projectId, includeArchived });
    const summaries = await Promise.all(
      threads.map(async (thread): Promise<ReviewSummary | null> => {
        let meta = await store.read(thread.id);
        if (meta === null || meta.role !== "primary") return null;
        if (meta.report === null && meta.findings.length === 0 && thread.status === "idle") meta = (await backfillReport(thread.id)) ?? meta;
        const counts: FindingCounts =
          meta.findings.length > 0 || meta.report !== null ? countFindings(meta.findings) : ((meta.outcome?.findings as FindingCounts | undefined) ?? {});
        return {
          threadId: thread.id,
          projectId: thread.projectId,
          title: thread.title ?? thread.titleFallback ?? thread.id,
          status: thread.status,
          archived: thread.archivedAt !== null,
          createdAt: thread.createdAt,
          url: meta.url,
          label: changeLabel(meta.forge, meta.number, meta.headRef),
          depth: meta.depth,
          round: meta.round,
          verdict: meta.report?.verdict ?? meta.outcome?.verdict ?? null,
          counts,
          riskLevel: meta.risk?.level ?? null,
          newCommits: meta.newCommits !== null,
          checks: meta.checks?.status ?? null,
          preview: meta.preview?.status ?? null,
          secondOpinion: meta.secondOpinion?.status ?? null,
          readOnlyViolations: meta.readOnlyViolations.length,
          mrState: meta.mrState,
        };
      }),
    );
    return summaries.filter((summary): summary is ReviewSummary => summary !== null).sort((a, b) => b.createdAt - a.createdAt);
  }

  const QUEUE_KEY = "queue";
  const queueSchema = z.object({ fetchedAt: z.number(), items: z.array(z.custom<QueueItem>()) });

  async function readQueue() {
    const parsed = queueSchema.safeParse(await bb.storage.kv.get(QUEUE_KEY));
    return parsed.success ? parsed.data : { fetchedAt: 0, items: [] as QueueItem[] };
  }

  const AUTO_START_PER_SWEEP = 3;
  let sweeping: Promise<void> | null = null;

  /** Lists review requests, syncs posted comments, flags new commits, and archives reviews of closed merge requests. */
  function sweep(): Promise<void> {
    sweeping ??= (async () => {
      try {
        const current = await settings.get();
        const projects = (await bb.sdk.projects.list()).filter((project) => project.kind === "standard");
        const reviews = await listReviews(null);
        const items: QueueItem[] = [];
        for (const project of projects) {
          const source = project.sources.find((candidate) => candidate.isDefault) ?? project.sources[0];
          if (source === undefined) continue;
          const result = await host
            .call("listReviewRequests", { repoPath: source.path, remote: current.remote }, { hostId: source.hostId, timeoutMs: 45_000 })
            .catch(() => ({ forge: null, items: [] }));
          // The `!` mention search has a 2-second budget, too short for a cold glab call.
          void suggestions(project.id, true).catch(() => undefined);
          for (const item of result.items) {
            const review = reviews.find((candidate) => candidate.projectId === project.id && candidate.label === changeLabel(item.forge, item.number, ""));
            const reviewMeta = review ? await store.read(review.threadId) : null;
            items.push({ ...item, projectId: project.id, projectName: project.name, reviewThreadId: review?.threadId ?? null, reviewedHeadSha: reviewMeta?.headSha ?? null });
          }
        }
        await bb.storage.kv.set(QUEUE_KEY, { fetchedAt: Date.now(), items } as unknown as JsonObject);

        for (const review of reviews.slice(0, 40)) {
          if (review.archived) continue;
          const meta = await syncReview(review.threadId).catch((error) => {
            log(`sync of ${review.threadId} failed`, error);
            return null;
          });
          if (current.autoArchiveClosed && meta !== null && (meta.mrState === "merged" || meta.mrState === "closed")) {
            await stopPreview(review.threadId).catch(() => undefined);
            await bb.sdk.threads.archive({ threadId: review.threadId }).catch((error) => log(`archiving ${review.threadId} failed`, error));
          }
        }

        if (current.autoStartReviews) {
          // A first sweep after enabling this could otherwise start a review for every open request at once.
          const toStart = items.filter((item) => item.reviewThreadId === null && !item.draft).slice(0, AUTO_START_PER_SWEEP);
          for (const item of toStart) {
            await startReview({ projectId: item.projectId, source: changeLabel(item.forge, item.number, "") }).catch((error) =>
              log(`auto-start of ${item.projectName} ${item.number} failed`, error),
            );
          }
        }
        publish({ kind: "queue" });
      } finally {
        sweeping = null;
      }
    })();
    return sweeping;
  }

  async function stats() {
    const threads = await reviewThreads({ includeArchived: true });
    let reviews = 0;
    let reported = 0;
    let posted = 0;
    let accepted = 0;
    let dismissed = 0;
    for (const thread of threads) {
      const meta = await store.read(thread.id);
      if (meta === null || meta.role !== "primary") continue;
      reviews += 1;
      for (const finding of meta.findings) {
        if (finding.severity === PRE_EXISTING) continue;
        reported += 1;
        if (finding.posted !== null) posted += 1;
        if (finding.status === "fixed" || finding.status === "resolved") accepted += 1;
        if (finding.status === "dismissed" || finding.status === "discarded") dismissed += 1;
      }
    }
    const decided = accepted + dismissed;
    return { reviews, reported, posted, accepted, dismissed, acceptanceRate: decided === 0 ? null : accepted / decided };
  }

  return {
    startReview,
    onEnvironmentReady,
    runChecks,
    startPreview,
    stopPreview,
    retrySecondOpinion,
    recordToolReport,
    recordTextReport,
    deliverSecondOpinion,
    reReview,
    postFindings,
    publishDrafts,
    dismissFinding,
    reopenFinding,
    syncReview,
    checkReadOnly,
    listReviews,
    readQueue,
    sweep,
    stats,
    suggestions,
    requireReview,
    publish,
  };
}
export type ReviewService = ReturnType<typeof createReviewService>;
