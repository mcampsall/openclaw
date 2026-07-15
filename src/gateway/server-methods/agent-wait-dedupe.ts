import { isNonTerminalAgentRunStatus } from "../../shared/agent-run-status.js";
import { setSafeTimeout } from "../../utils/timer-delay.js";
import type { DedupeEntry } from "../server-shared.js";

export type AgentWaitTerminalSnapshot = {
  status: "ok" | "error" | "timeout";
  startedAt?: number;
  endedAt?: number;
  error?: string;
  stopReason?: string;
  livenessState?: string;
  yielded?: boolean;
  result?: { text: string };
};

const AGENT_WAITERS_BY_RUN_ID = new Map<string, Set<() => void>>();
const AGENT_WAIT_RESULTS_BY_RUN_ID = new Map<string, { text: string; storedAt: number }>();
const AGENT_WAIT_RESULT_TTL_MS = 60 * 60 * 1_000;
const AGENT_WAIT_RESULT_LIMIT = 512;

function attachRunResult(
  runId: string,
  snapshot: AgentWaitTerminalSnapshot | null,
): AgentWaitTerminalSnapshot | null {
  if (!snapshot || snapshot.result) {
    return snapshot;
  }
  const stored = AGENT_WAIT_RESULTS_BY_RUN_ID.get(runId);
  if (!stored) {
    return snapshot;
  }
  if (Date.now() - stored.storedAt > AGENT_WAIT_RESULT_TTL_MS) {
    AGENT_WAIT_RESULTS_BY_RUN_ID.delete(runId);
    return snapshot;
  }
  return { ...snapshot, result: { text: stored.text } };
}

export function setAgentWaitRunResult(runId: string, text: string): void {
  const normalizedRunId = runId.trim();
  const normalizedText = text.trim();
  if (!normalizedRunId || !normalizedText) {
    return;
  }
  AGENT_WAIT_RESULTS_BY_RUN_ID.delete(normalizedRunId);
  AGENT_WAIT_RESULTS_BY_RUN_ID.set(normalizedRunId, {
    text: normalizedText,
    storedAt: Date.now(),
  });
  while (AGENT_WAIT_RESULTS_BY_RUN_ID.size > AGENT_WAIT_RESULT_LIMIT) {
    const oldest = AGENT_WAIT_RESULTS_BY_RUN_ID.keys().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    AGENT_WAIT_RESULTS_BY_RUN_ID.delete(oldest);
  }
  notifyWaiters(normalizedRunId);
}

function parseRunIdFromDedupeKey(key: string): string | null {
  if (key.startsWith("agent:")) {
    return key.slice("agent:".length) || null;
  }
  if (key.startsWith("chat:")) {
    return key.slice("chat:".length) || null;
  }
  return null;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function removeWaiter(runId: string, waiter: () => void): void {
  const waiters = AGENT_WAITERS_BY_RUN_ID.get(runId);
  if (!waiters) {
    return;
  }
  waiters.delete(waiter);
  if (waiters.size === 0) {
    AGENT_WAITERS_BY_RUN_ID.delete(runId);
  }
}

function addWaiter(runId: string, waiter: () => void): () => void {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    return () => {};
  }
  const existing = AGENT_WAITERS_BY_RUN_ID.get(normalizedRunId);
  if (existing) {
    existing.add(waiter);
    return () => removeWaiter(normalizedRunId, waiter);
  }
  AGENT_WAITERS_BY_RUN_ID.set(normalizedRunId, new Set([waiter]));
  return () => removeWaiter(normalizedRunId, waiter);
}

function notifyWaiters(runId: string): void {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    return;
  }
  const waiters = AGENT_WAITERS_BY_RUN_ID.get(normalizedRunId);
  if (!waiters || waiters.size === 0) {
    return;
  }
  for (const waiter of waiters) {
    waiter();
  }
}

function readTerminalSnapshotFromDedupeEntry(entry: DedupeEntry): AgentWaitTerminalSnapshot | null {
  const payload = entry.payload as
    | {
        status?: unknown;
        startedAt?: unknown;
        endedAt?: unknown;
        error?: unknown;
        summary?: unknown;
        stopReason?: unknown;
        livenessState?: unknown;
        yielded?: unknown;
        result?: unknown;
      }
    | undefined;
  const status = typeof payload?.status === "string" ? payload.status : undefined;
  if (isNonTerminalAgentRunStatus(status)) {
    return null;
  }

  const startedAt = asFiniteNumber(payload?.startedAt);
  const endedAt = asFiniteNumber(payload?.endedAt) ?? entry.ts;
  const resultMeta = asRecord(asRecord(payload?.result)?.meta);
  const resultText = asString(asRecord(payload?.result)?.text);
  const stopReason = asString(payload?.stopReason) ?? asString(resultMeta?.stopReason);
  const livenessState = asString(payload?.livenessState) ?? asString(resultMeta?.livenessState);
  const yielded = payload?.yielded === true || resultMeta?.yielded === true;
  const errorMessage =
    typeof payload?.error === "string"
      ? payload.error
      : typeof payload?.summary === "string"
        ? payload.summary
        : entry.error?.message;

  if (status === "ok" || status === "timeout") {
    return {
      status,
      startedAt,
      endedAt,
      error: status === "timeout" ? errorMessage : undefined,
      stopReason,
      livenessState,
      ...(yielded ? { yielded } : {}),
      ...(resultText ? { result: { text: resultText } } : {}),
    };
  }
  if (status === "error" || !entry.ok) {
    return {
      status: "error",
      startedAt,
      endedAt,
      error: errorMessage,
      stopReason,
      livenessState,
      ...(yielded ? { yielded } : {}),
      ...(resultText ? { result: { text: resultText } } : {}),
    };
  }
  return null;
}

