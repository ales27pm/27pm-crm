import type { CrmDatabase } from "./d1";
import { reconcileCakemailEventsBestEffort } from "./cakemail-event-store";
import { reconcileMailgunEventsBestEffort } from "./mailgun-event-reconciliation";
import type { OutboundProvider } from "./outbound-runtime";

export async function reconcileOutboundEventsBestEffort(
  db: CrmDatabase,
  provider: OutboundProvider,
  providerMessageId: string | null | undefined,
  externalMessageId: string | null | undefined,
): Promise<void> {
  if (provider === "cakemail") {
    await reconcileCakemailEventsBestEffort(
      db,
      providerMessageId,
      externalMessageId,
    );
    return;
  }
  await reconcileMailgunEventsBestEffort(db, externalMessageId);
}
