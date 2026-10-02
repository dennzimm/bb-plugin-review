import type { ReactNode } from "react";
import type { FindingSeverity, FindingStatus, Verdict } from "../shared/findings.ts";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

export function Chip({ children, tone = "neutral", title }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "bad" | "info"; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
        tone === "neutral" && "bg-muted text-muted-foreground",
        tone === "good" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
        tone === "warn" && "bg-amber-500/15 text-amber-700 dark:text-amber-400",
        tone === "bad" && "bg-destructive/15 text-destructive",
        tone === "info" && "bg-sky-500/15 text-sky-700 dark:text-sky-400",
      )}
    >
      {children}
    </span>
  );
}

export function VerdictChip({ verdict }: { verdict: Verdict | null }) {
  if (verdict === null) return null;
  return <Chip tone={verdict === "No blocking issues" ? "good" : verdict === "Fix before merging" ? "warn" : "bad"}>{verdict}</Chip>;
}

export function SeverityChip({ severity }: { severity: FindingSeverity }) {
  const tone = severity === "Critical" || severity === "High" ? "bad" : severity === "Medium" ? "warn" : severity === "Low" ? "info" : "neutral";
  return <Chip tone={tone}>{severity}</Chip>;
}

const STATUS_LABELS: Record<FindingStatus, string> = {
  open: "Open",
  drafted: "Draft on MR",
  posted: "Posted",
  fixed: "Fixed",
  obsolete: "Obsolete",
  resolved: "Resolved",
  dismissed: "Dismissed",
  discarded: "Draft deleted",
};

export function StatusChip({ status }: { status: FindingStatus }) {
  const tone = status === "fixed" || status === "resolved" ? "good" : status === "drafted" || status === "posted" ? "info" : "neutral";
  return <Chip tone={tone}>{STATUS_LABELS[status]}</Chip>;
}

export function Spinner({ className }: { className?: string }) {
  return <Icon name="Loading" className={cn("size-3.5 animate-spin", className)} />;
}

export function Disclosure({ summary, children, defaultOpen = false }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="group">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <Icon name="ChevronRight" className="size-3.5 transition-transform group-open:rotate-90" />
        {summary}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

export const fieldClassName =
  "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";
