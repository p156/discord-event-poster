import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import worker,{AuthState,passwordHash} from '../src/index.mjs';
import {WORKER_HOST,hasAllowedHost} from '../src/request-boundary.mjs';
import {parseStrictJson,validatePostPayload,readPostRequest,PostInputError} from '../src/forum-input.mjs';
import {botCanManageThreads,forumTagMapping} from '../src/forum-tags.mjs';
import {prepareForumPost,sendPreparedForumPost} from '../src/forum-posts.mjs';
const originalFetch=globalThis.fetch;
before(()=>{globalThis.fetch=()=>{throw new Error('REAL_NETWORK_DISABLED');};});
after(()=>{globalThis.fetch=originalFetch;});
const token='TEST_ONLY_BOT_TOKEN_NEVER_EXPOSE';
const env={DISCORD_BOT_TOKEN:token,DISCORD_FORUM_CHANNEL_ID:'123'};
const names=['周遊型','ホール型','ルーム型','オンライン','持ち帰り','イマーシブ','謎解き','ホラー'];
const payload=()=>({apiVersion:1,threadName:'【東京】題',content:'@everyone <@111> <@&222> https://outside.invalid/',tagIds:['100']});
const forum=()=>({id:'123',guild_id:'456',type:15,flags:0,permission_overwrites:[],available_tags:names.map((name,i)=>({id:String(100+i),name,moderated:false}))});
const receipt=()=>({id:'789',type:11,parent_id:'123',guild_id:'456',message:{id:'790',channel_id:'789'},token,content:token,url:'https://untrusted.invalid/'});
function mock({channel=forum(),post=()=>Response.json(receipt()),get,extras}={}){
 const calls=[];
 const fetchImpl=async(url,opts)=>{calls.push({url,opts});if(opts.method==='POST')return post(url,opts);if(url==='https://discord.com/api/v10/channels/123')return get?get(url,opts):Response.json(channel);if(extras)return extras(url,opts);throw new Error('Unexpected mock route');};
 return {calls,fetchImpl};
}
async function run(mocked,input=payload(),config=env,timeoutMs=10000){const p=await prepareForumPost(config,input,{fetchImpl:mocked.fetchImpl,timeoutMs});return p.outcome==='prepared'?sendPreparedForumPost(p.context):p;}
const posts=h=>h.calls.filter(c=>c.opts.method==='POST');
function req(text,headers={},body){return new Request('https://'+WORKER_HOST+'/api/forum/posts',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:body??text,...(body?{duplex:'half'}:{})});}

