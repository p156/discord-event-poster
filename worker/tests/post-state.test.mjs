import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.mjs';
import {fixture,payload,TestStorage,receipt} from './post-fixtures.mjs';
import {verifyOperation,signOperation,RETENTION_MS,payloadHash,internalProof} from '../src/post-keys.mjs';
const originalFetch=globalThis.fetch;
before(()=>{globalThis.fetch=()=>{throw new Error('REAL_DISCORD_DISABLED');};});after(()=>{globalThis.fetch=originalFetch;});
const record=(h,i)=>h.storage.data.get('posts:operation:'+i.operationId);
test('signed intent commits minimal 30-day record, canonical payload hash and authenticated status',async()=>{
 const h=await fixture(),i=await h.issue();assert.equal(i.response.status,201);assert.equal(h.writes,0);assert.equal(i.status,'not_started');const c=await verifyOperation(i.idempotencyKey,h.env.SESSION_SIGNING_KEY);assert.equal(c.expiresAt-c.issuedAt,RETENTION_MS);assert.equal(c.payloadHash,await payloadHash(payload()));assert.equal((await h.status(i)).status,200);
 const saved=JSON.stringify([...h.storage.data]);assert.ok(!saved.includes(h.env.DISCORD_BOT_TOKEN));assert.ok(!saved.includes(payload().content));assert.ok(!saved.includes(h.token));assert.ok(!saved.includes(i.idempotencyKey));assert.equal(record(h,i).attempt,0);
});
test('same-key parallel tabs, repeated requests and recreated Workers produce one write',async()=>{
 const h=await fixture(),i=await h.issue();const rs=await Promise.all(Array.from({length:12},()=>h.submit(i)));assert.equal(h.writes,1);assert.ok(rs.every(r=>[200,201,202].includes(r.status)));h.restart();assert.equal((await h.submit(i)).status,200);assert.equal((await (await h.status(i)).json()).status,'succeeded');assert.equal(h.writes,1);
 assert.ok(h.storage.events.indexOf('sync')<h.storage.events.indexOf('DISCORD_WRITE'));assert.equal(record(h,i).attempt,1);
});
test('same key with different content conflicts; intentional new operation may post same content',async()=>{
 const h=await fixture(),i=await h.issue();assert.equal((await h.submit(i,{...payload(),content:'changed'})).status,409);assert.equal(h.writes,0);await h.submit(i);const j=await h.issue();assert.notEqual(i.operationId,j.operationId);await h.submit(j);assert.equal(h.writes,2);
});
test('all sessions share 10 slots under 11 parallel submissions; GET/replay consumes no slot',async()=>{
 const h=await fixture(),other=await h.session(),intents=await Promise.all(Array.from({length:11},()=>h.issue()));const responses=await Promise.all(intents.map((i,n)=>h.submit(i,payload(),n%2?other:h.token)));
 assert.equal(h.writes,10);assert.equal(responses.filter(r=>r.status===429).length,1);const denied=responses.findIndex(r=>r.status===429);assert.match(responses[denied].headers.get('Retry-After'),/^\d+$/);assert.equal((await responses[denied].json()).error.code,'APP_RATE_LIMITED');
 const done=intents.find((i,n)=>n!==denied);await h.status(done);await h.submit(done);assert.equal(h.storage.data.get('posts:rate').slots.length,10);assert.equal(h.writes,10);
});
test('sliding window expires exactly at 60s and backwards clock never releases quota early',async()=>{
 const real=Date.now,start=real();Date.now=()=>start;
 try{const h=await fixture();for(let n=0;n<10;n++)await h.submit(await h.issue());const i=await h.issue();Date.now=()=>start+59999;assert.equal((await h.submit(i)).status,429);Date.now=()=>start-1;assert.equal((await h.submit(i)).status,400);Date.now=()=>start+60000;assert.equal((await h.submit(i)).status,201);assert.equal(h.writes,11);h.restart();Date.now=()=>start+59999;const j=await h.issue();await h.submit(j);assert.equal(h.storage.data.get('posts:rate').lastNow,start+60000);}finally{Date.now=real;}
});
test('intent, preparing, sending, quota and sync persistence failures stop before POST',async()=>{
 for(const point of ['intent','preparing','sending','rate','sync']){const h=await fixture();if(point==='intent')h.storage.fail=(k,v)=>k.startsWith('posts:operation:')&&v.status==='not_started';const i=await h.issue();if(point==='intent'){assert.equal(i.response.status,503);assert.equal(i.idempotencyKey,undefined);}else{h.storage.fail=(k,v)=>point==='sync'?k==='sync':point==='rate'?k==='posts:rate':k.startsWith('posts:operation:')&&v.status===point;assert.equal((await h.submit(i)).status,503);}assert.equal(h.writes,0);}
 const h=await fixture();await h.submit(await h.issue());h.storage.data.delete('posts:rate');const i=await h.issue();assert.equal((await h.submit(i)).status,503);assert.equal(h.writes,1,'lost shared quota must not reset to empty');
});
test('success result persistence failure becomes unknown; replay never writes again',async()=>{
 const h=await fixture(),i=await h.issue();h.storage.fail=(k,v)=>k.startsWith('posts:operation:')&&v.status==='succeeded';const r=await h.submit(i);assert.equal(r.status,502);assert.equal((await r.json()).status,'unknown');assert.equal(h.writes,1);h.storage.fail=null;h.restart();assert.equal((await h.submit(i)).status,202);assert.equal(h.writes,1);
 const real=Date.now;try{Date.now=()=>record(h,i).sendDeadline;assert.equal((await (await h.status(i)).json()).status,'unknown');assert.equal((await h.submit(i)).status,502);}finally{Date.now=real;}assert.equal(h.writes,1);
});
test('sending commit followed by crash before fetch never grants a second send',async()=>{
 const h=await fixture(),i=await h.issue();i.claims=await verifyOperation(i.idempotencyKey,h.env.SESSION_SIGNING_KEY);const reserve=await(await h.internal('post.reserve',i)).json();const begin=await(await h.internal('post.begin',i,{leaseId:reserve.leaseId})).json();assert.equal(begin.sendAllowed,true);h.restart();assert.equal((await h.submit(i)).status,202);assert.equal(h.writes,0);assert.equal(h.storage.data.get('posts:rate').slots.length,1);
 const replay=await(await h.internal('post.begin',i,{leaseId:reserve.leaseId})).json();assert.notEqual(replay.sendAllowed,true);
});
test('lost success response is recovered by status/replay without a new write',async()=>{
 const h=await fixture(),i=await h.issue();await h.submit(i);h.restart();const r=await(await h.status(i)).json();assert.equal(r.status,'succeeded');assert.equal(r.result.threadUrl,'https://discord.com/channels/456/789');await h.submit(i);assert.equal(h.writes,1);
});
test('post-start 5xx, network, timeout, bad JSON, receipt mismatch and 3xx stay unknown',async()=>{
 for(const post of [()=>new Response('',{status:500}),()=>{throw new Error('PRIVATE_NETWORK')},()=>new Promise(()=>{}),()=>new Response('{'),()=>Response.json({...receipt(),parent_id:'999'}),()=>new Response(null,{status:302,headers:{Location:'https://evil.invalid/'}})]){const h=await fixture({post,timeoutMs:5}),i=await h.issue();assert.equal((await h.submit(i)).status,502);assert.equal(record(h,i).status,'unknown');await h.submit(i);h.restart();await h.submit(i);assert.equal(h.writes,1);}
});
test('Discord429 is distinct, preserves long shared cooldown and max four safe attempts',async()=>{
 const real=Date.now;let t=real();Date.now=()=>t;
 try{const h=await fixture({post:()=>Response.json({retry_after:120,global:true},{status:429,headers:{'Retry-After':'100'}})}),i=await h.issue();for(let n=1;n<=4;n++){const r=await h.submit(i);assert.equal(r.status,429);assert.equal((await r.json()).error.code,'DISCORD_RATE_LIMITED');assert.equal(record(h,i).attempt,n);const other=await h.issue();const before=h.calls.length;assert.equal((await h.submit(other)).status,429);assert.equal(h.calls.length,before);t+=120251;}assert.equal(record(h,i).safeToRetry,false);await h.submit(i);assert.equal(h.writes,4);assert.equal(h.storage.data.get('posts:rate').slots.length,1);}finally{Date.now=real;}
});
test('malformed429 does not enable retry; rejected posts still consume slots',async()=>{
 const h=await fixture({post:()=>new Response('PRIVATE_429_BODY',{status:429})}),i=await h.issue();await h.submit(i);assert.equal(record(h,i).safeToRetry,false);await h.submit(i);assert.equal(h.writes,1);assert.equal(h.storage.data.get('posts:rate').slots.length,1);
 for(const status of [400,401,403,404]){const f=await fixture({post:()=>new Response('SECRET',{status})}),j=await f.issue();assert.equal((await f.submit(j)).status,502);assert.equal(record(f,j).status,'failed');await f.submit(j);assert.equal(f.writes,1);}
});
test('preflight errors do not reserve quota and do not leak body',async()=>{
 const h=await fixture({preflight:()=>Response.json({id:'999',type:15})}),i=await h.issue();const r=await h.submit(i);assert.equal(r.status,503);assert.equal(h.writes,0);assert.equal(h.storage.data.get('posts:rate'),undefined);assert.ok(!(await r.text()).includes('PRIVATE'));
});
test('tampered, oversized, future, mismatched IDs and expired tickets fail closed after deletion',async()=>{
 const h=await fixture(),i=await h.issue(),c=await verifyOperation(i.idempotencyKey,h.env.SESSION_SIGNING_KEY);for(const key of [i.idempotencyKey.slice(0,-1)+(i.idempotencyKey.endsWith('0')?'1':'0'),'x'.repeat(1025)]){assert.equal((await h.submit({...i,idempotencyKey:key})).status,400);}assert.equal((await h.call('/api/forum/posts/'+crypto.randomUUID(),'GET',null,i.idempotencyKey)).status,400);
 for(const bad of [{...c,payloadHash:[c.payloadHash]},{...c,operationId:[c.operationId]},{...c,issuedAt:String(c.issuedAt)},{...c,extra:true}])await assert.rejects(()=>signOperation(bad,h.env.SESSION_SIGNING_KEY),{code:'INVALID_OPERATION_KEY'});
 const future={...c,issuedAt:c.issuedAt+10000,expiresAt:c.expiresAt+10000};assert.equal((await h.submit({...i,idempotencyKey:await signOperation(future,h.env.SESSION_SIGNING_KEY)})).status,400);
 h.storage.data.delete('posts:operation:'+i.operationId);assert.equal((await h.submit(i)).status,503);const real=Date.now;try{Date.now=()=>c.expiresAt;h.token=await h.session();assert.equal((await h.status(i)).status,410);assert.equal((await h.submit(i)).status,410);}finally{Date.now=real;}assert.equal(h.writes,0);
});
test('expiry guard, 30-day alarm cleanup and auth alarm coexist without extending records',async()=>{
 const h=await fixture(),i=await h.issue(),expires=record(h,i).expiresAt;const real=Date.now;
 try{Date.now=()=>expires-119999;h.token=await h.session();assert.equal((await h.submit(i)).status,409);assert.ok(record(h,i));Date.now=()=>expires;h.storage.alarm=null;await h.object.alarm();assert.equal(record(h,i),undefined);assert.equal((await h.status(i)).status,410);}finally{Date.now=real;}
 assert.equal(h.writes,0);const second=await h.issue();const authExpiry=Date.now()+3600000;h.storage.alarm=authExpiry;await h.issue();assert.equal(h.storage.alarm,authExpiry);assert.ok(record(h,second));
});
test('sessions may share owner ticket, but logout/expiry/missing auth cannot use it',async()=>{
 const h=await fixture(),i=await h.issue(),other=await h.session();assert.equal((await h.status(i,other)).status,200);const r=await h.object.fetch(new Request('https://internal/auth',{method:'POST',body:JSON.stringify({action:'logout',token:h.token})}));assert.equal(r.status,200);assert.equal((await h.submit(i)).status,401);assert.equal((await h.status(i)).status,401);assert.equal((await h.submit(i,payload(),other)).status,201);
 const f=await fixture(),j=await f.issue();assert.equal((await f.call('/api/forum/posts','POST',payload(),j.idempotencyKey,'')).status,401);assert.equal(f.writes,0);
});
test('Origin/Host/CORS/method/unknown fields and internal DO forged calls cannot post',async()=>{
 const h=await fixture(),i=await h.issue();assert.equal((await h.call('/api/forum/posts','POST',payload(),i.idempotencyKey,h.token,{Origin:'https://evil.invalid'})).status,403);assert.equal((await h.call('/api/forum/posts','POST',payload(),i.idempotencyKey,h.token,{Host:'evil.invalid'})).status,403);assert.equal((await h.call('/api/forum/posts','POST',{...payload(),forumId:'999'},i.idempotencyKey)).status,400);assert.equal((await h.call('/api/forum/posts','DELETE',null,i.idempotencyKey)).status,405);
 const c=await verifyOperation(i.idempotencyKey,h.env.SESSION_SIGNING_KEY);assert.equal((await h.object.fetch(new Request('https://internal/auth',{method:'POST',body:JSON.stringify({action:'post.begin',token:h.token,claims:c})}))).status,403);assert.equal((await h.call('/api/forum/posts','OPTIONS',null,null,h.token,{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,idempotency-key,content-type'})).status,204);assert.equal(h.writes,0);
});
test('public Worker remains disconnected from all posting routes',async()=>{
 const h=await fixture();h.env.APP_PASSWORD_HASH='pbkdf2-sha256$600000$'+'ab'.repeat(16)+'$'+'cd'.repeat(32);const i=await h.issue();for(const args of [['/api/forum/post-intents','POST'],['/api/forum/posts','POST'],['/api/forum/posts/'+i.operationId,'GET']])assert.equal((await worker.fetch(h.request(...args),h.env)).status,404);assert.equal(h.writes,0);
});
test('expired preparation lease rejects old CAS and permits only a fresh lease',async()=>{
 const real=Date.now;let t=real();Date.now=()=>t;
 try{const h=await fixture(),i=await h.issue();i.claims=await verifyOperation(i.idempotencyKey,h.env.SESSION_SIGNING_KEY);const old=await(await h.internal('post.reserve',i)).json();assert.equal(old.record.status,'preparing');t+=15000;
 const fresh=await(await h.internal('post.reserve',i)).json();assert.notEqual(old.leaseId,fresh.leaseId);const denied=await(await h.internal('post.begin',i,{leaseId:old.leaseId})).json();assert.notEqual(denied.sendAllowed,true);const begin=await(await h.internal('post.begin',i,{leaseId:fresh.leaseId})).json();assert.equal(begin.sendAllowed,true);assert.equal(begin.record.attempt,1);}finally{Date.now=real;}
});
test('same-attempt late receipt resolves unknown; stale attempt and expired receipt cannot overwrite',async()=>{
 const real=Date.now;let t=real();Date.now=()=>t;
 try{const h=await fixture(),i=await h.issue();i.claims=await verifyOperation(i.idempotencyKey,h.env.SESSION_SIGNING_KEY);const lease=await(await h.internal('post.reserve',i)).json(),begin=await(await h.internal('post.begin',i,{leaseId:lease.leaseId})).json();t+=120000;assert.equal((await(await h.status(i)).json()).status,'unknown');
 const outcome={outcome:'succeeded',result:{guildId:'456',forumId:'123',threadId:'789',messageId:'790',url:'https://evil.invalid/'}};
 const stale=await(await h.internal('post.finish',i,{attemptId:crypto.randomUUID(),outcome})).json();assert.equal(stale.record.status,'unknown');const late=await(await h.internal('post.finish',i,{attemptId:begin.attemptId,outcome})).json();assert.equal(late.record.status,'succeeded');assert.equal(late.record.result.url,'https://discord.com/channels/456/789/790');
 const rejected=await(await h.internal('post.finish',i,{attemptId:begin.attemptId,outcome:{outcome:'unknown'}})).json();assert.equal(rejected.record.status,'succeeded');t=i.claims.expiresAt;h.token=await h.session();h.storage.data.delete('posts:operation:'+i.operationId);assert.equal((await h.internal('post.finish',i,{attemptId:begin.attemptId,outcome})).status,410);assert.equal(record(h,i),undefined);}finally{Date.now=real;}
});
test('lost beginSend reply and begin sync failure never dispatch or acquire a second grant',async()=>{
 for(const mode of ['reply','sync']){const h=await fixture(),i=await h.issue();
 if(mode==='reply'){h.env.AUTH_STATE.get=()=>({fetch:async r=>{const packet=await r.clone().json(),response=await h.object.fetch(r);if(packet.action==='post.begin'&&response.ok)throw new Error('PRIVATE_LOST_RESPONSE');return response;}});}else{h.storage.fail=k=>k==='sync'&&record(h,i)?.status==='sending';}
 assert.equal((await h.submit(i)).status,503);assert.equal(h.writes,0);h.storage.fail=null;h.env.AUTH_STATE.get=()=>({fetch:r=>h.object.fetch(r)});h.restart();assert.equal((await h.submit(i)).status,202);assert.equal(h.writes,0);assert.equal(record(h,i).attempt,1);}
});
test('logout during preflight prevents begin; post-success logout makes reply unknown but retains sending',async()=>{
 const h=await fixture(),i=await h.issue();h.preflight=async()=>{await h.object.fetch(new Request('https://internal/auth',{method:'POST',body:JSON.stringify({action:'logout',token:h.token})}));return Response.json({id:'123',guild_id:'456',type:15,flags:0,available_tags:[]});};assert.equal((await h.submit(i)).status,401);assert.equal(h.writes,0);
 const f=await fixture(),j=await f.issue();f.post=async()=>{await f.object.fetch(new Request('https://internal/auth',{method:'POST',body:JSON.stringify({action:'logout',token:f.token})}));return Response.json(receipt());};const r=await f.submit(j);assert.equal((await r.json()).status,'unknown');f.token=await f.session();await f.submit(j);assert.equal(f.writes,1);
});
test('target change blocks new attempt but preserves saved target links on GET and success replay',async()=>{
 const h=await fixture(),i=await h.issue(),j=await h.issue();await h.submit(i);h.env.DISCORD_FORUM_CHANNEL_ID='999';assert.equal((await h.submit(j)).status,409);assert.equal((await h.submit(i)).status,200);assert.equal((await(await h.status(i)).json()).result.forumId,'123');assert.equal(h.writes,1);
});
test('prepared-context expiry after durable begin remains non-retryable with no actual write',async()=>{
 const real=Date.now;let t=real();Date.now=()=>t;
 try{const h=await fixture(),i=await h.issue();h.env.AUTH_STATE.get=()=>({fetch:async r=>{const p=await r.clone().json(),response=await h.object.fetch(r);if(p.action==='post.begin')t+=15001;return response;}});assert.equal((await h.submit(i)).status,502);assert.equal(record(h,i).status,'unknown');assert.equal(h.writes,0);await h.submit(i);assert.equal(h.writes,0);assert.equal(h.storage.data.get('posts:rate').slots.length,1);}finally{Date.now=real;}
});
test('internal proof tamper/wrong URL and operation signature domain cannot authorize DO writes',async()=>{
 const h=await fixture(),i=await h.issue(),claims=await verifyOperation(i.idempotencyKey,h.env.SESSION_SIGNING_KEY),body={action:'post.reserve',token:h.token,claims};const proof=await internalProof(body,h.env.SESSION_SIGNING_KEY);
 for(const [url,packet]of [['https://evil.invalid/',{...body,proof}],['https://internal/auth',{...body,action:'post.begin',proof}],['https://internal/auth',{...body,proof:i.idempotencyKey.split('.').at(-1)}]])assert.equal((await h.object.fetch(new Request(url,{method:'POST',body:JSON.stringify(packet)}))).status,403);assert.equal(record(h,i).status,'not_started');assert.equal(h.writes,0);
});
test('session expiration during begin transaction is rechecked before quota or sending commit',async()=>{
 const real=Date.now;let t=real();Date.now=()=>t;
 try{const h=await fixture(),i=await h.issue();t=Number(h.token.split('.')[1])-1;const get=h.storage.get.bind(h.storage);let checking=false,reads=0;
 h.storage.get=async k=>{const v=await get(k);if(checking&&k==='sessions'&&++reads===2)t++;return v;};
 h.env.AUTH_STATE.get=()=>({fetch:async r=>{const p=await r.clone().json();if(p.action==='post.begin')checking=true;return h.object.fetch(r);}});
 assert.equal((await h.submit(i)).status,401);assert.equal(h.writes,0);assert.equal(h.storage.data.get('posts:rate'),undefined);assert.equal(record(h,i).status,'preparing');}finally{Date.now=real;}
});
