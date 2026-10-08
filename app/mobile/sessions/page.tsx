import type { Metadata } from "next";
import { AccessScreen } from "@/app/components/access-screen";
import { MobileSessionsManager } from "@/app/components/mobile-sessions";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { isCrmOperator } from "@/app/operator-access";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Appareils autorisés — 27PM CRM",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function MobileSessionsPage() {
  const returnTo = "/mobile/sessions";
  const user = await getChatGPTUser();
  if (!user) return <AccessScreen state="signed-out" returnTo={returnTo} />;
  if (!isCrmOperator(user.email)) {
    return <AccessScreen state="denied" email={user.email} returnTo={returnTo} />;
  }
  return <MobileSessionsManager />;
}
