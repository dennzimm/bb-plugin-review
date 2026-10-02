import type {
  BranchSuggestion,
  ChangeRequestSuggestion,
  PostItem,
  ReviewRequest,
  ReviewSuggestions,
} from "../contract.ts";
import { mapDiffLines, planComment, type DiffLineMap } from "../shared/diff-map.ts";
import type { Forge } from "../shared/review-source.ts";
import { Repo, record, stringOrNull } from "./exec.ts";
import { forgeOf } from "./prepare.ts";

type PostedRef = {
  kind: "gitlab-draft" | "gitlab-discussion" | "gitlab-note" | "github-pending" | "github-comment";
  id: string;
  positioned: boolean;
  url: string | null;
};

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function gitlabSuggestion(value: unknown): ReviewRequest | null {
  const mr = record(value);
  if (mr === null || typeof mr.iid !== "number") return null;
  return {
    forge: "gitlab",
    number: mr.iid,
    title: stringOrNull(mr.title) ?? "",
    author: stringOrNull(record(mr.author)?.username),
    sourceBranch: stringOrNull(mr.source_branch),
    targetBranch: stringOrNull(mr.target_branch),
    draft: mr.draft === true || mr.work_in_progress === true,
    headSha: stringOrNull(mr.sha),
    url: stringOrNull(mr.web_url),
    updatedAt: timestamp(mr.updated_at),
  };
}

const GITHUB_PR_FIELDS = "number,title,author,headRefName,baseRefName,isDraft,headRefOid,url,updatedAt";

function githubSuggestion(value: unknown): ReviewRequest | null {
  const pr = record(value);
  if (pr === null || typeof pr.number !== "number") return null;
  return {
    forge: "github",
    number: pr.number,
    title: stringOrNull(pr.title) ?? "",
    author: stringOrNull(record(pr.author)?.login),
    sourceBranch: stringOrNull(pr.headRefName),
    targetBranch: stringOrNull(pr.baseRefName),
    draft: pr.isDraft === true,
    headSha: stringOrNull(pr.headRefOid),
    url: stringOrNull(pr.url),
    updatedAt: timestamp(pr.updatedAt),
  };
}

async function listChangeRequests(repo: Repo, forge: Forge, reviewerOnly: boolean): Promise<ReviewRequest[]> {
  const list =
    forge === "gitlab"
      ? await repo.tryJson("glab", ["mr", "list", "--output", "json", "--per-page", "50", ...(reviewerOnly ? ["--reviewer=@me"] : [])])
      : await repo.tryJson("gh", [
          "pr",
          "list",
          "--limit",
          "50",
          "--json",
          GITHUB_PR_FIELDS,
          ...(reviewerOnly ? ["--search", "review-requested:@me"] : []),
        ]);
  if (!Array.isArray(list)) return [];
  const parse = forge === "gitlab" ? gitlabSuggestion : githubSuggestion;
  return list.flatMap((value) => {
    const parsed = parse(value);
    return parsed === null ? [] : [parsed];
  });
}

/** Remote-tracking branches as of the last fetch, most recent commit first. */
async function listBranches(repo: Repo, remote: string): Promise<BranchSuggestion[]> {
  const output = await repo.tryGit([
    "for-each-ref",
    "--sort=-committerdate",
    "--count=500",
    "--format=%(refname:lstrip=3)%09%(committerdate:unix)%09%(authorname)",
    `refs/remotes/${remote}`,
  ]);
  if (output === null || output === "") return [];
  return output.split("\n").flatMap((line): BranchSuggestion[] => {
    const [name, committedAt, author] = line.split("\t");
    // refs/remotes/<remote>/HEAD is a symbolic alias, not a branch.
    if (!name || name === "HEAD") return [];
    return [{ name, committedAt: Number(committedAt) * 1000, author: author ?? "" }];
  });
}

