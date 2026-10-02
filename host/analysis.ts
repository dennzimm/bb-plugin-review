import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ChangeAnalysis, ChangedFile, DependencyReport } from "../contract.ts";
import { Repo, record, runCommand } from "./exec.ts";

const LOCKFILES = new Set(["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb"]);
const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
const RULE_FILE_LIMIT = 20_000;

async function changedFiles(repo: Repo, baseSha: string, headSha: string): Promise<ChangedFile[]> {
  const output = await repo.git(["diff", "--numstat", "--no-renames", baseSha, headSha]);
  if (output === "") return [];
  return output.split("\n").map((line) => {
    const [added, deleted, ...pathParts] = line.split("\t");
    const binary = added === "-" || deleted === "-";
    return {
      path: pathParts.join("\t"),
      added: binary ? 0 : Number(added),
      deleted: binary ? 0 : Number(deleted),
      binary,
    };
  });
}

async function readJsonAt(repo: Repo, sha: string, path: string): Promise<Record<string, unknown> | null> {
  const content = await repo.tryGit(["show", `${sha}:${path}`]);
  if (content === null) return null;
  try {
    return record(JSON.parse(content));
  } catch {
    return null;
  }
}

function majorOf(spec: string | null): number | null {
  const match = spec === null ? null : /(\d+)\./.exec(spec.replace(/^workspace:|^npm:[^@]+@/, ""));
  return match ? Number(match[1]) : null;
}

async function manifestChanges(repo: Repo, baseSha: string, headSha: string, file: string) {
  const [before, after] = await Promise.all([readJsonAt(repo, baseSha, file), readJsonAt(repo, headSha, file)]);
  const changes: DependencyReport["manifests"][number]["changes"] = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const old = record(before?.[section]) ?? {};
    const next = record(after?.[section]) ?? {};
    for (const name of new Set([...Object.keys(old), ...Object.keys(next)])) {
      const from = typeof old[name] === "string" ? (old[name] as string) : null;
      const to = typeof next[name] === "string" ? (next[name] as string) : null;
      if (from === to) continue;
      const kind = from === null ? "added" : to === null ? "removed" : "changed";
      const fromMajor = majorOf(from);
      const toMajor = majorOf(to);
      changes.push({
        name,
        section,
        from,
        to,
        kind,
        major: kind === "changed" && fromMajor !== null && toMajor !== null && fromMajor !== toMajor,
      });
    }
  }
  return changes;
}

/** Package keys added or removed in a lockfile diff, by format. Heuristic: exact parsing of every lockfile format is out of scope. */
function lockfilePackages(file: string, diff: string): { added: string[]; removed: string[] } {
  const added = new Set<string>();
  const removed = new Set<string>();
  const name = basename(file);
  const patterns: RegExp[] =
    name === "pnpm-lock.yaml"
      ? [/^([+-]) {2}'?((?:@[^@/\s']+\/)?[^@\s'(]+@[^:('\s]+)/]
      : name === "package-lock.json" || name === "npm-shrinkwrap.json"
        ? [/^([+-])\s+"node_modules\/((?:@[^/"]+\/)?[^"]+)": \{/]
        : name === "bun.lock"
          ? [/^([+-])\s+"[^"]+": \["((?:@[^@/"]+\/)?[^@"]+@[^"]+)"/]
          : [/^([+-])"?((?:@[^@/"\s]+\/)?[^@"\s]+@[^:"\s,]+)/];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (!match) continue;
      (match[1] === "+" ? added : removed).add(match[2]);
    }
  }
  for (const entry of added) {
    if (removed.has(entry)) {
      added.delete(entry);
      removed.delete(entry);
    }
  }
  return { added: [...added].slice(0, 300), removed: [...removed].slice(0, 300) };
}

async function installScripts(repo: Repo, packages: string[]): Promise<DependencyReport["installScripts"]> {
  const found: DependencyReport["installScripts"] = [];
  const queue = packages.slice(0, 20);
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let spec = queue.shift(); spec !== undefined; spec = queue.shift()) {
        const scripts = record(await repo.tryJson("npm", ["view", spec, "scripts", "--json"], 15_000));
        const lifecycle = Object.keys(scripts ?? {}).filter((key) => ["preinstall", "install", "postinstall", "prepare"].includes(key));
        if (lifecycle.length > 0) found.push({ package: spec, scripts: lifecycle });
      }
    }),
  );
  return found;
}

