import { concatenateBytes } from "../lib/byte-utils.ts";

export class ResponseByteLimitError extends Error {
  constructor() {
    super("Response exceeded its byte limit.");
    this.name = "ResponseByteLimitError";
  }
}

export async function readBoundedResponseBytes(body, maximumBytes) {
  const reader = body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw new ResponseByteLimitError();
      }
      chunks.push(value);
    }
    return concatenateBytes(chunks, byteLength);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The caller owns outcome classification for stream failures.
    }
  }
}
