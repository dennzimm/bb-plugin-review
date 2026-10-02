import picomatch from "picomatch";
import type { ChangedFile, DependencyReport } from "../contract.ts";
import type { Risk } from "./store.ts";

export const DEFAULT_RISKY_PATHS = [
  "**/*auth*/**",
  "**/*auth*.*",
  "**/*session*.*",
  "**/middleware.*",
  "**/*payment*/**",
  "**/*checkout*/**",
  "**/migrations/**",
  "**/*.sql",
  "**/.env*",
  "**/next.config.*",
  "**/turbo.json",
  "**/.gitlab-ci*",
  "**/.github/workflows/**",
  "infrastructure/**",
  "**/*.tf",
  "**/Dockerfile*",
];

const NOT_REVIEWED = picomatch(
  ["**/pnpm-lock.yaml", "**/package-lock.json", "**/yarn.lock", "**/bun.lock", "**/bun.lockb", "**/*.snap", "**/generated/**", "**/__generated__/**", "**/*.min.*", "**/dist/**"],
  { dot: true },
);

/** Defect detection drops sharply on changes beyond a few hundred lines, so size dominates the score. */
const SPLIT_THRESHOLD_LINES = 400;

export function isReviewable(path: string): boolean {
  return !NOT_REVIEWED(path);
}

function areaOf(path: string): string {
  const parts = path.split("/");
  return parts.length > 2 && ["apps", "packages", "libs", "services", "infrastructure", "tests"].includes(parts[0])
    ? `${parts[0]}/${parts[1]}`
    : parts.length > 1
      ? parts[0]
      : "(root)";
}

export function assessRisk(files: readonly ChangedFile[], dependencies: DependencyReport | null, riskyPaths: readonly string[]): Risk {
  const reviewed = files.filter((file) => isReviewable(file.path));
  const reviewedLines = reviewed.reduce((sum, file) => sum + file.added + file.deleted, 0);
  const areas = [...new Set(reviewed.map((file) => areaOf(file.path)))].sort();
  const reasons: string[] = [];
  let score = 0;

  if (reviewedLines >= 1000) {
    score += 3;
    reasons.push(`${reviewedLines} changed lines`);
  } else if (reviewedLines >= SPLIT_THRESHOLD_LINES) {
    score += 2;
    reasons.push(`${reviewedLines} changed lines`);
  } else if (reviewedLines >= 100) {
    score += 1;
  }
  if (reviewed.length > 30) {
    score += 1;
    reasons.push(`${reviewed.length} files`);
  }

  const risky = picomatch([...riskyPaths], { dot: true, nocase: true });
  const riskyFiles = files.filter((file) => risky(file.path)).map((file) => file.path);
  if (riskyFiles.length > 0) {
    score += Math.min(3, riskyFiles.length);
    reasons.push(`sensitive paths: ${riskyFiles.slice(0, 4).join(", ")}${riskyFiles.length > 4 ? ` and ${riskyFiles.length - 4} more` : ""}`);
  }

  const majorBumps = dependencies?.manifests.flatMap((manifest) => manifest.changes.filter((change) => change.major)) ?? [];
  const newPackages = dependencies?.lockfiles.reduce((sum, lockfile) => sum + lockfile.added.length, 0) ?? 0;
  if (majorBumps.length > 0) {
    score += 1;
    reasons.push(`major upgrades: ${majorBumps.slice(0, 3).map((change) => change.name).join(", ")}`);
  }
  if (newPackages > 0) {
    score += 1;
    reasons.push(`${newPackages} package versions added to lockfiles`);
  }
  if ((dependencies?.installScripts.length ?? 0) > 0) {
    score += 1;
    reasons.push("new packages with install scripts");
  }

  const splitSuggested = reviewedLines >= 1000 || (reviewedLines >= SPLIT_THRESHOLD_LINES && areas.length >= 3);
  if (splitSuggested) reasons.push(`spans ${areas.length} areas: consider splitting`);

  return {
    level: score <= 1 ? "low" : score <= 3 ? "medium" : "high",
    score,
    reasons,
    splitSuggested,
    reviewedLines,
    files: files.length,
    areas,
  };
}
