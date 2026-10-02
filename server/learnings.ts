import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const learningSchema = z.object({
  id: z.string(),
  /** null applies to every project. */
  projectId: z.string().nullable(),
  text: z.string().min(1).max(1000),
  createdAt: z.number(),
  origin: z.object({ threadId: z.string(), findingId: z.string(), title: z.string() }).nullable(),
});
export type Learning = z.infer<typeof learningSchema>;

const KEY = "learnings";
const MAX_LEARNINGS = 100;
/** Learnings enter every brief; keep them from crowding out the review itself. */
const BRIEF_BUDGET = 4000;

export function learningsStore(bb: BbPluginApi) {
  async function all(): Promise<Learning[]> {
    const parsed = z.array(learningSchema).safeParse(await bb.storage.kv.get(KEY));
    return parsed.success ? parsed.data : [];
  }

  async function add(entry: Omit<Learning, "id" | "createdAt">): Promise<Learning> {
    const learning: Learning = { ...entry, id: randomUUID().slice(0, 8), createdAt: Date.now() };
    const next = [learning, ...(await all())].slice(0, MAX_LEARNINGS);
    await bb.storage.kv.set(KEY, next);
    return learning;
  }

  async function remove(id: string): Promise<boolean> {
    const current = await all();
    const next = current.filter((learning) => learning.id !== id);
    if (next.length === current.length) return false;
    await bb.storage.kv.set(KEY, next);
    return true;
  }

  async function forBrief(projectId: string): Promise<string[]> {
    const relevant = (await all()).filter((learning) => learning.projectId === null || learning.projectId === projectId);
    const lines: string[] = [];
    let used = 0;
    for (const learning of relevant) {
      used += learning.text.length;
      if (used > BRIEF_BUDGET) break;
      lines.push(learning.text);
    }
    return lines;
  }

  return { all, add, remove, forBrief };
}
export type LearningsStore = ReturnType<typeof learningsStore>;
