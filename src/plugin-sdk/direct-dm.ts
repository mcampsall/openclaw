import type { DispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.types.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  canonicalSurielExternalMessageId,
  canonicalSurielExternalTurnId,
  canonicalSurielSentAtFromTimestamp,
  queueCanonicalSurielThreadClearThenImport,
  queueCanonicalSurielThreadImport,
  queueCanonicalSurielThreadStatus,
  queueCanonicalSurielThreadStatusClear,
  resolveCanonicalSurielThreadBridge,
} from "./canonical-suriel-thread.js";
import { createInboundEnvelopeBuilder } from "./inbound-envelope.js";
import { recordInboundSessionAndDispatchReply } from "./inbound-reply-dispatch.js";
import type { OutboundReplyPayload } from "./reply-payload.js";
export {
  createPreCryptoDirectDmAuthorizer,
  resolveInboundDirectDmAccessWithRuntime,
  type AccessGroupMembershipResolver,
  type DirectDmCommandAuthorizationRuntime,
  type ResolvedInboundDirectDmAccess,
} from "./direct-dm-access.js";
export {
  createDirectDmPreCryptoGuardPolicy,
  type DirectDmPreCryptoGuardPolicy,
  type DirectDmPreCryptoGuardPolicyOverrides,
} from "./direct-dm-guard-policy.js";

type DirectDmRoutePeer = {
  kind: "direct";
  id: string;
};

type DirectDmRoute = {
  agentId: string;
  sessionKey: string;
  accountId?: string;
};

type DirectDmRuntime = {
  channel: {
    routing: {
      resolveAgentRoute: (params: {
        cfg: OpenClawConfig;
        channel: string;
        accountId: string;
        peer: DirectDmRoutePeer;
      }) => DirectDmRoute;
    };
    session: {
      resolveStorePath: typeof import("../config/sessions.js").resolveStorePath;
      readSessionUpdatedAt: (params: {
        storePath: string;
        sessionKey: string;
      }) => number | undefined;
      recordInboundSession: typeof import("../channels/session.js").recordInboundSession;
    };
    reply: {
      resolveEnvelopeFormatOptions: (
        cfg: OpenClawConfig,
      ) => ReturnType<typeof import("../auto-reply/envelope.js").resolveEnvelopeFormatOptions>;
      formatAgentEnvelope: typeof import("../auto-reply/envelope.js").formatAgentEnvelope;
      finalizeInboundContext: typeof import("../auto-reply/reply/inbound-context.js").finalizeInboundContext;
      dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
    };
  };
};

