const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;

export function isWellFormedUnicode(value: string): boolean {
  return !UNPAIRED_SURROGATE.test(value);
}
