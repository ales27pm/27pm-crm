import {
  CRM_MAILBOXES,
  extractEmailAddress,
  mailboxForAddress,
} from "./mailboxes";

export type SendAttemptPayload = Record<string, string | boolean>;

export type SendAttemptStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

export type SendAttemptCoordinator = {
  run: <T>(name: string, work: () => Promise<T>) => Promise<T>;
};

export type SendAttemptRegistry = {
  keyFor: (payload: SendAttemptPayload) => Promise<string>;
  confirm: (
    payload: SendAttemptPayload,
    idempotencyKey: string,
  ) => Promise<void>;
  pendingCount: () => number;
};

export type SendAttemptKeyFactory = (
  fingerprint: string,
) => string | Promise<string>;

const MAX_PENDING_ATTEMPTS = 64;
const STORAGE_PREFIX = "27pm.crm.send-attempt.v1:";
const VALID_KEY = /^[a-zA-Z0-9._:-]{8,128}$/u;

export function createSendAttemptRegistry(
  createKey: SendAttemptKeyFactory = () => `send:${crypto.randomUUID()}`,
  storage: SendAttemptStorage | null = browserSendAttemptStorage(),
  coordinator: SendAttemptCoordinator | null = browserSendAttemptCoordinator(),
  persistenceRequired = typeof window !== "undefined",
): SendAttemptRegistry {
  const pending = new Map<string, Promise<string>>();

  return {
    async keyFor(payload) {
      const fingerprint = canonicalSendAttemptFingerprint(payload);
      const existing = pending.get(fingerprint);
      if (existing) return existing;

      if (pending.size >= MAX_PENDING_ATTEMPTS) {
        const oldest = pending.keys().next().value;
        if (typeof oldest === "string") pending.delete(oldest);
      }

      const resolution = resolveAttemptKey(
        fingerprint,
        createKey,
        storage,
        coordinator,
        persistenceRequired,
      );
      pending.set(fingerprint, resolution);
      try {
        return await resolution;
      } catch (error) {
        if (pending.get(fingerprint) === resolution) pending.delete(fingerprint);
        throw error;
      }
    },
    async confirm(payload, idempotencyKey) {
      const fingerprint = canonicalSendAttemptFingerprint(payload);
      if (!VALID_KEY.test(idempotencyKey)) return;
      if (!storage) {
        if (!persistenceRequired) pending.delete(fingerprint);
        return;
      }
      try {
        const storageKey = await attemptStorageKey(fingerprint);
        const remove = async () => {
          if (storage.getItem(storageKey) === idempotencyKey) {
            storage.removeItem(storageKey);
          }
        };
        if (coordinator) {
          await coordinator.run(storageKey, remove);
        } else if (persistenceRequired) {
          return;
        } else {
          await remove();
        }
        pending.delete(fingerprint);
      } catch {
        // Keep the existing key when durable cleanup fails. Reusing a known key
        // is safer than allowing a duplicate provider request.
      }
    },
    pendingCount() {
      return pending.size;
    },
  };
}

export function canonicalSendAttemptFingerprint(
  payload: SendAttemptPayload,
): string {
  const mailboxValue =
    typeof payload.mailbox === "string"
      ? payload.mailbox.trim()
      : typeof payload.from === "string"
        ? payload.from.trim()
        : "";
  const mailbox =
    CRM_MAILBOXES.find((candidate) => candidate.id === mailboxValue) ??
    mailboxForAddress(mailboxValue);
  const recipientValue =
    typeof payload.to === "string" ? payload.to.trim() : "";
  const recipient = extractEmailAddress(recipientValue);
  const subject =
    typeof payload.subject === "string"
      ? payload.subject.replace(/[\r\n]+/gu, " ").trim()
      : "";
  const text =
    typeof payload.text === "string"
      ? payload.text.trim()
      : typeof payload.body === "string"
        ? payload.body.trim()
        : null;
  const html =
    typeof payload.html === "string" ? payload.html.trim() : null;
  const conversationId =
    typeof payload.conversationId === "string"
      ? payload.conversationId
      : null;

  return JSON.stringify({
    mailboxId: mailbox?.id ?? mailboxValue.toLowerCase(),
    to: [recipient ?? recipientValue.toLowerCase()],
    subject,
    text,
    html,
    conversationId,
  });
}

export function shouldRetainSendAttempt(
  responseStatus: number,
  errorCode: string | null,
): boolean {
  if (
    errorCode === "mailgun_send_unconfirmed" ||
    errorCode === "send_command_in_progress" ||
    errorCode === "idempotency_key_reused" ||
    errorCode === "send_command_conflict"
  ) {
    return true;
  }
  if (responseStatus === 409) return errorCode === null;
  if (responseStatus === 408 || responseStatus === 429) return true;
  if (responseStatus >= 500) {
    return !(
      (responseStatus === 502 &&
        (errorCode === "mailgun_send_failed" ||
          errorCode === "send_command_failed")) ||
      (responseStatus === 503 && errorCode === "unsubscribe_origin_invalid")
    );
  }
  return false;
}

async function resolveAttemptKey(
  fingerprint: string,
  createKey: SendAttemptKeyFactory,
  storage: SendAttemptStorage | null,
  coordinator: SendAttemptCoordinator | null,
  persistenceRequired: boolean,
): Promise<string> {
  if (!storage) {
    if (persistenceRequired) {
      throw new Error("Send attempt could not be persisted safely.");
    }
    return createValidatedAttemptKey(fingerprint, createKey);
  }

  const storageKey = await attemptStorageKey(fingerprint);
  const resolvePersisted = async () => {
    try {
      const stored = storage.getItem(storageKey);
      if (stored && VALID_KEY.test(stored)) return stored;
      if (stored) storage.removeItem(storageKey);
    } catch {
      if (persistenceRequired) {
        throw new Error("Send attempt could not be persisted safely.");
      }
    }

    const key = await createValidatedAttemptKey(fingerprint, createKey);
    try {
      storage.setItem(storageKey, key);
    } catch {
      if (persistenceRequired) {
        throw new Error("Send attempt could not be persisted safely.");
      }
    }
    return key;
  };

  if (coordinator) {
    return coordinator.run(storageKey, resolvePersisted);
  }
  if (persistenceRequired) {
    throw new Error("Send attempt coordination is unavailable.");
  }
  return resolvePersisted();
}

async function createValidatedAttemptKey(
  fingerprint: string,
  createKey: SendAttemptKeyFactory,
): Promise<string> {
  const key = await createKey(fingerprint);
  if (!VALID_KEY.test(key)) {
    throw new Error("Send idempotency key is invalid.");
  }
  return key;
}

async function attemptStorageKey(fingerprint: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(fingerprint),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${STORAGE_PREFIX}${hex}`;
}

function browserSendAttemptStorage(): SendAttemptStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function browserSendAttemptCoordinator(): SendAttemptCoordinator | null {
  if (typeof navigator === "undefined" || !navigator.locks) return null;
  return {
    async run<T>(name: string, work: () => Promise<T>): Promise<T> {
      return await navigator.locks.request(name, work);
    },
  };
}
