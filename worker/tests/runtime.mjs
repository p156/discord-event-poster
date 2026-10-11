import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {oauthBindings,BASE,startFlow,mockLogin} from './oauth-fixtures.mjs';
const origin='https://runtime.example';
const built=await build({entryPoints:[fileURLToPath(new URL('./post-runtime-entry.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-04-01',durableObjects:{AUTH_STATE:{className:'AuthState',useSQLite:true}},bindings:{...oauthBindings(origin),DISCORD_BOT_TOKEN:'TEST_ONLY',DISCORD_FORUM_CHANNEL_ID:'123',SESSION_SIGNING_KEY:'a'.repeat(64)}}));
const dispatch=(url,opts)=>mf.dispatchFetch(url,opts);
const call=(path,method='GET',body,token)=>dispatch(BASE+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
try{
 const s=await mockLogin(dispatch,origin);assert.equal((await call('/api/session','GET',null,s.token)).status,200);
 assert.equal((await call('/api/session','GET',null,s.token.slice(0,-1)+(s.token.endsWith('0')?'1':'0'))).status,401);
 assert.equal((await call('/api/login','POST',{password:'TEST_ONLY_PASSWORD'})).status,404);
 assert.equal((await call('/api/session','GET',null,'a'.repeat(64)+'.'+s.expiresAt+'.'+'b'.repeat(64))).status,401);
 assert.equal((await call('/api/logout','POST',{},s.token)).status,200);assert.equal((await call('/api/session','GET',null,s.token)).status,401);
 const f=await startFlow(dispatch,origin),url=BASE+'/api/oauth/callback?'+new URLSearchParams({state:f.state,code:'TEST_ONLY_CODE'});
 const results=await Promise.all([dispatch(url,{headers:{Cookie:f.cookie}}),dispatch(url,{headers:{Cookie:f.cookie}})]);assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(results.filter(r=>r.status===401).length,1);
 const html=await results.find(r=>r.status===200).text(),handoff=html.match(/"handoff":"([a-f0-9]{64})"/)[1];
 const done=await Promise.all([call('/api/oauth/complete','POST',{handoff,verifier:f.verifier}),call('/api/oauth/complete','POST',{handoff,verifier:f.verifier})]);assert.equal(done.filter(r=>r.status===200).length,1);assert.equal(done.filter(r=>r.status===401).length,1);
 console.log('PASS bundled workerd + SQLite DO: identify OAuth login, old auth rejected, tamper/logout rejection, parallel callback/handoff one-use; zero real Discord requests');
}finally{await mf.dispose();}
