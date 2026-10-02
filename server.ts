import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { parseReportText } from "./shared/findings.ts";
import { registerAgentSurfaces } from "./server/agent.ts";
import { registerCli } from "./server/cli.ts";
import { learningsStore } from "./server/learnings.ts";
import { registerRpc } from "./server/rpc.ts";
import { createReviewService } from "./server/service.ts";
import { defineSettings } from "./server/settings.ts";
import { reviewStore } from "./server/store.ts";

export { rpcContract } from "./server/rpc.ts";
export type { ReviewDetail } from "./server/rpc.ts";
export type { QueueItem, ReviewSummary } from "./server/service.ts";

export default async function plugin(bb: BbPluginApi) {
  const settings = defineSettings(bb);
  const store = reviewStore(bb);
  const learnings = learningsStore(bb);
  const service = createReviewService(bb, { settings, store, learnings });

  const ours = (thread: { originPluginId: string | null }) => thread.originPluginId === bb.pluginId;
  const warn = (message: string) => (error: unknown) => bb.log.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`);

  bb.events.on("thread.active", async ({ thread }) => {
    if (!ours(thread)) return;
    service.publish({ threadId: thread.id });
    await service.onEnvironmentReady(thread.id).catch(warn(`preparing ${thread.id}`));
  });

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    if (!ours(thread)) return;
    const meta = await store.read(thread.id);
    if (meta === null) return;
    if (lastAssistantText !== null) {
      await service.recordTextReport(thread.id, lastAssistantText, parseReportText).catch(warn(`reading the report of ${thread.id}`));
    }
    await service.checkReadOnly(thread.id).catch(warn(`checking the worktree of ${thread.id}`));
    if (meta.role === "second-opinion") {
      await service.deliverSecondOpinion(thread.id).catch(warn(`delivering the second opinion ${thread.id}`));
    }
    service.publish({ threadId: thread.id, kind: "finished", title: thread.title ?? "" });
  });

  bb.events.on("thread.failed", async ({ thread }) => {
    if (!ours(thread)) return;
    const meta = await store.read(thread.id);
    if (meta?.role === "second-opinion" && meta.primaryThreadId !== null) {
      await store
        .update(meta.primaryThreadId, (primary) =>
          primary.secondOpinion?.threadId === thread.id
            ? { secondOpinion: { threadId: thread.id, status: "failed", error: "The second reviewer's thread failed." } }
            : null,
        )
        .catch(warn("recording a failed second opinion"));
    }
    service.publish({ threadId: thread.id });
  });

  bb.events.on("thread.archived", async ({ thread }) => {
    if (!ours(thread)) return;
    const meta = await store.read(thread.id);
    if (meta?.preview && meta.preview.status !== "stopped") await service.stopPreview(thread.id).catch(warn(`stopping the preview of ${thread.id}`));
    service.publish({ threadId: thread.id });
  });

  for (const event of ["thread.unarchived", "thread.deleted"] as const) {
    bb.events.on(event, ({ thread }) => {
      if (ours(thread)) service.publish({ threadId: thread.id });
    });
  }

  bb.background.schedule("review-sweep", "*/10 * * * *", async () => {
    if ((await settings.get()).queuePolling) await service.sweep();
  });

  registerRpc(bb, service, store, learnings);
  registerCli(bb, { service, store, learnings, settings });
  registerAgentSurfaces(bb, service);
}
