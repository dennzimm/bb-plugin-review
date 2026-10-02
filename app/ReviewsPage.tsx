import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { ReviewSuggestions } from "../contract.ts";
import type { QueueItem, ReviewSummary, rpcContract } from "../server";
import { formatCounts } from "../shared/findings.ts";
import { errorMessage, timeAgo, useAction, useLearnings, useProjects, useQueue, useReviewRpc, useReviews, useStats } from "./api.ts";
import { Chip, Disclosure, EmptyState, Spinner, VerdictChip, fieldClassName } from "./ui.tsx";
import { Combobox, type ComboboxOption } from "@/components/combobox";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const LAST_PROJECT_KEY = "bb-plugin-review:last-project";
const depthOptions = [
  { value: "", label: "Default depth" },
  { value: "quick", label: "Quick: high-confidence blockers only" },
  { value: "standard", label: "Standard" },
  { value: "deep", label: "Deep: parallel passes, checks, preview, second opinion" },
] as const;

interface ProjectOption {
  id: string;
  name: string;
}

function readLastProject(): string | null {
  try {
    return window.localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

function rememberProject(projectId: string): void {
  try {
    window.localStorage.setItem(LAST_PROJECT_KEY, projectId);
  } catch {
    // Storage can be unavailable (private mode); the picker still works.
  }
}

function reference(forge: string, number: number): string {
  return `${forge === "gitlab" ? "!" : "#"}${number}`;
}

function useSuggestions(projectId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [suggestions, setSuggestions] = useState<ReviewSuggestions | null>(null);
  useEffect(() => {
    if (projectId === "") return;
    let cancelled = false;
    setSuggestions(null);
    rpc.call("review_suggestions", { projectId }).then(
      (result) => {
        if (!cancelled) setSuggestions(result);
      },
      () => {
        if (!cancelled) setSuggestions({ changeRequests: [], branches: [] });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, projectId]);
  return suggestions;
}

function branchOptions(suggestions: ReviewSuggestions | null): ComboboxOption[] {
  return (suggestions?.branches ?? []).map((branch) => ({
    key: `branch:${branch.name}`,
    value: branch.name,
    group: "Branches",
    primary: branch.name,
    secondary: `${timeAgo(branch.committedAt)} · ${branch.author}`,
  }));
}

function sourceOptions(suggestions: ReviewSuggestions | null): ComboboxOption[] {
  const changeRequests = (suggestions?.changeRequests ?? []).map((request) => {
    const ref = reference(request.forge, request.number);
    return {
      key: `change-request:${ref}`,
      value: ref,
      group: request.forge === "gitlab" ? "Open merge requests" : "Open pull requests",
      primary: `${ref} ${request.title}`,
      secondary: [request.sourceBranch && request.targetBranch ? `${request.sourceBranch} → ${request.targetBranch}` : null, request.author].filter(Boolean).join(" · "),
      badge: request.draft ? "Draft" : undefined,
    };
  });
  return [...changeRequests, ...branchOptions(suggestions)];
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}

function StartReviewForm({ projects, initialProjectId, onStarted }: { projects: ProjectOption[]; initialProjectId: string | null; onStarted: (threadId: string) => void }) {
  const rpc = useReviewRpc();
  const [projectId, setProjectId] = useState<string>(
    () => [initialProjectId, readLastProject()].find((id) => projects.some((project) => project.id === id)) ?? projects[0]?.id ?? "",
  );
  const [source, setSource] = useState("");
  const [targetBranch, setTargetBranch] = useState("");
  const [focus, setFocus] = useState("");
  const [depth, setDepth] = useState<"" | "quick" | "standard" | "deep">("");
  const [allowPosting, setAllowPosting] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialProjectId && projects.some((project) => project.id === initialProjectId)) setProjectId(initialProjectId);
  }, [initialProjectId, projects]);

  const suggestions = useSuggestions(projectId);
  const sources = useMemo(() => sourceOptions(suggestions), [suggestions]);
  const targets = useMemo(() => branchOptions(suggestions), [suggestions]);
  const targetFor = (option: ComboboxOption) =>
    suggestions?.changeRequests.find((request) => reference(request.forge, request.number) === option.value)?.targetBranch ?? null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (projectId === "" || source.trim() === "" || pending) return;
    setPending(true);
    setError(null);
    try {
      const started = await rpc.call("review_start", {
        projectId,
        source: source.trim(),
        targetBranch: targetBranch.trim() === "" ? null : targetBranch.trim(),
        focus: focus.trim() === "" ? null : focus.trim(),
        depth: depth === "" ? null : depth,
        allowPosting,
      });
      rememberProject(projectId);
      setSource("");
      setTargetBranch("");
      setFocus("");
      setAllowPosting(false);
      onStarted(started.threadId);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  if (projects.length === 0) return <EmptyState>Add a Git project to bb to review its branches.</EmptyState>;

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Field label="Project">
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)} className={cn(fieldClassName, "h-9 py-0")}>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Branch or merge request">
          <Combobox
            value={source}
            onChange={setSource}
            onPick={(option) => {
              setSource(option.value);
              const target = targetFor(option);
              if (target !== null && targetBranch.trim() === "") setTargetBranch(target);
            }}
            options={sources}
            loading={suggestions === null}
            emptyText="No matching merge request or branch; press Enter to use what you typed"
            placeholder="Search merge requests and branches, or paste a URL"
            autoFocus
            required
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Target branch">
          <Combobox
            value={targetBranch}
            onChange={setTargetBranch}
            onPick={(option) => setTargetBranch(option.value)}
            options={targets}
            loading={suggestions === null}
            placeholder="From the merge request, else the default branch"
          />
        </Field>
        <Field label="Depth">
          <select value={depth} onChange={(event) => setDepth(event.target.value as typeof depth)} className={cn(fieldClassName, "h-9 py-0")}>
            {depthOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Focus">
        <textarea
          value={focus}
          onChange={(event) => setFocus(event.target.value)}
          maxLength={4000}
          rows={2}
          placeholder="Optional: areas to scrutinise, for example the caching change in checkout"
          className={cn(fieldClassName, "resize-y")}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={allowPosting} onCheckedChange={(checked) => setAllowPosting(checked === true)} />
        Let the reviewer save its findings as a draft review on the merge request
      </label>
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || source.trim() === "" || projectId === ""}>
          <Icon name={pending ? "Loading" : "GitPullRequest"} className={pending ? "size-4 animate-spin" : "size-4"} />
          {pending ? "Fetching and starting…" : "Start review"}
        </Button>
        <span className="text-xs text-muted-foreground">Runs in a fresh read-only worktree. Your checkout is not touched.</span>
      </div>
    </form>
  );
}

