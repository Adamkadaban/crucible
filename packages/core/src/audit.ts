// Audit log aggregation helpers. The guest agent writes JSONL events to
// its --audit-log path, and host-side commands append their own records.
// `aggregateAuditEvents` merges multiple JSONL files into a single
// ordered list so the artifact export can ship a unified audit trail.

import { readFile } from "node:fs/promises";

export type AuditEvent = {
  readonly time: string;
  readonly source: "host" | "guest" | "unknown";
  readonly requestId?: string;
  readonly client?: string;
  readonly method?: string;
  readonly path?: string;
  readonly action?: string;
  readonly detail?: string;
};

export type AggregateAuditOptions = {
  readonly guestLogs?: readonly string[];
  readonly hostLogs?: readonly string[];
};

/**
 * Read JSONL audit logs from disk and return them sorted by timestamp.
 * Missing files are tolerated so a partial host run still produces a
 * useful trace.
 */
export async function aggregateAuditEvents(
  options: AggregateAuditOptions,
): Promise<readonly AuditEvent[]> {
  const events: AuditEvent[] = [];
  for (const path of options.guestLogs ?? []) {
    events.push(...(await readJsonLines(path, "guest")));
  }
  for (const path of options.hostLogs ?? []) {
    events.push(...(await readJsonLines(path, "host")));
  }
  events.sort((a, b) => a.time.localeCompare(b.time));
  return events;
}

async function readJsonLines(path: string, source: AuditEvent["source"]): Promise<AuditEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: AuditEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<AuditEvent>;
      if (typeof parsed.time !== "string") continue;
      out.push({ ...parsed, source } as AuditEvent);
    } catch {
      // skip malformed lines, continue the aggregation.
    }
  }
  return out;
}
