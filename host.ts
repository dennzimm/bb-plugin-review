import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract.ts";
import { analyzeChange } from "./host/analysis.ts";
import {
  changeRequestStatus,
  listDiscussions,
  listReviewRequests,
  listSuggestions,
  postFindings,
  publishDrafts,
} from "./host/forge.ts";
import { prepareReview } from "./host/prepare.ts";
import { guardWorktree, resetWorktree, runChecks, waitForUrl, worktreeStatus } from "./host/worktree.ts";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    prepareReview: (input, context) => prepareReview(input, context.signal),
    listSuggestions: (input, context) => listSuggestions(input, context.signal),
    listReviewRequests: (input, context) => listReviewRequests(input, context.signal),
    analyzeChange: (input, context) => analyzeChange(input, context.signal),
    listDiscussions: (input, context) => listDiscussions(input, context.signal),
    changeRequestStatus: (input, context) => changeRequestStatus(input, context.signal),
    postFindings: (input, context) => postFindings(input, context.signal),
    publishDrafts: (input, context) => publishDrafts(input, context.signal),
    resetWorktree: (input, context) => resetWorktree(input, context.signal),
    guardWorktree: (input, context) => guardWorktree(input, context.signal),
    worktreeStatus: (input, context) => worktreeStatus(input, context.signal),
    runChecks: (input, context) => runChecks(input, context.signal),
    waitForUrl: (input, context) => waitForUrl(input, context.signal),
  },
});
