import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendNotifyOutboxEvent,
  appendTaskLedgerEvent,
  buildTaskEvent,
  buildTaskId,
  buildTaskIdempotencyKey,
  buildTerminalNotification,
  canonicalJson,
  loadReliabilitySpineSnapshot,
  notificationsMissingForTerminalTasks,
  reduceTaskEvents,
} from "./spine.js";

const source = {
  channel: "discord",
  accountId: "default",
  chatId: "channel:1478495643763740744",
  messageId: "1498721006401880338",
};

describe("reliability spine core", () => {
  it("canonicalizes JSON independent of object key order", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  it("builds stable task IDs from canonical intent keys", () => {
    const now = new Date("2026-04-28T16:00:00.000Z");
    const left = buildTaskId({
      source: "Discord Channel",
      now,
      intentKey: { source: "discord", goal: "phase 1", messageId: "m1" },
    });
    const right = buildTaskId({
      source: "discord_channel",
      now,
      intentKey: { goal: "phase 1", messageId: "m1", source: "discord" },
    });
    expect(left).toBe(right);
    expect(left).toMatch(/^task_20260428_discord_channel_[a-f0-9]{16}$/);
  });

  it("requires a stable message or request id for task idempotency", () => {
    expect(() =>
      buildTaskIdempotencyKey({
        source: { channel: "discord" },
        kind: "agent_turn",
      }),
    ).toThrow(/messageId or source.requestId/);
  });

  it("reduces task events to the latest terminal state", () => {
    const taskId = "task_20260428_discord_abc123";
    const idempotencyKey = buildTaskIdempotencyKey({ source, kind: "agent_turn", goal: "build" });
    const started = buildTaskEvent({
      taskId,
      type: "started",
      source,
      idempotencyKey,
      ts: "2026-04-28T16:00:00.000Z",
    });
    const completed = buildTaskEvent({
      taskId,
      type: "completed",
      source,
      idempotencyKey,
      ts: "2026-04-28T16:01:00.000Z",
    });

    const snapshot = reduceTaskEvents([started, completed]).get(taskId);
    expect(snapshot).toMatchObject({ taskId, state: "completed", terminal: true });
    expect(snapshot?.lastEvent).toBe(completed);
  });

  it("only builds notifications from terminal task events", () => {
    const taskEvent = buildTaskEvent({
      taskId: "task_20260428_discord_abc123",
      type: "started",
      source,
      idempotencyKey: "idem",
      ts: "2026-04-28T16:00:00.000Z",
    });

    expect(() =>
      buildTerminalNotification({
        taskEvent,
        target: { channel: "discord", to: "channel:1478495643763740744" },
        message: "done",
      }),
    ).toThrow(/terminal task event/);
  });

  it("reconciles missing notifications for terminal tasks without duplicating existing outbox entries", () => {
    const target = { channel: "discord", to: "channel:1478495643763740744" };
    const taskA = buildTaskEvent({
      taskId: "task_20260428_discord_a",
      type: "completed",
      source,
      idempotencyKey: "idem-a",
      ts: "2026-04-28T16:00:00.000Z",
    });
    const taskB = buildTaskEvent({
      taskId: "task_20260428_discord_b",
      type: "failed",
      source,
      idempotencyKey: "idem-b",
      ts: "2026-04-28T16:01:00.000Z",
    });
    const existing = buildTerminalNotification({
      taskEvent: taskA,
      target,
      message: "already queued",
    });

    const missing = notificationsMissingForTerminalTasks({
      taskEvents: [taskA, taskB],
      notifications: [existing],
      target,
      formatMessage: (event) => `${event.taskId} ${event.state}`,
    });

    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      taskId: taskB.taskId,
      state: "queued",
      target,
      message: "task_20260428_discord_b failed",
    });
    expect(missing[0]?.idempotencyKey).toContain(taskB.taskId);
  });

  it("recovers task and notification state from append-only JSONL files after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-reliability-spine-"));
    try {
      const paths = {
        taskEventsPath: join(dir, "tasks.jsonl"),
        notifyOutboxPath: join(dir, "notify.jsonl"),
      };
      const target = { channel: "discord", to: "channel:1478495643763740744" };
      const taskId = "task_20260505_discord_restart";
      const idempotencyKey = buildTaskIdempotencyKey({
        source,
        kind: "agent_turn",
        goal: "restart",
      });
      const started = buildTaskEvent({
        taskId,
        type: "started",
        source,
        idempotencyKey,
        ts: "2026-05-05T20:00:00.000Z",
      });
      const completed = buildTaskEvent({
        taskId,
        type: "completed",
        source,
        idempotencyKey,
        ts: "2026-05-05T20:01:00.000Z",
      });
      const notification = buildTerminalNotification({
        taskEvent: completed,
        target,
        message: "completed after restart",
      });

      expect(await appendTaskLedgerEvent(paths.taskEventsPath, started)).toMatchObject({
        appended: true,
      });
      expect(await appendTaskLedgerEvent(paths.taskEventsPath, completed)).toMatchObject({
        appended: true,
      });
      expect(await appendTaskLedgerEvent(paths.taskEventsPath, completed)).toMatchObject({
        appended: false,
      });
      expect(await appendNotifyOutboxEvent(paths.notifyOutboxPath, notification)).toMatchObject({
        appended: true,
      });
      expect(await appendNotifyOutboxEvent(paths.notifyOutboxPath, notification)).toMatchObject({
        appended: false,
      });

      const recovered = await loadReliabilitySpineSnapshot(paths);
      expect(recovered.taskEvents).toHaveLength(2);
      expect(recovered.notifications).toHaveLength(1);
      expect(recovered.taskSnapshots.get(taskId)).toMatchObject({
        state: "completed",
        terminal: true,
      });
      expect(
        notificationsMissingForTerminalTasks({
          taskEvents: recovered.taskEvents,
          notifications: recovered.notifications,
          target,
          formatMessage: (event) => `${event.taskId} ${event.state}`,
        }),
      ).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
