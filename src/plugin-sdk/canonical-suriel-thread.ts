import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

const PUBLIC_CONVERSATION_ID = "michael:suriel-pa-main";
const log = createSubsystemLogger("canonical-suriel-thread");
const DEFAULT_LOOM_CONFIG_PATH = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "her-app",
  "config.json",
);

type CanonicalSurielTransport = "discord" | "voice" | "system";
type CanonicalSurielTurnStatusPhase =
  | "queued"
  | "thinking"
  | "tool"
  | "coding"
  | "web"
  | "deploy"
  | "build"
  | "concierge"
  | "done"
  | "error"
  | "stallSoft"
  | "stallHard"
  | "compacting";

type LoomConfig = {
  baseUrl: string;
  injectToken: string;
  openclawAgent: string;
  openclawSessionId: string;
};

export type CanonicalSurielThreadBridge = {
  sessionKey: string;
  importMessage: (input: {
    sender: "michael" | "her" | "system";
    body: string;
    transport: CanonicalSurielTransport;
    externalMessageId: string;
    sentAt?: string;
  }) => Promise<void>;
  updateTurnStatus: (input: {
    transport: CanonicalSurielTransport;
    externalTurnId: string;
    phase: CanonicalSurielTurnStatusPhase;
    tool?: string;
    sentAt?: string;
  }) => Promise<void>;
  clearTurnStatus: (input: {
    transport: CanonicalSurielTransport;
    externalTurnId: string;
  }) => Promise<void>;
};

type ResolveCanonicalSurielThreadBridgeParams = {
  cfg: OpenClawConfig;
  agentId: string;
  channel: string;
  accountId?: string;
  chatType: "direct" | "group" | "channel";
  senderId: string;
  peerId: string;
};

function resolveLoomConfigPath(): string {
  return (
    normalizeOptionalString(process.env.OPENCLAW_SURIEL_CANONICAL_LOOM_CONFIG_PATH) ??
    normalizeOptionalString(process.env.HER_APP_CONFIG_PATH) ??
    DEFAULT_LOOM_CONFIG_PATH
  );
}

function readLoomConfig(): LoomConfig | null {
  const explicitUrl =
    normalizeOptionalString(process.env.OPENCLAW_SURIEL_CANONICAL_LOOM_URL) ??
    normalizeOptionalString(process.env.HER_APP_CANONICAL_IMPORT_URL);
  const explicitToken =
    normalizeOptionalString(process.env.OPENCLAW_SURIEL_CANONICAL_LOOM_TOKEN) ??
    normalizeOptionalString(process.env.HER_APP_ADMIN_TOKEN) ??
    normalizeOptionalString(process.env.HER_APP_INJECT_TOKEN);
  const configPath = resolveLoomConfigPath();

  let parsed: Record<string, unknown> = {};
  try {
    if (fs.existsSync(configPath)) {
      parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  const host = normalizeOptionalString(parsed.host) ?? "127.0.0.1";
  const port =
    typeof parsed.port === "number" && Number.isFinite(parsed.port) && parsed.port > 0
      ? parsed.port
      : 8787;
  const baseUrl = explicitUrl ?? `http://${host}:${port}`;
  const injectToken = explicitToken ?? normalizeOptionalString(parsed.injectToken);
  const openclawAgent = normalizeOptionalString(parsed.openclawAgent) ?? "main";
  const openclawSessionId = normalizeOptionalString(parsed.openclawSessionId);
  if (!baseUrl || !injectToken || !openclawSessionId) {
    return null;
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    injectToken,
    openclawAgent,
    openclawSessionId,
  };
}

function normalizeIdentity(value: unknown): string | null {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  return normalized || null;
}

function collectAllowedDirectIdentities(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
}): Set<string> {
  const channel = normalizeLowercaseStringOrEmpty(params.channel);
  const identities = new Set<string>();
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) {
      return;
    }
    for (const entry of value) {
      const normalized = normalizeIdentity(entry);
      if (!normalized || normalized === "*") {
        continue;
      }
      identities.add(normalized);
      if (!normalized.includes(":")) {
        identities.add(`${channel}:${normalized}`);
      }
    }
  };

  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const channelConfig = channels?.[params.channel] as Record<string, unknown> | undefined;
  collect(channelConfig?.allowFrom);

  const accounts = channelConfig?.accounts as Record<string, unknown> | undefined;
  const accountConfig = params.accountId
    ? (accounts?.[params.accountId] as Record<string, unknown> | undefined)
    : undefined;
  collect(accountConfig?.allowFrom);

  const identityLinks = params.cfg.session?.identityLinks;
  if (identityLinks && typeof identityLinks === "object") {
    for (const [canonical, aliases] of Object.entries(identityLinks)) {
      const canonicalId = normalizeIdentity(canonical);
      if (canonicalId) {
        identities.add(canonicalId);
      }
      if (!Array.isArray(aliases)) {
        continue;
      }
      for (const alias of aliases) {
        const normalized = normalizeIdentity(alias);
        if (normalized) {
          identities.add(normalized);
        }
      }
    }
  }

  return identities;
}

