/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { submitRealtimeTalkConsult } from "./chat/realtime-talk-shared.js";

function requireFirstMockCall(calls: readonly unknown[][], label: string): unknown[] {
  const call = calls.at(0);
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

describe("RealtimeTalkSession consult handoff", () => {
  it("submits realtime consults through the Gateway tool-call endpoint", async () => {
    let listener: ((event: { event: string; payload?: unknown }) => void) | undefined;
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "talk.client.toolCall") {
        setImmediate(() => {
          listener?.({
            event: "chat",
            payload: {
              runId: "run-1",
              state: "final",
              message: { text: "Basement lights are off." },
            },
          });
        });
        return { runId: "run-1" };
      }
      if (method === "agent.wait") {
        return await new Promise((resolve) => setImmediate(() => resolve({ status: "pending" })));
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const addEventListener = vi.fn((callback: typeof listener) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    });
    const submit = vi.fn();

    await submitRealtimeTalkConsult({
      ctx: {
        client: { request, addEventListener },
        sessionKey: "agent:main:main",
        callbacks: {},
      } as never,
      callId: "call-1",
      args: { question: "Are the basement lights off?" },
      submit,
    });

    const toolCall = requireFirstMockCall(request.mock.calls, "Gateway request") as
      | [string, { sessionKey?: string; name?: string; args?: { question?: string } }]
      | undefined;
    expect(toolCall?.[0]).toBe("talk.client.toolCall");
    expect(toolCall?.[1]?.sessionKey).toBe("agent:main:main");
    expect(toolCall?.[1]?.name).toBe("openclaw_agent_consult");
    expect(toolCall?.[1]?.args).toEqual({ question: "Are the basement lights off?" });
    expect(submit).toHaveBeenCalledWith("call-1", { result: "Basement lights are off." });
  });

  it("keeps a registered consult alive across more than four heartbeat windows", async () => {
    let listener: ((event: { event: string; payload?: unknown }) => void) | undefined;
    let waitCount = 0;
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === "talk.client.toolCall") {
        return { runId: "run-long" };
      }
      if (method === "agent.wait") {
        waitCount += 1;
        expect(params).toEqual({ runId: "run-long", timeoutMs: 30_000 });
        return await new Promise((resolve) => {
          setImmediate(() => {
            if (waitCount === 5) {
              listener?.({
                event: "chat",
                payload: {
                  runId: "run-long",
                  state: "final",
                  message: { text: "The long task finished." },
                },
              });
            }
            resolve({ status: "pending", livenessState: "working" });
          });
        });
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const addEventListener = vi.fn((callback: typeof listener) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    });
    const submit = vi.fn();

    await submitRealtimeTalkConsult({
      ctx: {
        client: { request, addEventListener },
        sessionKey: "agent:main:main",
        callbacks: {},
      } as never,
      callId: "call-long",
      args: { question: "Do the long task." },
      submit,
    });

    expect(waitCount).toBe(5);
    expect(submit).toHaveBeenCalledWith("call-long", { result: "The long task finished." });
  });

  it("reports an untracked consult as a liveness failure", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.toolCall") {
        return { runId: "run-missing" };
      }
      if (method === "agent.wait") {
        return { status: "timeout" };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const submit = vi.fn();

    await submitRealtimeTalkConsult({
      ctx: {
        client: { request, addEventListener: () => () => undefined },
        sessionKey: "agent:main:main",
        callbacks: {},
      } as never,
      callId: "call-missing",
      args: { question: "Are you still there?" },
      submit,
    });

    expect(submit).toHaveBeenCalledWith("call-missing", {
      error: "OpenClaw tool call is no longer active",
    });
  });
});
