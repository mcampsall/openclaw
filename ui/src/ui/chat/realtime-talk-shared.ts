import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../../../../src/talk/agent-consult-tool.js";
import type { TalkEvent } from "../../../../src/talk/talk-events.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway.ts";

export type RealtimeTalkStatus = "idle" | "connecting" | "listening" | "thinking" | "error";
export type RealtimeTalkEvent = TalkEvent;

export type RealtimeTalkCallbacks = {
  onStatus?: (status: RealtimeTalkStatus, detail?: string) => void;
  onTranscript?: (entry: { role: "user" | "assistant"; text: string; final: boolean }) => void;
  onTalkEvent?: (event: RealtimeTalkEvent) => void;
};

export type RealtimeTalkEventInput<TPayload = unknown> = {
  type: RealtimeTalkEvent["type"];
  payload?: TPayload;
  turnId?: string;
  captureId?: string;
  final?: boolean;
  callId?: string;
  itemId?: string;
  parentId?: string;
};

export type RealtimeTalkAudioContract = {
  inputEncoding: "pcm16" | "g711_ulaw";
  inputSampleRateHz: number;
  outputEncoding: "pcm16" | "g711_ulaw";
  outputSampleRateHz: number;
};

export type RealtimeTalkWebRtcSdpSessionResult = {
  provider: string;
  transport: "webrtc";
  clientSecret: string;
  offerUrl?: string;
  offerHeaders?: Record<string, string>;
  model?: string;
  voice?: string;
  expiresAt?: number;
  consultThinkingLevel?: string;
  consultFastMode?: boolean;
  consultRouting?: "provider-direct" | "force-agent-consult";
};

export type RealtimeTalkJsonPcmWebSocketSessionResult = {
  provider: string;
  transport: "provider-websocket";
  protocol: string;
  clientSecret: string;
  websocketUrl: string;
  audio: RealtimeTalkAudioContract;
  initialMessage?: unknown;
  model?: string;
  voice?: string;
  expiresAt?: number;
  consultThinkingLevel?: string;
  consultFastMode?: boolean;
};

export type RealtimeTalkGatewayRelaySessionResult = {
  provider: string;
  transport: "gateway-relay";
  relaySessionId: string;
  audio: RealtimeTalkAudioContract;
  model?: string;
  voice?: string;
  expiresAt?: number;
  consultThinkingLevel?: string;
  consultFastMode?: boolean;
};

export type RealtimeTalkManagedRoomSessionResult = {
  provider: string;
  transport: "managed-room";
  roomUrl: string;
  token?: string;
  model?: string;
  voice?: string;
  expiresAt?: number;
  consultThinkingLevel?: string;
  consultFastMode?: boolean;
};

export type RealtimeTalkSessionResult =
  | RealtimeTalkWebRtcSdpSessionResult
  | RealtimeTalkJsonPcmWebSocketSessionResult
  | RealtimeTalkGatewayRelaySessionResult
  | RealtimeTalkManagedRoomSessionResult;

export type RealtimeTalkTransport = {
  start(): Promise<void>;
  stop(): void;
};

export type RealtimeTalkTransportContext = {
  client: GatewayBrowserClient;
  sessionKey: string;
  callbacks: RealtimeTalkCallbacks;
  consultThinkingLevel?: string;
  consultFastMode?: boolean;
};

export function createRealtimeTalkEventEmitter(
  ctx: RealtimeTalkTransportContext,
  session: RealtimeTalkSessionResult,
): (input: RealtimeTalkEventInput) => void {
  let seq = 0;
  let turnSeq = 0;
  let activeTurnId: string | undefined;
  const sessionId = resolveRealtimeTalkEventSessionId(ctx, session);
  return (input) => {
    if (!ctx.callbacks.onTalkEvent) {
      return;
    }
    const turnId = resolveRealtimeTalkTurnId(input);
    seq += 1;
    ctx.callbacks.onTalkEvent({
      id: `${sessionId}:${seq}`,
      type: input.type,
      sessionId,
      turnId,
      captureId: input.captureId,
      seq,
      timestamp: new Date().toISOString(),
      mode: "realtime",
      transport: session.transport,
      brain: "agent-consult",
      provider: session.provider,
      final: input.final,
      callId: input.callId,
      itemId: input.itemId,
      parentId: input.parentId,
      payload: input.payload ?? null,
    });
    if (
      input.type === "turn.ended" ||
      input.type === "turn.cancelled" ||
      input.type === "session.replaced" ||
      input.type === "session.closed"
    ) {
      activeTurnId = undefined;
    }
  };

  function resolveRealtimeTalkTurnId(input: RealtimeTalkEventInput): string | undefined {
    if (input.type === "turn.started") {
      activeTurnId = input.turnId ?? activeTurnId ?? `turn-${++turnSeq}`;
      return activeTurnId;
    }
    if (!isTurnScopedTalkEvent(input.type)) {
      return input.turnId;
    }
    activeTurnId = input.turnId ?? activeTurnId ?? `turn-${++turnSeq}`;
    return activeTurnId;
  }
}

function isTurnScopedTalkEvent(type: RealtimeTalkEvent["type"]): boolean {
  return (
    type === "turn.ended" ||
    type === "turn.cancelled" ||
    type.startsWith("input.audio.") ||
    type.startsWith("transcript.") ||
    type.startsWith("output.") ||
    type.startsWith("tool.")
  );
}

function resolveRealtimeTalkEventSessionId(
  ctx: RealtimeTalkTransportContext,
  session: RealtimeTalkSessionResult,
): string {
  const explicitSessionId = (session as { sessionId?: unknown }).sessionId;
  if (typeof explicitSessionId === "string" && explicitSessionId.trim()) {
    return explicitSessionId.trim();
  }
  if ("relaySessionId" in session && session.relaySessionId.trim()) {
    return session.relaySessionId;
  }
  return `${ctx.sessionKey}:${session.provider}:${session.transport}`;
}

