export interface Ticket {
  key: string;
  summary: string | null;
  status: string | null;
  type: string | null;
  url: string | null;
  /** Description and acceptance-criteria text, flattened from Atlassian Document Format. */
  text: string | null;
}

export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string | undefined;
}

export function findTicketKey(pattern: string, ...texts: Array<string | null | undefined>): string | null {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return null;
  }
  for (const text of texts) {
    const match = text ? regex.exec(text) : null;
    if (match) return match[0];
  }
  return null;
}

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
}

const BLOCK_TYPES = new Set(["paragraph", "heading", "blockquote", "codeBlock", "rule", "panel"]);

export function adfToText(node: unknown): string {
  const parts: string[] = [];
  const walk = (current: AdfNode, depth: number) => {
    if (current.type === "text" && typeof current.text === "string") {
      parts.push(current.text);
      return;
    }
    if (current.type === "hardBreak") parts.push("\n");
    if (current.type === "listItem") parts.push(`\n${"  ".repeat(Math.max(0, depth - 1))}- `);
    if (current.type === "heading") parts.push(`\n${"#".repeat(Number(current.attrs?.level ?? 2))} `);
    if (current.type === "mention" || current.type === "inlineCard") parts.push(String(current.attrs?.text ?? current.attrs?.url ?? ""));
    for (const child of current.content ?? []) {
      walk(child, current.type === "bulletList" || current.type === "orderedList" ? depth + 1 : depth);
    }
    if (current.type !== undefined && BLOCK_TYPES.has(current.type)) parts.push("\n");
  };
  if (typeof node === "string") return node;
  if (node && typeof node === "object") walk(node as AdfNode, 0);
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Resolves null when Jira is not configured; throws on request failures so callers can report them. */
export async function fetchTicket(config: JiraConfig, key: string, signal?: AbortSignal): Promise<Ticket | null> {
  if (config.baseUrl.trim() === "" || config.email.trim() === "" || !config.apiToken) return null;
  const base = config.baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,issuetype,description`, {
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`,
    },
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return { key, summary: null, status: null, type: null, url: `${base}/browse/${key}`, text: null };
  if (!response.ok) throw new Error(`Jira returned ${response.status} for ${key}`);
  const body = (await response.json()) as { fields?: Record<string, unknown> };
  const fields = body.fields ?? {};
  const text = adfToText(fields.description);
  return {
    key,
    summary: stringField(fields.summary),
    status: stringField((fields.status as { name?: unknown } | undefined)?.name),
    type: stringField((fields.issuetype as { name?: unknown } | undefined)?.name),
    url: `${base}/browse/${key}`,
    text: text === "" ? null : text.slice(0, 12_000),
  };
}