test('fixed Bot payload, mention suppression, trusted links; no token/body echo',async()=>{
 const h=mock(),r=await run(h);assert.equal(r.outcome,'succeeded');assert.equal(posts(h).length,1);
 const c=posts(h)[0];assert.equal(c.url,'https://discord.com/api/v10/channels/123/threads');assert.equal(c.opts.headers.Authorization,'Bot '+token);assert.equal(c.opts.redirect,'manual');
 assert.deepEqual(JSON.parse(c.opts.body),{name:payload().threadName,message:{content:payload().content,allowed_mentions:{parse:[],replied_user:false}},applied_tags:['100']});
 assert.equal(r.result.url,'https://discord.com/channels/456/789/790');assert.equal(r.safeToRetry,false);assert.ok(!JSON.stringify(r).includes(token));assert.ok(!JSON.stringify(r).includes('untrusted.invalid'));
 assert.ok(h.calls.every(c=>c.url.startsWith('https://discord.com/api/v10/')));assert.equal(h.calls.length,2);
});
test('immutable prepared snapshot, no secret in context, one-use handoff',async()=>{
 const h=mock(),p=payload(),e={...env};const ready=await prepareForumPost(e,p,{fetchImpl:h.fetchImpl});assert.equal(ready.outcome,'prepared');assert.ok(!JSON.stringify(ready).includes(token));
 p.content='CHANGED';p.tagIds.push('101');e.DISCORD_FORUM_CHANNEL_ID='999';e.DISCORD_BOT_TOKEN='OTHER';
 assert.equal((await sendPreparedForumPost(ready.context)).outcome,'succeeded');assert.equal(JSON.parse(posts(h)[0].opts.body).message.content,payload().content);
 assert.equal((await sendPreparedForumPost(ready.context)).code,'ADAPTER_CONTEXT_INVALID');assert.equal(posts(h).length,1);assert.equal((await sendPreparedForumPost({})).writeStarted,false);
});
test('expired preparation cannot be reused even after clock restoration',async()=>{
 const h=mock(),ready=await prepareForumPost(env,payload(),{fetchImpl:h.fetchImpl});const real=Date.now,t=real();
 try{Date.now=()=>t+15001;assert.equal((await sendPreparedForumPost(ready.context)).code,'ADAPTER_CONTEXT_INVALID');}finally{Date.now=real;}
 assert.equal((await sendPreparedForumPost(ready.context)).code,'ADAPTER_CONTEXT_INVALID');assert.equal(posts(h).length,0);
});
test('UTF-16 boundaries, normalization, emoji and combining characters',()=>{
 assert.equal(validatePostPayload({...payload(),threadName:'x'.repeat(100),content:'x'.repeat(2000)}).content.length,2000);
 for(const p of [{threadName:'x'.repeat(101)},{content:'x'.repeat(2001)},{threadName:'😀'.repeat(51)},{content:'😀'.repeat(1001)}])assert.throws(()=>validatePostPayload({...payload(),...p}),PostInputError);
 assert.equal(validatePostPayload({...payload(),threadName:'😀'.repeat(50),content:'😀'.repeat(1000)}).threadName.length,100);
 assert.equal(validatePostPayload({...payload(),threadName:' 題 ',content:' e\u0301\r\nx\ry\t '}).content,' e\u0301\nx\ny\t ');
 assert.equal(validatePostPayload({...payload(),threadName:' 題 '}).threadName,'題');
});
test('invalid types, unknown destinations, whitespace, controls, unpaired surrogates reject before GET',async()=>{
 const inputs=[null,[],42,{...payload(),apiVersion:2},{...payload(),apiVersion:'1'},...['threadName','content'].flatMap(k=>[null,123,{},[],true,'','  ','a\x00b','a\x7fb','\ud800','\udc00'].map(v=>({...payload(),[k]:v}))),{...payload(),threadName:'a\nb'},{...payload(),threadName:'\t題'},...['forumId','botToken','webhookUrl','allowed_mentions','channelId','actor','operationId'].map(k=>({...payload(),[k]:'FORBIDDEN'}))];
 for(const input of inputs){const h=mock(),r=await run(h,input);assert.equal(r.writeStarted,false);assert.equal(h.calls.length,0);assert.ok(['INVALID_REQUEST','CONTENT_INVALID'].includes(r.code));}
});
test('tag ID count/64bit/duplicates/types validation; 0 and 5 allowed',()=>{
 for(const ids of [null,'100',[100],['0'],['01'],['-1'],['1e3'],['18446744073709551616'],['100','100'],Array.from({length:6},(_,i)=>String(100+i))])assert.throws(()=>validatePostPayload({...payload(),tagIds:ids}),PostInputError);
 assert.equal(validatePostPayload({...payload(),tagIds:['18446744073709551615']}).tagIds.length,1);
 assert.equal(validatePostPayload({...payload(),tagIds:undefined}).tagIds.length,0);assert.equal(validatePostPayload({...payload(),tagIds:['100','101','102','103','104']}).tagIds.length,5);
});
test('strict JSON: escaped duplicate keys, deep structures, prototype fields, bad grammar',()=>{
 for(const text of ['{"apiVersion":1,"apiVersion":1}','{"tagIds":[],"tag\\u0049ds":[]}','{"a":{"b":{"c":{}}}}','{"x":1,}','[1,]','{"x":NaN}','{"x":01}','{"x":"\\q"}','{"x":"\n"}','{}true','\ufeff{}'])assert.throws(()=>parseStrictJson(text),PostInputError);
 for(const value of [{a:[1,true,false,null,'a"\\\n']},[1,2],{a:{b:1}},123,-0,1.1])assert.deepEqual(JSON.parse(JSON.stringify(parseStrictJson(JSON.stringify(value)))),JSON.parse(JSON.stringify(value)));
 assert.equal(Object.is(parseStrictJson('-0'),-0),true);
 assert.throws(()=>validatePostPayload(parseStrictJson('{"__proto__":{},"apiVersion":1,"threadName":"x","content":"x"}')),PostInputError);
});
test('JSON byte exact 16KiB and over-limit with false Content-Length',async()=>{
 const text=JSON.stringify(payload()),exact=text+' '.repeat(16384-new TextEncoder().encode(text).length);
 assert.equal((await readPostRequest(req(exact,{'Content-Length':'1'}))).apiVersion,1);
 await assert.rejects(readPostRequest(req(exact+' ',{'Content-Length':'1'})),{code:'BODY_TOO_LARGE',httpStatus:413});
 const multi=JSON.stringify({...payload(),content:'謎'.repeat(2000)});assert.equal((await readPostRequest(req(multi))).content.length,2000);
 await assert.rejects(readPostRequest(req('','',new ReadableStream({start(c){c.enqueue(new Uint8Array([0xc3,0x28]));c.close();}}))),{code:'INVALID_REQUEST'});
});
test('JSON media/encoding/type and body deadline are controlled without raw errors',async()=>{
 for(const h of [{'Content-Type':'text/plain'},{'Content-Type':'application/json; charset=iso-8859-1'},{'Content-Encoding':'gzip'}])await assert.rejects(readPostRequest(req(JSON.stringify(payload()),h)),{code:'UNSUPPORTED_MEDIA'});
 await assert.rejects(readPostRequest(req('not-json '+token)),{code:'INVALID_REQUEST'});
 await assert.rejects(readPostRequest(req('',{},new ReadableStream({})),{timeoutMs:5}),{code:'BODY_TIMEOUT',httpStatus:408});
});
test('fixed forum identity, shape and required tags reject before POST',async()=>{
 for(const channel of [{...forum(),id:'999'},{...forum(),type:0},{...forum(),guild_id:'bad'},{...forum(),available_tags:null}]){const h=mock({channel}),r=await run(h);assert.equal(r.code,'FORUM_RESPONSE_INVALID');assert.equal(posts(h).length,0);}
 const h=mock({channel:{...forum(),flags:16}});assert.equal((await run(h,{...payload(),tagIds:[]})).code,'TAG_REQUIRED');assert.equal(posts(h).length,0);
 assert.equal((await run(mock(),{...payload(),tagIds:[]})).outcome,'succeeded');
});
test('tag mapping shared with Phase 2; unknown/missing/duplicate names and IDs reject',async()=>{
 const f=forum();assert.equal(forumTagMapping(f).mapping['周遊型'],'100');
 for(const channel of [{...f,available_tags:f.available_tags.slice(1)},{...f,available_tags:[...f.available_tags,{id:'999',name:'周遊型',moderated:false}]},{...f,available_tags:[...f.available_tags,{id:'100',name:'その他',moderated:false}]},{...f,available_tags:[{id:'100',name:'その他',moderated:false}]}]){const h=mock({channel});assert.equal((await run(h)).code,'TAG_INVALID');assert.equal(posts(h).length,0);}
 const h=mock({channel:{...f,available_tags:[{id:'100',name:'周遊型',moderated:false}]}});assert.equal((await run(h)).outcome,'succeeded');
});
test('moderated tag permissions use fixed Bot/guild roles, never a client capability',async()=>{
 const channel=forum();channel.available_tags[0].moderated=true;
 const h=mock({channel,extras:(url)=>url.endsWith('/users/@me')?Response.json({id:'777',bot:true}):url.endsWith('/roles')?Response.json([{id:'456',permissions:'8'}]):Response.json({user:{id:'777'},roles:[]})});
 assert.equal((await run(h)).outcome,'succeeded');assert.deepEqual(h.calls.map(c=>c.url),['https://discord.com/api/v10/channels/123','https://discord.com/api/v10/users/@me','https://discord.com/api/v10/guilds/456/roles','https://discord.com/api/v10/guilds/456/members/777','https://discord.com/api/v10/channels/123/threads']);
 const denied=mock({channel,extras:url=>url.endsWith('/users/@me')?Response.json({id:'777',bot:true}):url.endsWith('/roles')?Response.json([{id:'456',permissions:'0'}]):Response.json({user:{id:'777'},roles:[]})});assert.equal((await run(denied)).code,'TAG_PERMISSION_UNVERIFIED');assert.equal(posts(denied).length,0);
 const r=await run(mock(),{...payload(),canManageThreads:true});assert.equal(r.code,'INVALID_REQUEST');
});
test('effective role/everyone/member overwrites, ADMINISTRATOR, timeout, incomplete proof',()=>{
 const f=forum(),self={id:'777',bot:true},m={user:{id:'777'},roles:['888']},p=(1024n|(1n<<34n)).toString(),roles=[{id:'456',permissions:p},{id:'888',permissions:'0'}];
 assert.equal(botCanManageThreads(f,self,m,roles),true);
 const deny={id:'456',type:0,deny:(1n<<34n).toString(),allow:'0'};assert.equal(botCanManageThreads({...f,permission_overwrites:[deny]},self,m,roles),false);
 const allow={id:'888',type:0,deny:'0',allow:(1n<<34n).toString()};assert.equal(botCanManageThreads({...f,permission_overwrites:[deny,allow]},self,m,roles),true);
 const memberDeny={id:'777',type:1,deny:(1n<<34n).toString(),allow:'0'};assert.equal(botCanManageThreads({...f,permission_overwrites:[deny,allow,memberDeny]},self,m,roles),false);
 assert.equal(botCanManageThreads(f,self,{...m,communication_disabled_until:'2099-01-01T00:00:00Z'},roles),false);
 assert.equal(botCanManageThreads({...f,permission_overwrites:[deny]},self,m,[{id:'456',permissions:'8'},{id:'888',permissions:'0'}]),true);
 assert.throws(()=>botCanManageThreads(f,self,m,[]),PostInputError);assert.throws(()=>botCanManageThreads(f,self,{...m,user:{id:'999'}},roles),PostInputError);
});

