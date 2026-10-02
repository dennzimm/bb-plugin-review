import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { PluginMessageDirectiveProps, PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { AppOverlay, FINDINGS_ACTION_ID, PANEL_PATH, QueueBadge, requestCommand, ThreadHeaderReview } from "./app/chrome.tsx";
import { FindingsBoard } from "./app/FindingsBoard.tsx";
import { ReviewsPage } from "./app/ReviewsPage.tsx";

function FindingsPanel({ threadId }: PluginThreadPanelProps) {
  return <FindingsBoard threadId={threadId} />;
}

/** `::review-findings` at the end of a review report renders the interactive findings there. */
function FindingsDirective({ message }: PluginMessageDirectiveProps) {
  return <FindingsBoard threadId={message.threadId} compact />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "reviews",
    title: "Reviews",
    icon: "GitPullRequest",
    path: PANEL_PATH,
    component: ReviewsPage,
    experimental_sidebarAccessory: QueueBadge,
  });
  app.slots.experimental_appOverlay({ id: "command-bridge", component: AppOverlay });
  app.slots.threadPanelAction({ id: FINDINGS_ACTION_ID, title: "Review findings", icon: "ListTodo", component: FindingsPanel });
  app.slots.experimental_threadHeaderAction({ id: "review-status", title: "Review", component: ThreadHeaderReview });
  app.slots.messageDirective({ id: "review-findings", component: FindingsDirective });

  app.commands.register({
    id: "start-review",
    title: "Review a branch or merge request…",
    run: ({ projectId }) => requestCommand({ kind: "open-reviews", projectId }),
  });
  app.commands.register({
    id: "show-findings",
    title: "Show review findings",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ openPanel }) => {
      openPanel({ actionId: FINDINGS_ACTION_ID, title: "Findings" });
    },
  });
  app.commands.register({
    id: "re-review",
    title: "Re-review this merge request's new commits",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ threadId }) => {
      if (threadId !== null) requestCommand({ kind: "re-review", threadId });
    },
  });
});
