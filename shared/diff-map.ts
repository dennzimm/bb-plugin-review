export interface DiffLine {
  kind: "added" | "context";
  oldLine: number | null;
}

/** New-side line number → how it appears in a single file's unified diff. */
export type DiffLineMap = Map<number, DiffLine>;

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function mapDiffLines(fileDiff: string): DiffLineMap {
  const map: DiffLineMap = new Map();
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of fileDiff.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      map.set(newLine, { kind: "added", oldLine: null });
      newLine += 1;
    } else if (line.startsWith("-")) {
      oldLine += 1;
    } else if (line.startsWith(" ") || line === "") {
      map.set(newLine, { kind: "context", oldLine });
      oldLine += 1;
      newLine += 1;
    } else {
      inHunk = false;
    }
  }
  return map;
}

/**
 * Picks the line a comment should anchor to: the finding's last line when it
 * is part of the diff, otherwise the closest diff line inside its range.
 */
export function anchorLine(map: DiffLineMap, startLine: number, endLine: number): number | null {
  for (let line = endLine; line >= startLine; line -= 1) {
    if (map.has(line)) return line;
  }
  return null;
}

/** True when every line in the range is part of the diff, so a suggestion can replace it. */
export function rangeInDiff(map: DiffLineMap, startLine: number, endLine: number): boolean {
  for (let line = startLine; line <= endLine; line += 1) {
    if (!map.has(line)) return false;
  }
  return true;
}

export interface CommentPlan {
  /** Line the comment is attached to; null when nothing in the range is part of the diff. */
  anchor: number | null;
  /** First line of a multi-line comment (GitHub), equal to anchor for single-line comments. */
  start: number | null;
  /** The lines an applicable suggestion replaces, or null when it can only be shown as text. */
  replaces: { start: number; end: number } | null;
}

/**
 * GitLab and GitHub suggestions replace lines relative to the comment's own
 * position, so a comment with a suggestion must sit on exactly the lines the
 * suggestion replaces, and all of them must be part of the diff.
 */
export function planComment(
  map: DiffLineMap,
  range: { start: number; end: number },
  suggestion: { start: number; end: number } | null,
): CommentPlan {
  if (suggestion !== null && suggestion.start <= suggestion.end && rangeInDiff(map, suggestion.start, suggestion.end)) {
    return { anchor: suggestion.end, start: suggestion.start, replaces: suggestion };
  }
  const anchor = anchorLine(map, range.start, range.end);
  const whole = anchor === range.end && rangeInDiff(map, range.start, range.end);
  return { anchor, start: whole ? range.start : anchor, replaces: null };
}
