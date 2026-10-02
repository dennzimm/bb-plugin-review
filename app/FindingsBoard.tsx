import { useMemo, useState } from "react";
import { Markdown, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ReviewDetail } from "../server";
import { countFindings, formatCounts, formatLocation, isActive, PRE_EXISTING, severities, type Finding } from "../shared/findings.ts";
import { useAction, useReview, useReviewRpc } from "./api.ts";
import { Chip, Disclosure, EmptyState, SeverityChip, Spinner, StatusChip, VerdictChip, fieldClassName } from "./ui.tsx";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const SEVERITY_ORDER = [...severities, PRE_EXISTING];

function fence(code: string): string {
  const longest = Math.max(2, ...Array.from(code.matchAll(/`+/g), (match) => match[0].length));
  const marks = "`".repeat(longest + 1);
  return `${marks}\n${code}\n${marks}`;
}

function DismissForm({ onSubmit, onCancel, busy }: { onSubmit: (reason: string, remember: boolean) => void; onCancel: () => void; busy: boolean }) {
  const [reason, setReason] = useState("");
  const [remember, setRemember] = useState(false);
  return (
    <div className="mt-2 space-y-2 rounded-md border border-border p-2">
      <textarea
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        rows={2}
        maxLength={1000}
        placeholder="Why is this wrong or not wanted? (optional)"
        className={cn(fieldClassName, "resize-y py-1.5")}
        autoFocus
      />
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs">
          <Checkbox checked={remember} onCheckedChange={(checked) => setRemember(checked === true)} />
          Remember for future reviews of this project
        </label>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => onSubmit(reason, remember)} disabled={busy}>
            {busy ? <Spinner /> : null}
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  );
}

function FindingCard({
  review,
  finding,
  selected,
  onSelect,
  selectable,
}: {
  review: ReviewDetail;
  finding: Finding;
  selected: boolean;
  onSelect: (selected: boolean) => void;
  selectable: boolean;
}) {
  const rpc = useReviewRpc();
  const navigate = useBbNavigate();
  const action = useAction();
  const [dismissing, setDismissing] = useState(false);
  const location = formatLocation(finding);
  const closed = !isActive(finding);

  const openFile = () => {
    if (review.environmentId === null || finding.file === null) return;
    navigate.experimental_openFilePreview({
      target: { kind: "workspace", environmentId: review.environmentId, path: finding.file },
      location:
        finding.startLine === null
          ? null
          : finding.endLine !== null && finding.endLine !== finding.startLine
            ? { kind: "range", startLine: finding.startLine, endLine: finding.endLine }
            : { kind: "line", line: finding.startLine, column: null },
    });
  };

  return (
    <li className={cn("rounded-lg border border-border bg-card p-3", closed && "opacity-70")}>
      <div className="flex items-start gap-2">
        {selectable ? (
          <Checkbox className="mt-0.5" checked={selected} onCheckedChange={(checked) => onSelect(checked === true)} aria-label={`Select ${finding.id}`} />
        ) : null}
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <SeverityChip severity={finding.severity} />
            <span className="font-mono text-xs text-muted-foreground">{finding.id}</span>
            <span className="min-w-0 flex-1 text-sm font-medium">{finding.title}</span>
            <StatusChip status={finding.status} />
          </div>
          {location ? (
            <button type="button" onClick={openFile} className="block max-w-full truncate font-mono text-xs text-muted-foreground hover:text-foreground hover:underline">
              {location}
            </button>
          ) : null}
          <Markdown content={finding.body} className="text-sm" />
          {finding.suggestion ? (
            <Disclosure summary="Suggested replacement">
              <Markdown content={fence(finding.suggestion)} className="text-sm" />
            </Disclosure>
          ) : null}
          {finding.evidence || finding.confidence !== null || finding.category ? (
            <Disclosure summary="Why this was flagged">
              <div className="space-y-1 text-xs text-muted-foreground">
                {finding.evidence ? <Markdown content={finding.evidence} className="text-xs" /> : null}
                <div>
                  {[finding.confidence !== null ? `Confidence ${finding.confidence}` : null, finding.category, `round ${finding.round}`].filter(Boolean).join(" · ")}
                </div>
              </div>
            </Disclosure>
          ) : null}
          {finding.statusNote ? <p className="text-xs text-muted-foreground">{finding.statusNote}</p> : null}
          {action.error ? (
            <p role="alert" className="text-xs text-destructive">
              {action.error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {finding.posted?.url ? (
              <Button size="sm" variant="ghost" onClick={() => navigate.openUrl(finding.posted!.url!)}>
                <Icon name="ExternalLink" className="size-3.5" />
                Comment
              </Button>
            ) : null}
            {finding.status === "dismissed" || finding.status === "discarded" ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void action.run("reopen", () => rpc.call("review_reopen", { threadId: review.threadId, findingId: finding.id }))}
              >
                Reopen
              </Button>
            ) : isActive(finding) && !dismissing ? (
              <Button size="sm" variant="ghost" onClick={() => setDismissing(true)}>
                Dismiss
              </Button>
            ) : null}
          </div>
          {dismissing ? (
            <DismissForm
              busy={action.pending !== null}
              onCancel={() => setDismissing(false)}
              onSubmit={(reason, remember) =>
                void action
                  .run("dismiss", () => rpc.call("review_dismiss", { threadId: review.threadId, findingId: finding.id, reason, remember }))
                  .then((result) => {
                    if (result !== null) setDismissing(false);
                  })
              }
            />
          ) : null}
        </div>
      </div>
    </li>
  );
}

function Overview({ review }: { review: ReviewDetail }) {
  const rpc = useReviewRpc();
  const navigate = useBbNavigate();
  const action = useAction();
  const counts = countFindings(review.findings);
  const tally = formatCounts(counts);
  const report = review.report;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <VerdictChip verdict={report?.verdict ?? null} />
        {tally ? <span className="text-sm">{tally}</span> : report ? <span className="text-sm">No open findings</span> : null}
        <Chip>{review.depth}</Chip>
        {review.round > 1 ? <Chip>round {review.round}</Chip> : null}
        {review.risk ? (
          <Chip tone={review.risk.level === "high" ? "bad" : review.risk.level === "medium" ? "warn" : "good"} title={review.risk.reasons.join("\n")}>
            {review.risk.level} risk
          </Chip>
        ) : null}
        {review.mrState && review.mrState !== "opened" ? <Chip>{review.mrState}</Chip> : null}
        {review.url ? (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => navigate.openUrl(review.url!)}>
            <Icon name="ExternalLink" className="size-3.5" />
            {review.label}
          </Button>
        ) : null}
      </div>

      {review.newCommits ? (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <Icon name="GitBranch" className="size-4" />
          New commits since this review.
          <Button
            size="sm"
            className="ml-auto"
            disabled={action.pending !== null}
            onClick={() => void action.run("again", () => rpc.call("review_again", { threadId: review.threadId }))}
          >
            {action.pending === "again" ? <Spinner /> : null}
            Re-review
          </Button>
        </div>
      ) : null}
      {review.readOnlyViolations.length > 0 ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          The review worktree has uncommitted changes: {review.readOnlyViolations.slice(0, 5).join(", ")}
          {review.readOnlyViolations.length > 5 ? ` and ${review.readOnlyViolations.length - 5} more` : ""}. Your own checkout and the merge request are not affected; re-review needs a clean worktree.
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
        {review.ticket ? (
          <Chip tone={report?.compliance?.status === "fully" ? "good" : report?.compliance?.status === "not" ? "bad" : report?.compliance?.status === "partially" ? "warn" : "neutral"} title={report?.compliance?.notes}>
            {review.ticket.key}
            {report?.compliance ? `: ${report.compliance.status}` : review.ticket.summary === null ? " (not fetched)" : ""}
          </Chip>
        ) : null}
        {review.checks ? (
          <Chip tone={review.checks.status === "passed" ? "good" : review.checks.status === "failed" ? "bad" : "neutral"} title={review.checks.results.map((result) => `${result.exitCode === 0 ? "✓" : "✗"} ${result.command}`).join("\n")}>
            {review.checks.status === "running" ? <Spinner className="size-3" /> : null}
            checks {review.checks.status}
          </Chip>
        ) : null}
        {review.preview ? (
          <Chip tone={review.preview.status === "ready" ? "good" : review.preview.status === "failed" ? "bad" : "neutral"}>
            {review.preview.status === "running" ? <Spinner className="size-3" /> : null}
            preview {review.preview.status}
          </Chip>
        ) : null}
        {review.secondOpinion?.threadId ? (
          <button type="button" onClick={() => navigate.toThread(review.secondOpinion!.threadId!)}>
            <Chip tone={review.secondOpinion.status === "failed" ? "bad" : "neutral"}>second opinion {review.secondOpinion.status}</Chip>
          </button>
        ) : review.secondOpinion?.status === "failed" ? (
          <Chip tone="bad" title={review.secondOpinion.error ?? undefined}>
            second opinion failed
          </Chip>
        ) : null}
        {review.secondOpinion?.status === "failed" ? (
          <Button size="sm" variant="ghost" disabled={action.pending !== null} onClick={() => void action.run("second", () => rpc.call("review_second_opinion", { threadId: review.threadId }))}>
            {action.pending === "second" ? <Spinner /> : null}
            Retry second opinion
          </Button>
        ) : null}
        {review.rules.length > 0 ? <Chip title={review.rules.join("\n")}>{review.rules.length} path rules</Chip> : null}
        {review.preview?.status === "ready" || review.preview?.status === "running" ? (
          <Button size="sm" variant="ghost" onClick={() => void action.run("preview", () => rpc.call("review_stop_preview", { threadId: review.threadId }))}>
            Stop preview
          </Button>
        ) : null}
      </div>

      {report?.summary ? <Markdown content={report.summary} className="text-sm" /> : null}
      {review.risk?.splitSuggested ? <p className="text-xs text-amber-700 dark:text-amber-400">Large change across {review.risk.areas.length} areas; consider asking for a split.</p> : null}
      {report?.walkthrough ? (
        <Disclosure summary="Walkthrough">
          <Markdown content={report.walkthrough} className="text-sm" />
        </Disclosure>
      ) : null}
      {report && report.questions.length > 0 ? (
        <Disclosure summary={`Questions for the author (${report.questions.length})`}>
          <Markdown content={report.questions.map((question) => `- ${question}`).join("\n")} className="text-sm" />
        </Disclosure>
      ) : null}
      {report && report.limitations.length > 0 ? (
        <Disclosure summary="Limitations">
          <Markdown content={report.limitations.map((limitation) => `- ${limitation}`).join("\n")} className="text-sm" />
        </Disclosure>
      ) : null}
      {action.error ? (
        <p role="alert" className="text-sm text-destructive">
          {action.error}
        </p>
      ) : null}
    </div>
  );
}

function PostingBar({ review, selected, clear }: { review: ReviewDetail; selected: string[]; clear: () => void }) {
  const rpc = useReviewRpc();
  const action = useAction();
  const [message, setMessage] = useState<string | null>(null);
  const drafted = review.findings.filter((finding) => finding.status === "drafted").length;
  if (review.forge === null) return null;
  const forgeName = review.forge === "gitlab" ? "GitLab" : "GitHub";

  const post = async () => {
    const result = await action.run("post", () => rpc.call("review_post", { threadId: review.threadId, findingIds: selected, publish: false }));
    if (result === null) return;
    clear();
    setMessage(
      [
        `Saved ${result.posted.length} as a draft review on ${review.label}.`,
        result.failed.length > 0 ? `${result.failed.length} failed: ${result.failed.map((entry) => `${entry.id} (${entry.error})`).join(", ")}.` : "",
        ...result.warnings,
      ]
        .filter(Boolean)
        .join(" "),
    );
  };

  return (
    <div className="sticky bottom-0 space-y-2 border-t border-border bg-background/95 py-2 backdrop-blur">
      {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
      {action.error ? (
        <p role="alert" className="text-xs text-destructive">
          {action.error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={selected.length === 0 || action.pending !== null} onClick={() => void post()}>
          {action.pending === "post" ? <Spinner /> : <Icon name="MessageSquarePlus" className="size-3.5" />}
          Save {selected.length || ""} as draft review
        </Button>
        {drafted > 0 ? (
          <Button
            size="sm"
            variant="outline"
            disabled={action.pending !== null}
            onClick={() =>
              void action.run("publish", () => rpc.call("review_publish", { threadId: review.threadId })).then((result) => {
                if (result) setMessage(result.detail);
              })
            }
          >
            {action.pending === "publish" ? <Spinner /> : null}
            Publish {drafted} draft{drafted === 1 ? "" : "s"}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={action.pending !== null}
          onClick={() => void action.run("sync", () => rpc.call("review_sync", { threadId: review.threadId }))}
        >
          {action.pending === "sync" ? <Spinner /> : <Icon name="ArrowReloadHorizontal" className="size-3.5" />}
          Sync with {forgeName}
        </Button>
      </div>
    </div>
  );
}

export function FindingsBoard({ threadId, compact = false }: { threadId: string; compact?: boolean }) {
  const { data: review, loaded, error } = useReview(threadId);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const findings = review?.findings ?? [];
    const sorted = [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
    return {
      active: sorted.filter((finding) => isActive(finding) && finding.severity !== PRE_EXISTING),
      preExisting: sorted.filter((finding) => finding.severity === PRE_EXISTING && isActive(finding)),
      closed: sorted.filter((finding) => !isActive(finding)),
    };
  }, [review]);

  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (!loaded) return <EmptyState>Loading review…</EmptyState>;
  if (review === null) return <EmptyState>This thread is not a review started by the Review plugin.</EmptyState>;

  const selectable = (finding: Finding) => review.forge !== null && finding.status === "open";
  const toggle = (id: string, value: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  const selectableIds = groups.active.filter(selectable).map((finding) => finding.id);
  const cards = (findings: Finding[]) => (
    <ul className="space-y-2">
      {findings.map((finding) => (
        <FindingCard
          key={finding.id}
          review={review}
          finding={finding}
          selectable={selectable(finding)}
          selected={selected.has(finding.id)}
          onSelect={(value) => toggle(finding.id, value)}
        />
      ))}
    </ul>
  );

  return (
    <div className={cn("space-y-4", compact && "rounded-lg border border-border p-3")}>
      <Overview review={review} />
      {review.report === null && review.findings.length === 0 ? (
        <EmptyState>{review.status === "active" || review.status === "starting" ? "The review is running…" : "No report yet."}</EmptyState>
      ) : groups.active.length === 0 ? (
        <EmptyState>No open findings.</EmptyState>
      ) : (
        <section className="space-y-2">
          {selectableIds.length > 1 ? (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={selectableIds.every((id) => selected.has(id))}
                onCheckedChange={(checked) => setSelected(checked === true ? new Set(selectableIds) : new Set())}
              />
              Select all open findings
            </label>
          ) : null}
          {cards(groups.active)}
        </section>
      )}
      {groups.preExisting.length > 0 ? <Disclosure summary={`Pre-existing issues (${groups.preExisting.length})`}>{cards(groups.preExisting)}</Disclosure> : null}
      {groups.closed.length > 0 ? <Disclosure summary={`Closed (${groups.closed.length})`}>{cards(groups.closed)}</Disclosure> : null}
      <PostingBar review={review} selected={[...selected].filter((id) => selectableIds.includes(id))} clear={() => setSelected(new Set())} />
    </div>
  );
}
