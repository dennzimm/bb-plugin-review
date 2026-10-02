import picomatch from "picomatch";
import { parse as parseYaml } from "yaml";
import type { ChangeAnalysis } from "../contract.ts";
import type { ProjectConfig } from "./settings.ts";

export interface MatchedRule {
  name: string;
  source: string;
  instructions: string;
  files: string[];
}

/** Globs with `!` prefixes exclude, as in GitLab Duo's fileFilters. */
function matcher(patterns: readonly string[]): (path: string) => boolean {
  const include = patterns.filter((pattern) => !pattern.startsWith("!"));
  const exclude = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
  const included = picomatch(include.length > 0 ? include : ["**"], { dot: true });
  const excluded = exclude.length > 0 ? picomatch(exclude, { dot: true }) : () => false;
  return (path) => included(path) && !excluded(path);
}

function matching(paths: readonly string[], patterns: readonly string[]): string[] {
  const test = matcher(patterns);
  return paths.filter((path) => test(path));
}

interface DuoInstruction {
  name?: unknown;
  fileFilters?: unknown;
  instructions?: unknown;
}

function duoRules(path: string, content: string, changed: readonly string[]): MatchedRule[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return [];
  }
  const list = (parsed as { instructions?: unknown } | null)?.instructions;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: DuoInstruction, index): MatchedRule[] => {
    if (typeof entry.instructions !== "string") return [];
    const filters = Array.isArray(entry.fileFilters) ? entry.fileFilters.filter((filter): filter is string => typeof filter === "string") : ["**"];
    const files = matching(changed, filters);
    if (files.length === 0) return [];
    return [{ name: typeof entry.name === "string" ? entry.name : `${path} #${index + 1}`, source: path, instructions: entry.instructions, files }];
  });
}

/** A REVIEW.md applies to changes at or below its own directory. */
function reviewMdRule(path: string, content: string, changed: readonly string[]): MatchedRule | null {
  const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  const files = changed.filter((file) => file.startsWith(directory));
  if (files.length === 0) return null;
  return { name: path, source: path, instructions: content, files };
}

export function matchRules(analysis: ChangeAnalysis, config: ProjectConfig): MatchedRule[] {
  const changed = analysis.files.map((file) => file.path);
  const rules: MatchedRule[] = [];
  for (const file of analysis.ruleFiles) {
    if (file.path.endsWith("REVIEW.md")) {
      const rule = reviewMdRule(file.path, file.content, changed);
      if (rule !== null) rules.push(rule);
    } else {
      rules.push(...duoRules(file.path, file.content, changed));
    }
  }
  config.rules.forEach((rule, index) => {
    const files = matching(changed, rule.paths);
    if (files.length > 0) {
      rules.push({ name: `Personal rule ${index + 1} (${rule.paths.join(", ")})`, source: "plugin settings", instructions: rule.instructions, files });
    }
  });
  return rules;
}
