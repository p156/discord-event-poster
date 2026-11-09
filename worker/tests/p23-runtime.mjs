import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {oauthBindings,BASE,mockLogin} from './oauth-fixtures.mjs';
const directory=await mkdtemp(path.join(tmpdir(),'poster-p23-')),origin='https://runtime.example';
const script=(await build({entryPoints:[fileURLToPath(new URL('./p23-runtime-entry.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'})).outputFiles[0].text;
const options=()=>convertV4MiniflareOptions({modules:true,script,compatibilityDate:'2026-04-01',resourcePersistencePath:directory,durableObjects:{AUTH_STATE:{className:'AuthState',useSQLite:true}},bindings:{...oauthBindings(origin),FORUM_POSTS_ENABLED:'true',DISCORD_BOT_TOKEN:'PRIVATE_TEST_BOT',DISCORD_FORUM_CHANNEL_ID:'123',SESSION_SIGNING_KEY:'a'.repeat(64)}});
let mf,session;
const dispatch=(url,opts)=>mf.dispatchFetch(url,{...opts,redirect:'manual'});
const call=async(route,body,key)=>{const r=await dispatch(BASE+route,{method:body===undefined?'GET':'POST',headers:{Origin:origin,Authorization:'Bearer '+session.token,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};};
try{
 mf=new Miniflare(options());session=await mockLogin(dispatch,origin);
 assert.equal((await call('/api/forums')).data.selected,'123');
 assert.equal((await call('/api/forums/register',{forumId:'124'})).status,200);
 await call('/api/forums/select',{forumId:'124'});
 // Persist an unfinished history cursor, then recreate the runtime on the same SQLite.
 await call('/api/forums/123/history/sync',{});
 await mf.dispose();mf=new Miniflare(options());
 assert.equal((await call('/api/forums')).data.selected,'124');
 session=await mockLogin(dispatch,origin);
 let history;for(let i=0;i<15;i++){history=await call('/api/forums/123/history/sync',{});if(!history.data.sync.more)break;}
 assert.equal(history.data.sync.complete,true);
 const rows=(await call('/api/forums/123/history/read',{})).data.items;
 assert.equal(rows.length,2);assert.ok(rows.every(r=>r.status==='ok'));
 const p={apiVersion:1,threadName:'第6回 謎解きフェスティバル',content:'本文',tagIds:['101']};
 const candidates=(await call('/api/forums/123/history/compare',{titles:[p.threadName]})).data;
 assert.equal(candidates.matches[0][0].differentEdition,true);
 const i=await call('/api/forums/123/post-intents',p);
 assert.equal((await call('/api/forums/124/posts',p,i.data.idempotencyKey)).status,409);
 const sent=await call('/api/forums/123/posts',p,i.data.idempotencyKey);assert.equal(sent.data.status,'succeeded');
 assert.equal((await call('/api/forums/123/posts',p,i.data.idempotencyKey)).data.status,'succeeded');
 await call('/api/forums/remove',{forumId:'123'});
 assert.equal((await call('/api/forums/123/posts/'+i.data.operationId,undefined,i.data.idempotencyKey)).data.status,'succeeded');
 await call('/api/forums/remove',{forumId:'124'});
 await mf.dispose();mf=new Miniflare(options());
 assert.equal((await call('/api/forums')).data.selected,'');assert.equal((await call('/api/forums')).data.forums.length,0);
 console.log('PASS P2/P3 real SQLite restart/relogin, resumable history, bot-only rows, title warnings, forum-bound keys, replay and unregister persistence; zero real Discord calls');
}finally{await mf?.dispose();await rm(directory,{recursive:true,force:true});}
