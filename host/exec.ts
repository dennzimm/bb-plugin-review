import { spawn } from "node:child_process";

export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  input?: string;
  shell?: boolean;
  /** Keep only the last N bytes of each stream. */
  maxBytes?: number;
}

// A credential prompt would hang the call until it times out.
const NON_INTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
  GLAB_NO_PROMPT: "1",
  GH_PROMPT_DISABLED: "1",
  NO_COLOR: "1",
  CI: "1",
};

export function runCommand(command: string, args: readonly string[], options: RunOptions): Promise<CommandResult> {
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...NON_INTERACTIVE_ENV },
      shell: options.shell ?? false,
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group, so a timeout also stops the children a shell started.
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    const keep = (chunks: Buffer[], chunk: Buffer, size: number): number => {
      chunks.push(chunk);
      let total = size + chunk.length;
      while (total > maxBytes && chunks.length > 1) total -= chunks.shift()!.length;
      return total;
    };
    child.stdout.on("data", (chunk: Buffer) => (stdoutBytes = keep(stdout, chunk, stdoutBytes)));
    child.stderr.on("data", (chunk: Buffer) => (stderrBytes = keep(stderr, chunk, stderrBytes)));

    const kill = () => {
      try {
        if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        // Already exited.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const onAbort = () => kill();
    options.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      resolve({ ok: false, exitCode: null, stdout: "", stderr: error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
        timedOut,
      });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export class Repo {
  constructor(
    readonly path: string,
    readonly signal: AbortSignal,
  ) {}

  run(command: string, args: readonly string[], timeoutMs = 60_000, input?: string): Promise<CommandResult> {
    return runCommand(command, args, { cwd: this.path, signal: this.signal, timeoutMs, input });
  }

  async git(args: readonly string[], timeoutMs = 60_000): Promise<string> {
    const result = await this.run("git", args, timeoutMs);
    if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || "unknown error"}`);
    return result.stdout;
  }

  async tryGit(args: readonly string[]): Promise<string | null> {
    const result = await this.run("git", args);
    return result.ok ? result.stdout : null;
  }

  async tryJson(command: string, args: readonly string[], timeoutMs = 30_000): Promise<unknown> {
    const result = await this.run(command, args, timeoutMs);
    if (!result.ok) return null;
    try {
      return JSON.parse(result.stdout);
    } catch {
      return null;
    }
  }

  /** Calls a forge API through glab/gh; throws with the CLI's error text on failure. */
  async api(command: "glab" | "gh", args: readonly string[], body?: unknown): Promise<unknown> {
    const fullArgs = body === undefined ? ["api", ...args] : ["api", ...args, "--input", "-", "-H", "Content-Type: application/json"];
    const result = await this.run(command, fullArgs, 60_000, body === undefined ? undefined : JSON.stringify(body));
    if (!result.ok) throw new Error(`${command} api ${args[0] ?? ""} failed: ${(result.stderr || result.stdout).slice(0, 500)}`);
    if (result.stdout === "") return null;
    try {
      return JSON.parse(result.stdout);
    } catch {
      return result.stdout;
    }
  }
}

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
