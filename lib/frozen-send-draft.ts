import type {
  SendAttemptCoordinator,
  SendAttemptPayload,
  SendAttemptStorage,
} from "./send-attempt-registry";
import type { SendUiOutcome } from "./send-ui-result";

export type FrozenSendDraft = {
  outcome: "outcome_unknown" | "local_repair";
  payload: SendAttemptPayload;
};

export type FrozenSendDraftReservation = {
  payload: SendAttemptPayload;
  slot: string;
  knownAccepted: boolean;
};

export type FrozenSendDraftRegistry = {
  restore: (slot: string) => Promise<FrozenSendDraft | null>;
  reserve: (
    slot: string,
    payload: SendAttemptPayload,
  ) => Promise<FrozenSendDraftReservation>;
  settle: (
    reservation: FrozenSendDraftReservation,
    outcome: SendUiOutcome,
  ) => Promise<FrozenSendDraft | null>;
};

type StoredFrozenSendDraft = {
  version: 1;
  outcome: "dispatching" | "outcome_unknown" | "local_repair";
  knownAccepted: boolean;
  payload: SendAttemptPayload;
  frozenAt: string;
  updatedAt: string;
};

export class FrozenSendDraftError extends Error {
  readonly code: "blocked" | "invalid" | "unavailable";

  constructor(code: FrozenSendDraftError["code"], message: string) {
    super(message);
    this.name = "FrozenSendDraftError";
    this.code = code;
  }
}

const STORAGE_PREFIX = "27pm.crm.frozen-send-draft.v1:";
const VALID_SLOT = /^(?:compose|reply:[a-zA-Z0-9_-]{1,128})$/u;
const VALID_PAYLOAD_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u;
const MAX_PAYLOAD_FIELDS = 32;
const MAX_PAYLOAD_STRING_LENGTH = 2_000_000;
const MAX_SERIALIZED_LENGTH = 4_100_000;
let cachedBrowserRegistry: FrozenSendDraftRegistry | null = null;

export function browserFrozenSendDraftRegistry(): FrozenSendDraftRegistry {
  if (typeof window === "undefined") throw unavailableError();
  if (!cachedBrowserRegistry) {
    cachedBrowserRegistry = createFrozenSendDraftRegistry();
  }
  return cachedBrowserRegistry;
}

export function replyFrozenDraftSlot(conversationId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(conversationId)) {
    throw new FrozenSendDraftError("invalid", "Conversation draft slot is invalid.");
  }
  return `reply:${conversationId}`;
}

export function createFrozenSendDraftRegistry(
  storage: SendAttemptStorage | null = browserStorage(),
  coordinator: SendAttemptCoordinator | null = browserCoordinator(),
  persistenceRequired = typeof window !== "undefined",
): FrozenSendDraftRegistry {
  return {
    async restore(slot) {
      const storageKey = checkedStorageKey(slot);
      if (!storage) {
        if (persistenceRequired) throw unavailableError();
        return null;
      }
      return restoredDraft(readStoredDraft(storage, storageKey));
    },

    async reserve(slot, payload) {
      const storageKey = checkedStorageKey(slot);
      const frozenPayload = checkedPayload(payload);
      return withRequiredStorageLock(
        storage,
        coordinator,
        persistenceRequired,
        storageKey,
        async () => {
          const existing = readStoredDraft(storage!, storageKey);
          const samePayload =
            existing !== null && payloadsEqual(existing.payload, frozenPayload);
          if (existing && !(existing.knownAccepted && samePayload)) {
            throw new FrozenSendDraftError(
              "blocked",
              "An unresolved send already freezes this draft.",
            );
          }

          const now = new Date().toISOString();
          const knownAccepted = existing?.knownAccepted === true;
          writeStoredDraft(storage!, storageKey, {
            version: 1,
            outcome: "dispatching",
            knownAccepted,
            payload: frozenPayload,
            frozenAt: existing?.frozenAt ?? now,
            updatedAt: now,
          });
          return { slot, payload: frozenPayload, knownAccepted };
        },
      );
    },

    async settle(reservation, outcome) {
      const storageKey = checkedStorageKey(reservation.slot);
      const frozenPayload = checkedPayload(reservation.payload);
      return withRequiredStorageLock(
        storage,
        coordinator,
        persistenceRequired,
        storageKey,
        async () => {
          const existing = readStoredDraft(storage!, storageKey);
          if (!existing || !payloadsEqual(existing.payload, frozenPayload)) {
            throw unavailableError();
          }

          if (outcome === "accepted") {
            storage!.removeItem(storageKey);
            return null;
          }

          // A local-repair retry cannot erase the already-known provider
          // acceptance merely because the repair request itself was rejected or
          // interrupted. It stays frozen and may only retry the exact payload.
          if (reservation.knownAccepted || outcome === "local_repair") {
            const stored = updatedStoredDraft(
              existing,
              frozenPayload,
              "local_repair",
              true,
            );
            writeStoredDraft(storage!, storageKey, stored);
            return restoredDraft(stored);
          }

          if (outcome === "definitive_failure") {
            storage!.removeItem(storageKey);
            return null;
          }

          const stored = updatedStoredDraft(
            existing,
            frozenPayload,
            "outcome_unknown",
            false,
          );
          writeStoredDraft(storage!, storageKey, stored);
          return restoredDraft(stored);
        },
      );
    },
  };
}

