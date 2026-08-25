import { crmDatabase } from "@/lib/d1";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = crmDatabase();
    await db.prepare("SELECT 1 AS healthy FROM mailboxes LIMIT 1").first();
    return Response.json({ status: "ok" });
  } catch {
    return Response.json({ status: "degraded" }, { status: 503 });
  }
}
