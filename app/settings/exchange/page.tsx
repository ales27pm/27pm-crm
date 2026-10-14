import type { Metadata } from "next";
import { AccessScreen } from "@/app/components/access-screen";
import { ExchangeConnection } from "@/app/components/exchange-connection";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { isCrmOperator } from "@/app/operator-access";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Connexion Exchange — 27PM CRM",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function ExchangeConnectionPage({
  searchParams,
}: {
  searchParams: Promise<{ complete?: string | string[] }>;
}) {
  const parameters = await searchParams;
  const returnTo = parameters.complete === "1"
    ? "/settings/exchange?complete=1" : "/settings/exchange";
  const user = await getChatGPTUser();
  if (!user) return <AccessScreen state="signed-out" returnTo={returnTo} />;
  if (!isCrmOperator(user.email)) {
    return <AccessScreen state="denied" email={user.email} returnTo={returnTo} />;
  }
  return <ExchangeConnection />;
}
