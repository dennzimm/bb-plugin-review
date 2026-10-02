import { useEffect } from "react";
import { useBbContext, useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { countFindings, formatCounts, REVIEWS_CHANGED } from "../shared/findings.ts";
import { useAction, useQueue, useReview, useReviewRpc } from "./api.ts";
import { Spinner, VerdictChip } from "./ui.tsx";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

export const PANEL_PATH = "reviews";
export const FINDINGS_ACTION_ID = "review-findings";

/**
 * Palette commands receive no navigation or RPC API, so they hand requests to
 * the always-mounted overlay, which can use the hooks.
 */
export const commandRequests = new EventTarget();
export type CommandRequest = { kind: "open-reviews"; projectId: string | null } | { kind: "re-review"; threadId: string };

export function requestCommand(request: CommandRequest) {
  commandRequests.dispatchEvent(new CustomEvent("request", { detail: request }));
}

export function AppOverlay() {
  const navigate = useBbNavigate();
  const context = useBbContext();
  const rpc = useReviewRpc();

  useEffect(() => {
    const onRequest = (event: Event) => {
      const request = (event as CustomEvent<CommandRequest>).detail;
      if (request.kind === "open-reviews") {
        navigate.toPluginPanel(PANEL_PATH, request.projectId ? { subPath: request.projectId } : undefined);
        return;
      }
      rpc.call("review_again", { threadId: request.threadId }).then(
        (result) => toast(`Re-review started: round ${result.round}`),
        (cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)),
      );
    };
    commandRequests.addEventListener("request", onRequest);
    return () => commandRequests.removeEventListener("request", onRequest);
  }, [navigate, rpc]);

  useRealtime(REVIEWS_CHANGED, (payload) => {
    const event = (payload ?? {}) as { kind?: string; threadId?: string; title?: string };
    if (event.kind !== "finished" || event.threadId === undefined || event.threadId === context.threadId) return;
    toast(`Review finished: ${(event.title ?? "").replace(/^Review: /, "")}`, {
      action: { label: "Open", onClick: () => navigate.toThread(event.threadId!) },
    });
  });

  return null;
}

export function ThreadHeaderReview({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const { data: review } = useReview(threadId);
  const navigate = useBbNavigate();
  const rpc = useReviewRpc();
  const action = useAction();
  if (review === null) return null;
  const tally = formatCounts(countFindings(review.findings));
  const openFindings = () => navigate.openThreadPanel({ actionId: FINDINGS_ACTION_ID, title: "Findings" });

  return (
    <div className="flex items-center gap-1.5">
      {!isCompactViewport ? <VerdictChip verdict={review.report?.verdict ?? null} /> : null}
      <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={openFindings} aria-label={tally || "Review findings"}>
        <Icon name="ListTodo" className="size-3.5" />
        {isCompactViewport ? null : tally || "Findings"}
      </Button>
      {review.newCommits ? (
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          disabled={action.pending !== null}
          aria-label="Re-review the new commits"
          onClick={() => void action.run("again", () => rpc.call("review_again", { threadId }))}
        >
          {action.pending ? <Spinner /> : <Icon name="ArrowReloadHorizontal" className="size-3.5" />}
          {isCompactViewport ? null : "Re-review"}
        </Button>
      ) : null}
    </div>
  );
}

export function QueueBadge() {
  const { data } = useQueue();
  const waiting = data?.items.filter((item) => item.reviewThreadId === null || (item.headSha !== null && item.headSha !== item.reviewedHeadSha)).length ?? 0;
  if (waiting === 0) return null;
  return <span className="text-xs tabular-nums text-muted-foreground">{waiting}</span>;
}