/** Route, envelope, record, and dispatch one direct-DM turn through the standard pipeline. */
export async function dispatchInboundDirectDmWithRuntime(params: {
  cfg: OpenClawConfig;
  runtime: DirectDmRuntime;
  channel: string;
  channelLabel: string;
  accountId: string;
  peer: DirectDmRoutePeer;
  senderId: string;
  senderAddress: string;
  recipientAddress: string;
  conversationLabel: string;
  rawBody: string;
  messageId: string;
  timestamp?: number;
  commandAuthorized?: boolean;
  bodyForAgent?: string;
  commandBody?: string;
  provider?: string;
  surface?: string;
  originatingChannel?: string;
  originatingTo?: string;
  extraContext?: Record<string, unknown>;
  deliver: (payload: OutboundReplyPayload) => Promise<void>;
  onRecordError: (err: unknown) => void;
  onDispatchError: (err: unknown, info: { kind: string }) => void;
}): Promise<{
  route: DirectDmRoute;
  storePath: string;
  ctxPayload: FinalizedMsgContext;
}> {
  const route = params.runtime.channel.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
  });
  const accountId = route.accountId ?? params.accountId;
  const canonicalBridge = resolveCanonicalSurielThreadBridge({
    cfg: params.cfg,
    agentId: route.agentId,
    channel: params.channel,
    accountId,
    chatType: "direct",
    senderId: params.senderId,
    peerId: params.peer.id,
  });
  const dispatchRoute = canonicalBridge
    ? { ...route, sessionKey: canonicalBridge.sessionKey }
    : route;
  const transport = params.channel === "discord" ? "discord" : "system";
  const canonicalTurnId = canonicalBridge
    ? canonicalSurielExternalTurnId({
        channel: params.channel,
        messageId: params.messageId,
      })
    : "";
  const buildEnvelope = createInboundEnvelopeBuilder({
    cfg: params.cfg,
    route: dispatchRoute,
    sessionStore: params.cfg.session?.store,
    resolveStorePath: params.runtime.channel.session.resolveStorePath,
    readSessionUpdatedAt: params.runtime.channel.session.readSessionUpdatedAt,
    resolveEnvelopeFormatOptions: params.runtime.channel.reply.resolveEnvelopeFormatOptions,
    formatAgentEnvelope: params.runtime.channel.reply.formatAgentEnvelope,
  });

  const { storePath, body } = buildEnvelope({
    channel: params.channelLabel,
    from: params.conversationLabel,
    body: params.rawBody,
    timestamp: params.timestamp,
  });
  queueCanonicalSurielThreadImport(canonicalBridge, {
    sender: "michael",
    body: params.rawBody,
    transport,
    externalMessageId: canonicalSurielExternalMessageId({
      channel: params.channel,
      messageId: params.messageId,
      side: "inbound",
    }),
    sentAt: canonicalSurielSentAtFromTimestamp(params.timestamp),
  });
  queueCanonicalSurielThreadStatus(canonicalBridge, {
    transport,
    externalTurnId: canonicalTurnId,
    phase: "thinking",
    sentAt: canonicalSurielSentAtFromTimestamp(params.timestamp),
  });

  const ctxPayload = params.runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: params.bodyForAgent ?? params.rawBody,
    RawBody: params.rawBody,
    CommandBody: params.commandBody ?? params.rawBody,
    From: params.senderAddress,
    To: params.recipientAddress,
    SessionKey: dispatchRoute.sessionKey,
    AccountId: accountId,
    ChatType: "direct",
    ConversationLabel: params.conversationLabel,
    SenderId: params.senderId,
    Provider: params.provider ?? params.channel,
    Surface: params.surface ?? params.channel,
    MessageSid: params.messageId,
    MessageSidFull: params.messageId,
    Timestamp: params.timestamp,
    CommandAuthorized: params.commandAuthorized,
    OriginatingChannel: params.originatingChannel ?? params.channel,
    OriginatingTo: params.originatingTo ?? params.recipientAddress,
    ...params.extraContext,
  });

  let finalDelivered = false;
  await recordInboundSessionAndDispatchReply({
    cfg: params.cfg,
    channel: params.channel,
    accountId,
    agentId: dispatchRoute.agentId,
    routeSessionKey: dispatchRoute.sessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: params.runtime.channel.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher:
      params.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    deliver: async (payload, info) => {
      await params.deliver(payload);
      const kind = info?.kind ?? "final";
      if (kind === "tool") {
        queueCanonicalSurielThreadStatus(canonicalBridge, {
          transport,
          externalTurnId: canonicalTurnId,
          phase: "tool",
        });
        return;
      }
      if (kind === "final") {
        finalDelivered = true;
      }
      if (kind === "final" && typeof payload.text === "string" && payload.text.trim()) {
        queueCanonicalSurielThreadClearThenImport(
          canonicalBridge,
          {
            transport,
            externalTurnId: canonicalTurnId,
          },
          {
            sender: "her",
            body: payload.text,
            transport,
            externalMessageId: canonicalSurielExternalMessageId({
              channel: params.channel,
              messageId: params.messageId,
              side: "reply",
              suffix: kind,
            }),
          },
        );
      } else if (kind === "final") {
        queueCanonicalSurielThreadStatusClear(canonicalBridge, {
          transport,
          externalTurnId: canonicalTurnId,
        });
      }
    },
    onRecordError: params.onRecordError,
    onDispatchError: (err, info) => {
      queueCanonicalSurielThreadStatus(canonicalBridge, {
        transport,
        externalTurnId: canonicalTurnId,
        phase: "error",
      });
      params.onDispatchError(err, info);
    },
  });
  if (!finalDelivered) {
    queueCanonicalSurielThreadStatusClear(canonicalBridge, {
      transport,
      externalTurnId: canonicalTurnId,
    });
  }

  return {
    route: dispatchRoute,
    storePath,
    ctxPayload,
  };
}
