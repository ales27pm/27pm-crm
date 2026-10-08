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
    worker.indexOf("const attachmentDownload = await handleAttachmentDownloadRequest") <
      worker.indexOf("const preparedRequest = await prepareInternalApiRequest"),
    "the bounded direct download handler must run before the generic edge body reader",
  );
  assert.doesNotMatch(legacyRoute, /getPrivateObjectBucket|\.get\(/u);
  assert.match(legacyRoute, /attachment_download_ticket_required/u);
  assert.match(ticketRoute, /requireSameOriginOperatorRequest\(request\)/u);
  assert.match(ticketRoute, /CRM_ATTACHMENT_DOWNLOAD_SIGNING_KEY/u);
  assert.match(ticketRoute, /CRM_ATTACHMENT_DOWNLOAD_ORIGIN/u);
  assert.doesNotMatch(ticketRoute, /CRM_MOBILE_TOKEN_SIGNING_KEY/u);
  assert.match(ticketRoute, /downloadAction: downloadAction\.toString\(\)/u);
  assert.match(ticketRoute, /ticket: ticket\.token/u);
  assert.match(ticketRoute, /method: "POST"/u);
  assert.doesNotMatch(ticketRoute, /searchParams|\?ticket=/u);
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

test("the Web thread lazily lists attachments and posts a clean ticket directly to the Worker", async () => {
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
  assert.match(threadView, /payload\.method !== "POST"/u);
  assert.match(threadView, /ad2\\\./u);
  assert.match(threadView, /typeof payload\.ticket !== "string"/u);
  assert.match(threadView, /url\.protocol !== "https:"/u);
  assert.match(threadView, /url\.username/u);
  assert.match(threadView, /url\.password/u);
  assert.match(threadView, /url\.search/u);
  assert.match(threadView, /url\.hash/u);
  assert.match(threadView, /document\.createElement\("form"\)/u);
  assert.match(threadView, /form\.method = "POST"/u);
  assert.match(threadView, /form\.enctype = "application\/x-www-form-urlencoded"/u);
  assert.match(threadView, /form\.autocomplete = "off"/u);
  assert.match(threadView, /form\.target = "_self"/u);
  assert.match(threadView, /form\.action = ticket\.downloadAction/u);
  assert.match(threadView, /document\.createElement\("input"\)/u);
  assert.match(threadView, /input\.type = "hidden"/u);
  assert.match(threadView, /input\.name = "ticket"/u);
  assert.match(threadView, /input\.value = ticket\.ticket/u);
  assert.match(threadView, /form\.submit\(\)/u);
  assert.match(threadView, /window\.setTimeout\(\(\) => form\.remove\(\), 0\)/u);
  assert.doesNotMatch(
    threadView,
    /document\.createElement\("a"\)|anchor\.|URL\.createObjectURL|\.blob\(|fetch\(\s*ticket\.downloadAction|\?ticket=|localStorage|sessionStorage/u,
  );
});
