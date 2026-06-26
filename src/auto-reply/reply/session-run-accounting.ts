import fs from "node:fs/promises";
import path from "node:path";
import { deriveSessionTotalTokens, type NormalizedUsage } from "../../agents/usage.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { incrementCompactionCount } from "./session-updates.js";
import { persistSessionUsageUpdate } from "./session-usage.js";

type PersistRunSessionUsageParams = Parameters<typeof persistSessionUsageUpdate>[0];

type IncrementRunCompactionCountParams = Omit<
  Parameters<typeof incrementCompactionCount>[0],
  "tokensAfter"
> & {
  amount?: number;
  cfg?: OpenClawConfig;
  compactionTokensAfter?: number;
  lastCallUsage?: NormalizedUsage;
  contextTokensUsed?: number;
  newSessionId?: string;
  newSessionFile?: string;
};

function resolvePositiveTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export async function persistRunSessionUsage(params: PersistRunSessionUsageParams): Promise<void> {
  await persistSessionUsageUpdate(params);
}

export async function incrementRunCompactionCount(
  params: IncrementRunCompactionCountParams,
): Promise<number | undefined> {
  const tokensAfterCompaction =
    resolvePositiveTokenCount(params.compactionTokensAfter) ??
    (params.lastCallUsage
      ? deriveSessionTotalTokens({
          usage: params.lastCallUsage,
          contextTokens: params.contextTokensUsed,
        })
      : undefined);
  const fallbackRotation = await resolveLatestSuccessorRotationIfNeeded({
    cfg: params.cfg,
    sessionEntry: params.sessionEntry,
    newSessionId: params.newSessionId,
    newSessionFile: params.newSessionFile,
  });
  return incrementCompactionCount({
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    cfg: params.cfg,
    amount: params.amount,
    tokensAfter: tokensAfterCompaction,
    newSessionId: params.newSessionId ?? fallbackRotation?.sessionId,
    newSessionFile: params.newSessionFile ?? fallbackRotation?.sessionFile,
  });
}

async function resolveLatestSuccessorRotationIfNeeded(params: {
  cfg?: OpenClawConfig;
  sessionEntry?: SessionEntry;
  newSessionId?: string;
  newSessionFile?: string;
}): Promise<{ sessionId?: string; sessionFile: string } | undefined> {
  if (params.cfg?.agents?.defaults?.compaction?.truncateAfterCompaction !== true) {
    return undefined;
  }
  const currentSessionFile = params.sessionEntry?.sessionFile?.trim();
  if (!currentSessionFile) {
    return undefined;
  }
  const explicitNewSessionFile = params.newSessionFile?.trim();
  if (explicitNewSessionFile && path.resolve(explicitNewSessionFile) !== path.resolve(currentSessionFile)) {
    return undefined;
  }
  if (params.newSessionId && params.newSessionId !== params.sessionEntry?.sessionId) {
    return undefined;
  }

  const currentResolved = path.resolve(currentSessionFile);
  const dir = path.dirname(currentResolved);
  let entries: Array<{
    name: string;
    isFile: () => boolean;
  }>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  let latest:
    | {
        sessionFile: string;
        sessionId?: string;
        mtimeMs: number;
      }
    | undefined;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const candidate = path.join(dir, entry.name);
    if (path.resolve(candidate) === currentResolved) {
      continue;
    }
    const header = await readSessionHeader(candidate);
    if (!header || path.resolve(header.parentSession) !== currentResolved) {
      continue;
    }
    const stat = await fs.stat(candidate).catch(() => undefined);
    if (!stat) {
      continue;
    }
    if (!latest || stat.mtimeMs > latest.mtimeMs) {
      latest = {
        sessionFile: candidate,
        sessionId: header.sessionId,
        mtimeMs: stat.mtimeMs,
      };
    }
  }
  return latest ? { sessionId: latest.sessionId, sessionFile: latest.sessionFile } : undefined;
}

async function readSessionHeader(
  sessionFile: string,
): Promise<{ sessionId?: string; parentSession: string } | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(sessionFile, "r");
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) {
      return undefined;
    }
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0]?.trim();
    if (!firstLine) {
      return undefined;
    }
    const parsed = JSON.parse(firstLine) as {
      type?: unknown;
      id?: unknown;
      parentSession?: unknown;
    };
    if (parsed.type !== "session" || typeof parsed.parentSession !== "string") {
      return undefined;
    }
    return {
      parentSession: parsed.parentSession,
      ...(typeof parsed.id === "string" && parsed.id.trim()
        ? { sessionId: parsed.id.trim() }
        : {}),
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
