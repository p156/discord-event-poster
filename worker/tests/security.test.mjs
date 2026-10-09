import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{AuthState,passwordHash} from '../src/index.mjs';
const origin='https://poster.example';
const password='TEST_ONLY_password';
const names=['周遊型','ホール型','ルーム型','オンライン','持ち帰り','イマーシブ','謎解き','ホラー'];
async function setup(){
 const map=new Map();const storage={get:async k=>structuredClone(map.get(k)),put:async(k,v)=>map.set(k,structuredClone(v)),delete:async k=>map.delete(k),setAlarm:async()=>{}};
 const env={ALLOWED_ORIGIN:origin,DISCORD_BOT_TOKEN:'TEST_ONLY_BOT',DISCORD_FORUM_CHANNEL_ID:'123',APP_PASSWORD_HASH:'pbkdf2-sha256$600000$'+'ab'.repeat(16)+'$'+await passwordHash(password,'ab'.repeat(16)),SESSION_SIGNING_KEY:'c'.repeat(64)};
 const object=new AuthState({storage},env);env.AUTH_STATE={idFromName:()=>0,get:()=>({fetch:r=>object.fetch(r)})};
 const call=(path,method='GET',body,token,requestOrigin=origin)=>worker.fetch(new Request('https://discord-event-poster-api.monma5435.workers.dev'+path,{method,headers:{Origin:requestOrigin,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);
 const login=async()=>{const r=await call('/api/login','POST',{password});assert.equal(r.status,200);return r.json();};return {env,object,map,call,login};
}
test('signed sessions: tamper, expiration, logout replay and cross-instance revocation',async()=>{
 const h=await setup(),s=await h.login();assert.equal((await h.call('/api/session','GET',null,s.token)).status,200);
 assert.equal((await h.call('/api/session','GET',null,s.token.slice(0,-1)+(s.token.endsWith('0')?'1':'0'))).status,401);
 assert.equal((await h.call('/api/logout','POST',null,s.token)).status,200);
 const second=new AuthState({storage:h.object.storage},h.env);h.env.AUTH_STATE.get=()=>({fetch:r=>second.fetch(r)});
 assert.equal((await h.call('/api/session','GET',null,s.token)).status,401);
 const s2=await h.login();const real=Date.now;try{Date.now=()=>s2.expiresAt+1;assert.equal((await h.call('/api/session','GET',null,s2.token)).status,401);}finally{Date.now=real;}
});
test('shared global limit serializes concurrent attempts and survives object recreation',async()=>{
 const h=await setup();const results=await Promise.all(Array.from({length:7},()=>h.call('/api/login','POST',{password:'wrong'})));
 assert.equal(results.filter(r=>r.status===401).length,5);assert.equal(results.filter(r=>r.status===429).length,2);
 const other=new AuthState({storage:h.object.storage},h.env);h.env.AUTH_STATE.get=()=>({fetch:r=>other.fetch(r)});assert.equal((await h.call('/api/login','POST',{password})).status,429);
});
test('Origin, missing secrets, unknown proxy and unauthenticated requests fail closed',async()=>{
 const h=await setup();assert.equal((await h.call('/api/forum/tags')).status,401);
 assert.equal((await h.call('/api/login','POST',{password},null,'https://evil.example')).status,403);
 assert.equal((await h.call('/api/forum/tags?channel_id=999')).status,400);
 assert.equal((await h.call('/api/discord/channels/999')).status,404);
 delete h.env.SESSION_SIGNING_KEY;assert.equal((await h.call('/api/login','POST',{password})).status,503);
});
test('fixed forum tags detect duplicates/missing; webhook membership; upstream sanitized',async()=>{
 const h=await setup(),s=await h.login();const real=globalThis.fetch;const calls=[];
 try{globalThis.fetch=async(url,opts)=>{calls.push({url,opts});return Response.json(url.endsWith('/webhooks')?[{id:'456',type:1,channel_id:'123',token:'NEVER_RETURN'}]:{id:'123',type:15,available_tags:[...names.slice(0,7).map((name,i)=>({name,id:String(100+i)})),{name:'周遊型',id:'200'},{name:'その他',id:'201'}]});};
 const r=await h.call('/api/forum/tags','GET',null,s.token),body=await r.json();assert.deepEqual(body.missing,['ホラー']);assert.deepEqual(body.duplicates,['周遊型']);assert.equal(body.mapping['周遊型'],undefined);
 assert.equal((await h.call('/api/forum/webhook-check','POST',{webhookId:'456'},s.token)).status,200);
 assert.equal((await h.call('/api/forum/webhook-check','POST',{webhookId:'999'},s.token)).status,409);
 assert.ok(calls.every(c=>c.url.startsWith('https://discord.com/api/v10/channels/123')));
 const logs=[],realError=console.error;console.error=(...args)=>logs.push(args.join(' '));
 try {
  globalThis.fetch=async()=>{throw new Error(h.env.DISCORD_BOT_TOKEN);};const error=await h.call('/api/forum/tags','GET',null,s.token);assert.equal(error.status,503);assert.ok(!(await error.text()).includes(h.env.DISCORD_BOT_TOKEN));
  assert.deepEqual(JSON.parse(logs.at(-1)),{event:'request_failed',stage:'discord_fetch',errorName:'Error'});
  assert.ok(logs.every(line=>!line.includes(h.env.DISCORD_BOT_TOKEN)));
 } finally { console.error=realError; }
 }finally{globalThis.fetch=real;}
});
test('Discord failure stages preserve safe status diagnostics',async()=>{
 const statuses=[401,403,404,429,500,502,503];
 for(const status of statuses){
  const h=await setup(),s=await h.login(),logs=[],realFetch=globalThis.fetch,realError=console.error;console.error=(...args)=>logs.push(args.join(' '));
  try { globalThis.fetch=async()=>new Response('SECRET_RESPONSE_BODY',{status});const r=await h.call('/api/forum/tags','GET',null,s.token);assert.equal(r.status,502);assert.ok(!(await r.text()).includes('SECRET_RESPONSE_BODY'));assert.deepEqual(JSON.parse(logs.at(-1)),{event:'request_failed',stage:'discord_response',errorName:'Error',status}); }
  finally { globalThis.fetch=realFetch;console.error=realError; }
 }
});
test('Discord JSON and forum-shape failures are classified without body leakage',async()=>{
 const h=await setup(),s=await h.login(),realFetch=globalThis.fetch,realError=console.error,logs=[];console.error=(...args)=>logs.push(args.join(' '));
 try {
  globalThis.fetch=async()=>new Response('NOT_JSON_SECRET',{status:200});let r=await h.call('/api/forum/tags','GET',null,s.token);assert.equal(r.status,503);assert.ok(!(await r.text()).includes('NOT_JSON_SECRET'));assert.deepEqual(JSON.parse(logs.at(-1)),{event:'request_failed',stage:'discord_json_parse',errorName:'SyntaxError'});
  globalThis.fetch=async()=>Response.json({id:'123',type:13,available_tags:[]});r=await h.call('/api/forum/tags','GET',null,s.token);assert.equal(r.status,502);assert.deepEqual(JSON.parse(logs.at(-1)),{event:'request_failed',stage:'discord_response',errorName:'InvalidForumResponse'});
  assert.ok(logs.every(line=>!line.includes('NOT_JSON_SECRET')));
 } finally { globalThis.fetch=realFetch;console.error=realError; }
});
test('normal forum fetch rejects every redirect without following or forwarding the token',async()=>{
 const statuses=[301,302,307,308];
 for(const status of statuses){
  const h=await setup(),s=await h.login(),calls=[],realFetch=globalThis.fetch,realError=console.error,logs=[];console.error=(...args)=>logs.push(args.join(' '));
  try { globalThis.fetch=async(url,opts)=>{calls.push({url,opts});return new Response(null,{status,headers:{Location:'https://secret.invalid/target'}});};const r=await h.call('/api/forum/tags','GET',null,s.token);assert.equal(r.status,502);assert.equal(calls.length,1);assert.equal(calls[0].opts.redirect,'manual');assert.equal(calls[0].opts.headers.Authorization,'Bot TEST_ONLY_BOT');assert.deepEqual(JSON.parse(logs.at(-1)),{event:'request_failed',stage:'discord_response',errorName:'Error',status}); }
  finally { globalThis.fetch=realFetch;console.error=realError; }
 }
});
