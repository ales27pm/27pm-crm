import { AccessScreen } from "./components/access-screen";
import { CrmApp } from "./components/crm-app";
import { getChatGPTUser } from "./chatgpt-auth";
import { demoDashboard, emptyDashboard } from "./demo-data";
import { isCrmOperator } from "./operator-access";
import { runtimeString } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getChatGPTUser();

  if (!user) {
    return <AccessScreen state="signed-out" />;
  }

  if (!isCrmOperator(user.email)) {
    return <AccessScreen state="denied" email={user.email} />;
  }

  return (
    <CrmApp
      initialData={runtimeString("CRM_DEMO_MODE") === "true" ? demoDashboard : emptyDashboard}
      operator={{ displayName: user.displayName, email: user.email }}
    />
  );
}
