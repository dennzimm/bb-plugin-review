import assert from "node:assert/strict";
import { test } from "node:test";
import { adfToText, findTicketKey } from "../server/jira.ts";
import { assessRisk, DEFAULT_RISKY_PATHS } from "../server/risk.ts";
import { routesFromFiles } from "../server/routes.ts";
import { matchRules } from "../server/rules.ts";
import { projectConfigSchema } from "../server/settings.ts";

const file = (path: string, added = 10, deleted = 0) => ({ path, added, deleted, binary: false });

test("risk grows with size, sensitive paths and dependency changes", () => {
  const small = assessRisk([file("apps/web/src/a.ts", 20)], null, DEFAULT_RISKY_PATHS);
  assert.equal(small.level, "low");
  assert.equal(small.splitSuggested, false);

  const large = assessRisk(
    [file("apps/web/src/middleware.ts", 300), file("packages/ui/x.tsx", 300), file("packages/api/y.ts", 200), file("pnpm-lock.yaml", 5000)],
    { manifests: [{ file: "package.json", changes: [{ name: "next", section: "dependencies", from: "^14.0.0", to: "^15.0.0", kind: "changed", major: true }] }], lockfiles: [{ file: "pnpm-lock.yaml", added: ["a@1.0.0"], removed: [], linesChanged: 5000 }], duplicates: [], installScripts: [], osv: null },
    DEFAULT_RISKY_PATHS,
  );
  assert.equal(large.reviewedLines, 800);
  assert.equal(large.level, "high");
  assert.equal(large.splitSuggested, true);
  assert.ok(large.reasons.some((reason) => reason.includes("middleware")));
  assert.deepEqual(large.areas, ["apps/web", "packages/api", "packages/ui"]);
});

test("rules match by path: REVIEW.md scope, Duo filters with negation, personal globs", () => {
  const analysis = {
    files: [file("apps/web/app/page.tsx"), file("apps/web/app/page.test.tsx"), file("packages/ui/button.tsx")],
    dependencies: null,
    ruleFiles: [
      { path: "apps/web/REVIEW.md", content: "Check server/client boundaries." },
      { path: "packages/other/REVIEW.md", content: "Not relevant." },
      {
        path: ".gitlab/duo/mr-review-instructions.yaml",
        content: "instructions:\n  - name: Components\n    fileFilters:\n      - '**/*.tsx'\n      - '!**/*.test.tsx'\n    instructions: Check accessibility.\n",
      },
    ],
  };
  const config = projectConfigSchema.parse({ rules: [{ paths: ["packages/ui/**"], instructions: "Use design tokens." }] });
  const rules = matchRules(analysis, config);
  assert.deepEqual(
    rules.map((rule) => [rule.name, rule.files]),
    [
      ["apps/web/REVIEW.md", ["apps/web/app/page.tsx", "apps/web/app/page.test.tsx"]],
      ["Components", ["apps/web/app/page.tsx", "packages/ui/button.tsx"]],
      ["Personal rule 1 (packages/ui/**)", ["packages/ui/button.tsx"]],
    ],
  );
});

test("ticket keys and Jira descriptions", () => {
  const pattern = "(?<![A-Za-z0-9])[A-Z][A-Z0-9]+-\\d+(?!\\d)";
  assert.equal(findTicketKey(pattern, null, "feature/SHOP-7441_spring-sale-banner"), "SHOP-7441");
  assert.equal(findTicketKey(pattern, "fix/faster-logout", "Speed up logout"), null);
  const adf = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Acceptance criteria" }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Banner shows the sale price" }] }] }] },
    ],
  };
  const text = adfToText(adf);
  assert.match(text, /### Acceptance criteria/);
  assert.match(text, /- Banner shows the sale price/);
});

test("routes from Next.js app files", () => {
  assert.deepEqual(
    routesFromFiles([
      "apps/web/src/app/[locale]/(main)/account/_components/ProfileCard.tsx",
      "apps/web/src/app/[locale]/(main)/account/page.tsx",
      "apps/web/src/app/[locale]/(main)/page.tsx",
      "apps/web/src/lib/x.ts",
    ]),
    ["/", "/account"],
  );
});
