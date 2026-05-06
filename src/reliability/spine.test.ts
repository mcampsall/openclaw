import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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
  readTaskLedgerEvents,
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

  it("keeps terminal state sticky when a heartbeat arrives after completion", () => {
    const taskId = "task_20260505_discord_sticky";
    const idempotencyKey = "idem-sticky";
    const completed = buildTaskEvent({
      taskId,
      type: "completed",
      source,
      idempotencyKey,
      ts: "2026-05-05T20:00:00.000Z",
    });
    const lateHeartbeat = buildTaskEvent({
      taskId,
      type: "heartbeat",
      source,
      idempotencyKey,
      ts: "2026-05-05T20:00:30.000Z",
    });

    const snapshot = reduceTaskEvents([completed, lateHeartbeat]).get(taskId);
    expect(snapshot).toMatchObject({ state: "completed", terminal: true });
    expect(snapshot?.lastEvent).toBe(completed);
  });

  it("reduces correctly when events arrive out of timestamp order", () => {
    const taskId = "task_20260505_discord_ooo";
    const idempotencyKey = "idem-ooo";
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

    const snapshot = reduceTaskEvents([completed, started]).get(taskId);
    expect(snapshot).toMatchObject({ state: "completed", terminal: true });
    expect(snapshot?.lastEvent).toBe(completed);
  });

  it("treats cancelled as a sticky terminal state", () => {
    const taskId = "task_20260505_discord_cancelled";
    const idempotencyKey = "idem-cancelled";
    const started = buildTaskEvent({
      taskId,
      type: "started",
      source,
      idempotencyKey,
      ts: "2026-05-05T20:00:00.000Z",
    });
    const cancelled = buildTaskEvent({
      taskId,
      type: "cancelled",
      source,
      idempotencyKey,
      ts: "2026-05-05T20:01:00.000Z",
    });
    const lateHeartbeat = buildTaskEvent({
      taskId,
      type: "heartbeat",
      source,
      idempotencyKey,
      ts: "2026-05-05T20:02:00.000Z",
    });

    const snapshot = reduceTaskEvents([started, cancelled, lateHeartbeat]).get(taskId);
    expect(snapshot).toMatchObject({ state: "cancelled", terminal: true });
    expect(snapshot?.lastEvent).toBe(cancelled);
  });

  it("filters notifications by target when reconciling missing terminal notifications", () => {
    const targetA = { channel: "discord", to: "channel:111" };
    const targetB = { channel: "discord", to: "channel:222" };
    const completed = buildTaskEvent({
      taskId: "task_20260505_discord_target",
      type: "completed",
      source,
      idempotencyKey: "idem-target",
      ts: "2026-05-05T20:00:00.000Z",
    });
    const notificationForA = buildTerminalNotification({
      taskEvent: completed,
      target: targetA,
      message: "queued for A",
    });

    const missingForB = notificationsMissingForTerminalTasks({
      taskEvents: [completed],
      notifications: [notificationForA],
      target: targetB,
      formatMessage: (event) => `${event.taskId} ${event.state}`,
    });

    expect(missingForB).toHaveLength(1);
    expect(missingForB[0]).toMatchObject({ target: targetB, taskId: completed.taskId });
  });

  it("skips and warns on corrupt JSONL lines instead of throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-reliability-spine-corrupt-"));
    try {
      const filePath = join(dir, "tasks.jsonl");
      const goodEvent = buildTaskEvent({
        taskId: "task_20260505_discord_good",
        type: "completed",
        source,
        idempotencyKey: "idem-good",
        ts: "2026-05-05T20:00:00.000Z",
      });
      const lines = [JSON.stringify(goodEvent), "{not json", JSON.stringify(goodEvent)].join("\n");
      await writeFile(filePath, `${lines}\n`, "utf8");

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const events = await readTaskLedgerEvents(filePath);
        expect(events).toHaveLength(2);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toMatch(/skipping invalid JSONL record/u);
        expect(warn.mock.calls[0]?.[0]).toMatch(/:2:/u);
      } finally {
        warn.mockRestore();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent appends so the dedup check is atomic", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-reliability-spine-mutex-"));
    try {
      const filePath = join(dir, "tasks.jsonl");
      const event = buildTaskEvent({
        taskId: "task_20260505_discord_mutex",
        type: "completed",
        source,
        idempotencyKey: "idem-mutex",
        ts: "2026-05-05T20:00:00.000Z",
      });

      const results = await Promise.all([
        appendTaskLedgerEvent(filePath, event),
        appendTaskLedgerEvent(filePath, event),
        appendTaskLedgerEvent(filePath, event),
      ]);

      const appended = results.filter((result) => result.appended);
      expect(appended).toHaveLength(1);

      const persisted = await readTaskLedgerEvents(filePath);
      expect(persisted).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
