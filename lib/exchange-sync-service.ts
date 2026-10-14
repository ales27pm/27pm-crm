import "server-only";

import type { ExchangeServiceContext } from "./exchange-connection-service";
import { withExchangeAccess } from "./exchange-connection-service";
import {
  ExchangeGraphError,
  getExchangeFolder,
  getExchangeMessage,
  readExchangeDelta,
  type ExchangeGraphFolder,
  type ExchangeGraphMessage,
} from "./exchange-graph";
import {
  getExchangeSyncCursor,
  markExchangeMessagesRemoved,
  resetExchangeSyncCursor,
  saveExchangeSyncCursor,
  upsertExchangeMessageLink,
} from "./exchange-mail-store";
import { projectExchangeMessage } from "./exchange-message-import";

export type ExchangeFolderSyncResult = {
  folder: ExchangeGraphFolder;
  processed: number;
  removed: number;
  ambiguous: number;
  externalSent: number;
  more: boolean;
  deltaReset: boolean;
};

/** One bounded delta page. The caller repeats only when `more` is true. */
export async function syncExchangeFolder(
  context: ExchangeServiceContext,
  folderName: ExchangeGraphFolder,
): Promise<ExchangeFolderSyncResult> {
  return withExchangeAccess(context, async (access) => {
    const folder = await getExchangeFolder(access, folderName);
    const cursor = await getExchangeSyncCursor(context.db, access.scope, folder.id);
    let page;
    try {
      page = await readExchangeDelta(
        access,
        folder.id,
        cursor?.nextLink ?? cursor?.deltaLink ?? undefined,
      );
    } catch (error) {
      if (error instanceof ExchangeGraphError && error.code === "exchange_graph_delta_reset" && cursor) {
        const reset = await resetExchangeSyncCursor(context.db, {
          scope: access.scope,
          guard: access.guard,
          folderId: folder.id,
          expectedVersion: cursor.version,
        });
        if (!reset) throw new Error("exchange_sync_cursor_reset_failed");
        return {
          folder: folderName,
          processed: 0,
          removed: 0,
          ambiguous: 0,
          externalSent: 0,
          more: true,
          deltaReset: true,
        };
      }
      throw error;
    }

    const detailed = await loadDetails(access, page.messages);
    let processed = 0;
    let ambiguous = 0;
    let externalSent = 0;
    for (const message of detailed) {
      await access.assertCurrent();
      const projection = await projectExchangeMessage(context.db, folderName, message, {
        scope: access.scope,
        guard: access.guard,
        now: access.now(),
      });
      const stored = await upsertExchangeMessageLink(context.db, {
        scope: access.scope,
        guard: access.guard,
        message,
        projection,
      });
      if (!stored) throw new Error("exchange_message_link_persistence_failed");
      processed += 1;
      if (projection?.classification === "ambiguous") ambiguous += 1;
      if (projection?.classification === "external_sent") externalSent += 1;
    }

    const removed = await markExchangeMessagesRemoved(context.db, {
      scope: access.scope,
      guard: access.guard,
      folderId: folder.id,
      graphMessageIds: page.removedIds,
    });
    await access.assertCurrent();
    const advanced = await saveExchangeSyncCursor(context.db, {
      scope: access.scope,
      guard: access.guard,
      folderId: folder.id,
      expectedVersion: cursor?.version ?? null,
      nextLink: page.nextLink,
      deltaLink: page.deltaLink,
    });
    if (!advanced) throw new Error("exchange_sync_cursor_persistence_failed");
    return {
      folder: folderName,
      processed,
      removed,
      ambiguous,
      externalSent,
      more: Boolean(page.nextLink),
      deltaReset: false,
    };
  });
}

async function loadDetails(
  access: Parameters<typeof getExchangeMessage>[0],
  messages: ExchangeGraphMessage[],
): Promise<ExchangeGraphMessage[]> {
  const result: ExchangeGraphMessage[] = [];
  for (let offset = 0; offset < messages.length; offset += 4) {
    const batch = messages.slice(offset, offset + 4);
    // A detail 404 is not proof that another tracked folder will project the
    // item. Failing the page leaves the cursor unchanged, so a transient Graph
    // race cannot silently discard a new inbound message.
    const loaded = await Promise.all(batch.map((message) =>
      getExchangeMessage(access, message.id)));
    result.push(...loaded);
  }
  return result;
}
