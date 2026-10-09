import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pbkdf2Sync} from 'node:crypto';
import worker,{AuthState,passwordHash} from '../src/index.mjs';
import {installProductionPbkdf2Limit} from './production-crypto.mjs';
const salt='ab'.repeat(16),password='TEST_ONLY_パスワード🔒';
function environment(hash){
 const data=new Map();const storage={get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v)),setAlarm:async()=>{}};
 const env={ALLOWED_ORIGIN:'https://poster.example',DISCORD_FORUM_CHANNEL_ID:'123',DISCORD_BOT_TOKEN:'TEST_ONLY_BOT',APP_PASSWORD_HASH:hash,SESSION_SIGNING_KEY:'a'.repeat(64)};
 const state=new AuthState({storage},env);env.AUTH_STATE={idFromName:()=>0,get:()=>({fetch:r=>state.fetch(r)})};
 const call=(path,body,token)=>worker.fetch(new Request('https://discord-event-poster-api.monma5435.workers.dev'+path,{method:body?'POST':'GET',headers:{Origin:env.ALLOWED_ORIGIN,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);
 return {env,call};
}
test('production cap reproduces old PBKDF2 failure; 100k boundary remains supported',async()=>{
 const guard=installProductionPbkdf2Limit();try{
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
  const derive=iterations=>crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:Buffer.from(salt,'hex'),iterations},key,256);
  assert.equal((await derive(100000)).byteLength,32);
  for(const iterations of [100001,600000])await assert.rejects(derive(iterations),{name:'NotSupportedError'});
  assert.equal(guard.forbiddenCalls,2);
 }finally{guard.restore();}
});
test('fixed 600k PBKDF2 matches independent native reference under production cap',async()=>{
 const expected=pbkdf2Sync(password,Buffer.from(salt,'hex'),600000,32,'sha256').toString('hex');
 const guard=installProductionPbkdf2Limit();try{assert.equal(await passwordHash(password,salt),expected);assert.equal(guard.forbiddenCalls,0);}finally{guard.restore();}
});
test('existing 600k secret logs in; wrong password, tamper, logout and shared rate limit still reject',async()=>{
 const hash='pbkdf2-sha256$600000$'+salt+'$'+pbkdf2Sync(password,Buffer.from(salt,'hex'),600000,32,'sha256').toString('hex');
 const h=environment(hash),guard=installProductionPbkdf2Limit();try{
  const result=await h.call('/api/login',{password});assert.equal(result.status,200);const session=await result.json();
  assert.equal((await h.call('/api/session',null,session.token)).status,200);
  assert.equal((await h.call('/api/logout',{},session.token)).status,200);
  assert.equal((await h.call('/api/session',null,session.token)).status,401);
  for(let i=0;i<4;i++)assert.equal((await h.call('/api/login',{password:'wrong'})).status,401);
  assert.equal((await h.call('/api/login',{password})).status,429);assert.equal(h.env.APP_PASSWORD_HASH,hash);assert.equal(guard.forbiddenCalls,0);
 }finally{guard.restore();}
});
test('weaker or malformed stored hashes fail closed, never downgrade or bypass authentication',async()=>{
 for(const hash of ['pbkdf2-sha256$100000$'+salt+'$'+'0'.repeat(64),'malformed']){
  const h=environment(hash);assert.equal((await h.call('/api/login',{password})).status,503);
 }
 await assert.rejects(passwordHash(password,salt,600001));
});