export function readTerminalSnapshotFromGatewayDedupe(params: {
  dedupe: Map<string, DedupeEntry>;
  runId: string;
  ignoreAgentTerminalSnapshot?: boolean;
}): AgentWaitTerminalSnapshot | null {
  if (params.ignoreAgentTerminalSnapshot) {
    const chatEntry = params.dedupe.get(`chat:${params.runId}`);
    if (!chatEntry) {
      return null;
    }
    return attachRunResult(params.runId, readTerminalSnapshotFromDedupeEntry(chatEntry));
  }

  const chatEntry = params.dedupe.get(`chat:${params.runId}`);
  const chatSnapshot = chatEntry ? readTerminalSnapshotFromDedupeEntry(chatEntry) : null;

  const agentEntry = params.dedupe.get(`agent:${params.runId}`);
  const agentSnapshot = agentEntry ? readTerminalSnapshotFromDedupeEntry(agentEntry) : null;
  if (agentEntry) {
    if (!agentSnapshot) {
      // If agent is still in-flight, only trust chat if it was written after
      // this agent entry (indicating a newer completed chat run reused runId).
      if (chatSnapshot && chatEntry && chatEntry.ts > agentEntry.ts) {
        return attachRunResult(params.runId, chatSnapshot);
      }
      return null;
    }
  }

  if (agentSnapshot && chatSnapshot && agentEntry && chatEntry) {
    // Reused idempotency keys can leave both records present. Prefer the
    // freshest terminal snapshot so callers observe the latest run outcome.
    return attachRunResult(
      params.runId,
      chatEntry.ts > agentEntry.ts ? chatSnapshot : agentSnapshot,
    );
  }

  return attachRunResult(params.runId, agentSnapshot ?? chatSnapshot);
}

export async function waitForTerminalGatewayDedupe(params: {
  dedupe: Map<string, DedupeEntry>;
  runId: string;
  timeoutMs: number;
  signal?: AbortSignal;
  ignoreAgentTerminalSnapshot?: boolean;
}): Promise<AgentWaitTerminalSnapshot | null> {
  const initial = readTerminalSnapshotFromGatewayDedupe(params);
  if (initial) {
    return initial;
  }
  if (params.signal?.aborted) {
    return null;
  }

  return await new Promise((resolve) => {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    let removeWaiter: (() => void) | undefined;

    const finish = (snapshot: AgentWaitTerminalSnapshot | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (onAbort) {
        params.signal?.removeEventListener("abort", onAbort);
      }
      removeWaiter?.();
      resolve(snapshot);
    };

    const onWake = () => {
      const snapshot = readTerminalSnapshotFromGatewayDedupe(params);
      if (snapshot) {
        finish(snapshot);
      }
    };

    removeWaiter = addWaiter(params.runId, onWake);
    onWake();
    if (settled) {
      return;
    }

    if (params.timeoutMs > 0) {
      timeoutHandle = setSafeTimeout(() => finish(null), params.timeoutMs);
      timeoutHandle.unref?.();
    }

    onAbort = () => finish(null);
    params.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function setGatewayDedupeEntry(params: {
  dedupe: Map<string, DedupeEntry>;
  key: string;
  entry: DedupeEntry;
}) {
  const existing = params.dedupe.get(params.key);
  const existingSnapshot = existing ? readTerminalSnapshotFromDedupeEntry(existing) : null;
  const incomingSnapshot = readTerminalSnapshotFromDedupeEntry(params.entry);
  if (existingSnapshot?.status === "timeout" && existingSnapshot.stopReason === "rpc") {
    return;
  }
  params.dedupe.set(params.key, params.entry);
  const runId = parseRunIdFromDedupeKey(params.key);
  if (!runId) {
    return;
  }
  if (!incomingSnapshot) {
    return;
  }
  notifyWaiters(runId);
}

export const __testing = {
  clearRunResults(): void {
    AGENT_WAIT_RESULTS_BY_RUN_ID.clear();
  },
  getWaiterCount(runId?: string): number {
    if (runId) {
      return AGENT_WAITERS_BY_RUN_ID.get(runId)?.size ?? 0;
    }
    let total = 0;
    for (const waiters of AGENT_WAITERS_BY_RUN_ID.values()) {
      total += waiters.size;
    }
    return total;
  },
  resetWaiters() {
    AGENT_WAITERS_BY_RUN_ID.clear();
  },
};
