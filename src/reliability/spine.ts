import { createHash } from "node:crypto";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

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

export type ReliabilitySpineStorePaths = {
  taskEventsPath: string;
  notifyOutboxPath: string;
};

export type ReliabilitySpineSnapshot = {
  taskEvents: TaskLedgerEvent[];
  notifications: NotifyOutboxEvent[];
  taskSnapshots: Map<string, ReliabilityTaskSnapshot>;
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

async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch (error) {
        throw new Error(
          `Invalid JSONL record in ${filePath}:${index + 1}: ${(error as Error).message}`,
          {
            cause: error,
          },
        );
      }
    });
}

async function appendJsonlRecord(filePath: string, record: unknown): Promise<void> {
  await ensureParentDir(filePath);
  await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

export async function readTaskLedgerEvents(filePath: string): Promise<TaskLedgerEvent[]> {
  return readJsonlFile<TaskLedgerEvent>(filePath);
}

export async function readNotifyOutboxEvents(filePath: string): Promise<NotifyOutboxEvent[]> {
  return readJsonlFile<NotifyOutboxEvent>(filePath);
}

export async function appendTaskLedgerEvent(
  filePath: string,
  event: TaskLedgerEvent,
): Promise<{ appended: boolean; event: TaskLedgerEvent }> {
  const existing = await readTaskLedgerEvents(filePath);
  const alreadyPersisted = existing.some(
    (candidate) =>
      candidate.taskId === event.taskId &&
      candidate.type === event.type &&
      candidate.idempotencyKey === event.idempotencyKey,
  );
  if (alreadyPersisted) {
    return { appended: false, event };
  }

  await appendJsonlRecord(filePath, event);
  return { appended: true, event };
}

export async function appendNotifyOutboxEvent(
  filePath: string,
  notification: NotifyOutboxEvent,
): Promise<{ appended: boolean; notification: NotifyOutboxEvent }> {
  const existing = await readNotifyOutboxEvents(filePath);
  const alreadyPersisted = existing.some(
    (candidate) =>
      candidate.notificationId === notification.notificationId ||
      candidate.idempotencyKey === notification.idempotencyKey,
  );
  if (alreadyPersisted) {
    return { appended: false, notification };
  }

  await appendJsonlRecord(filePath, notification);
  return { appended: true, notification };
}

export async function loadReliabilitySpineSnapshot(
  paths: ReliabilitySpineStorePaths,
): Promise<ReliabilitySpineSnapshot> {
  const [taskEvents, notifications] = await Promise.all([
    readTaskLedgerEvents(paths.taskEventsPath),
    readNotifyOutboxEvents(paths.notifyOutboxPath),
  ]);
  return {
    taskEvents,
    notifications,
    taskSnapshots: reduceTaskEvents(taskEvents),
  };
}
