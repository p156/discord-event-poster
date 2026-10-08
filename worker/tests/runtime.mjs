import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {passwordHash} from '../src/index.mjs';
const origin='https://runtime.example';
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:await readFile(new URL('../src/index.mjs',import.meta.url),'utf8'),compatibilityDate:'2026-04-01',durableObjects:{AUTH_STATE:{className:'AuthState',useSQLite:true}},bindings:{ALLOWED_ORIGIN:origin,DISCORD_BOT_TOKEN:'TEST_ONLY',DISCORD_FORUM_CHANNEL_ID:'123',SESSION_SIGNING_KEY:'a'.repeat(64),APP_PASSWORD_HASH:'pbkdf2-sha256$600000$'+'ab'.repeat(16)+'$'+await passwordHash('TEST_ONLY_PASSWORD','ab'.repeat(16))}}));
try{
 const call=(path,method='GET',body,token)=>mf.dispatchFetch('https://runtime.example'+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const login=await call('/api/login','POST',{password:'TEST_ONLY_PASSWORD'});assert.equal(login.status,200,'workerd PBKDF2 and SQLite Durable Object login');const session=await login.json();
 assert.equal((await call('/api/session','GET',null,session.token)).status,200);
 assert.equal((await call('/api/logout','POST',null,session.token)).status,200);
 assert.equal((await call('/api/session','GET',null,session.token)).status,401);
 console.log('PASS workerd runtime: SQLite DO, PBKDF2 600000, signed session, logout replay');
}finally{await mf.dispose();}