function restoredDraft(record: StoredFrozenSendDraft | null): FrozenSendDraft | null {
  if (!record) return null;
  return {
    outcome: record.knownAccepted ? "local_repair" : "outcome_unknown",
    payload: { ...record.payload },
  };
}

function updatedStoredDraft(
  previous: StoredFrozenSendDraft,
  payload: SendAttemptPayload,
  outcome: StoredFrozenSendDraft["outcome"],
  knownAccepted: boolean,
): StoredFrozenSendDraft {
  return {
    version: 1,
    outcome,
    knownAccepted,
    payload,
    frozenAt: previous.frozenAt,
    updatedAt: new Date().toISOString(),
  };
}

async function withRequiredStorageLock<T>(
  storage: SendAttemptStorage | null,
  coordinator: SendAttemptCoordinator | null,
  persistenceRequired: boolean,
  storageKey: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!storage) {
    if (persistenceRequired) throw unavailableError();
    throw unavailableError();
  }
  if (!coordinator) {
    if (persistenceRequired) throw unavailableError();
    return work();
  }
  try {
    return await coordinator.run(storageKey, work);
  } catch (error) {
    if (error instanceof FrozenSendDraftError) throw error;
    throw unavailableError();
  }
}

function readStoredDraft(
  storage: SendAttemptStorage,
  storageKey: string,
): StoredFrozenSendDraft | null {
  let serialized: string | null;
  try {
    serialized = storage.getItem(storageKey);
  } catch {
    throw unavailableError();
  }
  if (serialized === null) return null;
  if (serialized.length > MAX_SERIALIZED_LENGTH) throw unavailableError();

  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw unavailableError();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw unavailableError();
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !["dispatching", "outcome_unknown", "local_repair"].includes(
      String(record.outcome),
    ) ||
    typeof record.knownAccepted !== "boolean" ||
    typeof record.frozenAt !== "string" ||
    typeof record.updatedAt !== "string"
  ) {
    throw unavailableError();
  }
  const payload = checkedPayload(record.payload);
  if (
    record.knownAccepted !== (record.outcome === "local_repair") &&
    record.outcome !== "dispatching"
  ) {
    throw unavailableError();
  }
  return {
    version: 1,
    outcome: record.outcome as StoredFrozenSendDraft["outcome"],
    knownAccepted: record.knownAccepted,
    payload,
    frozenAt: record.frozenAt,
    updatedAt: record.updatedAt,
  };
}

function writeStoredDraft(
  storage: SendAttemptStorage,
  storageKey: string,
  record: StoredFrozenSendDraft,
) {
  const serialized = JSON.stringify(record);
  if (serialized.length > MAX_SERIALIZED_LENGTH) throw unavailableError();
  try {
    storage.setItem(storageKey, serialized);
  } catch {
    throw unavailableError();
  }
}

function checkedPayload(value: unknown): SendAttemptPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FrozenSendDraftError("invalid", "Frozen send payload is invalid.");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_PAYLOAD_FIELDS) {
    throw new FrozenSendDraftError("invalid", "Frozen send payload is invalid.");
  }
  const payload: SendAttemptPayload = {};
  for (const [key, entry] of entries.sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    if (
      !VALID_PAYLOAD_KEY.test(key) ||
      (typeof entry !== "string" && typeof entry !== "boolean") ||
      (typeof entry === "string" && entry.length > MAX_PAYLOAD_STRING_LENGTH)
    ) {
      throw new FrozenSendDraftError("invalid", "Frozen send payload is invalid.");
    }
    payload[key] = entry;
  }
  if (JSON.stringify(payload).length > MAX_SERIALIZED_LENGTH) {
    throw new FrozenSendDraftError("invalid", "Frozen send payload is invalid.");
  }
  return payload;
}

function payloadsEqual(
  left: SendAttemptPayload,
  right: SendAttemptPayload,
): boolean {
  return JSON.stringify(checkedPayload(left)) === JSON.stringify(checkedPayload(right));
}

function checkedStorageKey(slot: string): string {
  if (!VALID_SLOT.test(slot)) {
    throw new FrozenSendDraftError("invalid", "Frozen draft slot is invalid.");
  }
  return `${STORAGE_PREFIX}${slot}`;
}

function unavailableError(): FrozenSendDraftError {
  return new FrozenSendDraftError(
    "unavailable",
    "Frozen draft persistence is unavailable.",
  );
}

function browserStorage(): SendAttemptStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function browserCoordinator(): SendAttemptCoordinator | null {
  if (typeof navigator === "undefined" || !navigator.locks) return null;
  return {
    async run<T>(name: string, work: () => Promise<T>): Promise<T> {
      return navigator.locks.request(name, work);
    },
  };
}