function isMichaelAllowedDirectSurface(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  senderId: string;
  peerId: string;
}): boolean {
  const channel = normalizeLowercaseStringOrEmpty(params.channel);
  if (!channel || channel === "telegram") {
    return false;
  }
  const allowed = collectAllowedDirectIdentities(params);
  const sender = normalizeIdentity(params.senderId);
  const peer = normalizeIdentity(params.peerId);
  const candidates = [
    sender,
    sender ? `${channel}:${sender}` : null,
    peer,
    peer ? `${channel}:${peer}` : null,
  ].filter(Boolean) as string[];
  return candidates.some((candidate) => allowed.has(candidate));
}

function isCanonicalSurielThreadDisabled(): boolean {
  const value = normalizeLowercaseStringOrEmpty(process.env.OPENCLAW_SURIEL_CANONICAL_THREAD);
  return value === "0" || value === "false" || value === "off" || value === "disabled";
}

function buildExplicitSessionKey(agentId: string, sessionId: string): string {
  return `agent:${normalizeAgentId(agentId)}:explicit:${sessionId.trim()}`;
}

function toIsoSentAt(timestamp: number | undefined): string | undefined {
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  const date = new Date(timestamp as number);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function resolveCanonicalSurielThreadBridge(
  params: ResolveCanonicalSurielThreadBridgeParams,
): CanonicalSurielThreadBridge | null {
  if (isCanonicalSurielThreadDisabled() || params.chatType !== "direct") {
    return null;
  }
  const loom = readLoomConfig();
  if (!loom) {
    return null;
  }
  if (normalizeAgentId(params.agentId) !== normalizeAgentId(loom.openclawAgent)) {
    return null;
  }
  if (
    !isMichaelAllowedDirectSurface({
      cfg: params.cfg,
      channel: params.channel,
      accountId: params.accountId,
      senderId: params.senderId,
      peerId: params.peerId,
    })
  ) {
    return null;
  }
  return {
    sessionKey: buildExplicitSessionKey(params.agentId, loom.openclawSessionId),
    importMessage: async (input) => {
      const body = input.body.trim();
      if (!body || !input.externalMessageId.trim()) {
        return;
      }
      const response = await fetch(`${loom.baseUrl}/api/admin/conversation/import`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${loom.injectToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          conversationId: PUBLIC_CONVERSATION_ID,
          sender: input.sender,
          body,
          transport: input.transport,
          externalMessageId: input.externalMessageId,
          ...(input.sentAt ? { sentAt: input.sentAt } : {}),
        }),
      });
      if (!response.ok) {
        throw new Error(`canonical_suriel_import_failed:${response.status}`);
      }
    },
    updateTurnStatus: async (input) => {
      if (!input.externalTurnId.trim()) {
        return;
      }
      const response = await fetch(`${loom.baseUrl}/api/admin/conversation/turn-status`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${loom.injectToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          conversationId: PUBLIC_CONVERSATION_ID,
          action: "update",
          transport: input.transport,
          externalTurnId: input.externalTurnId,
          phase: input.phase,
          ...(input.tool?.trim() ? { tool: input.tool.trim() } : {}),
          ...(input.sentAt ? { sentAt: input.sentAt } : {}),
        }),
      });
      if (!response.ok) {
        throw new Error(`canonical_suriel_turn_status_failed:${response.status}`);
      }
    },
    clearTurnStatus: async (input) => {
      if (!input.externalTurnId.trim()) {
        return;
      }
      const response = await fetch(`${loom.baseUrl}/api/admin/conversation/turn-status`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${loom.injectToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          conversationId: PUBLIC_CONVERSATION_ID,
          action: "clear",
          transport: input.transport,
          externalTurnId: input.externalTurnId,
        }),
      });
      if (!response.ok) {
        throw new Error(`canonical_suriel_turn_status_clear_failed:${response.status}`);
      }
    },
  };
}

