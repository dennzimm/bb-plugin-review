import assert from "node:assert/strict";
import { test } from "node:test";
import { countFindings, formatOutcome, parseReportText, type Finding } from "../shared/findings.ts";

const report = [
  "I found two Medium issues and no blockers.",
  "",
  "1. [Medium] Reset the cached locale when the user switches accounts",
  "   File: `apps/web/src/app/settings/_lib/locale.ts:51-73`",
  "   `setLocale` writes the cookie but never clears the cached value.",
  "   It never clears it.",
  "",
  "2. **[High]** Saving the form twice creates duplicate orders",
  "   File: apps/web/OrderForm.tsx:26",
  "   The submit handler is not debounced.",
  "",
  "3. [Pre-existing] Old cookie bug",
  "   File: apps/web/storage.ts:10",
  "   Already broken before.",
  "",
  "**Summary:** Tally: 1 High, 1 Medium. Verdict: **Fix before merging**.",
  "",
  "**Limitations**",
  "- 2. [Low] this is not a finding inside limitations",
].join("\n");

test("parses findings, locations and verdict from a text report", () => {
  const parsed = parseReportText(report);
  assert.ok(parsed);
  assert.equal(parsed.verdict, "Fix before merging");
  assert.equal(parsed.findings.length, 4 - 1);
  const [first, second, third] = parsed.findings;
  assert.equal(first.severity, "Medium");
  assert.equal(first.file, "apps/web/src/app/settings/_lib/locale.ts");
  assert.equal(first.startLine, 51);
  assert.equal(first.endLine, 73);
  assert.match(first.body, /never clears it/);
  assert.equal(second.severity, "High");
  assert.equal(second.title, "Saving the form twice creates duplicate orders");
  assert.equal(second.startLine, 26);
  assert.equal(second.endLine, 26);
  assert.equal(third.severity, "Pre-existing");
});

test("previous finding statuses and no-finding reports", () => {
  const parsed = parseReportText("Previous findings:\n- F1: fixed\n- F3 still open\n\nNo actionable findings.");
  assert.deepEqual(parsed?.previous, [
    { id: "F1", status: "fixed" },
    { id: "F3", status: "still-open" },
  ]);
  assert.equal(parsed?.verdict, "No blocking issues");
  assert.equal(parseReportText("Finding 2 matters because the cookie lives 15 minutes."), null);
});

test("counts exclude pre-existing and closed findings", () => {
  const base: Omit<Finding, "id" | "severity" | "status"> = {
    round: 1, title: "t", file: null, startLine: null, endLine: null, body: "b", suggestion: null, suggestionStartLine: null, suggestionEndLine: null,
    confidence: null, evidence: null, category: null, statusNote: null, posted: null,
  };
  const findings: Finding[] = [
    { ...base, id: "F1", severity: "High", status: "open" },
    { ...base, id: "F2", severity: "Medium", status: "posted" },
    { ...base, id: "F3", severity: "Medium", status: "fixed" },
    { ...base, id: "F4", severity: "Pre-existing", status: "open" },
    { ...base, id: "F5", severity: "Low", status: "dismissed" },
  ];
  const counts = countFindings(findings);
  assert.deepEqual(counts, { High: 1, Medium: 1 });
  assert.equal(formatOutcome("Fix before merging", counts), "Fix before merging · 1 High, 1 Medium");
});
