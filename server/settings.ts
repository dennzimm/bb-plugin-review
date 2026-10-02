import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const depths = ["quick", "standard", "deep"] as const;
export type Depth = (typeof depths)[number];
const when = ["never", "deep", "always"] as const;

export const projectConfigSchema = z
  .object({
    /** Shell commands run in the review worktree; `{base}` and `{head}` expand to the merge base and head SHAs. */
    checks: z.array(z.string().min(1)).max(20).default([]),
    checkTimeoutMinutes: z.number().int().min(1).max(29).default(20),
    preview: z
      .object({
        command: z.string().min(1),
        url: z.string().url(),
        baselineUrl: z.string().url().optional(),
        readyTimeoutSeconds: z.number().int().min(10).max(600).default(180),
      })
      .optional(),
    rules: z.array(z.object({ paths: z.array(z.string().min(1)).min(1), instructions: z.string().min(1) })).default([]),
    criteria: z.string().default(""),
    riskyPaths: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

const projectConfigsSchema = z.record(z.string(), projectConfigSchema);

function parseProjectConfigs(text: string): Record<string, ProjectConfig> {
  if (text.trim() === "") return {};
  return projectConfigsSchema.parse(JSON.parse(text));
}

export const settingsSchemaIssues = (text: string): string | null => {
  try {
    parseProjectConfigs(text);
    return null;
  } catch (error) {
    return error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") : String(error);
  }
};

export function defineSettings(bb: BbPluginApi) {
  return bb.settings.define({
    remote: {
      type: "string",
      label: "Git remote",
      description: "Remote that branches, merge requests, and pull requests are fetched from.",
      experimental_schema: z.string().regex(/^[A-Za-z0-9._-]+$/, "Use a plain remote name such as origin"),
      default: "origin",
    },
    readOnlyMode: {
      type: "select",
      label: "Read-only enforcement",
      description:
        "plan starts reviews in Plan mode, which blocks file edits. guarded skips Plan mode and relies on the review instructions, a removed push upstream, and a dirty-worktree check after every turn.",
      options: ["plan", "guarded"],
      default: "plan",
    },
    defaultDepth: {
      type: "select",
      label: "Default review depth",
      description: "quick reports only high-confidence correctness and security issues; deep fans out by dimension and runs checks, preview, and a second opinion when configured.",
      options: [...depths],
      default: "standard",
    },
    teamGuidelines: {
      type: "string",
      label: "Team review criteria",
      description: "Extra criteria added to every review, in every project.",
      experimental_multiline: true,
      experimental_schema: z.string().max(8000, "Keep team criteria under 8000 characters"),
      default: "",
    },
    projectConfig: {
      type: "string",
      label: "Per-project configuration (JSON)",
      description:
        'Keyed by project name or id: checks, checkTimeoutMinutes, preview {command, url, baselineUrl}, rules [{paths, instructions}], criteria, riskyPaths. See the README for an example.',
      experimental_multiline: true,
      experimental_schema: z.string().refine((text) => settingsSchemaIssues(text) === null, {
        message: "Invalid project configuration; check the JSON against the README example",
      }),
      default: "{}",
    },
    runChecksWhen: { type: "select", label: "Run configured checks", options: [...when], default: "deep" },
    previewWhen: { type: "select", label: "Start configured UI preview", options: [...when], default: "deep" },
    secondOpinionWhen: { type: "select", label: "Ask a second reviewer", options: [...when], default: "deep" },
    secondOpinionProvider: {
      type: "string",
      label: "Second reviewer provider",
      description: "Provider id of the second reviewer, for example codex. Empty disables second opinions.",
      default: "",
    },
    secondOpinionModel: { type: "string", label: "Second reviewer model", description: "Optional model id.", default: "" },
    inspectInstallScripts: {
      type: "boolean",
      label: "Inspect new packages",
      description: "Look up install scripts of newly added packages with npm view and run osv-scanner when it is installed.",
      default: true,
    },
    queuePolling: {
      type: "boolean",
      label: "Watch my review requests",
      description: "Every 10 minutes, list merge requests where you are a reviewer, sync posted comments, and flag reviews with new commits.",
      default: true,
    },
    autoStartReviews: {
      type: "boolean",
      label: "Start reviews automatically",
      description: "Start a review when a new merge request requests your review.",
      default: false,
    },
    autoArchiveClosed: {
      type: "boolean",
      label: "Archive reviews of merged or closed merge requests",
      default: true,
    },
    jiraBaseUrl: {
      type: "string",
      label: "Jira URL",
      description: "For example https://your-company.atlassian.net. Empty disables ticket compliance.",
      default: "",
    },
    jiraEmail: { type: "string", label: "Jira account email", default: "" },
    jiraApiToken: { type: "string", label: "Jira API token", secret: true },
    ticketPattern: {
      type: "string",
      label: "Ticket key pattern",
      description: "Regular expression for ticket keys in branch names and titles.",
      experimental_schema: z.string().refine((value) => {
        try {
          new RegExp(value);
          return true;
        } catch {
          return false;
        }
      }, "Not a valid regular expression"),
      // `\b` would not match keys followed by `_`, which is common in branch names.
      default: "(?<![A-Za-z0-9])[A-Z][A-Z0-9]+-\\d+(?!\\d)",
    },
  });
}

export type Settings = Awaited<ReturnType<ReturnType<typeof defineSettings>["get"]>>;

export function projectConfigFor(settings: Settings, project: { id: string; name: string }): ProjectConfig {
  const configs = parseProjectConfigs(settings.projectConfig);
  return configs[project.id] ?? configs[project.name] ?? projectConfigSchema.parse({});
}

export function enabledFor(setting: "never" | "deep" | "always" | string, depth: Depth): boolean {
  return setting === "always" || (setting === "deep" && depth === "deep");
}
