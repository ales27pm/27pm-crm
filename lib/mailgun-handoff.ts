export const MAILGUN_HANDOFF_ID = "mailgun-bootstrap-v1";
export const MAILGUN_HANDOFF_PURPOSE = "mailgun_bootstrap";
export const MAILGUN_HANDOFF_EXPIRES_AT = "2026-08-26T12:00:00.000Z";
export const MAILGUN_HANDOFF_KEY_FINGERPRINT =
  "97904e8cd6494c62911d9cc6c83720d2efb6f2554e92b0d721df71d4bb4a2beb";
export const MAILGUN_HANDOFF_CONSUMER_TOKEN_SHA256 =
  "e72d035fdb9ff3191946a770426c0be71dee386b92fe1f7f02d6fda9aa4d9245";
export const MAILGUN_HANDOFF_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxOrzSaQMvaARJmPja2Su
1BxrK+2HpsC9IJsZoBWUnmlm8hAHdUjtTsrnJ5mHfH+vy5WXkpc8O7exSGCDME0F
dYobt1dsZzYkA/GNGkmGOmyhowf2RiONDhc11IzIAUweY3iSrFj765ADuXpPL0Z/
GqPfv0mD8qQxh6k6EzuAainyXY6fFEhSaji2yFnswKb3A4AgrDtbbDL0R0IDmJo+
LMR1gsYpfk/Zmm9W4ya+E6crWdXp/1Bv/3X9PrOZy8rjCrqZluDfRUarmlJ1UC3z
51BP+DfWX/VGcosAHnUQZ1p4ySjdrlrbtYdAFYDNiJw/Yud2lwcvTQJfhNMieA/l
mwIDAQAB
-----END PUBLIC KEY-----`;

const RSA_CIPHERTEXT_BYTES = 256;
const encoder = new TextEncoder();

export type MailgunHandoffValidation =
  | { ok: true; ciphertext: string }
  | {
      ok: false;
      reason: "expired" | "payload_invalid" | "fingerprint_invalid";
    };

export function validateMailgunHandoffPayload(
  value: unknown,
  nowMs = Date.now(),
): MailgunHandoffValidation {
  if (nowMs >= Date.parse(MAILGUN_HANDOFF_EXPIRES_AT)) {
    return { ok: false, reason: "expired" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "payload_invalid" };
  }

  const payload = value as Record<string, unknown>;
  if (payload.keyFingerprint !== MAILGUN_HANDOFF_KEY_FINGERPRINT) {
    return { ok: false, reason: "fingerprint_invalid" };
  }
  if (
    typeof payload.ciphertext !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(payload.ciphertext) ||
    payload.ciphertext.length > 512
  ) {
    return { ok: false, reason: "payload_invalid" };
  }

  try {
    const decoded = atob(payload.ciphertext);
    if (decoded.length !== RSA_CIPHERTEXT_BYTES) {
      return { ok: false, reason: "payload_invalid" };
    }
  } catch {
    return { ok: false, reason: "payload_invalid" };
  }
  return { ok: true, ciphertext: payload.ciphertext };
}

export async function verifyMailgunHandoffConsumerToken(
  value: string | null | undefined,
  expectedHash = MAILGUN_HANDOFF_CONSUMER_TOKEN_SHA256,
): Promise<boolean> {
  if (!value || value.length < 32 || value.length > 256) return false;
  if (!/^[a-f0-9]{64}$/u.test(expectedHash)) return false;

  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  const actualHash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return constantTimeEqual(actualHash, expectedHash);
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
