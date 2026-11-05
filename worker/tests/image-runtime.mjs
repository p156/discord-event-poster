import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {oauthBindings,mockLogin} from './oauth-fixtures.mjs';
const bundled=await build({entryPoints:[fileURLToPath(new URL('./image-runtime-entry.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
const origin='https://runtime.example',base='https://discord-event-poster-api.monma5435.workers.dev';
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-04-01',durableObjects:{AUTH_STATE:{className:'AuthState',useSQLite:true}},bindings:{FORUM_POSTS_ENABLED:'true',ALLOWED_ORIGIN:origin,DISCORD_BOT_TOKEN:'TEST_ONLY',DISCORD_FORUM_CHANNEL_ID:'123',SESSION_SIGNING_KEY:'a'.repeat(64),...oauthBindings(origin)}}));
let token;const p={apiVersion:2,threadName:'TEST_ONLY',content:'本文 📍 https://realescapegame.jp/event',tagIds:[],officialUrl:'https://realescapegame.jp/event'};
const call=(path,body=p,key,extra={})=>mf.dispatchFetch(base+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(key?{'Idempotency-Key':key}:{}),...extra},body:JSON.stringify(body)});
try{
 assert.equal((await call('/api/forum/image-preview')).status,401);token=(await mockLogin((u,o)=>mf.dispatchFetch(u,o),origin)).token;
 for(const [path,expected,source]of [['/event','/image.png','og:image'],['/twitter','/twitter.png','twitter:image'],['/multiple','/image.png','og:image'],['/entity','/entity.png','og:image'],['/none',null,null]]){const r=await call('/test/parse',{},undefined,{'X-Test-Path':path});const d=await r.json();assert.equal(d.imageUrl,expected?'https://realescapegame.jp'+expected:null,path);assert.equal(d.source,source);}
 console.log('PASS real HTMLRewriter: priority/fallback/case/order/entity/relative/head/base ignored');
 const over=await call('/test/parse',{},undefined,{'X-Test-Mode':'oversize'});assert.equal((await over.json()).reasonCode,'IMAGE_TOO_LARGE');
 const r=await call('/api/forum/image-preview');assert.equal(r.status,200);const preview=await r.json();const thumb=await call('/api/forum/image-thumbnail',{previewTicket:preview.previewTicket});assert.equal(thumb.status,200);assert.equal(thumb.headers.get('Set-Cookie'),null);await thumb.arrayBuffer();
 const bad=await call('/api/forum/image-thumbnail',{previewTicket:preview.previewTicket},undefined,{'X-Test-Mode':'thumbnail-bad'});assert.equal(bad.status,422);await bad.arrayBuffer();
 const input={...p,imageUrl:preview.imageUrl};const issued=await Promise.all([call('/api/forum/post-intents',{...input,previewTicket:preview.previewTicket}),call('/api/forum/post-intents',{...input,previewTicket:preview.previewTicket})]);assert.deepEqual(issued.map(r=>r.status).sort(),[201,409]);const i=await issued.find(r=>r.status===201).json();await issued.find(r=>r.status===409).arrayBuffer();
 const posts=await Promise.all(Array.from({length:12},()=>call('/api/forum/posts',input,i.idempotencyKey)));assert.ok(posts.every(r=>[200,201,202].includes(r.status)));assert.ok(posts.every(r=>r.headers.get('X-Test-Writes')==='1'));const completed=posts.find(r=>r.status===201);assert.ok(completed);assert.equal(Number(completed.headers.get('X-Test-External')),Number(bad.headers.get('X-Test-External'))+1);const message=JSON.parse(decodeURIComponent(completed.headers.get('X-Test-Message')));assert.equal(message.embeds,undefined);assert.equal(message.flags,undefined);assert.equal(message.content,p.content);assert.equal(completed.headers.get('X-Test-Attached'),'true');assert.deepEqual(message.attachments,[{id:0,filename:'official-image.png'}]);await Promise.all(posts.map(r=>r.arrayBuffer()));
 console.log('PASS real SQLite DO: ticket CAS, 12 parallel posts one write, frozen image URL/one validated attachment fetch/no custom Embed, thumbnail');
}finally{await mf.dispose();}
