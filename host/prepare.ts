import type { ChangeRequest, PreparedReview } from "../contract.ts";
import { assertSafeBranchName, forgeFromRemoteUrl, parseReviewSource, type Forge } from "../shared/review-source.ts";
import { Repo, record, stringOrNull } from "./exec.ts";

interface ChangeRequestLookup {
  changeRequest: ChangeRequest;
  /** The source branch lives in a fork, so it cannot be fetched by name. */
  crossRepository: boolean;
}

/** Best effort: missing or unauthenticated glab/gh yields null. */
export async function lookupChangeRequest(repo: Repo, forge: Forge, idOrBranch: string): Promise<ChangeRequestLookup | null> {
  if (forge === "gitlab") {
    const mr = record(await repo.tryJson("glab", ["mr", "view", idOrBranch, "--output", "json"]));
    if (mr === null || typeof mr.iid !== "number") return null;
    return {
      changeRequest: {
        forge,
        number: mr.iid,
        url: stringOrNull(mr.web_url),
        title: stringOrNull(mr.title),
        description: stringOrNull(mr.description),
        author: stringOrNull(record(mr.author)?.username),
        sourceBranch: stringOrNull(mr.source_branch),
        targetBranch: stringOrNull(mr.target_branch),
      },
      crossRepository:
        typeof mr.source_project_id === "number" &&
        typeof mr.target_project_id === "number" &&
        mr.source_project_id !== mr.target_project_id,
    };
  }
  const pr = record(
    await repo.tryJson("gh", [
      "pr",
      "view",
      idOrBranch,
      "--json",
      "number,title,body,author,headRefName,baseRefName,url,isCrossRepository",
    ]),
  );
  if (pr === null || typeof pr.number !== "number") return null;
  return {
    changeRequest: {
      forge,
      number: pr.number,
      url: stringOrNull(pr.url),
      title: stringOrNull(pr.title),
      description: stringOrNull(pr.body),
      author: stringOrNull(record(pr.author)?.login),
      sourceBranch: stringOrNull(pr.headRefName),
      targetBranch: stringOrNull(pr.baseRefName),
    },
    crossRepository: pr.isCrossRepository === true,
  };
}

async function defaultBranch(repo: Repo, remote: string): Promise<string> {
  const symbolic = await repo.tryGit(["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
  if (symbolic !== null && symbolic.startsWith(`${remote}/`)) return symbolic.slice(remote.length + 1);
  const advertised = await repo.tryGit(["ls-remote", "--symref", remote, "HEAD"]);
  const match = advertised === null ? null : /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(advertised);
  if (match) return match[1];
  throw new Error(`Cannot determine the default branch of "${remote}". Pass the target branch explicitly.`);
}

function stripRemotePrefix(branch: string, remote: string): string {
  return branch.startsWith(`${remote}/`) ? branch.slice(remote.length + 1) : branch;
}

export async function forgeOf(repo: Repo, remote: string): Promise<Forge | null> {
  return forgeFromRemoteUrl(await repo.tryGit(["remote", "get-url", remote]));
}

export async function prepareReview(
  input: { repoPath: string; source: string; targetBranch: string | null; remote: string },
  signal: AbortSignal,
): Promise<PreparedReview> {
  const { remote } = input;
  const repo = new Repo(input.repoPath, signal);
  const warnings: string[] = [];

  const remoteUrl = await repo.tryGit(["remote", "get-url", remote]);
  if (remoteUrl === null) throw new Error(`The project repository has no remote named "${remote}".`);
  const remoteForge = forgeFromRemoteUrl(remoteUrl);
  const source = parseReviewSource(input.source, remote);

  let lookup: ChangeRequestLookup | null = null;
  let headBranch: string | null = null;
  let changeRequestRef: { forge: Forge; number: number } | null = null;

  if (source.kind === "change-request") {
    const forge = source.forge ?? remoteForge;
    if (forge === null) {
      throw new Error(`Cannot tell the forge of "${remoteUrl}". Write !${source.number} for GitLab or #${source.number} for GitHub.`);
    }
    lookup = await lookupChangeRequest(repo, forge, String(source.number));
    if (lookup === null) {
      warnings.push(
        `Could not read ${forge === "gitlab" ? `!${source.number} with glab` : `#${source.number} with gh`}; title, description and target branch are unknown.`,
      );
    }
    if (lookup?.changeRequest.sourceBranch && !lookup.crossRepository) {
      headBranch = lookup.changeRequest.sourceBranch;
    } else {
      changeRequestRef = { forge, number: source.number };
    }
  } else {
    headBranch = source.branch;
    if (remoteForge !== null) lookup = await lookupChangeRequest(repo, remoteForge, source.branch);
  }

  const targetBranch = stripRemotePrefix(
    input.targetBranch ?? lookup?.changeRequest.targetBranch ?? (await defaultBranch(repo, remote)),
    remote,
  );
  assertSafeBranchName(targetBranch);

  let headRef: string;
  let headRefspec: string;
  if (headBranch !== null) {
    assertSafeBranchName(headBranch);
    headRef = `${remote}/${headBranch}`;
    headRefspec = `+refs/heads/${headBranch}:refs/remotes/${remote}/${headBranch}`;
  } else if (changeRequestRef !== null) {
    const { forge, number } = changeRequestRef;
    // bb's worktree provider re-fetches a `<remote>/<branch>` base as
    // refs/heads/<branch>, which does not exist for a merge-request head, so
    // the ref must not look remote-tracking. Outside refs/heads it also stays
    // out of the user's branch list.
    headRef = `refs/bb-review/${forge === "gitlab" ? "mr" : "pr"}-${number}`;
    headRefspec = `+refs/${forge === "gitlab" ? "merge-requests" : "pull"}/${number}/head:${headRef}`;
  } else {
    throw new Error("Nothing to review.");
  }

  const targetRef = `${remote}/${targetBranch}`;
  await repo.git(
    ["fetch", "--no-tags", "--quiet", remote, headRefspec, `+refs/heads/${targetBranch}:refs/remotes/${targetRef}`],
    5 * 60_000,
  );

  const headSha = await repo.git(["rev-parse", "--verify", `${headRef}^{commit}`]);
  const mergeBaseSha = await repo.git(["merge-base", headSha, targetRef]);
  const commitCount = Number(await repo.git(["rev-list", "--count", `${mergeBaseSha}..${headSha}`]));
  const shortStat = await repo.git(["diff", "--shortstat", mergeBaseSha, headSha]);
  if (commitCount === 0) warnings.push(`${headRef} has no commits that are not already in ${targetRef}.`);

  return {
    forge: lookup?.changeRequest.forge ?? changeRequestRef?.forge ?? remoteForge,
    remote,
    headRef,
    headSha,
    targetBranch,
    targetRef,
    mergeBaseSha,
    commitCount,
    shortStat,
    changeRequest: lookup?.changeRequest ?? null,
    warnings,
  };
}
