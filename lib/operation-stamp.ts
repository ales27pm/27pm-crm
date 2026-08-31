export function uniqueOperationTimestamp(now = new Date()): string {
  if (Number.isNaN(now.valueOf())) throw new TypeError("operation_timestamp_invalid");
  const entropy = crypto.getRandomValues(new Uint8Array(8));
  const decimalFraction = Array.from(entropy, (value) => String(value).padStart(3, "0")).join("");
  return now.toISOString().replace(/Z$/u, `${decimalFraction}Z`);
}