export async function listSuggestions(input: { repoPath: string; remote: string }, signal: AbortSignal): Promise<ReviewSuggestions> {
  const repo = new Repo(input.repoPath, signal);
  const forge = await forgeOf(repo, input.remote);
  const [changeRequests, branches] = await Promise.all([
    forge === null ? Promise.resolve([]) : listChangeRequests(repo, forge, false),
    listBranches(repo, input.remote),
  ]);
  return {
    changeRequests: changeRequests.map(({ updatedAt: _updatedAt, ...rest }): ChangeRequestSuggestion => rest),
    branches,
  };
}

export async function listReviewRequests(input: { repoPath: string; remote: string }, signal: AbortSignal) {
  const repo = new Repo(input.repoPath, signal);
  const forge = await forgeOf(repo, input.remote);
  return { forge, items: forge === null ? [] : await listChangeRequests(repo, forge, true) };
}

interface ChangeRequestTarget {
  repoPath: string;
  forge: Forge;
  number: number;
}

function mrPath(number: number, suffix = ""): string {
  return `projects/:id/merge_requests/${number}${suffix}`;
}

export async function listDiscussions(input: ChangeRequestTarget, signal: AbortSignal) {
  const repo = new Repo(input.repoPath, signal);
  const comments: Array<{ author: string; body: string; path: string | null; line: number | null; resolved: boolean | null }> = [];
  const trim = (body: string) => (body.length > 600 ? `${body.slice(0, 600)}…` : body);
  if (input.forge === "gitlab") {
    const discussions = await repo.api("glab", [mrPath(input.number, "/discussions?per_page=100")]);
    for (const discussion of Array.isArray(discussions) ? discussions : []) {
      for (const value of (record(discussion)?.notes as unknown[] | undefined) ?? []) {
        const note = record(value);
        if (note === null || note.system === true) continue;
        const position = record(note.position);
        comments.push({
          author: stringOrNull(record(note.author)?.username) ?? "unknown",
          body: trim(String(note.body ?? "")),
          path: stringOrNull(position?.new_path) ?? stringOrNull(position?.old_path),
          line: typeof position?.new_line === "number" ? position.new_line : null,
          resolved: note.resolvable === true ? note.resolved === true : null,
        });
      }
    }
  } else {
    const [review, issue] = await Promise.all([
      repo.api("gh", [`repos/{owner}/{repo}/pulls/${input.number}/comments?per_page=100`]),
      repo.api("gh", [`repos/{owner}/{repo}/issues/${input.number}/comments?per_page=100`]),
    ]);
    for (const value of [...(Array.isArray(review) ? review : []), ...(Array.isArray(issue) ? issue : [])]) {
      const comment = record(value);
      if (comment === null) continue;
      comments.push({
        author: stringOrNull(record(comment.user)?.login) ?? "unknown",
        body: trim(String(comment.body ?? "")),
        path: stringOrNull(comment.path),
        line: typeof comment.line === "number" ? comment.line : null,
        resolved: null,
      });
    }
  }
  return { comments: comments.slice(0, 200) };
}

const MARKER = /<!-- (bb-review:[A-Za-z0-9_:-]+) -->/;

function markerIn(body: unknown): string | null {
  return typeof body === "string" ? (MARKER.exec(body)?.[1] ?? null) : null;
}

