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
 const call=(path,method='GET',body,token,requestOrigin=origin)=>worker.fetch(new Request('https://worker.example'+path,{method,headers:{Origin:requestOrigin,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);
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
test('owner-only Discord connectivity diagnostic compares fixed anonymous and bot requests',async()=>{
 const h=await setup(),s=await h.login(),realFetch=globalThis.fetch,realLog=console.log,calls=[],logs=[];console.log=(...args)=>logs.push(args.join(' '));
 try {
  globalThis.fetch=async(url,opts)=>{calls.push({url,opts});return url.endsWith('/gateway')?new Response(null,{status:204}):new Response('{}',{status:200});};
  const r=await h.call('/api/diagnostics/discord','POST',null,s.token),body=await r.json();assert.equal(r.status,200);assert.deepEqual(body,{anonymous:{kind:'http_response',status:204},bot:{kind:'http_response',status:200},comparison:{bot_manual_abort_signal:{kind:'http_response',status:200},bot_error_controller:{kind:'http_response',status:200},bot_manual_controller:{kind:'http_response',status:200}}});
  assert.equal(calls.length,5);assert.equal(calls[0].url,'https://discord.com/api/v10/gateway');assert.deepEqual(calls[0].opts.headers,{});assert.equal(calls[1].url,'https://discord.com/api/v10/channels/123');assert.equal(calls[1].opts.headers.Authorization,'Bot TEST_ONLY_BOT');assert.equal(calls[1].opts.redirect,'error');assert.equal(calls[2].opts.redirect,'manual');assert.equal(calls[3].opts.redirect,'error');assert.equal(calls[4].opts.redirect,'manual');assert.ok(logs.every(line=>!line.includes('TEST_ONLY_BOT')));
 } finally { globalThis.fetch=realFetch;console.log=realLog; }
});
test('diagnostic classifies redirects, fetch failures, explicit timeout and access controls',async()=>{
 const h=await setup(),s=await h.login(),realFetch=globalThis.fetch,realLog=console.log,realSetTimeout=globalThis.setTimeout,realClearTimeout=globalThis.clearTimeout,realNow=Date.now;let clock=realNow();Date.now=()=>clock;
 try {
  globalThis.fetch=async(url,opts)=>opts.redirect==='error'?(()=>{throw new TypeError('SECRET_REDIRECT');})():Response.redirect('https://secret.invalid',302);let r=await h.call('/api/diagnostics/discord','POST',null,s.token);assert.deepEqual(await r.json(),{anonymous:{kind:'unknown_fetch_error'},bot:{kind:'unknown_fetch_error'},comparison:{bot_manual_abort_signal:{kind:'redirect',status:302},bot_error_controller:{kind:'unknown_fetch_error'},bot_manual_controller:{kind:'redirect',status:302}}});clock+=60001;
  globalThis.fetch=async()=>{throw new TypeError('SECRET_EXCEPTION');};r=await h.call('/api/diagnostics/discord','POST',null,s.token);assert.deepEqual(await r.json(),{anonymous:{kind:'unknown_fetch_error'},bot:{kind:'unknown_fetch_error'},comparison:{bot_manual_abort_signal:{kind:'unknown_fetch_error'},bot_error_controller:{kind:'unknown_fetch_error'},bot_manual_controller:{kind:'unknown_fetch_error'}}});clock+=60001;
  globalThis.setTimeout=callback=>{callback();return 0;};globalThis.clearTimeout=()=>{};globalThis.fetch=async()=>{throw Object.assign(new Error('SECRET_TIMEOUT'),{name:'TimeoutError'});};r=await h.call('/api/diagnostics/discord','POST',null,s.token);assert.deepEqual(await r.json(),{anonymous:{kind:'timeout'},bot:{kind:'timeout'},comparison:{bot_manual_abort_signal:{kind:'timeout'},bot_error_controller:{kind:'timeout'},bot_manual_controller:{kind:'timeout'}}});globalThis.setTimeout=realSetTimeout;globalThis.clearTimeout=realClearTimeout;
  assert.equal((await h.call('/api/diagnostics/discord','POST')).status,401);assert.equal((await h.call('/api/diagnostics/discord','POST',null,s.token,'https://evil.example')).status,403);
  globalThis.fetch=async()=>Response.json({});const next=await h.login();assert.equal((await h.call('/api/diagnostics/discord','POST',null,next.token)).status,429);
 } finally { globalThis.setTimeout=realSetTimeout;globalThis.clearTimeout=realClearTimeout;globalThis.fetch=realFetch;console.log=realLog;Date.now=realNow; }
});
test('normal forum fetch rejects every redirect without following or forwarding the token',async()=>{
 const statuses=[301,302,307,308];
 for(const status of statuses){
  const h=await setup(),s=await h.login(),calls=[],realFetch=globalThis.fetch,realError=console.error,logs=[];console.error=(...args)=>logs.push(args.join(' '));
  try { globalThis.fetch=async(url,opts)=>{calls.push({url,opts});return new Response(null,{status,headers:{Location:'https://secret.invalid/target'}});};const r=await h.call('/api/forum/tags','GET',null,s.token);assert.equal(r.status,502);assert.equal(calls.length,1);assert.equal(calls[0].opts.redirect,'manual');assert.equal(calls[0].opts.headers.Authorization,'Bot TEST_ONLY_BOT');assert.deepEqual(JSON.parse(logs.at(-1)),{event:'request_failed',stage:'discord_response',errorName:'Error',status}); }
  finally { globalThis.fetch=realFetch;console.error=realError; }
 }
});
