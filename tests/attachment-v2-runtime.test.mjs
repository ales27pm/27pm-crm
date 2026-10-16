import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const ORIGIN = "https://crm.27pm.org";
const CHUNK = 2 * 1024 * 1024;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

// This synthetic adapter deliberately exercises request-neutral transfer code,
// not the production JWT/scanner authorization routes. No remote account or
// network service is involved: DB and BUCKET are local workerd bindings.
const ENTRY = `
import { createUpload, uploadStatus, getAttachment } from './lib/attachment-v2-store';
import { putUploadChunk, finishUpload, readAttachmentChunk, attachmentDownloadManifest } from './lib/attachment-v2-transfer';
import { attachmentV2ErrorResponse, sha256Hex } from './lib/attachment-v2-protocol';
const actor = {creator:'runtime-test@example.test',sessionId:'local-runtime-only'};
const now = new Date('2026-10-16T17:00:00.000Z');
export default { async fetch(request, env) {
 const url = new URL(request.url), parts = url.pathname.split('/').filter(Boolean);
 try {
  if (url.pathname === '/uploads' && request.method === 'POST')
   return Response.json(await createUpload(env.DB, await request.json(), actor, request.headers.get('idempotency-key'), now));
  if (parts[0] === 'uploads' && parts[2] === 'chunks')
   return Response.json(await putUploadChunk(env.DB,env.BUCKET,parts[1],Number(parts[3]),request.body,actor,now));
  if (parts[0] === 'uploads' && parts[2] === 'complete')
   return Response.json(await finishUpload(env.DB,env.BUCKET,parts[1],actor,now));
  if (parts[0] === 'uploads') return Response.json(await uploadStatus(env.DB,parts[1],actor,now));
  if (parts[0] === 'objects') {
   const row = await getAttachment(env.DB,parts[1]);
   if (!row) return new Response(null,{status:404});
   if (parts[2] === 'metadata') {
    const value = await env.BUCKET.head(row.storage_key);
    return Response.json({size:value.size,objectVersion:value.version,
     sha256ArrayBuffer:value.checksums.sha256 instanceof ArrayBuffer,
     fixedLengthStreamAvailable:typeof FixedLengthStream === 'function'});
   }
   if (parts[2] === 'replace') {
    const bytes = await request.arrayBuffer();
    await env.BUCKET.put(row.storage_key,bytes,{sha256:await sha256Hex(bytes)});
    return Response.json({ok:true});
   }
   if (parts[2] === 'chunks') {
    const chunk = await readAttachmentChunk(env.BUCKET,row,Number(parts[3]),url.searchParams.get('version'));
    return new Response(chunk.body,{headers:{'content-type':'application/octet-stream',
     'content-length':String(chunk.byteSize),'x-attachment-object-version':chunk.objectVersion}});
   }
   return Response.json(attachmentDownloadManifest(row));
  }
  if (url.pathname === '/native-checksum-probe') {
   try {await env.BUCKET.put('local-checksum-probe',new Uint8Array([1,2,3]),{sha256:'0'.repeat(64)});}
   catch {return Response.json({rejected:true});}
   return Response.json({rejected:false});
  }
  return new Response(null,{status:404});
 } catch(error) {return attachmentV2ErrorResponse(error);}
}};
`;

async function runtime(t) {
  const bundled = await build({ stdin: { contents: ENTRY, resolveDir: process.cwd(), sourcefile: "attachment-v2-local-runtime-entry.ts", loader: "ts" },
    bundle: true, format: "esm", platform: "browser", target: "es2022", write: false });
  const mf = new Miniflare(convertV4MiniflareOptions({ name: "attachment-runtime", modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-09-18", d1Databases: ["DB"], r2Buckets: ["BUCKET"], host: "127.0.0.1", port: 0 }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  for (const query of ["CREATE TABLE organizations(id text PRIMARY KEY,deleted_at text)",
    "CREATE TABLE deals(id text PRIMARY KEY)", "CREATE TABLE conversations(id text PRIMARY KEY)",
    "INSERT INTO organizations VALUES ('account-1',NULL)"]) await db.prepare(query).run();
  const migration = await readFile(new URL("../drizzle/0022_attachment_v2_uploads.sql", import.meta.url), "utf8");
  for (const statement of migration.split("--> statement-breakpoint").map(v => v.trim()).filter(Boolean)) await db.prepare(statement).run();
  return { mf, db };
}
async function manifest(bytes) {
  return { ownerKind: "account", ownerId: "account-1", fileName: "runtime.bin", contentType: "application/octet-stream",
    byteSize: bytes.length, sha256: sha(bytes), chunks: Array.from({ length: Math.ceil(bytes.length / CHUNK) }, (_, i) => {
      const part = bytes.subarray(i * CHUNK, (i + 1) * CHUNK);
      return { byteSize: part.length, sha256: sha(part) };
    }) };
}
async function post(mf, path, value, headers = {}) {
  return mf.dispatchFetch(ORIGIN + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value) });
}

