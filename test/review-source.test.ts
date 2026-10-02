import assert from "node:assert/strict";
import { test } from "node:test";
import { forgeFromRemoteUrl, parseReviewSource } from "../shared/review-source.ts";

test("merge request and pull request references", () => {
  assert.deepEqual(parseReviewSource("https://gitlab.com/group/sub/repo/-/merge_requests/42/diffs", "origin"), {
    kind: "change-request",
    forge: "gitlab",
    number: 42,
    url: "https://gitlab.com/group/sub/repo/-/merge_requests/42/diffs",
  });
  assert.deepEqual(parseReviewSource("https://github.com/o/r/pull/7", "origin"), {
    kind: "change-request",
    forge: "github",
    number: 7,
    url: "https://github.com/o/r/pull/7",
  });
  assert.deepEqual(parseReviewSource("!12", "origin"), { kind: "change-request", forge: "gitlab", number: 12, url: null });
  assert.deepEqual(parseReviewSource("#12", "origin"), { kind: "change-request", forge: "github", number: 12, url: null });
  assert.deepEqual(parseReviewSource(" 12 ", "origin"), { kind: "change-request", forge: null, number: 12, url: null });
});

test("branch names drop remote and ref prefixes", () => {
  assert.deepEqual(parseReviewSource("feature/checkout", "origin"), { kind: "branch", branch: "feature/checkout" });
  assert.deepEqual(parseReviewSource("origin/feature/checkout", "origin"), { kind: "branch", branch: "feature/checkout" });
  assert.deepEqual(parseReviewSource("refs/heads/fix-1", "origin"), { kind: "branch", branch: "fix-1" });
  assert.deepEqual(parseReviewSource("upstream/fix-1", "upstream"), { kind: "branch", branch: "fix-1" });
});

test("rejects names git would misread", () => {
  for (const bad of ["--upload-pack=evil", "a..b", "has space", "x.lock", "trailing/", "a:b", ""]) {
    assert.throws(() => parseReviewSource(bad, "origin"), bad);
  }
});

test("forge from remote URL", () => {
  assert.equal(forgeFromRemoteUrl("git@gitlab.com:group/repo.git"), "gitlab");
  assert.equal(forgeFromRemoteUrl("https://github.com/o/r.git"), "github");
  assert.equal(forgeFromRemoteUrl("ssh://git.example.com/r.git"), null);
});

