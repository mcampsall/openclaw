import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  createDirectDmPreCryptoGuardPolicy,
  createPreCryptoDirectDmAuthorizer,
  dispatchInboundDirectDmWithRuntime,
  resolveInboundDirectDmAccessWithRuntime,
} from "./direct-dm.js";

const baseCfg = {
  commands: { useAccessGroups: true },
} as unknown as OpenClawConfig;

function createDirectDmRuntime() {
  const recordInboundSession = vi.fn(async () => {});
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ dispatcherOptions }) => {
    await dispatcherOptions.deliver({ text: "reply text" });
  });
  return {
    recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher,
    runtime: {
      channel: {
        routing: {
          resolveAgentRoute: vi.fn(({ accountId, peer }) => ({
            agentId: "agent-main",
            accountId,
            sessionKey: `dm:${peer.id}`,
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/tmp/direct-dm-session-store"),
          readSessionUpdatedAt: vi.fn(() => 1234),
          recordInboundSession,
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn(() => ({ mode: "agent" })),
          formatAgentEnvelope: vi.fn(({ body }) => `env:${body}`),
          finalizeInboundContext: vi.fn((ctx) => ctx),
          dispatchReplyWithBufferedBlockDispatcher,
        },
      },
    } as never,
  };
}

describe("plugin-sdk/direct-dm", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("resolves inbound DM access and command auth through one helper", async () => {
    const result = await resolveInboundDirectDmAccessWithRuntime({
      cfg: baseCfg,
      channel: "nostr",
      accountId: "default",
      dmPolicy: "pairing",
      allowFrom: [],
      senderId: "paired-user",
      rawBody: "/status",
      isSenderAllowed: (senderId, allowFrom) => allowFrom.includes(senderId),
      readStoreAllowFrom: async () => ["paired-user"],
      runtime: {
        shouldComputeCommandAuthorized: () => true,
        resolveCommandAuthorizedFromAuthorizers: ({ authorizers }) =>
          authorizers.some((entry) => entry.configured && entry.allowed),
      },
      modeWhenAccessGroupsOff: "configured",
    });

    expect(result.access.decision).toBe("allow");
    expect(result.access.effectiveAllowFrom).toEqual(["paired-user"]);
    expect(result.senderAllowedForCommands).toBe(true);
    expect(result.commandAuthorized).toBe(true);
  });

  it("blocks open DMs unless the effective allowlist matches", async () => {
    const result = await resolveInboundDirectDmAccessWithRuntime({
      cfg: baseCfg,
      channel: "nostr",
      accountId: "default",
      dmPolicy: "open",
      allowFrom: [],
      senderId: "random-user",
      rawBody: "hello",
      isSenderAllowed: (senderId, allowFrom) => allowFrom.includes(senderId),
      readStoreAllowFrom: async () => ["random-user"],
      runtime: {
        shouldComputeCommandAuthorized: () => false,
        resolveCommandAuthorizedFromAuthorizers: () => true,
      },
    });

    expect(result.access.decision).toBe("block");
    expect(result.access.reason).toBe("dmPolicy=open (not allowlisted)");
    expect(result.access.effectiveAllowFrom).toStrictEqual([]);
    expect(result.commandAuthorized).toBeUndefined();
  });

  it("resolves generic message sender access groups for direct DMs", async () => {
    const result = await resolveInboundDirectDmAccessWithRuntime({
      cfg: {
        ...baseCfg,
        accessGroups: {
          owners: {
            type: "message.senders",
            members: {
              nostr: ["owner-pubkey"],
              telegram: ["12345"],
            },
          },
        },
      } as OpenClawConfig,
      channel: "nostr",
      accountId: "default",
      dmPolicy: "allowlist",
      allowFrom: ["accessGroup:owners"],
      senderId: "owner-pubkey",
      rawBody: "/status",
      isSenderAllowed: (senderId, allowFrom) => allowFrom.includes(senderId),
      runtime: {
        shouldComputeCommandAuthorized: () => true,
        resolveCommandAuthorizedFromAuthorizers: ({ authorizers }) =>
          authorizers.some((entry) => entry.configured && entry.allowed),
      },
    });

    expect(result.access.decision).toBe("allow");
    expect(result.access.effectiveAllowFrom).toEqual(["accessGroup:owners", "owner-pubkey"]);
    expect(result.commandAuthorized).toBe(true);
  });

  it("creates a pre-crypto authorizer that issues pairing and blocks unknown senders", async () => {
    const issuePairingChallenge = vi.fn(async () => {});
    const onBlocked = vi.fn();
    const authorizer = createPreCryptoDirectDmAuthorizer({
      resolveAccess: async (senderId) => ({
        access:
          senderId === "pair-me"
            ? {
                decision: "pairing" as const,
                reasonCode: "dm_policy_pairing_required",
                reason: "dmPolicy=pairing (not allowlisted)",
                effectiveAllowFrom: [],
              }
            : {
                decision: "block" as const,
                reasonCode: "dm_policy_disabled",
                reason: "dmPolicy=disabled",
                effectiveAllowFrom: [],
              },
      }),
      issuePairingChallenge,
      onBlocked,
    });

    await expect(
      Promise.all([
        authorizer({
          senderId: "pair-me",
          reply: async () => {},
        }),
        authorizer({
          senderId: "blocked",
          reply: async () => {},
        }),
      ]),
    ).resolves.toEqual(["pairing", "block"]);

    expect(issuePairingChallenge).toHaveBeenCalledTimes(1);
    expect(onBlocked).toHaveBeenCalledWith({
      senderId: "blocked",
      reason: "dmPolicy=disabled",
      reasonCode: "dm_policy_disabled",
    });
  });

  it("builds a shared pre-crypto guard policy with partial overrides", () => {
    const policy = createDirectDmPreCryptoGuardPolicy({
      maxFutureSkewSec: 30,
      rateLimit: {
        maxPerSenderPerWindow: 5,
      },
    });

    expect(policy.allowedKinds).toEqual([4]);
    expect(policy.maxFutureSkewSec).toBe(30);
    expect(policy.maxCiphertextBytes).toBe(16 * 1024);
    expect(policy.rateLimit.maxPerSenderPerWindow).toBe(5);
    expect(policy.rateLimit.maxGlobalPerWindow).toBe(200);
  });

  it("dispatches direct DMs through the standard route/session/reply pipeline", async () => {
    const { recordInboundSession, dispatchReplyWithBufferedBlockDispatcher, runtime } =
      createDirectDmRuntime();
    const deliver = vi.fn(async () => {});

    const result = await dispatchInboundDirectDmWithRuntime({
      cfg: {
        session: { store: { type: "jsonl" } },
      } as never,
      runtime,
      channel: "nostr",
      channelLabel: "Nostr",
      accountId: "default",
      peer: { kind: "direct", id: "sender-1" },
      senderId: "sender-1",
      senderAddress: "nostr:sender-1",
      recipientAddress: "nostr:bot-1",
      conversationLabel: "sender-1",
      rawBody: "hello world",
      messageId: "event-123",
      timestamp: 1_710_000_000_000,
      commandAuthorized: true,
      deliver,
      onRecordError: () => {},
      onDispatchError: () => {},
    });

    expect(result.route.agentId).toBe("agent-main");
    expect(result.route.accountId).toBe("default");
    expect(result.route.sessionKey).toBe("dm:sender-1");
    expect(result.storePath).toBe("/tmp/direct-dm-session-store");
    expect(result.ctxPayload.Body).toBe("env:hello world");
    expect(result.ctxPayload.BodyForAgent).toBe("hello world");
    expect(result.ctxPayload.From).toBe("nostr:sender-1");
    expect(result.ctxPayload.To).toBe("nostr:bot-1");
    expect(result.ctxPayload.SenderId).toBe("sender-1");
    expect(result.ctxPayload.MessageSid).toBe("event-123");
    expect(result.ctxPayload.CommandAuthorized).toBe(true);
    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith({ text: "reply text" });
  });

  it("canonicalizes Michael Discord DMs onto the Loom app session and imports both sides", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "openclaw-canonical-suriel-"));
    const loomConfigPath = join(tmp, "config.json");
    await writeFile(
      loomConfigPath,
      JSON.stringify({
        host: "127.0.0.1",
        port: 8787,
        injectToken: "loom-token",
        openclawAgent: "main",
        openclawSessionId: "her-app",
      }),
    );
    vi.stubEnv("OPENCLAW_SURIEL_CANONICAL_LOOM_CONFIG_PATH", loomConfigPath);
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const recordInboundSession = vi.fn(async () => {});
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "tool progress" }, { kind: "tool" });
      await dispatcherOptions.deliver({ text: "final reply" }, { kind: "final" });
    });
    const runtime = {
      channel: {
        routing: {
          resolveAgentRoute: vi.fn(({ accountId }) => ({
            agentId: "main",
            accountId,
            sessionKey: "agent:main:discord:default:direct:1478511895441833984",
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/tmp/direct-dm-session-store"),
          readSessionUpdatedAt: vi.fn(() => 1234),
          recordInboundSession,
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn(() => ({ mode: "agent" })),
          formatAgentEnvelope: vi.fn(({ body }) => `env:${body}`),
          finalizeInboundContext: vi.fn((ctx) => ctx),
          dispatchReplyWithBufferedBlockDispatcher,
        },
      },
    } as never;
    const deliver = vi.fn(async () => {});

    const result = await dispatchInboundDirectDmWithRuntime({
      cfg: {
        session: {
          store: { type: "jsonl" },
          identityLinks: {
            "1478511895441833984": ["discord:214258906367655936"],
          },
        },
        channels: {
          discord: {
            allowFrom: ["214258906367655936"],
          },
        },
      } as never,
      runtime,
      channel: "discord",
      channelLabel: "Discord",
      accountId: "default",
      peer: { kind: "direct", id: "1478511895441833984" },
      senderId: "214258906367655936",
      senderAddress: "discord:214258906367655936",
      recipientAddress: "discord:suriel",
      conversationLabel: "Michael",
      rawBody: "hello from discord",
      messageId: "discord-message-1",
      timestamp: 1_710_000_000_000,
      commandAuthorized: true,
      deliver,
      onRecordError: () => {},
      onDispatchError: () => {},
    });

    expect(result.route.sessionKey).toBe("agent:main:explicit:her-app");
    expect(result.ctxPayload.SessionKey).toBe("agent:main:explicit:her-app");
    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    expect(recordInboundSession.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: "agent:main:explicit:her-app",
    });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(bodies).toEqual([
      expect.objectContaining({
        conversationId: "michael:suriel-pa-main",
        sender: "michael",
        transport: "discord",
        externalMessageId: "discord:discord-message-1:inbound",
        body: "hello from discord",
      }),
      expect.objectContaining({
        conversationId: "michael:suriel-pa-main",
        sender: "her",
        transport: "discord",
        externalMessageId: "discord:discord-message-1:reply:final",
        body: "final reply",
      }),
    ]);
    expect(bodies.some((body) => body.body === "tool progress")).toBe(false);
  });

  it("does not block Discord delivery when canonical Loom import is unavailable", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "openclaw-canonical-suriel-fail-"));
    const loomConfigPath = join(tmp, "config.json");
    await writeFile(
      loomConfigPath,
      JSON.stringify({
        host: "127.0.0.1",
        port: 8787,
        injectToken: "loom-token",
        openclawAgent: "main",
        openclawSessionId: "her-app",
      }),
    );
    vi.stubEnv("OPENCLAW_SURIEL_CANONICAL_LOOM_CONFIG_PATH", loomConfigPath);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("loom offline");
      }),
    );

    const { recordInboundSession, dispatchReplyWithBufferedBlockDispatcher, runtime } =
      createDirectDmRuntime();
    runtime.channel.routing.resolveAgentRoute = vi.fn(({ accountId }) => ({
      agentId: "main",
      accountId,
      sessionKey: "agent:main:discord:default:direct:1478511895441833984",
    })) as never;
    const deliver = vi.fn(async () => {});

    await expect(
      dispatchInboundDirectDmWithRuntime({
        cfg: {
          session: { store: { type: "jsonl" } },
          channels: {
            discord: {
              allowFrom: ["214258906367655936"],
            },
          },
        } as never,
        runtime,
        channel: "discord",
        channelLabel: "Discord",
        accountId: "default",
        peer: { kind: "direct", id: "1478511895441833984" },
        senderId: "214258906367655936",
        senderAddress: "discord:214258906367655936",
        recipientAddress: "discord:suriel",
        conversationLabel: "Michael",
        rawBody: "hello while app is down",
        messageId: "discord-message-2",
        commandAuthorized: true,
        deliver,
        onRecordError: () => {},
        onDispatchError: () => {},
      }),
    ).resolves.toMatchObject({
      route: { sessionKey: "agent:main:explicit:her-app" },
    });

    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith({ text: "reply text" });
  });
});
