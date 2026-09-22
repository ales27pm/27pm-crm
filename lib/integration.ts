import type { CrmDatabase, D1Row, PreparedQuery } from './d1';
import { createAccount, updateAccount, createContact, updateContact, parseAccountInput, parseContactInput, entityId } from './crm-accounts';
import { boundedRequest } from './bounded-request';
import { readJsonObject, optionalTrimmedString, validIsoTimestamp } from './http';

export type IntegrationConfig = { token: string | null; scopes: string | null; subject: string | null };
const resources = ['organizations', 'contacts', 'deals', 'tasks', 'documents'] as const;
type Resource = typeof resources[number];
const fields: Record<Resource, Record<string, string>> = {
  organizations: { id:'id', name:'name', website:'website', sourceLabel:'source_label', sourceUrl:'source_url', sourceDate:'source_date', score:'score', priority:'priority', budgetMinCents:'budget_min_cents', budgetMaxCents:'budget_max_cents', ownerEmail:'owner_email', doNotContact:'do_not_contact', nextFollowUpAt:'next_follow_up_at', nextStep:'next_step', notes:'notes', updatedAt:'updated_at' },
  contacts: { id:'id', name:'display_name', email:'email', organizationId:'organization_id', phone:'phone', role:'role', sourceLabel:'source', doNotContact:'do_not_contact', doNotCall:'do_not_call', unsubscribedAt:'unsubscribed_at', updatedAt:'updated_at' },
  deals: { id:'id', conversationId:'conversation_id', organizationId:'organization_id', contactId:'contact_id', stage:'stage', projectType:'project_type', nextAction:'next_action', nextActionAt:'next_action_at', note:'note', estimatedValueCents:'estimated_value_cents', updatedAt:'updated_at' },
  tasks: { id:'id', conversationId:'conversation_id', dealId:'deal_id', title:'title', status:'status', dueAt:'due_at', completedAt:'completed_at', contactAction:'contact_action', contactChannel:'contact_channel', updatedAt:'updated_at' },
  documents: { id:'id', dealId:'deal_id', title:'title', content:'content', mediaType:'media_type', status:'status', updatedAt:'updated_at' },
};
const table = (r: Resource) => r === 'documents' ? 'integration_documents' : r;
const visible = (r: Resource) => r === 'organizations' || r === 'contacts' ? 'deleted_at IS NULL' : r === 'tasks' ? "contact_action=0 AND contact_channel='internal'" : '1=1';
const projection = (r: Resource) => Object.entries(fields[r]).map(([alias,col]) => `${col} AS "${alias}"`).join(',');
const jsonProjection = (r: Resource) => `json_object(${Object.entries(fields[r]).map(([alias,col]) => `'${alias}',${col}`).join(',')})`;
class Failure extends Error { constructor(public status: number, public code: string) { super(code); } }
function fail(status: number, code: string): never { throw new Failure(status, code); }
const reply = (body: unknown, status=200, replay=false) => Response.json(body, { status, headers: { 'cache-control':'private, no-store', ...(replay ? {'idempotency-replayed':'true'} : {}) } });
const digest = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))).map(x=>x.toString(16).padStart(2,'0')).join('');
const canonical = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical((value as Record<string,unknown>)[k])}`).join(',')}}`;

