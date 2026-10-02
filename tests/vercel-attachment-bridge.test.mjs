import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Vercel never proxies attachment bytes and the Worker owns the direct path", async () => {
  const [proxy, worker, legacyRoute, ticketRoute] = await Promise.all([
    read("proxy.ts"),
    read("worker/index.ts"),
    read("app/api/attachments/[id]/route.ts"),
    read("app/api/attachments/[id]/download-ticket/route.ts"),
  ]);

  assert.match(proxy, /matcher: \["\/api\//u);
  assert.doesNotMatch(proxy, /downloads\/attachments/u);
  assert.match(worker, /handleAttachmentDownloadRequest/u);
  assert.ok(
    worker.indexOf("handleAttachmentDownloadRequest") < worker.indexOf("handler.fetch"),
    "the direct download must be handled before Vinext",
  );
  assert.doesNotMatch(legacyRoute, /getPrivateObjectBucket|\.get\(/u);
  assert.match(legacyRoute, /attachment_download_ticket_required/u);
  assert.match(ticketRoute, /requireSameOriginOperatorRequest\(request\)/u);
  assert.match(ticketRoute, /CRM_ATTACHMENT_DOWNLOAD_SIGNING_KEY/u);
  assert.match(ticketRoute, /CRM_ATTACHMENT_DOWNLOAD_ORIGIN/u);
  assert.doesNotMatch(ticketRoute, /CRM_MOBILE_TOKEN_SIGNING_KEY/u);
});

test("attachment bearer secrets stay on the Worker side of the Vercel split", async () => {
  const [example, nextConfig, proxy, runbook, viteConfig] = await Promise.all([
    read(".env.example"),
    read("next.config.ts"),
    read("proxy.ts"),
    read("docs/vercel-migration/README.md"),
    read("vite.config.ts"),
  ]);
  assert.match(example, /CRM_ATTACHMENT_DOWNLOAD_SIGNING_KEY=/u);
  assert.doesNotMatch(example, /NEXT_PUBLIC_CRM_ATTACHMENT/u);
  assert.doesNotMatch(`${nextConfig}\n${proxy}`, /CRM_ATTACHMENT_DOWNLOAD_SIGNING_KEY/u);
  assert.match(runbook, /CRM_ATTACHMENT_DOWNLOAD_SIGNING_KEY/u);
  assert.match(runbook, /redact_query_string/u);
  assert.match(runbook, /4\.5 MB/u);
  assert.match(
    viteConfig,
    /observability:\s*\{[\s\S]*enabled:\s*true,[\s\S]*redact_query_string:\s*true/u,
  );
});

test("the Web thread lazily lists attachments and immediately follows a clean ticket", async () => {
  const [listRoute, threadView, types] = await Promise.all([
    read("app/api/attachments/route.ts"),
    read("app/components/thread-view.tsx"),
    read("app/crm-types.ts"),
  ]);
  assert.match(listRoute, /requireOperatorRequest\(request\)/u);
  assert.doesNotMatch(listRoute, /OperatorOrMobile|r2_key|sha256/u);
  assert.match(listRoute, /JOIN messages message ON message\.id = attachment\.message_id/u);
  assert.match(listRoute, /message\.conversation_id = \?/u);
  assert.match(listRoute, /safeAttachmentDisplayName\(attachment\.fileName\)/u);
  assert.match(types, /export type CrmAttachment/u);
  assert.match(
    threadView,
    /fetch\(\s*`\/api\/attachments\?conversationId=\$\{encodeURIComponent\(/u,
  );
  assert.match(
    threadView,
    /fetch\(\s*`\/api\/attachments\/\$\{encodeURIComponent\(attachment\.id\)\}\/download-ticket`/u,
  );
  assert.match(threadView, /method: "POST"/u);
  assert.match(threadView, /anchor\.referrerPolicy = "no-referrer"/u);
  assert.doesNotMatch(threadView, /localStorage|sessionStorage/u);
});
