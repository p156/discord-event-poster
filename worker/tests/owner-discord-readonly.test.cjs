'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{Readable}=require('node:stream');
const {EXPECTED:E,collect,run}=require('../tools/owner-discord-readonly.cjs');
globalThis.fetch=()=>{throw Error('LIVE_FORBIDDEN');};
const token='FAKE_SECRET_MARKER';
const self={id:E.botId,bot:true,username:token};
const forum={id:E.forumId,guild_id:E.guildId,type:15,topic:token};
function fixture(bodies=[self,forum],status=200){let count=0;return {get count(){return count;},fetch:async(url,init)=>{
 assert.equal(url,['https://discord.com/api/v10/users/@me','https://discord.com/api/v10/channels/'+E.forumId][count]);
 assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.headers.Authorization,'Bot '+token);
 return new Response(JSON.stringify(bodies[count++]),{status});
}};}
test('two fixed GETs; projection cannot promote Worker identity or disclose response fields',async()=>{
 const f=fixture(),r=await collect(token,f.fetch);assert.equal(f.count,2);assert.equal(r.status,'PASS');
 for(const key of ['workerTokenIdentity','workerForumIdentity','botForum','effectivePermissions'])assert.equal(r[key],'NOT VERIFIED');
 assert.equal(r.productionGo,false);assert.equal(r.releaseEligible,false);assert.ok(!JSON.stringify(r).includes(token));
});
test('wrong identity, nonbot, wrong forum/guild/type stop',async()=>{
 for(const bodies of [[{...self,id:'1'},forum],[{...self,bot:false},forum],[self,{...forum,id:'1'}],[self,{...forum,guild_id:'1'}],[self,{...forum,type:0}]]){
  const f=fixture(bodies);await assert.rejects(()=>collect(token,f.fetch));assert.equal(f.count,bodies[0]===self?2:1);
 }
});
test('HTTP, redirect, rate limit stop without retries or raw diagnostic',async()=>{
 for(const status of [301,401,403,429,500]){const f=fixture([self],status);const r=await run(Readable.from([Buffer.from(JSON.stringify({token}))]),f.fetch,['node','tool']);assert.deepEqual(r,{diagnostic:'OWNER_DISCORD_STOPPED'});assert.equal(f.count,1);}
});
test('invalid input/arguments never connect',async()=>{
 for(const input of ['{}','{"token":"bad token"}','{"token":"x","extra":1}','x','x'.repeat(8193)]){
  const f=fixture();assert.deepEqual(await run(Readable.from([Buffer.from(input)]),f.fetch,['node','tool']),{diagnostic:'OWNER_DISCORD_STOPPED'});assert.equal(f.count,0);
 }
 const f=fixture();await run(Readable.from([]),f.fetch,['node','tool',token]);assert.equal(f.count,0);
});
test('malformed and oversized bodies, thrown secrets are suppressed',async()=>{
 for(const fetcher of [async()=>new Response('bad JSON '+token),async()=>new Response('x'.repeat(65537)),async()=>{throw Error(token);}]){
  assert.deepEqual(await run(Readable.from([Buffer.from(JSON.stringify({token}))]),fetcher,['node','tool']),{diagnostic:'OWNER_DISCORD_STOPPED'});
 }
});