for(const [status,code]of [[400,'DISCORD_REQUEST_REJECTED'],[401,'DISCORD_CREDENTIAL_REJECTED'],[403,'DISCORD_PERMISSION_DENIED'],[404,'DISCORD_TARGET_UNAVAILABLE']])test('Discord '+status+' is a known non-creation rejection, sanitized, no retry',async()=>{
 const h=mock({post:()=>Response.json({message:token},{status})}),r=await run(h);assert.equal(r.outcome,'rejected');assert.equal(r.code,code);assert.equal(r.upstreamStatus,status);assert.equal(r.safeToRetry,false);assert.equal(posts(h).length,1);assert.ok(!JSON.stringify(r).includes(token));
});
for(const status of [301,302,303,307,308,500,502,503])test('Discord '+status+' after write is unknown and never followed/retried',async()=>{
 const h=mock({post:()=>new Response(token,{status,headers:{Location:'https://evil.invalid/'+token}})}),r=await run(h);assert.equal(r.outcome,'unknown');assert.equal(r.code,'OUTCOME_UNKNOWN');assert.equal(r.failureCode,status<400?'REDIRECT':'HTTP_ERROR');assert.equal(r.safeToRetry,false);assert.equal(posts(h).length,1);assert.equal(h.calls.length,2);assert.ok(!JSON.stringify(r).includes(token));
});
test('network failure after write vs preflight; raw exceptions never escape',async()=>{
 const logs=[],real=console.error;console.error=(...args)=>logs.push(args);
 try{const h=mock({post:()=>{throw new TypeError(token);}}),r=await run(h);assert.equal(r.outcome,'unknown');assert.equal(r.failureCode,'NETWORK');assert.ok(!JSON.stringify(r).includes(token));assert.equal(posts(h).length,1);
 const pre=mock({get:()=>{throw new Error(token);}}),n=await run(pre);assert.equal(n.outcome,'not_sent');assert.equal(n.safeToRetry,true);assert.equal(posts(pre).length,0);assert.equal(logs.length,0);}finally{console.error=real;}
});
test('fetch and body timeouts after write are unknown; no retry; before write stays non-sent',async()=>{
 for(const post of [()=>new Promise(()=>{}),()=>new Response(new ReadableStream({}),{status:200})]){const h=mock({post}),r=await run(h,payload(),env,5);assert.equal(r.outcome,'unknown');assert.equal(r.failureCode,'TIMEOUT');assert.equal(r.safeToRetry,false);assert.equal(posts(h).length,1);}
 const h=mock({get:()=>new Promise(()=>{})}),r=await run(h,payload(),env,5);assert.equal(r.outcome,'not_sent');assert.equal(r.failureCode,'TIMEOUT');assert.equal(posts(h).length,0);
});
test('429 retains largest positive wait and scope; no automatic request occurs',async()=>{
 const h=mock({post:()=>Response.json({retry_after:120,global:true,message:token},{status:429,headers:{'Retry-After':'2','X-RateLimit-Reset-After':'3','X-RateLimit-Bucket':'bucket123','X-RateLimit-Scope':'global'}})}),r=await run(h);
 assert.equal(r.outcome,'rejected');assert.equal(r.code,'DISCORD_RATE_LIMITED');assert.equal(r.retry.retryAfterSeconds,120);assert.equal(r.retry.global,true);assert.equal(r.retry.automaticRetryAllowed,true);assert.equal(posts(h).length,1);assert.ok(!JSON.stringify(r).includes(token));
 for(const body of ['not-json',JSON.stringify({retry_after:true}),JSON.stringify({retry_after:-1})]){const bad=mock({post:()=>new Response(body,{status:429,headers:{'X-RateLimit-Bucket':token}})}),x=await run(bad);assert.equal(x.retry.retryAfterSeconds,60);assert.equal(x.retry.automaticRetryAllowed,false);assert.equal(x.retry.bucket,null);assert.equal(posts(bad).length,1);}
 const pre=mock({get:()=>Response.json({retry_after:4},{status:429})}),x=await run(pre);assert.equal(x.outcome,'not_sent');assert.equal(x.retry.retryAfterSeconds,4);assert.equal(posts(pre).length,0);
});
test('successful HTTP with invalid JSON/receipt/oversize is unknown; IDs cannot create arbitrary links',async()=>{
 const variants=[()=>new Response(token,{status:200}),()=>new Response(null,{status:204}),()=>Response.json({}),()=>Response.json({...receipt(),parent_id:'999'}),()=>Response.json({...receipt(),guild_id:'999'}),()=>Response.json({...receipt(),type:0}),()=>Response.json({...receipt(),id:'https://evil.invalid'}),()=>Response.json({...receipt(),message:{id:'790',channel_id:'999'}}),()=>new Response('x'.repeat(65537),{status:200})];
 for(const post of variants){const h=mock({post}),r=await run(h);assert.equal(r.outcome,'unknown');assert.equal(r.safeToRetry,false);assert.equal(posts(h).length,1);assert.ok(!JSON.stringify(r).includes(token));}
});
test('invalid server configuration never fetches; read method overrides are ignored',async()=>{
 for(const e of [{...env,DISCORD_FORUM_CHANNEL_ID:'https://evil.invalid'},{...env,DISCORD_BOT_TOKEN:'x\r\nAuthorization: other'},{...env,DISCORD_BOT_TOKEN:''}]){const h=mock(),r=await run(h,payload(),e);assert.equal(r.writeStarted,false);assert.equal(h.calls.length,0);}
 const h=mock();const r=await prepareForumPost(env,payload(),{fetchImpl:h.fetchImpl,method:'DELETE',body:'bad'});assert.equal(r.outcome,'prepared');assert.equal(h.calls[0].opts.method,'GET');
});
test('Host boundary ignores spoofed forward headers and preserves the canonical deployed host',()=>{
 const good=path=>new Request('https://'+WORKER_HOST+path);
 assert.equal(hasAllowedHost(good('/api/session')),true);assert.equal(hasAllowedHost(new Request('https://'+WORKER_HOST,{headers:{Host:WORKER_HOST+':443','X-Forwarded-Host':'evil.invalid'}})),true);
 for(const url of ['http://'+WORKER_HOST,'https://'+WORKER_HOST+':444','https://evil.invalid','https://'+WORKER_HOST+'.evil.invalid'])assert.equal(hasAllowedHost(new Request(url,{headers:{'X-Forwarded-Host':WORKER_HOST}})),false);
 assert.equal(hasAllowedHost(new Request('https://'+WORKER_HOST,{headers:{Host:'evil.invalid'}})),false);
});
test('public routes and RPC exports cannot reach the posting adapter, even with a valid session',async()=>{
 const data=new Map(),state={storage:{get:async k=>data.get(k),put:async(k,v)=>data.set(k,v),setAlarm:async()=>{}}};
 const e={...env,ALLOWED_ORIGIN:'https://poster.example',SESSION_SIGNING_KEY:'a'.repeat(64),APP_PASSWORD_HASH:'pbkdf2-sha256$600000$'+'ab'.repeat(16)+'$'+await passwordHash('TEST_ONLY_PASSWORD','ab'.repeat(16))};const auth=new AuthState(state,e);e.AUTH_STATE={idFromName:()=>0,get:()=>({fetch:r=>auth.fetch(r)})};
 const call=(url,path,headers={})=>worker.fetch(new Request(url+path,{method:'POST',headers:{Origin:e.ALLOWED_ORIGIN,'Content-Type':'application/json',...headers},body:JSON.stringify({password:'TEST_ONLY_PASSWORD',...payload()})}),e);
 const base='https://'+WORKER_HOST;const login=await call(base,'/api/login');assert.equal(login.status,200);const s=await login.json();
 for(const path of ['/api/forum/posts','/api/forum/post-intents','/api/diagnostics/post','/api/forum/posts/123'])assert.equal((await call(base,path,{Authorization:'Bearer '+s.token})).status,404);
 assert.equal((await call('https://evil.invalid','/api/login')).status,403);assert.equal((await call(base,'/api/login',{Origin:'https://evil.invalid'})).status,403);
 const built=await build({entryPoints:[fileURLToPath(new URL('../src/index.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'browser',metafile:true});
 assert.ok(!Object.keys(built.metafile.inputs).some(p=>p.endsWith('forum-posts.mjs')||p.endsWith('post-handler.mjs')));assert.deepEqual(built.metafile.outputs[Object.keys(built.metafile.outputs)[0]].exports.sort(),['AuthState','default','passwordHash']);
});
