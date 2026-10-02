/** Realtime channel the Reviews UI refetches on. */
export const REVIEWS_CHANGED = "reviews-changed";

export const severities = ["Critical", "High", "Medium", "Low"] as const;
export type Severity = (typeof severities)[number];
/** Bugs the change did not introduce; reported separately and never counted in the verdict. */
export const PRE_EXISTING = "Pre-existing";
export type FindingSeverity = Severity | typeof PRE_EXISTING;
export const findingSeverities = [...severities, PRE_EXISTING] as const;

/** The verdicts the review guidelines ask for, most severe first. */
export const verdicts = ["Needs rework", "Fix before merging", "No blocking issues"] as const;
export type Verdict = (typeof verdicts)[number];

export const findingCategories = [
  "correctness",
  "contracts",
  "security",
  "error-handling",
  "requirements",
  "tests",
  "performance",
  "maintainability",
  "dependencies",
  "ui",
] as const;
export type FindingCategory = (typeof findingCategories)[number];

/**
 * open: reported, not acted on. drafted/posted: sent to the merge request.
 * fixed/obsolete: decided by a re-review. resolved: the forge thread was resolved.
 * dismissed: the user rejected it. discarded: the user deleted the draft on the forge.
 */
export const findingStatuses = ["open", "drafted", "posted", "fixed", "obsolete", "resolved", "dismissed", "discarded"] as const;
export type FindingStatus = (typeof findingStatuses)[number];

export const previousFindingStatuses = ["fixed", "still-open", "obsolete"] as const;
export type PreviousFindingStatus = (typeof previousFindingStatuses)[number];

export interface PostedRef {
  kind: "gitlab-draft" | "gitlab-discussion" | "gitlab-note" | "github-pending" | "github-comment";
  id: string;
  positioned: boolean;
  url: string | null;
}

export interface Finding {
  id: string;
  round: number;
  severity: FindingSeverity;
  title: string;
  file: string | null;
  startLine: number | null;
  endLine: number | null;
  body: string;
  suggestion: string | null;
  /** Lines the suggestion replaces; null means the finding's own range. */
  suggestionStartLine: number | null;
  suggestionEndLine: number | null;
  confidence: number | null;
  evidence: string | null;
  category: FindingCategory | null;
  status: FindingStatus;
  statusNote: string | null;
  posted: PostedRef | null;
}

export const complianceStatuses = ["fully", "partially", "not", "unknown"] as const;
export type ComplianceStatus = (typeof complianceStatuses)[number];

export interface ReviewReport {
  verdict: Verdict | null;
  summary: string | null;
  walkthrough: string | null;
  questions: string[];
  limitations: string[];
  compliance: { status: ComplianceStatus; notes: string } | null;
  source: "tool" | "text";
  round: number;
  reportedAt: number;
}

export type FindingCounts = Partial<Record<Severity, number>>;

const ACTIVE_STATUSES: ReadonlySet<FindingStatus> = new Set(["open", "drafted", "posted"]);

export function isActive(finding: Pick<Finding, "status">): boolean {
  return ACTIVE_STATUSES.has(finding.status);
}

/** Counts findings that still need attention; pre-existing ones never count. */
export function countFindings(findings: readonly Finding[]): FindingCounts {
  const counts: FindingCounts = {};
  for (const finding of findings) {
    if (finding.severity === PRE_EXISTING || !isActive(finding)) continue;
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  }
  return counts;
}

export function formatCounts(counts: FindingCounts): string {
  return severities
    .filter((severity) => (counts[severity] ?? 0) > 0)
    .map((severity) => `${counts[severity]} ${severity}`)
    .join(", ");
}

export function formatOutcome(verdict: Verdict | null, counts: FindingCounts): string {
  return [verdict, formatCounts(counts)].filter(Boolean).join(" · ");
}

export function formatLocation(finding: Pick<Finding, "file" | "startLine" | "endLine">): string | null {
  if (finding.file === null) return null;
  if (finding.startLine === null) return finding.file;
  return finding.endLine !== null && finding.endLine !== finding.startLine
    ? `${finding.file}:${finding.startLine}-${finding.endLine}`
    : `${finding.file}:${finding.startLine}`;
}

/** A finding as parsed from text, before the plugin assigns ids and status. */
export type DraftFinding = Omit<Finding, "id" | "round" | "status" | "statusNote" | "posted">;

export interface ParsedReport {
  verdict: Verdict | null;
  findings: DraftFinding[];
  previous: Array<{ id: string; status: PreviousFindingStatus }>;
}

const FINDING_HEADER = /^\s*(?:\d+\.|[-*])\s*\*{0,2}\[(Critical|High|Medium|Low|Pre-existing)\]\*{0,2}\s*(.+?)\s*$/i;
const FILE_LINE = /^\s*(?:[-*]\s*)?\**File:?\**:?\s*`?([^`\s:]+(?:\.[^`\s:]+)?)(?::(\d+)(?:-(\d+))?)?`?/i;
const SECTION_END = /^\s*(?:\*\*|#{1,4}\s)?\s*(Summary|Questions|Limitations|Previous findings|Walkthrough)\b/i;

function canonicalSeverity(value: string): FindingSeverity {
  const lower = value.toLowerCase();
  if (lower === "pre-existing") return PRE_EXISTING;
  return severities.find((severity) => severity.toLowerCase() === lower) ?? "Medium";
}

function findVerdict(text: string): Verdict | null {
  return (
    verdicts.find((candidate) => text.includes(candidate)) ??
    (/No actionable findings/i.test(text) ? "No blocking issues" : null)
  );
}

/**
 * Reads a report written in the guidelines' text format. Used when the agent
 * did not call the present_review tool (for example when Plan mode makes it
 * avoid tool calls), so the review panel still gets structured findings.
 */
export function parseReportText(text: string): ParsedReport | null {
  const lines = text.split("\n");
  const findings: DraftFinding[] = [];
  let current: { draft: DraftFinding; body: string[] } | null = null;
  const flush = () => {
    if (current === null) return;
    current.draft.body = current.body.join("\n").trim();
    findings.push(current.draft);
    current = null;
  };

  for (const line of lines) {
    const header = FINDING_HEADER.exec(line);
    if (header) {
      flush();
      current = {
        draft: {
          severity: canonicalSeverity(header[1]),
          title: header[2].replace(/\*+$/, "").trim(),
          file: null,
          startLine: null,
          endLine: null,
          body: "",
          suggestion: null,
          suggestionStartLine: null,
          suggestionEndLine: null,
          confidence: null,
          evidence: null,
          category: null,
        },
        body: [],
      };
      continue;
    }
    if (current === null) continue;
    if (SECTION_END.test(line)) {
      flush();
      continue;
    }
    const file = current.draft.file === null ? FILE_LINE.exec(line) : null;
    if (file) {
      current.draft.file = file[1];
      current.draft.startLine = file[2] ? Number(file[2]) : null;
      current.draft.endLine = file[3] ? Number(file[3]) : current.draft.startLine;
      continue;
    }
    current.body.push(line.replace(/^ {3}/, ""));
  }
  flush();

  const previous = Array.from(text.matchAll(/\b(F\d+)\b[^\n]*?\b(fixed|still[ -]open|obsolete)\b/gi), (match) => ({
    id: match[1].toUpperCase(),
    status: match[2].toLowerCase().replace(" ", "-") as PreviousFindingStatus,
  }));
  const verdict = findVerdict(text);
  if (verdict === null && findings.length === 0 && previous.length === 0) return null;
  return { verdict, findings, previous };
}
