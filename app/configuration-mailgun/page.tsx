import { AccessScreen } from "@/app/components/access-screen";
import { MailgunHandoffForm } from "@/app/components/mailgun-handoff-form";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { isCrmOperator } from "@/app/operator-access";

export const dynamic = "force-dynamic";

export default async function MailgunConfigurationPage() {
  const user = await getChatGPTUser();
  if (!user) return <AccessScreen state="signed-out" />;
  if (!isCrmOperator(user.email)) {
    return <AccessScreen state="denied" email={user.email} />;
  }

  return <MailgunHandoffForm operatorEmail={user.email} />;
}