export function queueCanonicalSurielThreadImport(
  bridge: CanonicalSurielThreadBridge | null,
  input: Parameters<CanonicalSurielThreadBridge["importMessage"]>[0],
): void {
  if (!bridge) {
    return;
  }
  void bridge.importMessage(input).catch((error) => {
    log.warn("canonical conversation import failed", {
      conversationId: PUBLIC_CONVERSATION_ID,
      sender: input.sender,
      transport: input.transport,
      externalMessageId: input.externalMessageId,
      error: formatErrorMessage(error),
    });
  });
}

export function queueCanonicalSurielThreadStatus(
  bridge: CanonicalSurielThreadBridge | null,
  input: Parameters<CanonicalSurielThreadBridge["updateTurnStatus"]>[0],
): void {
  if (!bridge) {
    return;
  }
  void bridge.updateTurnStatus(input).catch((error) => {
    log.warn("canonical conversation status update failed", {
      conversationId: PUBLIC_CONVERSATION_ID,
      transport: input.transport,
      externalTurnId: input.externalTurnId,
      phase: input.phase,
      error: formatErrorMessage(error),
    });
  });
}

export function queueCanonicalSurielThreadStatusClear(
  bridge: CanonicalSurielThreadBridge | null,
  input: Parameters<CanonicalSurielThreadBridge["clearTurnStatus"]>[0],
): void {
  if (!bridge) {
    return;
  }
  void bridge.clearTurnStatus(input).catch((error) => {
    log.warn("canonical conversation status clear failed", {
      conversationId: PUBLIC_CONVERSATION_ID,
      transport: input.transport,
      externalTurnId: input.externalTurnId,
      error: formatErrorMessage(error),
    });
  });
}

export function queueCanonicalSurielThreadClearThenImport(
  bridge: CanonicalSurielThreadBridge | null,
  clearInput: Parameters<CanonicalSurielThreadBridge["clearTurnStatus"]>[0],
  importInput: Parameters<CanonicalSurielThreadBridge["importMessage"]>[0],
): void {
  if (!bridge) {
    return;
  }
  void (async () => {
    try {
      await bridge.clearTurnStatus(clearInput);
    } catch (error) {
      log.warn("canonical conversation status clear failed", {
        conversationId: PUBLIC_CONVERSATION_ID,
        transport: clearInput.transport,
        externalTurnId: clearInput.externalTurnId,
        error: formatErrorMessage(error),
      });
    }
    try {
      await bridge.importMessage(importInput);
    } catch (error) {
      log.warn("canonical conversation import failed", {
        conversationId: PUBLIC_CONVERSATION_ID,
        sender: importInput.sender,
        transport: importInput.transport,
        externalMessageId: importInput.externalMessageId,
        error: formatErrorMessage(error),
      });
    }
  })();
}

export function canonicalSurielExternalMessageId(params: {
  channel: string;
  messageId: string;
  side: "inbound" | "reply";
  suffix?: string;
}): string {
  return [
    normalizeLowercaseStringOrEmpty(params.channel) || "unknown",
    params.messageId.trim(),
    params.side,
    params.suffix?.trim(),
  ]
    .filter(Boolean)
    .join(":")
    .slice(0, 200);
}

export function canonicalSurielExternalTurnId(params: {
  channel: string;
  messageId: string;
}): string {
  return [normalizeLowercaseStringOrEmpty(params.channel) || "unknown", params.messageId.trim()]
    .filter(Boolean)
    .join(":")
    .slice(0, 180);
}

export { toIsoSentAt as canonicalSurielSentAtFromTimestamp };