export async function handleIntegration(request: Request, db: CrmDatabase, config: IntegrationConfig): Promise<Response> {
  try {
    if (!config.token || config.token.length < 32 || !config.scopes || !config.subject || !/^[a-zA-Z0-9_-]{1,64}$/.test(config.subject)) fail(503,'integration_unconfigured');
    const supplied = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
    const expectedHash = await digest(config.token);
    const actualHash = await digest(supplied ?? '');
    let difference = 0;
    for (let i=0; i<expectedHash.length; i++) difference |= expectedHash.charCodeAt(i) ^ actualHash.charCodeAt(i);
    if (!supplied || difference) fail(401,'integration_authentication_required');
    if (request.method !== 'POST') fail(405,'method_not_allowed');
    const bounded = await boundedRequest(request, 65536);
    if (!bounded) fail(413,'request_too_large');
    const payload = await readJsonObject(bounded);
    if (!payload || typeof payload.operation !== 'string') fail(400,'operation_invalid');
    if (Object.keys(payload).some(k=>!['operation','id','query','limit','data'].includes(k))) fail(400,'unknown_command_field');
    const [resource, action, extra] = payload.operation.split('.');
    if (extra || !resources.includes(resource as Resource) || !['search','read','create','update'].includes(action)) fail(400,'operation_invalid');
    const r = resource as Resource;
    const write = action === 'create' || action === 'update';
    if (!config.scopes.split(/[\s,]+/).includes(`${r}:${write ? 'write' : 'read'}`)) fail(403,'integration_scope_forbidden');
    const actor = `integration:${config.subject}`;
    const id = entityId(payload.id);
    if ((action === 'read' || action === 'update') && !id) fail(400,'entity_id_invalid');
    if (!write) {
      const operationId = crypto.randomUUID();
      const query = payload.query === undefined ? '' : optionalTrimmedString(payload.query,200);
      if (query === undefined) fail(400,'query_invalid');
      const limit = payload.limit ?? 20;
      if (!Number.isInteger(limit) || Number(limit)<1 || Number(limit)>50) fail(400,'limit_invalid');
      const searchColumns: Record<Resource,string[]> = {organizations:['name'],contacts:['display_name','email'],deals:['project_type','note'],tasks:['title'],documents:['title']};
      const search = searchColumns[r].map(c=>`instr(lower(coalesce(${c},'')),lower(?))>0`).join(' OR ');
      const statement = action === 'read'
        ? db.prepare(`SELECT ${projection(r)} FROM ${table(r)} WHERE ${visible(r)} AND id=?`).bind(id)
        : db.prepare(`SELECT ${projection(r)} FROM ${table(r)} WHERE ${visible(r)} AND (${search}) ORDER BY id LIMIT ?`).bind(...searchColumns[r].map(()=>query ?? ''),limit);
      const results = await db.batch([statement,db.prepare('INSERT INTO audit_entries (id,actor_email,action,entity_type,entity_id,details_json) VALUES (?,?,?,?,?,?)').bind(operationId,actor,`integration.${action}`,r,id ?? 'search',JSON.stringify({operationId}))]);
      const items = results[0].results ?? [];
      if (action === 'read' && !items.length) fail(404,'entity_not_found');
      return reply(action === 'read' ? {item:items[0]} : {items});
    }
    const key = request.headers.get('idempotency-key');
    if (!key || !/^[a-zA-Z0-9._:-]{8,128}$/.test(key)) fail(400,'idempotency_key_required');
    const fingerprint = await digest(canonical(payload));
    const replay = async () => {
      const old = await db.prepare('SELECT request_hash,response_json FROM integration_operations WHERE subject=? AND idempotency_key=?').bind(config.subject,key).first<{request_hash:string;response_json:string}>();
      if (!old) return null;
      if (old.request_hash !== fingerprint) fail(409,'idempotency_conflict');
      return reply(JSON.parse(old.response_json),200,true);
    };
    const previous = await replay(); if (previous) return previous;
    const data = payload.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400,'data_invalid');
    const operationId = crypto.randomUUID();
    const staged = stageDatabase(db,operationId);
    let target = id;
    if (r === 'organizations') {
      const parsed = parseAccountInput(data as Record<string,unknown>); if (!parsed.ok) fail(400,parsed.code);
      if (action === 'create') target = (await createAccount(staged.db,parsed.value,actor)).id;
      else if (!await updateAccount(staged.db,id!,parsed.value,actor)) fail(404,'entity_not_found');
    } else if (r === 'contacts') {
      const parsed = parseContactInput(data as Record<string,unknown>); if (!parsed.ok) fail(400,parsed.code);
      if (action === 'create') { const created = await createContact(staged.db,parsed.value,actor); if (!created) fail(404,'organization_not_found'); target=created.id; }
      else { const result=await updateContact(staged.db,id!,parsed.value,actor); if(result!=='updated') fail(result==='not_found'?404:409,result); }
    } else target = await prepareSimple(staged.db,r,action,id,data as Record<string,unknown>);
    const receipt = db.prepare(`UPDATE integration_operations SET response_json=(SELECT json_object('operationId',?,'resource',?,'persisted',json('true'),'item',${jsonProjection(r)}) FROM ${table(r)} WHERE id=? AND ${visible(r)}) WHERE id=?`).bind(operationId,r,target,operationId);
    try {
      await db.batch([
        db.prepare('INSERT INTO integration_operations (id,subject,idempotency_key,request_hash,response_json) VALUES (?,?,?,?,?)').bind(operationId,config.subject,key,fingerprint,'{}'),
        ...staged.guards,...staged.writes,
        db.prepare('INSERT INTO audit_entries (id,actor_email,action,entity_type,entity_id,details_json) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(),actor,`integration.${action}`,r,target,JSON.stringify({operationId,requestHash:fingerprint})),
        receipt,
      ]);
    } catch (error) {
      const recovered = await replay(); if(recovered) return recovered;
      if (/constraint|suppressed_channel|unique/i.test(String(error))) fail(409,'write_conflict');
      throw error;
    }
    const persisted = await replay();
    if (!persisted) fail(500,'receipt_missing');
    return reply(await persisted.json(),action==='create'?201:200);
  } catch(error) { return reply({error:error instanceof Failure ? error.code : 'integration_failed'},error instanceof Failure ? error.status : 503); }
}

