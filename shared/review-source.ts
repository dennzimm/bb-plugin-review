export type Forge = "gitlab" | "github";

export type ReviewSource =
  | { kind: "branch"; branch: string }
  | { kind: "change-request"; forge: Forge | null; number: number; url: string | null };

const GITLAB_MR_URL = /^https?:\/\/[^\s]+?\/-\/merge_requests\/(\d+)(?:[/?#].*)?$/;
const GITHUB_PR_URL = /^https?:\/\/[^\s]+?\/pull\/(\d+)(?:[/?#].*)?$/;

/**
 * Accepts a merge-request or pull-request URL, `!123` (GitLab), `#123`
 * (GitHub), a bare number (forge decided later from the remote), or a branch
 * name, optionally prefixed with `<remote>/` or `refs/heads/`.
 */
export function parseReviewSource(raw: string, remote: string): ReviewSource {
  const value = raw.trim();
  if (value === "") throw new Error("Name a branch, merge request, or pull request to review.");

  const gitlabUrl = GITLAB_MR_URL.exec(value);
  if (gitlabUrl) return { kind: "change-request", forge: "gitlab", number: Number(gitlabUrl[1]), url: value };
  const githubUrl = GITHUB_PR_URL.exec(value);
  if (githubUrl) return { kind: "change-request", forge: "github", number: Number(githubUrl[1]), url: value };

  const numbered = /^([!#]?)(\d+)$/.exec(value);
  if (numbered) {
    const forge: Forge | null = numbered[1] === "!" ? "gitlab" : numbered[1] === "#" ? "github" : null;
    return { kind: "change-request", forge, number: Number(numbered[2]), url: null };
  }

  let branch = value;
  for (const prefix of ["refs/heads/", `refs/remotes/${remote}/`, `${remote}/`]) {
    if (branch.startsWith(prefix)) {
      branch = branch.slice(prefix.length);
      break;
    }
  }
  assertSafeBranchName(branch);
  return { kind: "branch", branch };
}

/** Rejects names git would read as options or that cannot be a branch. */
export function assertSafeBranchName(branch: string): void {
  if (
    branch === "" ||
    branch.startsWith("-") ||
    /[\s~^:?*[\\]|\.\.|@\{|\/\/|\.lock$|^\/|\/$|\.$/.test(branch)
  ) {
    throw new Error(`"${branch}" is not a valid branch name.`);
  }
}

export function forgeFromRemoteUrl(remoteUrl: string | null): Forge | null {
  if (remoteUrl === null) return null;
  if (/github/i.test(remoteUrl)) return "github";
  if (/gitlab/i.test(remoteUrl)) return "gitlab";
  return null;
}
