import {createRequire} from 'node:module';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const require=createRequire(import.meta.url),g=require('../tools/staging-artifacts.cjs');
const {files}=await g.render(),t=g.TARGET;
const bindings={ALLOWED_ORIGIN:t.web,DISCORD_OAUTH_REDIRECT_URI:t.api+'/api/oauth/callback',DISCORD_OAUTH_CLIENT_ID:t.clientId,DISCORD_FORUM_CHANNEL_ID:t.forumId,DISCORD_OAUTH_CLIENT_SECRET:'STAGING_OAUTH_FIXTURE',DISCORD_BOT_TOKEN:'STAGING_BOT_FIXTURE',DISCORD_ALLOWED_USER_ID:'123',SESSION_SIGNING_KEY:'a'.repeat(64),AUTH_SESSION_SIGNING_KEY:'b'.repeat(64),FORUM_POSTS_ENABLED:'read-only'};
// Miniflare's proxy changes Host; restore URL Host only in this test harness,
// as the existing production runtime harness does. Block all external fetches.
const harness=await build({stdin:{contents:`import worker from 'generated';export {AuthState} from 'generated';globalThis.fetch=()=>{throw Error('REAL_NETWORK_FORBIDDEN');};export default {fetch(request,env){const headers=new Headers(request.headers);headers.set('Host',new URL(request.url).host);return worker.fetch(new Request(request,{headers}),env);}};`},bundle:true,write:false,format:'esm',platform:'browser',plugins:[{name:'generated-fixture',setup(b){b.onResolve({filter:/^generated$/},()=>({path:'generated',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:files['worker/index.mjs'].toString(),loader:'js'}));}}]});
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:harness.outputFiles[0].text,compatibilityDate:'2026-04-01',durableObjects:{AUTH_STATE:{className:'AuthState',useSQLite:true}},bindings}));
const dispatch=(url,options={})=>mf.dispatchFetch(url,{...options,redirect:'manual',headers:{Host:new URL(url).hostname,...options.headers}});
try {
 for(const base of ['https://discord-event-poster-api.monma5435.workers.dev','https://arbitrary.invalid'])assert.equal((await dispatch(base+'/api/session',{headers:{Origin:t.web}})).status,403);
 assert.equal((await dispatch(t.api+'/api/session',{headers:{Origin:'https://p156.github.io'}})).status,403);
 for(const route of ['/api/forum/posts','/api/forum/post-intents','/api/forum/image-preview','/api/forum/image-thumbnail','/api/login'])assert.equal((await dispatch(t.api+route,{method:'POST',headers:{Origin:t.web}})).status,404);
 assert.equal((await dispatch(t.api+'/api/session',{headers:{Origin:t.web}})).status,401);
 const started=await dispatch(t.api+'/api/oauth/start',{method:'POST',headers:{Origin:t.web,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({challenge:'e'.repeat(64)}).toString()});
 assert.equal(started.status,303);const redirect=new URL(started.headers.get('Location'));assert.equal(redirect.searchParams.get('redirect_uri'),bindings.DISCORD_OAUTH_REDIRECT_URI);assert.equal(redirect.searchParams.get('client_id'),t.clientId);assert.equal(redirect.searchParams.get('scope'),'identify');assert.ok(started.headers.get('Set-Cookie').includes('HttpOnly'));
 console.log('PASS staging generated bundle workerd/SQLite: fixed Host/Origin, read-only posts/images, old login rejected, DO authentication invoked');
}finally{await mf.dispose();}