function QueueRow({ item }: { item: QueueItem }) {
  const rpc = useReviewRpc();
  const navigate = useBbNavigate();
  const action = useAction();
  const ref = reference(item.forge, item.number);
  const outdated = item.reviewThreadId !== null && item.headSha !== null && item.headSha !== item.reviewedHeadSha;
  return (
    <li className="flex flex-wrap items-center gap-2 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {ref} {item.title}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {item.projectName} · {item.author ?? "unknown"}
          {item.updatedAt ? ` · updated ${timeAgo(item.updatedAt)}` : ""}
          {item.draft ? " · draft" : ""}
        </div>
        {action.error ? <div className="text-xs text-destructive">{action.error}</div> : null}
      </div>
      {item.reviewThreadId === null ? (
        <Button
          size="sm"
          disabled={action.pending !== null}
          onClick={() =>
            void action.run("start", () => rpc.call("review_start", { projectId: item.projectId, source: ref })).then((started) => {
              if (started) navigate.toThread(started.threadId);
            })
          }
        >
          {action.pending ? <Spinner /> : null}
          Review
        </Button>
      ) : outdated ? (
        <Button
          size="sm"
          variant="outline"
          disabled={action.pending !== null}
          onClick={() => void action.run("again", () => rpc.call("review_again", { threadId: item.reviewThreadId! })).then(() => navigate.toThread(item.reviewThreadId!))}
        >
          {action.pending ? <Spinner /> : null}
          Re-review new commits
        </Button>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => navigate.toThread(item.reviewThreadId!)}>
          Open review
        </Button>
      )}
    </li>
  );
}

