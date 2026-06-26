import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type { AgentInternalEvent } from "../../../agents/internal-events.js";
import { AgentParamsSchema } from "./agent.js";

function makeAgentParamsWithInternalEvent(event: AgentInternalEvent) {
  return {
    message: "A music generation task finished. Process the completion update now.",
    sessionKey: "agent:main:discord:channel:1456744319972282449",
    internalEvents: [event],
    idempotencyKey: "music_generate:task-123:ok",
  };
}

const musicCompletionEvent: AgentInternalEvent = {
  type: "task_completion",
  source: "music_generation",
  childSessionKey: "music_generate:task-123",
  childSessionId: "task-123",
  announceType: "music generation task",
  taskLabel: "OpenClaw release anthem",
  status: "ok",
  statusLabel: "completed successfully",
  result: "Generated 1 track.",
  attachments: [
    {
      type: "audio",
      path: "/tmp/openclaw/generated-release-anthem.mp3",
      mimeType: "audio/mpeg",
      name: "generated-release-anthem.mp3",
    },
  ],
  mediaUrls: ["/tmp/openclaw/generated-release-anthem.mp3"],
  replyInstruction: "Deliver the generated music.",
};

describe("AgentParamsSchema", () => {
  it("accepts generated music attachments on internal completion events", () => {
    const params = makeAgentParamsWithInternalEvent(musicCompletionEvent);

    expect(Value.Check(AgentParamsSchema, params)).toBe(true);
  });

  it("keeps task completion internal events strict", () => {
    const params = makeAgentParamsWithInternalEvent({
      ...musicCompletionEvent,
      unexpected: true,
    } as AgentInternalEvent);

    expect(Value.Check(AgentParamsSchema, params)).toBe(false);
  });

  it("rejects malformed generated attachment entries on internal events", () => {
    const params = makeAgentParamsWithInternalEvent({
      ...musicCompletionEvent,
      attachments: [null],
    } as unknown as AgentInternalEvent);

    expect(Value.Check(AgentParamsSchema, params)).toBe(false);
  });

  it("accepts an explicit chatType conversation hint", () => {
    for (const chatType of ["direct", "group", "channel"]) {
      expect(
        Value.Check(AgentParamsSchema, {
          message: "hi",
          sessionKey: "agent:main:explicit:her-app",
          idempotencyKey: "turn-1",
          chatType,
        }),
      ).toBe(true);
    }
  });

  it("accepts transcriptMessage for runtime-context turns", () => {
    expect(
      Value.Check(AgentParamsSchema, {
        message: "<runtime-context>app state</runtime-context>\n\n<suriel-turn-input>\nhi\n</suriel-turn-input>",
        transcriptMessage: "hi",
        sessionKey: "agent:main:explicit:her-app",
        idempotencyKey: "turn-runtime-context-1",
      }),
    ).toBe(true);
  });

  it("rejects unknown chatType values and stays optional", () => {
    expect(
      Value.Check(AgentParamsSchema, {
        message: "hi",
        sessionKey: "agent:main:explicit:her-app",
        idempotencyKey: "turn-1",
        chatType: "internal",
      }),
    ).toBe(false);
    expect(
      Value.Check(AgentParamsSchema, {
        message: "hi",
        sessionKey: "agent:main:explicit:her-app",
        idempotencyKey: "turn-1",
      }),
    ).toBe(true);
  });

  it("accepts runtime toolsAllow, including an empty private-mode allowlist", () => {
    expect(
      Value.Check(AgentParamsSchema, {
        message: "hi",
        sessionKey: "agent:main:explicit:her-app-private-1",
        idempotencyKey: "turn-private",
        toolsAllow: [],
      }),
    ).toBe(true);
    expect(
      Value.Check(AgentParamsSchema, {
        message: "hi",
        sessionKey: "agent:main:explicit:her-app",
        idempotencyKey: "turn-read-only",
        toolsAllow: ["memory_search", "memory_get"],
      }),
    ).toBe(true);
  });
});
