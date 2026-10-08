import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {pbkdf2Sync} from 'node:crypto';
import assert from 'node:assert/strict';
import {installProductionPbkdf2Limit} from './production-crypto.mjs';
const origin='https://runtime.example';
const bundled=await build({entryPoints:[fileURLToPath(new URL('../src/index.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
const script=`(${installProductionPbkdf2Limit.toString()})();\n`+bundled.outputFiles[0].text;
const started=performance.now();
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script,compatibilityDate:'2026-04-01',durableObjects:{AUTH_STATE:{className:'AuthState',useSQLite:true}},bindings:{ALLOWED_ORIGIN:origin,DISCORD_BOT_TOKEN:'TEST_ONLY',DISCORD_FORUM_CHANNEL_ID:'123',SESSION_SIGNING_KEY:'a'.repeat(64),APP_PASSWORD_HASH:'pbkdf2-sha256$600000$'+'ab'.repeat(16)+'$'+pbkdf2Sync('TEST_ONLY_PASSWORD',Buffer.from('ab'.repeat(16),'hex'),600000,32,'sha256').toString('hex')}}));
try{
 const call=(path,method='GET',body,token)=>mf.dispatchFetch('https://runtime.example'+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const login=await call('/api/login','POST',{password:'TEST_ONLY_PASSWORD'});assert.equal(login.status,200,'workerd PBKDF2 100k cap + existing 600k secret login');
 console.log('Local workerd first login including startup: '+Math.round(performance.now()-started)+' ms (wall time, not production CPU)');const session=await login.json();
 assert.equal((await call('/api/session','GET',null,session.token)).status,200);
 assert.equal((await call('/api/logout','POST',null,session.token)).status,200);
 assert.equal((await call('/api/session','GET',null,session.token)).status,401);
 const wrong=await call('/api/login','POST',{password:'WRONG_TEST_ONLY'});assert.equal(wrong.status,401);
 console.log('PASS workerd + explicit production PBKDF2 cap: SQLite DO, 600k existing hash, wrong password, signed session, logout replay');
}finally{await mf.dispose();}