// Reuse existing services while committing their writes, audit and receipt in ONE D1 batch.
// Every pre-write read is rechecked inside that batch, preventing stale authorization/state.
function stageDatabase(source: CrmDatabase, operationId:string) {
  const guards: PreparedQuery[]=[]; const writes: PreparedQuery[]=[];
  const quoted = (v:string) => `"${v.replaceAll('"','""')}"`;
  const prepare = (sql:string):PreparedQuery => {
    let values:unknown[]=[];
    const assertRows = (rows:D1Row[]) => {
      const keys = rows.length ? Object.keys(rows[0]) : [];
      const current = keys.length ? `(SELECT json_group_array(json_object(${keys.map(k=>`'${k.replaceAll("'","''")}',${quoted(k)}`).join(',')})) FROM (${sql}))` : `(SELECT CASE WHEN EXISTS(${sql}) THEN 'unexpected' ELSE '[]' END)`;
      guards.push(source.prepare(`UPDATE integration_operations SET valid=CASE WHEN ${current}=? THEN 1 ELSE 0 END WHERE id=?`).bind(...values,JSON.stringify(rows),operationId));
    };
    const query:PreparedQuery={ bind(...v){values=v;return query;}, async first<T=D1Row>() {const row=await source.prepare(sql).bind(...values).first<T>();assertRows(row?[row as D1Row]:[]);return row;},async all<T=D1Row>(){const result=await source.prepare(sql).bind(...values).all<T>();assertRows(result.results as D1Row[]);return result;},async run(){fail(500,'staging_direct_write_forbidden');} };
    // Keep the actual prepared statement for D1, not the read-tracking wrapper.
    captured.set(query,()=>source.prepare(sql).bind(...values));
    return query;
  };
  const captured = new WeakMap<PreparedQuery,()=>PreparedQuery>();
  const db:CrmDatabase={prepare,async batch(statements){writes.push(...statements.map(s=>{const resolve=captured.get(s);if(!resolve) fail(500,'foreign_statement');return resolve();}));return statements.map(()=>({success:true,meta:{changes:1}}));}};
  return {db,guards,writes};
}

