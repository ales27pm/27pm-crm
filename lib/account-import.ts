export type StoredAccountImport = {
  id: string;
  recordCount: number;
  requestHash: string | null;
};

export function classifyAccountImportResult(
  stored: StoredAccountImport | null,
  attemptedId: string,
  attemptedHash: string,
):
  | { kind: "unverifiable" }
  | { kind: "reused" }
  | { kind: "accepted"; imported: boolean; recordCount: number } {
  if (!stored?.requestHash) return { kind: "unverifiable" };
  if (stored.requestHash !== attemptedHash) return { kind: "reused" };
  return {
    kind: "accepted",
    imported: stored.id === attemptedId,
    recordCount: Number(stored.recordCount),
  };
}