function QueueSection({ projectFilter }: { projectFilter: string }) {
  const rpc = useReviewRpc();
  const { data: queue } = useQueue();
  const action = useAction();
  const data = queue === null ? null : { ...queue, items: queue.items.filter((item) => projectFilter === "" || item.projectId === projectFilter) };
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Waiting for your review</h2>
        <Button size="sm" variant="ghost" disabled={action.pending !== null} onClick={() => void action.run("refresh", () => rpc.call("queue_list", { refresh: true }))}>
          {action.pending ? <Spinner /> : <Icon name="ArrowReloadHorizontal" className="size-3.5" />}
          {data?.fetchedAt ? `Checked ${timeAgo(data.fetchedAt)}` : "Check now"}
        </Button>
      </div>
      {action.error ? <p className="text-xs text-destructive">{action.error}</p> : null}
      {data === null ? (
        <EmptyState>Loading…</EmptyState>
      ) : data.items.length === 0 ? (
        <EmptyState>{data.fetchedAt === 0 ? "Not checked yet." : "No merge requests are waiting for your review."}</EmptyState>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {data.items.map((item) => (
            <QueueRow key={`${item.projectId}:${item.number}`} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ReviewRow({ review, projectName }: { review: ReviewSummary; projectName: string }) {
  const navigate = useBbNavigate();
  const rpc = useReviewRpc();
  const action = useAction();
  const running = ["active", "starting", "pending", "stopping"].includes(review.status);
  const tally = formatCounts(review.counts);
  return (
    <li className="flex items-center gap-3 px-4 py-3 hover:bg-accent/50">
      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => navigate.toThread(review.threadId)}>
        <div className="truncate text-sm font-medium">{review.title.replace(/^Review: /, "")}</div>
        <div className="truncate text-xs text-muted-foreground">
          {[projectName, new Date(review.createdAt).toLocaleString(), review.depth !== "standard" ? review.depth : null, review.round > 1 ? `round ${review.round}` : null, tally || null]
            .filter(Boolean)
            .join(" · ")}
        </div>
        {action.error ? <div className="text-xs text-destructive">{action.error}</div> : null}
      </button>
      {review.riskLevel === "high" ? <Chip tone="bad">high risk</Chip> : null}
      {review.readOnlyViolations > 0 ? <Chip tone="bad" title="The review worktree has uncommitted changes">uncommitted changes</Chip> : null}
      {review.checks === "failed" ? <Chip tone="bad">checks failed</Chip> : null}
      {review.newCommits ? (
        <Button
          size="sm"
          variant="outline"
          disabled={action.pending !== null}
          onClick={() => void action.run("again", () => rpc.call("review_again", { threadId: review.threadId }))}
        >
          {action.pending ? <Spinner /> : null}
          Re-review
        </Button>
      ) : null}
      {running ? (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          Reviewing
        </span>
      ) : review.status === "error" ? (
        <Chip tone="bad">Failed</Chip>
      ) : review.verdict ? (
        <VerdictChip verdict={review.verdict} />
      ) : (
        <span className="text-xs text-muted-foreground">Done</span>
      )}
      {review.mrState === "merged" || review.mrState === "closed" ? <Chip>{review.mrState}</Chip> : null}
      {review.url ? (
        <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-foreground" aria-label="Open merge request" onClick={() => navigate.openUrl(review.url!)}>
          <Icon name="ExternalLink" className="size-4" />
        </Button>
      ) : null}
    </li>
  );
}

function StatsLine() {
  const { data } = useStats();
  if (data === null || data.reported === 0) return null;
  const rate = data.acceptanceRate === null ? null : `${Math.round(data.acceptanceRate * 100)}%`;
  return (
    <p className="text-xs text-muted-foreground">
      {data.reviews} reviews · {data.reported} findings · {data.posted} posted · {data.accepted} fixed or resolved · {data.dismissed} dismissed
      {rate ? ` · ${rate} accepted of those decided` : ""}
    </p>
  );
}

function LearningsSection({ projects }: { projects: ProjectOption[] }) {
  const rpc = useReviewRpc();
  const { data } = useLearnings();
  const action = useAction();
  const [text, setText] = useState("");
  const [projectId, setProjectId] = useState("");
  const name = (id: string | null) => (id === null ? "All projects" : (projects.find((project) => project.id === id)?.name ?? id));
  return (
    <Disclosure summary={`Learnings (${data?.length ?? 0}): what reviews are told not to report`}>
      <div className="space-y-2">
        {data && data.length > 0 ? (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {data.map((learning) => (
              <li key={learning.id} className="flex items-start gap-2 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div>{learning.text}</div>
                  <div className="text-xs text-muted-foreground">
                    {name(learning.projectId)} · {timeAgo(learning.createdAt)}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => void action.run("remove", () => rpc.call("learnings_remove", { id: learning.id }))}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">Dismiss a finding with "Remember" to add one, or add one here.</p>
        )}
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim() === "") return;
            void action.run("add", () => rpc.call("learnings_add", { projectId: projectId === "" ? null : projectId, text })).then((result) => {
              if (result) setText("");
            });
          }}
        >
          <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Do not flag …" className={cn(fieldClassName, "h-8 min-w-48 flex-1 py-0")} />
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)} className={cn(fieldClassName, "h-8 w-auto py-0")}>
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <Button size="sm" type="submit" disabled={text.trim() === "" || action.pending !== null}>
            Add
          </Button>
        </form>
        {action.error ? <p className="text-xs text-destructive">{action.error}</p> : null}
      </div>
    </Disclosure>
  );
}

export function ReviewsPage({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [projectFilter, setProjectFilter] = useState("");
  const projects = useProjects();
  const reviews = useReviews(includeArchived);
  const initialProjectId = subPath === "" ? null : subPath;
  const projectName = (id: string) => projects.data?.find((project) => project.id === id)?.name ?? id;

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 p-4 md:p-5">
        <p className="text-sm text-muted-foreground">
          Review someone's branch, merge request, or pull request without changing any code. Also in the command palette, as <code>bb review start</code>, and
          through <code>!</code> mentions in any composer.
        </p>
        {projects.error ? <p className="text-sm text-destructive">{projects.error}</p> : null}
        {projects.data === null ? (
          <EmptyState>Loading projects…</EmptyState>
        ) : (
          <StartReviewForm projects={projects.data} initialProjectId={initialProjectId} onStarted={(threadId) => navigate.toThread(threadId)} />
        )}
        {projects.data && projects.data.length > 1 ? (
          <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
            Show
            <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} className={cn(fieldClassName, "h-8 w-auto py-0 text-xs")}>
              <option value="">All projects</option>
              {projects.data.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <QueueSection projectFilter={projectFilter} />
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Reviews</h2>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox checked={includeArchived} onCheckedChange={(checked) => setIncludeArchived(checked === true)} />
              Show archived
            </label>
          </div>
          <StatsLine />
          {reviews.error ? <p className="text-sm text-destructive">{reviews.error}</p> : null}
          {reviews.data === null ? (
            <EmptyState>Loading reviews…</EmptyState>
          ) : reviews.data.filter((review) => projectFilter === "" || review.projectId === projectFilter).length === 0 ? (
            <EmptyState>
              No reviews yet. Start one above, or run <code>bb review start</code>.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {reviews.data.filter((review) => projectFilter === "" || review.projectId === projectFilter).map((review) => (
                <ReviewRow key={review.threadId} review={review} projectName={projectName(review.projectId)} />
              ))}
            </ul>
          )}
        </section>
        {projects.data ? <LearningsSection projects={projects.data} /> : null}
      </div>
    </div>
  );
}