async function osvScan(repo: Repo, headSha: string, lockfile: string): Promise<string | null> {
  const which = await runCommand("osv-scanner", ["--version"], { cwd: repo.path, signal: repo.signal, timeoutMs: 10_000 });
  if (!which.ok) return null;
  const content = await repo.tryGit(["show", `${headSha}:${lockfile}`]);
  if (content === null) return null;
  const directory = await mkdtemp(join(tmpdir(), "bb-review-osv-"));
  try {
    const path = join(directory, basename(lockfile));
    await writeFile(path, content);
    const result = await runCommand("osv-scanner", ["scan", "--lockfile", path, "--format", "markdown"], {
      cwd: directory,
      signal: repo.signal,
      timeoutMs: 120_000,
      maxBytes: 64 * 1024,
    });
    // osv-scanner exits 1 when it finds vulnerabilities.
    const output = (result.stdout || result.stderr).trim();
    return output === "" ? "No known vulnerabilities reported." : output.slice(-6000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function dependencyReport(
  repo: Repo,
  baseSha: string,
  headSha: string,
  files: ChangedFile[],
  inspect: boolean,
): Promise<DependencyReport | null> {
  const manifests = files.filter((file) => basename(file.path) === "package.json").map((file) => file.path);
  const lockfiles = files.filter((file) => LOCKFILES.has(basename(file.path)));
  if (manifests.length === 0 && lockfiles.length === 0) return null;

  const manifestReports = await Promise.all(
    manifests.map(async (file) => ({ file, changes: await manifestChanges(repo, baseSha, headSha, file) })),
  );
  const lockfileReports = await Promise.all(
    lockfiles.map(async (file) => {
      const diff = file.binary ? "" : ((await repo.tryGit(["diff", "--unified=0", baseSha, headSha, "--", file.path])) ?? "");
      return { file: file.path, ...lockfilePackages(file.path, diff), linesChanged: file.added + file.deleted };
    }),
  );

  const touched = new Set(manifestReports.flatMap((report) => report.changes.map((change) => change.name)));
  const duplicates: DependencyReport["duplicates"] = [];
  if (touched.size > 0) {
    const allManifests = ((await repo.tryGit(["ls-tree", "-r", "--name-only", headSha])) ?? "")
      .split("\n")
      .filter((path) => basename(path) === "package.json" && !path.includes("node_modules/"))
      .slice(0, 200);
    const specs = new Map<string, Set<string>>();
    for (const path of allManifests) {
      const manifest = await readJsonAt(repo, headSha, path);
      for (const section of DEPENDENCY_SECTIONS) {
        for (const [name, spec] of Object.entries(record(manifest?.[section]) ?? {})) {
          if (!touched.has(name) || typeof spec !== "string" || spec.startsWith("workspace:")) continue;
          if (!specs.has(name)) specs.set(name, new Set());
          specs.get(name)!.add(`${spec} (${path})`);
        }
      }
    }
    for (const [name, values] of specs) {
      const distinct = new Set([...values].map((value) => value.split(" (")[0]));
      if (distinct.size > 1) duplicates.push({ name, specs: [...values].slice(0, 10) });
    }
  }

  const addedPackages = lockfileReports.flatMap((report) => report.added);
  const directAdded = manifestReports.flatMap((report) =>
    report.changes.filter((change) => change.kind !== "removed" && change.to !== null && !change.to.startsWith("workspace:")).map((change) => change.name),
  );
  // Only the first 20 candidates are looked up, so direct dependencies go first.
  const nameOf = (spec: string) => spec.slice(0, spec.lastIndexOf("@") > 0 ? spec.lastIndexOf("@") : spec.length);
  const direct = new Set(directAdded);
  const scriptCandidates =
    addedPackages.length > 0
      ? [...addedPackages.filter((spec) => direct.has(nameOf(spec))), ...addedPackages.filter((spec) => !direct.has(nameOf(spec)))]
      : directAdded;
  const scripts = inspect && scriptCandidates.length > 0 ? await installScripts(repo, scriptCandidates) : [];
  const firstLockfile = lockfiles.find((file) => !file.binary);
  const osv = inspect && firstLockfile !== undefined ? await osvScan(repo, headSha, firstLockfile.path) : null;

  return { manifests: manifestReports, lockfiles: lockfileReports, duplicates, installScripts: scripts, osv };
}

async function ruleFiles(repo: Repo, headSha: string): Promise<ChangeAnalysis["ruleFiles"]> {
  const tree = ((await repo.tryGit(["ls-tree", "-r", "--name-only", headSha])) ?? "").split("\n");
  const wanted = tree.filter(
    (path) => basename(path) === "REVIEW.md" || path === ".gitlab/duo/mr-review-instructions.yaml" || path === ".gitlab/duo/mr-review-instructions.yml",
  );
  const files: ChangeAnalysis["ruleFiles"] = [];
  for (const path of wanted.slice(0, 20)) {
    const content = await repo.tryGit(["show", `${headSha}:${path}`]);
    if (content !== null) files.push({ path, content: content.slice(0, RULE_FILE_LIMIT) });
  }
  return files;
}

export async function analyzeChange(
  input: { repoPath: string; baseSha: string; headSha: string; inspectInstallScripts: boolean },
  signal: AbortSignal,
): Promise<ChangeAnalysis> {
  const repo = new Repo(input.repoPath, signal);
  const files = await changedFiles(repo, input.baseSha, input.headSha);
  const [dependencies, rules] = await Promise.all([
    dependencyReport(repo, input.baseSha, input.headSha, files, input.inspectInstallScripts),
    ruleFiles(repo, input.headSha),
  ]);
  return { files: files.slice(0, 3000), dependencies, ruleFiles: rules };
}