async function prepareSimple(db:CrmDatabase,r:'deals'|'tasks'|'documents',action:string,id:string|null,data:Record<string,unknown>) {
  const allowed: Record<typeof r,string[]> = {deals:['organizationId','contactId','stage','projectType','nextAction','nextActionAt','note','estimatedValueCents'],tasks:['dealId','conversationId','title','status','dueAt'],documents:['dealId','title','content']};
  if(Object.keys(data).some(k=>!allowed[r].includes(k))) fail(400,'unknown_data_field');
  if(!Object.keys(data).length) fail(400,'no_changes');
  const target=id ?? crypto.randomUUID();
  let existing:D1Row|null=null;
  if(action==='update') { existing=await db.prepare(`SELECT * FROM ${table(r)} WHERE id=? AND ${visible(r)}`).bind(id).first();if(!existing) fail(404,'entity_not_found'); }
  const values:Record<string,unknown>={};
  for(const [key,max] of [['title',300],['content',20000],['projectType',120],['nextAction',500],['note',10000]] as const) {
    if(!(key in data))continue;
    const value=optionalTrimmedString(data[key],max);
    if(value===undefined || (['title','content'].includes(key)&&!value)) fail(400,`${key}_invalid`);
    values[fields[r][key]]=key==='note' ? value??'' : value;
  }
  for(const key of ['nextActionAt','dueAt'] as const) if(key in data){const value=validIsoTimestamp(data[key]);if(value===undefined)fail(400,`${key}_invalid`);values[fields[r][key]]=value;}
  if('stage' in data){if(!['new','qualified','discovery','proposal','won','lost','archived'].includes(String(data.stage)))fail(400,'stage_invalid');values.stage=data.stage;}
  if('estimatedValueCents' in data){const v=data.estimatedValueCents;if(v!==null&&(!Number.isSafeInteger(v)||Number(v)<0||Number(v)>1000000000))fail(400,'value_invalid');values.estimated_value_cents=v;}
  if('status' in data){if(!['open','done','cancelled'].includes(String(data.status)))fail(400,'status_invalid');values.status=data.status;values.completed_at=data.status==='done'?new Date().toISOString():null;}
  if(r==='deals'){
    const organizationId=entityId(data.organizationId ?? existing?.organization_id);
    if(!organizationId)fail(400,'organization_required');
    const org=await db.prepare('SELECT id,name FROM organizations WHERE id=? AND deleted_at IS NULL').bind(organizationId).first<{id:string;name:string}>();
    if(!org)fail(404,'organization_not_found');
    const contactId=data.contactId===null?null:entityId(data.contactId ?? existing?.contact_id);
    if(data.contactId!==undefined&&data.contactId!==null&&!contactId)fail(400,'contact_id_invalid');
    if(contactId&&!await db.prepare('SELECT id FROM contacts WHERE id=? AND organization_id=? AND deleted_at IS NULL').bind(contactId,organizationId).first())fail(409,'contact_organization_mismatch');
    values.organization_id=organizationId; values.contact_id=contactId;
    if(action==='create'){
      const conversation=crypto.randomUUID();values.conversation_id=conversation;
      await db.batch([db.prepare("INSERT INTO conversations (id,mailbox_id,contact_id,subject,normalized_subject,thread_key,is_unread,last_message_at) VALUES (?,'mailbox_bonjour',?,?,lower(trim(?)),?,0,?)").bind(conversation,contactId,org.name,org.name,`integration:${target}`,new Date().toISOString())]);
    }else await db.batch([db.prepare('UPDATE conversations SET contact_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(contactId,existing!.conversation_id)]);
  } else {
    const dealId=entityId(data.dealId ?? existing?.deal_id);
    const conversationId=entityId(data.conversationId ?? existing?.conversation_id);
    if('dealId' in data&&!entityId(data.dealId))fail(400,'deal_id_invalid');
    if('conversationId' in data&&!entityId(data.conversationId))fail(400,'conversation_id_invalid');
    const deal=dealId?await db.prepare('SELECT id,conversation_id FROM deals WHERE id=?').bind(dealId).first<{id:string;conversation_id:string}>():null;
    if(dealId&&!deal)fail(404,'deal_not_found');
    if(r==='documents') {if(!deal)fail(400,'deal_required');values.deal_id=deal.id;}
    else {
      const parent=deal?.conversation_id ?? conversationId;
      if(!parent)fail(400,'task_parent_required');
      if(conversationId&&parent!==conversationId)fail(409,'task_parent_mismatch');
      if(!await db.prepare('SELECT id FROM conversations WHERE id=?').bind(parent).first())fail(404,'conversation_not_found');
      values.deal_id=dealId;values.conversation_id=parent;values.contact_action=0;values.contact_channel='internal';
    }
    if(action==='create'&&!values.title)fail(400,'title_required');
    if(r==='documents'&&action==='create'&&!values.content)fail(400,'content_required');
  }
  if(action==='create') {const entries=Object.entries({id:target,...values});await db.batch([db.prepare(`INSERT INTO ${table(r)} (${entries.map(([k])=>k).join(',')}) VALUES (${entries.map(()=>'?').join(',')})`).bind(...entries.map(([,v])=>v))]);}
  else {const entries=Object.entries(values);await db.batch([db.prepare(`UPDATE ${table(r)} SET ${entries.map(([k])=>`${k}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(...entries.map(([,v])=>v),target)]);}
  return target;
}