test("actual local workerd D1/R2 accepts ten2MiB chunks, FixedLengthStream20MiB SHA-256 assembly and exact-version ranges", { timeout: 60000 }, async t => {
  const { mf, db } = await runtime(t);
  const bytes = Buffer.alloc(20 * 1024 * 1024, 97), input = await manifest(bytes);
  const creation = await post(mf, "/uploads", input, { "idempotency-key": "runtime-upload-1" });
  assert.equal(creation.status, 200, await creation.clone().text());
  const upload = await creation.json();
  assert.equal(upload.chunkCount, 10);
  for (let i = 9; i >= 0; i--) {
    const response = await mf.dispatchFetch(`${ORIGIN}/uploads/${upload.id}/chunks/${i}`, { method: "PUT",
      headers: { "content-type": "application/octet-stream" }, body: bytes.subarray(i * CHUNK, (i + 1) * CHUNK) });
    assert.equal(response.status, 200, await response.clone().text());
    await response.arrayBuffer();
  }
  const duplicate = await mf.dispatchFetch(`${ORIGIN}/uploads/${upload.id}/chunks/0`, { method: "PUT", body: bytes.subarray(0, CHUNK) });
  assert.equal(duplicate.status, 200, await duplicate.clone().text()); await duplicate.arrayBuffer();
  const completion = await post(mf, `/uploads/${upload.id}/complete`, {});
  assert.equal(completion.status, 200, await completion.clone().text());
  const completed = await completion.json();
  assert.equal(completed.state, "committed");
  const metaResponse = await mf.dispatchFetch(`${ORIGIN}/objects/${completed.attachmentId}/metadata`);
  const metadata = await metaResponse.json();
  assert.equal(metadata.sha256ArrayBuffer, true);
  assert.equal(metadata.fixedLengthStreamAvailable, true);
  assert.equal(metadata.size, bytes.length);
  const downloadManifest = await (await mf.dispatchFetch(`${ORIGIN}/objects/${completed.attachmentId}/manifest`)).json();
  const actual = createHash("sha256");
  for (let i = 0; i < 10; i++) {
    const response = await mf.dispatchFetch(`${ORIGIN}/objects/${completed.attachmentId}/chunks/${i}?version=${encodeURIComponent(downloadManifest.objectVersion)}`);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("x-attachment-object-version"), downloadManifest.objectVersion);
    const part = Buffer.from(await response.arrayBuffer());
    assert.equal(part.length, CHUNK); actual.update(part);
  }
  assert.equal(actual.digest("hex"), input.sha256);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM attachment_v2_objects").first()).n, 1);
  const replaced = await mf.dispatchFetch(`${ORIGIN}/objects/${completed.attachmentId}/replace`, { method: "POST", body: bytes });
  assert.equal(replaced.status, 200); await replaced.arrayBuffer();
  const drift = await mf.dispatchFetch(`${ORIGIN}/objects/${completed.attachmentId}/chunks/0?version=${encodeURIComponent(downloadManifest.objectVersion)}`);
  assert.equal(drift.status, 409);
  assert.equal((await drift.json()).error, "attachment_object_changed");
});

test("actual local workerd refuses oversized manifest, corrupt chunks and incorrect native R2 checksum", { timeout: 60000 }, async t => {
  const { mf, db } = await runtime(t), bytes = Buffer.from("hello"), input = await manifest(bytes);
  const oversized = await post(mf, "/uploads", { ...input, byteSize: 20971521 }, { "idempotency-key": "runtime-oversize" });
  assert.equal(oversized.status, 400); await oversized.arrayBuffer();
  const created = await post(mf, "/uploads", input, { "idempotency-key": "runtime-small-1" });
  const upload = await created.json();
  for (const [bad, expected] of [[Buffer.from("wrong"), 409], [Buffer.alloc(6), 413]]) {
    const response = await mf.dispatchFetch(`${ORIGIN}/uploads/${upload.id}/chunks/0`, { method: "PUT", body: bad });
    assert.equal(response.status, expected); await response.arrayBuffer();
  }
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM attachment_v2_chunks").first()).n, 0);
  const native = await mf.dispatchFetch(`${ORIGIN}/native-checksum-probe`);
  assert.deepEqual(await native.json(), { rejected: true });
});
