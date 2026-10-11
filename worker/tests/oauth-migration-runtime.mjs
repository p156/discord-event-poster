import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {oauthBindings,BASE,mockLogin} from './oauth-fixtures.mjs';
const directory=await mkdtemp(path.join(tmpdir(),'poster-oauth-migration-')),origin='https://runtime.example';
const bundle=async name=>(await build({entryPoints:[fileURLToPath(new URL(name,import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'})).outputFiles[0].text;
const options=script=>convertV4MiniflareOptions({modules:true,script,compatibilityDate:'2026-04-01',resourcePersistencePath:directory,durableObjects:{AUTH_STATE:{className:'AuthState',useSQLite:true}},bindings:{...oauthBindings(origin),FORUM_POSTS_ENABLED:'true',DISCORD_BOT_TOKEN:'TEST_ONLY',DISCORD_FORUM_CHANNEL_ID:'123',SESSION_SIGNING_KEY:'a'.repeat(64)}});
let mf;
try{
 mf=new Miniflare(options(await bundle('./legacy-auth-state-entry.mjs')));const old=await (await mf.dispatchFetch(BASE+'/__test/seed',{redirect:'manual'})).json();await mf.dispose();
 mf=new Miniflare(options(await bundle('./post-runtime-entry.mjs')));
 const dispatch=(url,opts)=>mf.dispatchFetch(url,{...opts,redirect:'manual'});
 const inspect=token=>dispatch(BASE+'/api/forum/posts/'+old.operationId,{headers:{Origin:origin,Authorization:'Bearer '+token,'Idempotency-Key':old.idempotencyKey}});
 assert.equal((await inspect(old.token)).status,401);
 const session=await mockLogin(dispatch,origin),r=await inspect(session.token);assert.equal(r.status,200);assert.equal(r.headers.get('X-Test-Writes'),'0');const saved=await r.json();assert.equal(saved.status,'succeeded');assert.deepEqual(saved.result,old.record.result);
 const replay=await dispatch(BASE+'/api/forum/posts',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+session.token,'Idempotency-Key':old.idempotencyKey,'Content-Type':'application/json'},body:JSON.stringify({apiVersion:1,threadName:'TEST_ONLY',content:'TEST_ONLY',tagIds:[]})});assert.equal(replay.status,200);assert.equal(replay.headers.get('X-Test-Writes'),'0');assert.equal((await replay.json()).status,'succeeded');
 await mf.dispose();mf=new Miniflare(options(await bundle('./post-runtime-entry.mjs')));assert.equal((await inspect(session.token)).status,200);assert.equal((await inspect(old.token)).status,401);
 console.log('PASS persisted SQLite v1 -> OAuth2 migration: same DO identity, old session rejected, old operation signature/receipt preserved, replay zero writes, new session survives restart');
}finally{await mf?.dispose();await rm(directory,{recursive:true,force:true});}
