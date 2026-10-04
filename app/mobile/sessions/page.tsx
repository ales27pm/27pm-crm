import type { Metadata } from "next";
import { AccessScreen } from "@/app/components/access-screen";
import { MobileSessionsManager } from "@/app/components/mobile-sessions";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { isCrmOperator } from "@/app/operator-access";
import { crmDatabase } from "@/lib/d1";
import { listActiveMobileSessions } from "@/lib/mobile-auth-store";

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
  const sessions = await loadMobileSessions(user.email);
  if (!sessions) {
    return (
      <main className="mobile-authorization-screen">
        <section className="mobile-authorization-panel">
          <p className="mobile-authorization-kicker">27PM CRM · Sécurité mobile</p>
          <h1>Liste indisponible</h1>
          <p>La base mobile n’est pas encore disponible sur ce déploiement.</p>
        </section>
      </main>
    );
  }
  return <MobileSessionsManager initialSessions={sessions} />;
}

async function loadMobileSessions(email: string) {
  try {
    return await listActiveMobileSessions(crmDatabase(), email);
  } catch {
    return null;
  }
}
