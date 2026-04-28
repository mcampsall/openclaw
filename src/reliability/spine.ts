import { createHash } from "node:crypto";

export type ReliabilitySource = {
  channel: string;
  accountId?: string;
  chatId?: string;
  messageId?: string;
  requestId?: string;
};

export type TaskIntentKey = Record<string, unknown>;

export type TaskState =
  | "declared"
  | "claimed"
  | "started"
  | "heartbeat"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskTerminalState = Extract<TaskState, "completed" | "failed" | "cancelled">;

export type TaskEventType = TaskState;

export type TaskLedgerEvent = {
  v: 1;
  ts: string;
  taskId: string;
  eventId: string;
  type: TaskEventType;
  state: TaskState;
  source: ReliabilitySource;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
};

export type NotifyState = "queued" | "delivering" | "delivered" | "failed" | "sealed";

export type NotifyOutboxEvent = {
  v: 1;
  ts: string;
  notificationId: string;
  taskId: string;
  state: NotifyState;
  idempotencyKey: string;
  target: {
    channel: string;
    to: string;
    accountId?: string;
  };
  message: string;
};

export type ReliabilityTaskSnapshot = {
  taskId: string;
  state: TaskState;
  terminal: boolean;
  lastEvent: TaskLedgerEvent;
};

const TERMINAL_TASK_STATES = new Set<TaskState>(["completed", "failed", "cancelled"]);
const SAFE_SOURCE_RE = /[^a-z0-9_-]+/gi;

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortObject(item)]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortObject(value));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function dateStamp(input: Date): string {
  return input.toISOString().slice(0, 10).replaceAll("-", "");
}

function normalizeSourceName(source: string): string {
  const normalized = source
    .trim()
    .toLowerCase()
    .replace(SAFE_SOURCE_RE, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "unknown";
}

export function buildTaskId(params: {
  intentKey: TaskIntentKey;
  source: string;
  now?: Date;
}): string {
  const now = params.now ?? new Date();
  const source = normalizeSourceName(params.source);
  const hash = sha256Hex(canonicalJson(params.intentKey)).slice(0, 16);
  return `task_${dateStamp(now)}_${source}_${hash}`;
}

export function buildTaskIdempotencyKey(params: {
  source: ReliabilitySource;
  kind: string;
  goal?: string;
}): string {
  const source = params.source;
  const stableIdentity = source.messageId ?? source.requestId;
  if (!stableIdentity) {
    throw new Error("source.messageId or source.requestId is required for task idempotency");
  }
  return [
    "task",
    normalizeSourceName(source.channel),
    source.accountId ?? "default",
    source.chatId ?? "unknown-chat",
    stableIdentity,
    params.kind,
    params.goal ? sha256Hex(params.goal).slice(0, 12) : null,
  ]
    .filter(Boolean)
    .join(":");
}

export function buildTaskEvent(params: {
  taskId: string;
  type: TaskEventType;
  source: ReliabilitySource;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  ts?: string;
}): TaskLedgerEvent {
  const ts = params.ts ?? new Date().toISOString();
  return {
    v: 1,
    ts,
    taskId: params.taskId,
    eventId: `evt_${sha256Hex(`${params.taskId}:${params.type}:${params.idempotencyKey}:${ts}`).slice(0, 24)}`,
    type: params.type,
    state: params.type,
    source: params.source,
    idempotencyKey: params.idempotencyKey,
    ...(params.payload ? { payload: params.payload } : {}),
  };
}

export function reduceTaskEvents(events: TaskLedgerEvent[]): Map<string, ReliabilityTaskSnapshot> {
  const snapshots = new Map<string, ReliabilityTaskSnapshot>();
  for (const event of events) {
    snapshots.set(event.taskId, {
      taskId: event.taskId,
      state: event.state,
      terminal: TERMINAL_TASK_STATES.has(event.state),
      lastEvent: event,
    });
  }
  return snapshots;
}

export function buildTerminalNotification(params: {
  taskEvent: TaskLedgerEvent;
  target: NotifyOutboxEvent["target"];
  message: string;
  ts?: string;
}): NotifyOutboxEvent {
  if (!TERMINAL_TASK_STATES.has(params.taskEvent.state)) {
    throw new Error("terminal task event is required to enqueue a terminal notification");
  }
  const ts = params.ts ?? new Date().toISOString();
  const notificationId = `ntf_${sha256Hex(
    canonicalJson({
      taskId: params.taskEvent.taskId,
      target: params.target,
      state: params.taskEvent.state,
    }),
  ).slice(0, 24)}`;
  return {
    v: 1,
    ts,
    notificationId,
    taskId: params.taskEvent.taskId,
    state: "queued",
    idempotencyKey: `notify:${params.taskEvent.taskId}:${params.taskEvent.state}:${notificationId}`,
    target: params.target,
    message: params.message,
  };
}

export function notificationsMissingForTerminalTasks(params: {
  taskEvents: TaskLedgerEvent[];
  notifications: NotifyOutboxEvent[];
  target: NotifyOutboxEvent["target"];
  formatMessage: (event: TaskLedgerEvent) => string;
}): NotifyOutboxEvent[] {
  const existingTaskIds = new Set(params.notifications.map((notification) => notification.taskId));
  return Array.from(reduceTaskEvents(params.taskEvents).values())
    .filter((snapshot) => snapshot.terminal && !existingTaskIds.has(snapshot.taskId))
    .map((snapshot) =>
      buildTerminalNotification({
        taskEvent: snapshot.lastEvent,
        target: params.target,
        message: params.formatMessage(snapshot.lastEvent),
      }),
    );
}
