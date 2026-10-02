import type { CheckResult } from "../contract.ts";
import { Repo, runCommand } from "./exec.ts";

const OUTPUT_TAIL = 6000;

export async function worktreeStatus(input: { worktreePath: string }, signal: AbortSignal) {
  const repo = new Repo(input.worktreePath, signal);
  const status = await repo.git(["status", "--porcelain", "--untracked-files=normal"]);
  const dirty = status === "" ? [] : status.split("\n").map((line) => line.slice(3));
  return { dirty: dirty.slice(0, 200) };
}

/** Moves the review worktree to a new head; refuses when the reviewer left changes behind. */
export async function resetWorktree(input: { worktreePath: string; sha: string }, signal: AbortSignal) {
  const { dirty } = await worktreeStatus(input, signal);
  if (dirty.length > 0) {
    throw new Error(`The review worktree has uncommitted changes (${dirty.slice(0, 5).join(", ")}); clean it up before re-reviewing.`);
  }
  const repo = new Repo(input.worktreePath, signal);
  await repo.git(["reset", "--quiet", "--hard", input.sha]);
  return { ok: true as const };
}

/**
 * bb creates the review branch tracking the reviewed branch, so a bare
 * `git push` from the review would publish to it. Dropping the upstream makes
 * an accidental push fail instead.
 */
export async function guardWorktree(input: { worktreePath: string }, signal: AbortSignal) {
  const repo = new Repo(input.worktreePath, signal);
  await repo.tryGit(["branch", "--unset-upstream"]);
  return { ok: true as const };
}

export async function runChecks(
  input: { worktreePath: string; commands: string[]; timeoutMs: number },
  signal: AbortSignal,
): Promise<{ results: CheckResult[] }> {
  const deadline = Date.now() + input.timeoutMs;
  const results: CheckResult[] = [];
  for (const command of input.commands) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      results.push({ command, exitCode: null, durationMs: 0, output: "Skipped: the check time budget ran out.", timedOut: true });
      continue;
    }
    const started = Date.now();
    const result = await runCommand("/bin/sh", ["-c", command], {
      cwd: input.worktreePath,
      signal,
      timeoutMs: remaining,
      maxBytes: 256 * 1024,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    results.push({
      command,
      exitCode: result.exitCode,
      durationMs: Date.now() - started,
      output: output.length > OUTPUT_TAIL ? `…${output.slice(-OUTPUT_TAIL)}` : output,
      timedOut: result.timedOut,
    });
  }
  return { results };
}

export async function waitForUrl(input: { url: string; timeoutMs: number }, signal: AbortSignal) {
  const deadline = Date.now() + input.timeoutMs;
  let status: number | null = null;
  while (Date.now() < deadline && !signal.aborted) {
    try {
      const response = await fetch(input.url, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
      status = response.status;
      if (status < 500) return { ok: true, status };
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { ok: false, status };
}
