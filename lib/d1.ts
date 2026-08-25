import "server-only";

import { getD1 } from "@/db";

export type D1Row = Record<string, unknown>;

export interface PreparedQuery {
  bind(...values: unknown[]): PreparedQuery;
  first<T = D1Row>(): Promise<T | null>;
  all<T = D1Row>(): Promise<{ results: T[]; success: boolean }>;
  run<T = D1Row>(): Promise<{
    results?: T[];
    success: boolean;
    meta: { changes?: number };
  }>;
}

export interface CrmDatabase {
  prepare(query: string): PreparedQuery;
  batch<T = D1Row>(
    statements: PreparedQuery[],
  ): Promise<
    Array<{
      results?: T[];
      success: boolean;
      meta: { changes?: number };
    }>
  >;
}

export function crmDatabase(): CrmDatabase {
  return getD1() as unknown as CrmDatabase;
}

export function changedRows(result: { meta?: { changes?: number } }): number {
  return result.meta?.changes ?? 0;
}

export function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint failed|constraint failed/i.test(message);
}
