import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  complianceStatuses,
  findingCategories,
  findingSeverities,
  previousFindingStatuses,
  verdicts,
} from "../shared/findings.ts";
import type { ReviewService } from "./service.ts";

const TOOL_NAME = "present_review";

const presentReviewParameters = z.object({
  verdict: z.enum(verdicts),
  summary: z.string().min(1).max(4000).describe("Tally line, what the change does, and the reason for the verdict."),
  findings: z
    .array(
      z.object({
        id: z.string().regex(/^F\d+$/i).nullish().describe("Id of an earlier finding you are updating; omit for new findings."),
        severity: z.enum(findingSeverities),
        title: z.string().min(1).max(200),
        file: z.string().max(500).nullish(),
        startLine: z.number().int().positive().nullish(),
        endLine: z.number().int().positive().nullish(),
        body: z.string().min(1).max(4000).describe("One paragraph: the trigger, then the consequence."),
        suggestion: z
          .string()
          .max(4000)
          .nullish()
          .describe("Exact replacement text for the lines it replaces (suggestionStartLine..suggestionEndLine, default startLine..endLine); omit unless it is a complete fix."),
        suggestionStartLine: z.number().int().positive().nullish().describe("First line the suggestion replaces, when not the whole finding range."),
        suggestionEndLine: z.number().int().positive().nullish().describe("Last line the suggestion replaces."),
        confidence: z.number().int().min(0).max(100).nullish(),
        evidence: z.string().max(2000).nullish().describe("How you verified the finding."),
        category: z.enum(findingCategories).nullish(),
      }),
    )
    .max(60),
  previousFindings: z
    .array(z.object({ id: z.string().regex(/^F\d+$/i), status: z.enum(previousFindingStatuses), note: z.string().max(500).nullish() }))
    .max(100)
    .optional(),
  compliance: z.object({ status: z.enum(complianceStatuses), notes: z.string().max(2000) }).nullish(),
  walkthrough: z.string().max(8000).nullish(),
  questions: z.array(z.string().max(1000)).max(20).optional(),
  limitations: z.array(z.string().max(1000)).max(20).optional(),
});

export function registerAgentSurfaces(bb: BbPluginApi, service: ReviewService) {
  bb.agents.registerTool({
    name: TOOL_NAME,
    description:
      "Show this review's result in the user's review panel. Display only: it does not change files, the repository, the merge request, or any external service, so it is part of a read-only review and allowed in Plan mode. Call it once the review is complete, and again with the complete result whenever you update it.",
    presentation: { label: { pending: "Presenting review", completed: "Presented review" } },
    parameters: presentReviewParameters,
    async execute(params, { threadId }) {
      const { meta, added } = await service.recordToolReport(threadId, {
        verdict: params.verdict,
        summary: params.summary,
        findings: params.findings.map((finding) => ({
          id: finding.id ?? null,
          severity: finding.severity,
          title: finding.title,
          file: finding.file ?? null,
          startLine: finding.startLine ?? null,
          endLine: finding.endLine ?? finding.startLine ?? null,
          body: finding.body,
          suggestion: finding.suggestion ?? null,
          suggestionStartLine: finding.suggestionStartLine ?? null,
          suggestionEndLine: finding.suggestionEndLine ?? null,
          confidence: finding.confidence ?? null,
          evidence: finding.evidence ?? null,
          category: finding.category ?? null,
        })),
        previousFindings: params.previousFindings?.map((entry) => ({ id: entry.id, status: entry.status, note: entry.note ?? null })),
        compliance: params.compliance ?? null,
        walkthrough: params.walkthrough ?? null,
        questions: params.questions,
        limitations: params.limitations,
      });
      const ids = meta.findings.map((finding) => `${finding.id} ${finding.title}`).slice(-60);
      return [
        `Shown in the review panel: ${meta.findings.length} finding(s), ${added} new. Ids: ${ids.join("; ") || "none"}.`,
        "Now write the report message for the user and end it with a line containing only ::review-findings.",
      ].join("\n");
    },
  });

  bb.agents.configure((context) => {
    const metadata = context.pluginMetadata as Record<string, unknown>;
    const isReview = typeof metadata.headSha === "string" && typeof metadata.headRef === "string";
    return {
      tools: isReview ? [TOOL_NAME] : [],
      skills: ["branch-review"],
      ...(isReview
        ? {
            instructions:
              "This thread is a read-only code review run by the Review plugin. Do not edit files, commit, or push. Report the result with the present_review tool (display only, allowed in Plan mode) and end the report with ::review-findings.",
          }
        : {}),
    };
  });

  bb.ui.registerMentionProvider({
    id: "merge-requests",
    label: "Merge requests",
    triggers: ["!"],
    async search({ query, projectId }) {
      const projects = (await bb.sdk.projects.list()).filter((project) => project.kind === "standard" && (projectId === null || project.id === projectId));
      const needle = query.trim().toLowerCase();
      const items = [];
      for (const project of projects.slice(0, 5)) {
        const suggestions = await service.suggestions(project.id).catch(() => null);
        for (const request of suggestions?.changeRequests ?? []) {
          const reference = `${request.forge === "gitlab" ? "!" : "#"}${request.number}`;
          if (needle !== "" && !`${request.number} ${request.title} ${request.sourceBranch ?? ""} ${request.author ?? ""}`.toLowerCase().includes(needle)) continue;
          items.push({
            id: `${project.id}|${request.forge}|${request.number}`,
            title: `${reference} ${request.title}`,
            subtitle: [project.name, request.sourceBranch && request.targetBranch ? `${request.sourceBranch} → ${request.targetBranch}` : null, request.author]
              .filter(Boolean)
              .join(" · "),
            icon: "GitPullRequest",
          });
        }
      }
      return items.slice(0, 20);
    },
    async resolve(itemId) {
      const [projectId, forge, number] = itemId.split("|");
      const project = await bb.sdk.projects.get({ projectId });
      const suggestions = await service.suggestions(projectId).catch(() => null);
      const request = suggestions?.changeRequests.find((candidate) => candidate.forge === forge && String(candidate.number) === number);
      const reference = `${forge === "gitlab" ? "!" : "#"}${number}`;
      if (request === undefined) return { context: `Merge request ${reference} in project ${project.name}.` };
      return {
        context: [
          `Merge request ${reference} in project ${project.name}: ${request.title}`,
          request.url ? `URL: ${request.url}` : null,
          request.sourceBranch && request.targetBranch ? `Branches: ${request.sourceBranch} → ${request.targetBranch}` : null,
          request.author ? `Author: ${request.author}` : null,
          request.draft ? "Draft: yes" : null,
          `To review it in a read-only worktree: bb review start '${reference}' --project ${JSON.stringify(project.name)}`,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    },
  });
}