type ChatPayload = {
  runId?: string;
  state?: string;
  errorMessage?: string;
  message?: unknown;
};

type AgentWaitResult = {
  status?: string;
  error?: string;
  stopReason?: string;
  endedAt?: number;
  livenessState?: string;
  yielded?: boolean;
};

const AGENT_WAIT_HEARTBEAT_MS = 30_000;
const EMPTY_FINAL_FALLBACK_GRACE_MS = 500;

function extractTextFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  const content = Array.isArray(record.content) ? record.content : [];
  const parts = content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const entry = block as Record<string, unknown>;
      return entry.type === "text" && typeof entry.text === "string" ? entry.text : "";
    })
    .filter(Boolean);
  return parts.join("\n\n").trim();
}

function waitForChatResult(params: {
  client: GatewayBrowserClient;
  runId: string;
  signal?: AbortSignal;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (params.signal?.aborted) {
      reject(new DOMException("OpenClaw tool call aborted", "AbortError"));
      return;
    }
    let settled = false;
    let fallbackTimer: number | undefined;
    const onAbort = () => {
      settleReject(new DOMException("OpenClaw tool call aborted", "AbortError"));
    };
    params.signal?.addEventListener("abort", onAbort, { once: true });
    let unsubscribe: () => void = () => undefined;
    const settleResolve = (value: string) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleReject = (error: Error | DOMException) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    unsubscribe = params.client.addEventListener((evt: GatewayEventFrame) => {
      if (evt.event !== "chat") {
        return;
      }
      const payload = evt.payload as ChatPayload | undefined;
      if (!payload || payload.runId !== params.runId) {
        return;
      }
      if (payload.state === "final") {
        settleResolve(extractTextFromMessage(payload.message) || "OpenClaw finished with no text.");
      } else if (payload.state === "aborted") {
        settleReject(
          new DOMException(payload.errorMessage ?? "OpenClaw tool call aborted", "AbortError"),
        );
      } else if (payload.state === "error") {
        settleReject(new Error(payload.errorMessage ?? "OpenClaw tool call failed"));
      }
    });
    void monitorRunLifecycle();

    async function monitorRunLifecycle() {
      while (!settled) {
        let result: AgentWaitResult;
        try {
          result = await params.client.request<AgentWaitResult>("agent.wait", {
            runId: params.runId,
            timeoutMs: AGENT_WAIT_HEARTBEAT_MS,
          });
        } catch (error) {
          settleReject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (settled) {
          return;
        }
        if (result.status === "pending") {
          continue;
        }
        if (result.status === "ok") {
          fallbackTimer = window.setTimeout(() => {
            settleResolve("OpenClaw finished with no text.");
          }, EMPTY_FINAL_FALLBACK_GRACE_MS);
          return;
        }
        if (result.status === "error") {
          settleReject(new Error(result.error?.trim() || "OpenClaw tool call failed"));
          return;
        }
        if (result.status === "timeout") {
          const terminal =
            result.endedAt !== undefined ||
            Boolean(result.error?.trim()) ||
            Boolean(result.stopReason?.trim()) ||
            Boolean(result.livenessState?.trim()) ||
            result.yielded === true;
          settleReject(
            new Error(
              terminal
                ? result.error?.trim() || "OpenClaw tool call timed out"
                : "OpenClaw tool call is no longer active",
            ),
          );
          return;
        }
        settleReject(
          new Error(`OpenClaw tool call returned unknown status: ${String(result.status)}`),
        );
        return;
      }
    }

    function cleanup() {
      if (fallbackTimer !== undefined) {
        window.clearTimeout(fallbackTimer);
      }
      params.signal?.removeEventListener("abort", onAbort);
      unsubscribe();
    }
  });
}

export async function submitRealtimeTalkConsult(params: {
  ctx: RealtimeTalkTransportContext;
  args: unknown;
  submit: (callId: string, result: unknown) => void;
  callId: string;
  relaySessionId?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { ctx, callId, submit } = params;
  ctx.callbacks.onStatus?.("thinking");
  let runId: string | undefined;
  let aborted = false;
  const abortRun = () => {
    aborted = true;
    if (runId) {
      void ctx.client.request("chat.abort", { sessionKey: ctx.sessionKey, runId });
    }
  };
  if (params.signal?.aborted) {
    return;
  }
  params.signal?.addEventListener("abort", abortRun, { once: true });
  try {
    const args =
      typeof params.args === "string" ? JSON.parse(params.args || "{}") : (params.args ?? {});
    const response = await ctx.client.request<{ runId?: string; idempotencyKey?: string }>(
      "talk.client.toolCall",
      {
        sessionKey: ctx.sessionKey,
        callId,
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args,
        ...(params.relaySessionId ? { relaySessionId: params.relaySessionId } : {}),
      },
    );
    runId = response.runId ?? response.idempotencyKey;
    if (!runId) {
      throw new Error("OpenClaw realtime tool call did not return a run id");
    }
    if (params.signal?.aborted) {
      abortRun();
      return;
    }
    const result = await waitForChatResult({
      client: ctx.client,
      runId,
      signal: params.signal,
    });
    submit(callId, { result });
  } catch (error) {
    if (aborted || params.signal?.aborted || isAbortError(error)) {
      return;
    }
    submit(callId, {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    params.signal?.removeEventListener("abort", abortRun);
    if (!aborted && !params.signal?.aborted) {
      ctx.callbacks.onStatus?.("listening");
    }
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  );
}

export { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME };
