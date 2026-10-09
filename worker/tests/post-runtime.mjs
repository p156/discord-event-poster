import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {pbkdf2Sync} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {installProductionPbkdf2Limit} from './production-crypto.mjs';
const bundled=await build({entryPoints:[fileURLToPath(new URL('./post-runtime-entry.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
const directory=await mkdtemp(path.join(tmpdir(),'poster-step3-'));
const origin='https://runtime.example',base='https://discord-event-poster-api.monma5435.workers.dev';
const options=convertV4MiniflareOptions({modules:true,script:`(${installProductionPbkdf2Limit.toString()})();\n`+bundled.outputFiles[0].text,compatibilityDate:'2026-04-01',durableObjects:{AUTH_STATE:{className:'AuthState',useSQLite:true}},resourcePersistencePath:directory,bindings:{ALLOWED_ORIGIN:origin,DISCORD_BOT_TOKEN:'TEST_ONLY',DISCORD_FORUM_CHANNEL_ID:'123',SESSION_SIGNING_KEY:'a'.repeat(64),APP_PASSWORD_HASH:'pbkdf2-sha256$600000$'+'ab'.repeat(16)+'$'+pbkdf2Sync('TEST_ONLY_PASSWORD',Buffer.from('ab'.repeat(16),'hex'),600000,32,'sha256').toString('hex')}});
let mf=new Miniflare(options),token;
const payload={apiVersion:1,threadName:'TEST_ONLY',content:'TEST_ONLY',tagIds:[]};
const call=(p,method='POST',body=payload,key,extra={})=>mf.dispatchFetch(base+p,{method,headers:{Origin:origin,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(key?{'Idempotency-Key':key}:{}),...extra},...(method==='POST'?{body:JSON.stringify(body)}:{})});
const intent=async()=>{const r=await call('/api/forum/post-intents');assert.equal(r.status,201);return r.json();};
try{
 assert.equal((await call('/api/forum/post-intents')).status,401);
 const login=await call('/api/login','POST',{password:'TEST_ONLY_PASSWORD'});assert.equal(login.status,200);token=(await login.json()).token;
 const i=await intent();const same=await Promise.all(Array.from({length:12},()=>call('/api/forum/posts','POST',payload,i.idempotencyKey)));
 assert.ok(same.every(r=>[200,201,202].includes(r.status)));await Promise.all(same.map(r=>r.arrayBuffer()));
 const status=await call('/api/forum/posts/'+i.operationId,'GET',null,i.idempotencyKey);assert.equal(status.headers.get('X-Test-Writes'),'1');assert.equal((await status.json()).status,'succeeded');
 const intents=await Promise.all(Array.from({length:10},intent));const submissions=await Promise.all(intents.map(i=>call('/api/forum/posts','POST',payload,i.idempotencyKey)));assert.equal(submissions.filter(r=>r.status===429).length,1);await Promise.all(submissions.map(r=>r.arrayBuffer()));
 console.log('PASS workerd SQLite transactions/sync: parallel same-key one write; app-wide max ten');
 await mf.dispose();mf=new Miniflare(options);
 const restored=await call('/api/forum/posts','POST',payload,i.idempotencyKey);assert.equal(restored.status,200);assert.equal(restored.headers.get('X-Test-Writes'),'0');assert.equal((await restored.json()).result.threadId,'789');
 const fresh=await intent();const limited=await call('/api/forum/posts','POST',payload,fresh.idempotencyKey);assert.equal(limited.status,429);assert.equal((await limited.json()).error.code,'APP_RATE_LIMITED');assert.equal(limited.headers.get('X-Test-Writes'),'0');
 assert.equal((await call('/api/logout','POST',{})).status,200);assert.equal((await call('/api/forum/posts/'+i.operationId,'GET',null,i.idempotencyKey)).status,401);
 console.log('PASS workerd restart with persisted SQLite: signed session/history/quota preserved, replay no write, logout rejected');
 await mf.dispose();mf=new Miniflare({...options,resourcePersistencePath:path.join(directory,'failure-cases')});
 const freshLogin=await call('/api/login','POST',{password:'TEST_ONLY_PASSWORD'});assert.equal(freshLogin.status,200);token=(await freshLogin.json()).token;
 for(const mode of ['500','timeout']){const op=await intent();const failure=await call('/api/forum/posts','POST',payload,op.idempotencyKey,{'X-Test-Mode':mode});assert.equal(failure.status,502);const count=failure.headers.get('X-Test-Writes');assert.equal((await failure.json()).status,'unknown');const replay=await call('/api/forum/posts','POST',payload,op.idempotencyKey);assert.equal(replay.headers.get('X-Test-Writes'),count);assert.equal((await replay.json()).status,'unknown');}
 const retry=await intent();const rejected=await call('/api/forum/posts','POST',payload,retry.idempotencyKey,{'X-Test-Mode':'429'});assert.equal(rejected.status,429);assert.ok(Number(rejected.headers.get('Retry-After'))>=120);assert.equal((await rejected.json()).error.code,'DISCORD_RATE_LIMITED');
 const blocked=await intent(),before=await call('/api/forum/posts','POST',payload,blocked.idempotencyKey);assert.equal(before.status,429);assert.equal(before.headers.get('X-Test-Writes'),'3');await before.arrayBuffer();
 console.log('PASS workerd: 5xx/timeout unknown never resend; Discord429 shared long cooldown');
}finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
