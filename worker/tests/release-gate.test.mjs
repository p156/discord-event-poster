import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.mjs';
import {fixture,payload} from './post-fixtures.mjs';
import {readFile} from 'node:fs/promises';
import {verifyOperation,signOperation} from '../src/post-keys.mjs';
const configured=h=>{h.env.APP_PASSWORD_HASH='pbkdf2-sha256$600000$'+'ab'.repeat(16)+'$'+'cd'.repeat(32);return h;};
test('deadline during delayed pre-send DO check must never dispatch after timeout',async()=>{
 const h=await fixture({timeoutMs:5}),i=await h.issue();let release;
 h.env.AUTH_STATE.get=()=>({fetch:async r=>{const body=await r.clone().json();const response=await h.object.fetch(r);if(body.action==='discord.check'&&body.scope.route==='POST channel/threads')await new Promise(resolve=>{release=resolve;});return response;}});
 const result=await h.submit(i);assert.equal(result.status,502);assert.equal(h.writes,0);assert.ok(release);release();await new Promise(r=>setTimeout(r,10));assert.equal(h.writes,0,'no delayed/background write after deadline');
});
test('rollback read-only mode rejects writes but preserves authenticated same-key GET',async()=>{
 const h=configured(await fixture()),i=await h.issue();await h.submit(i);h.env.FORUM_POSTS_ENABLED='read-only';
 const status=await worker.fetch(h.request('/api/forum/posts/'+i.operationId,'GET',null,i.idempotencyKey),h.env);assert.equal(status.status,200);assert.equal((await status.json()).status,'succeeded');
 for(const route of ['/api/forum/posts','/api/forum/post-intents'])assert.equal((await worker.fetch(h.request(route),h.env)).status,404);
 assert.equal((await worker.fetch(h.request('/api/forum/posts/'+i.operationId,'GET',null,i.idempotencyKey,''),h.env)).status,401);assert.equal(h.writes,1);
});
test('formal route rejects HTTPS/Origin/Host/Bearer/method/preflight bypasses',async()=>{
 const h=configured(await fixture());h.env.FORUM_POSTS_ENABLED='true';const id=crypto.randomUUID(),route='/api/forum/posts/'+id;
 const bad=[new Request(h.request('/api/forum/post-intents'),{headers:{Origin:h.env.ALLOWED_ORIGIN,Authorization:'Bearer invalid'}}),new Request('http://discord-event-poster-api.monma5435.workers.dev/api/forum/post-intents',{method:'POST',headers:{Origin:h.env.ALLOWED_ORIGIN},body:JSON.stringify(payload())}),h.request('/api/forum/post-intents','POST',payload(),null,h.token,{Origin:'https://evil.invalid'}),h.request('/api/forum/post-intents','POST',payload(),null,h.token,{Host:'evil.invalid'})];
 for(const [n,r]of bad.entries())assert.equal((await worker.fetch(r,h.env)).status,n?403:401);
 for(const method of ['PUT','DELETE','PATCH','GET'])assert.equal((await worker.fetch(h.request('/api/forum/posts',method,null),h.env)).status,405);
 for(const [path,method,headers]of [['/api/forum/posts','DELETE','authorization'],[route,'POST','authorization'],['/api/forum/posts','POST','x-enable-posts']])assert.equal((await worker.fetch(h.request(path,'OPTIONS',null,null,h.token,{'Access-Control-Request-Method':method,'Access-Control-Request-Headers':headers}),h.env)).status,403);
 assert.equal(h.writes,0);
});
test('formal POST rejects revoked/expired sessions, modified ticket and payload reuse',async()=>{
 const h=configured(await fixture()),i=await h.issue();h.env.FORUM_POSTS_ENABLED='true';
 const other={...payload(),content:'OTHER_BODY'};assert.equal((await worker.fetch(h.request('/api/forum/posts','POST',other,i.idempotencyKey),h.env)).status,409);
 const c=await verifyOperation(i.idempotencyKey,h.env.SESSION_SIGNING_KEY),signed=await signOperation({...c,operationId:crypto.randomUUID()},h.env.SESSION_SIGNING_KEY);assert.equal((await worker.fetch(h.request('/api/forum/posts/'+i.operationId,'GET',null,signed),h.env)).status,400);
 const tampered=i.idempotencyKey.slice(0,-1)+(i.idempotencyKey.endsWith('0')?'1':'0');assert.equal((await worker.fetch(h.request('/api/forum/posts','POST',payload(),tampered),h.env)).status,400);
 const real=Date.now;try{Date.now=()=>Number(h.token.split('.')[1]);assert.equal((await worker.fetch(h.request('/api/forum/posts','POST',payload(),i.idempotencyKey),h.env)).status,401);}finally{Date.now=real;}
 await worker.fetch(h.request('/api/logout','POST',{}),h.env);assert.equal((await worker.fetch(h.request('/api/forum/posts','POST',payload(),i.idempotencyKey),h.env)).status,401);assert.equal(h.writes,0);
});
test('write observer sees sending, slot and confirmed storage, never plaintext history',async()=>{
 const h=await fixture(),i=await h.issue();h.post=()=>{const r=h.storage.data.get('posts:operation:'+i.operationId);assert.equal(r.status,'sending');assert.equal(r.attempt,1);assert.equal(h.storage.data.get('posts:rate').slots.length,1);assert.ok(h.storage.events.includes('sync'));return Response.json({id:'789',type:11,parent_id:'123',guild_id:'456',message:{id:'790',channel_id:'789'}});};
 assert.equal((await h.submit(i)).status,201);const saved=JSON.stringify([...h.storage.data]);for(const secret of [h.env.DISCORD_BOT_TOKEN,h.token,payload().content,i.idempotencyKey])assert.ok(!saved.includes(secret));
});
test('different live sessions racing the same operation still produce one send',async()=>{
 const h=await fixture(),i=await h.issue(),other=await h.session();await Promise.all([h.submit(i),h.submit(i,payload(),other)]);assert.equal(h.writes,1);
});
test('deployment config stays default-off with existing AuthState binding and migration',async()=>{
 const config=JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));assert.equal(config.name,'discord-event-poster-api');assert.equal(config.main,'src/index.mjs');assert.notEqual(config.vars?.FORUM_POSTS_ENABLED,'true');assert.deepEqual(config.durable_objects.bindings,[{name:'AUTH_STATE',class_name:'AuthState'}]);assert.deepEqual(config.migrations,[{tag:'auth-v1',new_sqlite_classes:['AuthState']}]);assert.deepEqual(config.secrets.required.sort(),['ALLOWED_ORIGIN','APP_PASSWORD_HASH','DISCORD_BOT_TOKEN','DISCORD_FORUM_CHANNEL_ID','SESSION_SIGNING_KEY'].sort());
 const pages=await readFile(new URL('../../_config.yml',import.meta.url),'utf8');for(const p of ['worker','tests','node_modules','work','tests-acceptance.cjs','tests-v010.js','package.json','package-lock.json'])assert.ok(pages.split('\n').some(line=>line.trim()==='- '+p));
});
