import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.mjs';
import {fixture,payload} from './post-fixtures.mjs';
import {createDiscordFetch} from '../src/discord-cooldown.mjs';
test('server-only exact gate: absent/false/non-string rejects posts, intent, status and preflight',async()=>{
 const h=await fixture();h.env.APP_PASSWORD_HASH='pbkdf2-sha256$600000$'+'ab'.repeat(16)+'$'+'cd'.repeat(32);
 for(const value of [undefined,'false',false,true,'TRUE','1']){h.env.FORUM_POSTS_ENABLED=value;for(const path of ['/api/forum/posts','/api/forum/post-intents','/api/forum/posts/'+crypto.randomUUID()])assert.equal((await worker.fetch(h.request(path,'POST',payload(),null,h.token,{'X-Forum-Posts-Enabled':'true'}),h.env)).status,404);assert.equal((await worker.fetch(h.request('/api/forum/posts','OPTIONS',null,null,h.token,{'Access-Control-Request-Method':'POST'}),h.env)).status,404);}
 h.env.FORUM_POSTS_ENABLED='true';assert.equal((await worker.fetch(h.request('/api/forum/post-intents','POST',payload(),null,''),h.env)).status,401);assert.equal((await worker.fetch(h.request('/api/forum/post-intents','POST',payload(),null,h.token,{Origin:'https://evil.invalid'}),h.env)).status,403);assert.equal((await worker.fetch(h.request('/api/forum/post-intents','POST',payload(),null,h.token,{Host:'evil.invalid'}),h.env)).status,403);const r=await worker.fetch(h.request('/api/forum/post-intents'),h.env);assert.equal(r.status,201);assert.equal(h.writes,0);
});
test('non-global cooldown isolates route, method and major; shared learned bucket links only proven routes',async()=>{
 const h=await fixture();let count=0,limited=false;
 const fetcher=async(url,opts)=>{count++;const web=String(url).endsWith('/webhooks');return limited&&!web?Response.json({retry_after:120,global:false},{status:429,headers:{'X-RateLimit-Bucket':'tag-bucket'}}):Response.json({}, {headers:{'X-RateLimit-Bucket':web?'webhook-bucket':'tag-bucket'}});};
 const fetch=createDiscordFetch(h.env,h.token,fetcher),tag='https://discord.com/api/v10/channels/123',web=tag+'/webhooks';
 await fetch(tag,{method:'GET'});await fetch(web,{method:'GET'});limited=true;await fetch(tag,{method:'GET'});await assert.rejects(()=>fetch(tag,{method:'GET'}),e=>e.status===429);assert.equal(count,3);await fetch(web,{method:'GET'});assert.equal(count,4);
 limited=false;await fetch(tag+'/threads',{method:'POST'});limited=true;await assert.rejects(()=>fetch(tag+'/threads',{method:'POST'}),e=>e.status===429); // Same bucket explicitly learned, not inferred from the channel.
 const other=createDiscordFetch({...h.env,DISCORD_FORUM_CHANNEL_ID:'999'},h.token,fetcher);await other('https://discord.com/api/v10/channels/999',{method:'GET'});assert.ok(count>=6);
});
test('unknown bucket 429 blocks only same route; explicit global blocks tags/webhooks/posts',async()=>{
 for(const global of [false,true]){const h=await fixture();let count=0;const f=createDiscordFetch(h.env,h.token,async()=>{count++;return Response.json({retry_after:90,global},{status:429});});await f('https://discord.com/api/v10/channels/123',{method:'GET'});await assert.rejects(()=>f('https://discord.com/api/v10/channels/123',{method:'GET'}),e=>e.status===429);
 if(global){await assert.rejects(()=>f('https://discord.com/api/v10/channels/123/webhooks',{method:'GET'}),e=>e.status===429);assert.equal(count,1);}else{await f('https://discord.com/api/v10/channels/123/webhooks',{method:'GET'});assert.equal(count,2);}}
});
test('legacy tag read and webhook check respect shared global cooldown with no automatic retry',async()=>{
 const h=await fixture();h.env.APP_PASSWORD_HASH='pbkdf2-sha256$600000$'+'ab'.repeat(16)+'$'+'cd'.repeat(32);let calls=0;const original=globalThis.fetch;
 try{globalThis.fetch=async()=>{calls++;return Response.json({retry_after:120,global:true},{status:429});};const tags=await worker.fetch(h.request('/api/forum/tags','GET'),h.env);assert.equal(tags.status,429);const check=await worker.fetch(h.request('/api/forum/webhook-check','POST',{webhookId:'456'}),h.env);assert.equal(check.status,429);assert.equal(calls,1);assert.ok(Number(check.headers.get('Retry-After'))>=120);}finally{globalThis.fetch=original;}
});