export async function changeRequestStatus(input: ChangeRequestTarget & { markers: string[] }, signal: AbortSignal) {
  const repo = new Repo(input.repoPath, signal);
  const wanted = new Set(input.markers);
  const threads: Array<{ marker: string; resolved: boolean; url: string | null; id: string }> = [];
  const drafts: string[] = [];

  if (input.forge === "gitlab") {
    const mr = record(await repo.api("glab", [mrPath(input.number)]));
    const state = mr?.state === "opened" || mr?.state === "merged" || mr?.state === "closed" ? mr.state : "unknown";
    const webUrl = stringOrNull(mr?.web_url);
    if (wanted.size > 0) {
      const [discussions, draftNotes] = await Promise.all([
        repo.api("glab", [mrPath(input.number, "/discussions?per_page=100")]),
        repo.api("glab", [mrPath(input.number, "/draft_notes?per_page=100")]).catch(() => []),
      ]);
      for (const discussion of Array.isArray(discussions) ? discussions : []) {
        const notes = (record(discussion)?.notes as unknown[] | undefined) ?? [];
        const first = record(notes[0]);
        const marker = markerIn(first?.body);
        if (first === null || marker === null || !wanted.has(marker)) continue;
        threads.push({
          marker,
          resolved: notes.some((note) => record(note)?.resolved === true),
          url: webUrl === null ? null : `${webUrl}#note_${String(first.id)}`,
          id: String(record(discussion)?.id ?? first.id),
        });
      }
      for (const value of Array.isArray(draftNotes) ? draftNotes : []) {
        const marker = markerIn(record(value)?.note);
        if (marker !== null && wanted.has(marker)) drafts.push(marker);
      }
    }
    return { state, headSha: stringOrNull(mr?.sha), threads, drafts } as const;
  }

  const pr = record(await repo.tryJson("gh", ["pr", "view", String(input.number), "--json", "state,headRefOid,url"]));
  const state = pr?.state === "OPEN" ? "opened" : pr?.state === "MERGED" ? "merged" : pr?.state === "CLOSED" ? "closed" : "unknown";
  if (wanted.size > 0) {
    const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{body url}}}} reviews(states:PENDING,first:5){nodes{comments(first:100){nodes{body}}}}}}}`;
    const repoInfo = record(await repo.tryJson("gh", ["repo", "view", "--json", "owner,name"]));
    const owner = stringOrNull(record(repoInfo?.owner)?.login);
    const name = stringOrNull(repoInfo?.name);
    if (owner !== null && name !== null) {
      const result = record(
        await repo.api("gh", ["graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${input.number}`]),
      );
      const pull = record(record(record(result?.data)?.repository)?.pullRequest);
      for (const value of (record(pull?.reviewThreads)?.nodes as unknown[] | undefined) ?? []) {
        const thread = record(value);
        const comment = record(((record(thread?.comments)?.nodes as unknown[] | undefined) ?? [])[0]);
        const marker = markerIn(comment?.body);
        if (thread === null || marker === null || !wanted.has(marker)) continue;
        threads.push({ marker, resolved: thread.isResolved === true, url: stringOrNull(comment?.url), id: String(thread.id) });
      }
      for (const review of (record(pull?.reviews)?.nodes as unknown[] | undefined) ?? []) {
        for (const value of (record(record(review)?.comments)?.nodes as unknown[] | undefined) ?? []) {
          const marker = markerIn(record(value)?.body);
          if (marker !== null && wanted.has(marker)) drafts.push(marker);
        }
      }
    }
  }
  return { state, headSha: stringOrNull(pr?.headRefOid), threads, drafts } as const;
}

async function fileDiffMap(repo: Repo, baseSha: string, headSha: string, path: string, cache: Map<string, DiffLineMap>) {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  const diff = (await repo.tryGit(["diff", "--unified=3", "--no-color", baseSha, headSha, "--", path])) ?? "";
  const map = mapDiffLines(diff);
  cache.set(path, map);
  return map;
}

function withMarker(body: string, marker: string): string {
  return `${body}\n\n<!-- ${marker} -->`;
}

function fencedSuggestion(code: string, header: string): string {
  const longest = Math.max(2, ...Array.from(code.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${header}\n${code.replace(/\n$/, "")}\n${fence}`;
}

function rangeOf(item: PostItem): { start: number; end: number } {
  return { start: item.startLine!, end: item.endLine ?? item.startLine! };
}

function suggestionRangeOf(item: PostItem): { start: number; end: number } | null {
  if (item.suggestion === null) return null;
  const range = rangeOf(item);
  const start = item.suggestionStartLine ?? range.start;
  return { start, end: item.suggestionEndLine ?? (item.suggestionStartLine !== null ? start : range.end) };
}

function suggestionAsText(item: PostItem): string {
  const range = suggestionRangeOf(item)!;
  return `Suggested replacement for lines ${range.start}-${range.end}:\n\n${fencedSuggestion(item.suggestion!, "")}`;
}

interface PostInput extends ChangeRequestTarget {
  reviewedHeadSha: string;
  mergeBaseSha: string;
  summary: string | null;
  items: PostItem[];
  publish: boolean;
}

async function postToGitlab(repo: Repo, input: PostInput) {
  const warnings: string[] = [];
  const versions = await repo.api("glab", [mrPath(input.number, "/versions")]);
  const list = (Array.isArray(versions) ? versions : []).map(record).filter((version) => version !== null);
  const version = list.find((candidate) => candidate.head_commit_sha === input.reviewedHeadSha) ?? list[0];
  if (version === undefined) throw new Error("GitLab returned no diff versions for this merge request.");
  if (version.head_commit_sha !== input.reviewedHeadSha) {
    warnings.push("The merge request has changed since this review; comments anchor to its latest version and may be outdated.");
  }
  const baseSha = String(version.base_commit_sha);
  const headSha = String(version.head_commit_sha);
  const startSha = String(version.start_commit_sha);
  const diffBase = (await repo.tryGit(["cat-file", "-e", `${baseSha}^{commit}`])) === null ? input.mergeBaseSha : baseSha;
  const maps = new Map<string, DiffLineMap>();
  const mr = record(await repo.api("glab", [mrPath(input.number)]));
  const webUrl = stringOrNull(mr?.web_url);

  const results: Array<{ marker: string; ref: PostedRef | null; error: string | null }> = [];
  for (const item of input.items) {
    let body = item.body;
    let position: Record<string, unknown> | null = null;
    if (item.file !== null && item.startLine !== null) {
      const map = await fileDiffMap(repo, diffBase, headSha, item.file, maps);
      const plan = planComment(map, rangeOf(item), suggestionRangeOf(item));
      if (plan.anchor !== null) {
        const line = map.get(plan.anchor)!;
        position = {
          position_type: "text",
          base_sha: baseSha,
          start_sha: startSha,
          head_sha: headSha,
          old_path: item.file,
          new_path: item.file,
          new_line: plan.anchor,
          ...(line.kind === "context" ? { old_line: line.oldLine } : {}),
        };
      }
      if (item.suggestion !== null) {
        body += plan.replaces
          ? `\n\n${fencedSuggestion(item.suggestion, `suggestion:-${plan.replaces.end - plan.replaces.start}+0`)}`
          : `\n\n${suggestionAsText(item)}`;
      }
      if (position === null) body = `**\`${item.file}:${item.startLine}\`**\n\n${body}`;
    } else if (item.suggestion !== null) {
      body += `\n\n${fencedSuggestion(item.suggestion, "")}`;
    }
    const note = withMarker(body, item.marker);
    try {
      let created: Record<string, unknown> | null;
      try {
        created = record(await repo.api("glab", ["--method", "POST", mrPath(input.number, "/draft_notes")], { note, ...(position ? { position } : {}) }));
      } catch (error) {
        if (position === null) throw error;
        // GitLab rejects positions it cannot place in its own diff; keep the comment as a general note.
        warnings.push(`${item.file}:${item.startLine} could not be placed in the diff and was added as a general comment.`);
        position = null;
        created = record(
          await repo.api("glab", ["--method", "POST", mrPath(input.number, "/draft_notes")], {
            note: withMarker(`**\`${item.file}:${item.startLine}\`**\n\n${body}`, item.marker),
          }),
        );
      }
      results.push({
        marker: item.marker,
        ref: { kind: "gitlab-draft", id: String(created?.id ?? ""), positioned: position !== null, url: webUrl },
        error: null,
      });
    } catch (error) {
      results.push({ marker: item.marker, ref: null, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (input.summary !== null) {
    await repo.api("glab", ["--method", "POST", mrPath(input.number, "/draft_notes")], { note: input.summary }).catch((error: unknown) => {
      warnings.push(`The summary comment failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  if (input.publish && results.some((result) => result.ref !== null)) {
    await repo.api("glab", ["--method", "POST", mrPath(input.number, "/draft_notes/bulk_publish")]);
    for (const result of results) {
      if (result.ref !== null) result.ref = { ...result.ref, kind: result.ref.positioned ? "gitlab-discussion" : "gitlab-note" };
    }
  }
  return { results, warnings };
}

async function myPendingGithubReview(repo: Repo, number: number): Promise<string | null> {
  const user = record(await repo.api("gh", ["user"]));
  const reviews = await repo.api("gh", [`repos/{owner}/{repo}/pulls/${number}/reviews?per_page=100`]);
  for (const value of Array.isArray(reviews) ? reviews : []) {
    const review = record(value);
    if (review?.state === "PENDING" && record(review.user)?.login === user?.login) return String(review.id);
  }
  return null;
}

async function postToGithub(repo: Repo, input: PostInput) {
  const warnings: string[] = [];
  if ((await myPendingGithubReview(repo, input.number)) !== null) {
    throw new Error("You already have a pending review on this pull request. Submit or discard it on GitHub first.");
  }
  const maps = new Map<string, DiffLineMap>();
  const comments: Array<Record<string, unknown>> = [];
  const unplaced: string[] = [];
  const placed = new Set<string>();
  for (const item of input.items) {
    let body = item.body;
    if (item.file !== null && item.startLine !== null) {
      const map = await fileDiffMap(repo, input.mergeBaseSha, input.reviewedHeadSha, item.file, maps);
      const plan = planComment(map, rangeOf(item), suggestionRangeOf(item));
      if (item.suggestion !== null) body += plan.replaces ? `\n\n${fencedSuggestion(item.suggestion, "suggestion")}` : `\n\n${suggestionAsText(item)}`;
      if (plan.anchor !== null) {
        comments.push({
          path: item.file,
          line: plan.anchor,
          side: "RIGHT",
          ...(plan.start !== null && plan.start < plan.anchor ? { start_line: plan.start, start_side: "RIGHT" } : {}),
          body: withMarker(body, item.marker),
        });
        placed.add(item.marker);
        continue;
      }
      body = `**\`${item.file}:${item.startLine}\`**\n\n${body}`;
    }
    unplaced.push(withMarker(body, item.marker));
  }
  const reviewBody = [input.summary, ...unplaced].filter((part): part is string => part !== null).join("\n\n---\n\n");
  if (unplaced.length > 0) warnings.push(`${unplaced.length} finding(s) outside the diff were added to the review body.`);
  const created = record(
    await repo.api("gh", ["--method", "POST", `repos/{owner}/{repo}/pulls/${input.number}/reviews`], {
      commit_id: input.reviewedHeadSha,
      ...(reviewBody === "" ? {} : { body: reviewBody }),
      comments,
      ...(input.publish ? { event: "COMMENT" } : {}),
    }),
  );
  const id = String(created?.id ?? "");
  const url = stringOrNull(created?.html_url);
  return {
    results: input.items.map((item) => ({
      marker: item.marker,
      ref: {
        kind: input.publish ? ("github-comment" as const) : ("github-pending" as const),
        id,
        positioned: placed.has(item.marker),
        url,
      },
      error: null,
    })),
    warnings,
  };
}

export async function postFindings(input: PostInput, signal: AbortSignal) {
  const repo = new Repo(input.repoPath, signal);
  return input.forge === "gitlab" ? postToGitlab(repo, input) : postToGithub(repo, input);
}

export async function publishDrafts(input: ChangeRequestTarget, signal: AbortSignal) {
  const repo = new Repo(input.repoPath, signal);
  if (input.forge === "gitlab") {
    await repo.api("glab", ["--method", "POST", mrPath(input.number, "/draft_notes/bulk_publish")]);
    return { published: true, detail: "Published all your draft comments on the merge request." };
  }
  const pending = await myPendingGithubReview(repo, input.number);
  if (pending === null) return { published: false, detail: "There is no pending review to submit." };
  await repo.api("gh", ["--method", "POST", `repos/{owner}/{repo}/pulls/${input.number}/reviews/${pending}/events`], { event: "COMMENT" });
  return { published: true, detail: "Submitted your pending review." };
}
