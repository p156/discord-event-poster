import {historyState} from '../src/forum-history.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{AuthState} from '../src/index.mjs';
import {issueSession} from '../src/auth-session.mjs';
import {oauthBindings} from './oauth-fixtures.mjs';
import {TestStorage} from './post-fixtures.mjs';
import {createDiscordMock,addThread} from './p23-discord-mock.mjs';
import {titleKey,titleMatch} from '../src/title-match.mjs';
class Storage extends TestStorage{
  async list(options={}){const result=await super.list({...options,limit:100000});return new Map([...result].filter(([k])=>!options.startAfter||k>options.startAfter).slice(0,options.limit||1000));}
}
async function harness(){
  const storage=new Storage(),origin='https://poster.example',mock=createDiscordMock();
  const env={...oauthBindings(origin),DISCORD_BOT_TOKEN:'PRIVATE_TEST_BOT',DISCORD_FORUM_CHANNEL_ID:'123',SESSION_SIGNING_KEY:'a'.repeat(64),FORUM_POSTS_ENABLED:'true'};
  let object=new AuthState({storage},env);env.AUTH_STATE={idFromName:()=>0,get:()=>({fetch:r=>object.fetch(r)})};
  let token=(await issueSession(storage,env)).token;
  const call=async(path,body,key,method=body===undefined?'GET':'POST')=>{
    if(path==='/api/forums/select'&&body?.expectedRevision===undefined){const r=(await call('/api/forums')).body;body={...body,expectedRevision:r.revision,expectedGeneration:r.forums.find(f=>f.id===body.forumId)?.generation};}
    const real=globalThis.fetch;globalThis.fetch=mock.fetch;
    try{
      const response=await worker.fetch(new Request('https://discord-event-poster-api.monma5435.workers.dev'+path,{method,headers:{Origin:origin,Authorization:'Bearer '+token,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})}),env);
      return {status:response.status,body:await response.json()};
    }finally{globalThis.fetch=real;}
  };
  const sync=async(id='123')=>{
    let result;for(let i=0;i<100;i++){result=await call('/api/forums/'+id+'/history/sync',{});if(!result.body.sync?.more||result.body.sync.status==='partial')break;}
    return result;
  };
  const payload={apiVersion:1,threadName:'謎の部屋からの脱出',content:'本文',tagIds:[]};
  const post=async(id='123',p=payload)=>{
    const issued=await call('/api/forums/'+id+'/post-intents',p);assert.equal(issued.status,201,JSON.stringify(issued));
    return {issued,...await call('/api/forums/'+id+'/posts',p,issued.body.idempotencyKey)};
  };
  return {storage,env,mock,call,sync,post,payload,restart:()=>{object=new AuthState({storage},env);},relogin:async()=>{token=(await issueSession(storage,env)).token;}};
}
test('NFKC, whitespace, punctuation and regions normalize without losing edition numbers',()=>{
  assert.equal(titleKey('【東京】『ＡＢＣ　脱出！』'),titleKey('abc 脱出'));
  assert.equal(titleMatch('謎の部屋からの脱出','【大阪】謎の部屋からの脱出').score,100);
  assert.ok(titleMatch('謎の部屋からの脱出','謎の部屋からの脱出・再演'));
  assert.ok(titleMatch('閉ざされた部屋からの脱出','閉ざされた部屋から脱出'));
  assert.equal(titleMatch('猫とお茶','宇宙探検隊'),null);
  assert.equal(titleMatch('第5回 謎解きフェスティバル','第6回 謎解きフェスティバル').differentEdition,true);
  assert.equal(titleMatch('','題'),null);
});
test('registry migrates once, registers multiple guild forums, persists selection across restart/login, removes without Discord deletion',async()=>{
  const h=await harness();
  assert.equal((await h.call('/api/forums')).body.selected,'123');
  assert.equal((await h.call('/api/discord/guilds',{})).body.guilds.length,2);
  assert.equal((await h.call('/api/discord/forums',{guildId:'456'})).body.forums.length,2);
  assert.equal((await h.call('/api/forums/register',{forumId:'124'})).status,200);
  await h.call('/api/forums/select',{forumId:'124'});h.restart();await h.relogin();
  assert.equal((await h.call('/api/forums')).body.selected,'124');
  await h.call('/api/forums/remove',{forumId:'124'});h.restart();
  assert.equal((await h.call('/api/forums')).body.selected,'');
  await h.call('/api/forums/remove',{forumId:'123'});h.restart();
  assert.equal((await h.call('/api/forums')).body.forums.length,0);
  await h.call('/api/forums/register',{forumId:'123'});
  assert.equal((await h.call('/api/forums')).body.forums.length,1);
  assert.equal(h.mock.state.writes.length,0);
});
test('Bot guild enumeration exposes a continuation for all 200+ servers',async()=>{
  const h=await harness();h.mock.state.guildPages=true;
  const page=await h.call('/api/discord/guilds',{});assert.equal(page.body.guilds.length,200);assert.equal(page.body.after,'1199');
  h.mock.state.guildPages=false;assert.equal((await h.call('/api/discord/guilds',{after:page.body.after})).body.after,null);
});
for(const mode of ['denyUser','denyBot'])test(mode+' denies discovery, registration and posting',async()=>{
  const h=await harness();h.mock.state[mode]=true;
  assert.equal((await h.call('/api/forums/register',{forumId:'124'})).status,403);
  const i=await h.call('/api/forums/123/post-intents',h.payload);const r=await h.call('/api/forums/123/posts',h.payload,i.body.idempotencyKey);assert.equal(r.body.error.code,'DISCORD_PERMISSION_DENIED');assert.equal(h.mock.state.writes.length,0);
});
test('forum tag IDs remain distinct and removed IDs fail before dispatch',async()=>{
  const h=await harness();await h.call('/api/forums/register',{forumId:'124'});
  assert.deepEqual((await h.call('/api/forums/123/tags')).body.tags.map(t=>t.id),['100','101']);
  assert.deepEqual((await h.call('/api/forums/124/tags')).body.tags.map(t=>t.id),['200','201']);
  const p={...h.payload,tagIds:['101']};assert.equal((await h.post('123',p)).body.status,'succeeded');
  const wrong=await h.call('/api/forums/124/post-intents',p);
  assert.equal((await h.call('/api/forums/124/posts',p,wrong.body.idempotencyKey)).status,422);
  const i=await h.call('/api/forums/123/post-intents',p);h.mock.state.tagRemoved=true;
  assert.equal((await h.call('/api/forums/123/posts',p,i.body.idempotencyKey)).status,422);
  assert.equal(h.mock.state.writes.length,1);
});
test('history includes own active and archived posts only, persists resumable cursor, never fetches replies',async()=>{
  const h=await harness();addThread(h.mock,10000,'第5回 謎解きフェスティバル');addThread(h.mock,10001,'他人の投稿',{owner:'888'});
  addThread(h.mock,10002,'別フォーラム',{forumId:'124'});
  for(let i=0;i<51;i++)addThread(h.mock,20000+i,'過去のイベント'+i,{archived:true});
  await h.call('/api/forums/123/history/sync',{});h.restart();await h.relogin();
  assert.equal((await h.sync()).body.sync.complete,true);
  const rows=(await h.call('/api/forums/123/history/read',{})).body.items;
  assert.equal(rows.length,52);assert.ok(rows.every(r=>r.status==='ok'&&r.createdAt&&r.url.startsWith('https://discord.com/channels/456/')));
  assert.ok(!h.mock.state.reads.some(p=>p.includes('10001/messages')));
  assert.ok(h.mock.state.reads.some(p=>p.includes('archived/public?')&&p.includes('before=')));
  assert.ok(!h.mock.state.reads.some(p=>/\/messages(?:\?|$)/.test(p)));
  const matched=await h.call('/api/forums/123/history/compare',{titles:['第6回 謎解きフェスティバル']});
  assert.equal(matched.body.matches[0][0].differentEdition,true);assert.equal(matched.body.unverified,false);
});
test('history pagination and duplicate scan cover more than one stored page',async()=>{
  const h=await harness();for(let i=0;i<102;i++)addThread(h.mock,30000+i,'履歴イベント'+i);
  await h.sync();
  const first=(await h.call('/api/forums/123/history/read',{})).body;assert.equal(first.items.length,100);assert.ok(first.after);
  const second=(await h.call('/api/forums/123/history/read',{after:first.after})).body;assert.equal(second.items.length,2);assert.equal(second.after,null);
  const result=(await h.call('/api/forums/123/history/compare',{titles:['履歴イベント101']})).body;
  assert.ok(result.matches[0].some(m=>m.title==='履歴イベント101'));
});
test('deleted channel, missing starter and inaccessible channel are distinguished',async()=>{
  const h=await harness();addThread(h.mock,40000,'削除対象');addThread(h.mock,40001,'取得不能対象');addThread(h.mock,40002,'本文削除',{body:false});
  await h.sync();assert.equal((await h.call('/api/forums/123/history/read',{})).body.items.find(r=>r.threadId==='40002').status,'body_deleted');h.mock.state.active=[];h.mock.state.deleted.add('40000');
  await h.sync();
  const rows=(await h.call('/api/forums/123/history/read',{})).body.items;
  assert.equal(rows.find(r=>r.threadId==='40000').status,'deleted');
  assert.equal(rows.find(r=>r.threadId==='40001').status,'unavailable');
  assert.equal(rows.find(r=>r.threadId==='40002').status,'unavailable');
});
for(const mode of ['historyError','historyDenied'])test(mode+' warns unverified and still permits a post',async()=>{
  const h=await harness();h.mock.state[mode]=true;
  const result=await h.call('/api/forums/123/history/sync',{});assert.equal(result.body.sync.complete,false);
  assert.equal((await h.call('/api/forums/123/history/compare',{titles:[h.payload.threadName]})).body.unverified,true);
  assert.equal((await h.post()).body.status,'succeeded');assert.equal(h.mock.state.writes.length,1);
});
test('duplicate candidates are advisory and isolated to the selected forum',async()=>{
  const h=await harness();addThread(h.mock,50000,h.payload.threadName);await h.sync();
  assert.equal((await h.call('/api/forums/123/history/compare',{titles:[h.payload.threadName]})).body.matches[0].length,1);
  assert.equal((await h.post()).body.status,'succeeded');
  await h.call('/api/forums/register',{forumId:'124'});await h.sync('124');
  assert.equal((await h.call('/api/forums/124/history/compare',{titles:[h.payload.threadName]})).body.matches[0].length,0);
});
test('operation keys never follow selected destination; unregistered receipts remain queryable',async()=>{
  const h=await harness();await h.call('/api/forums/register',{forumId:'124'});
  const i=await h.call('/api/forums/123/post-intents',h.payload);
  await h.call('/api/forums/select',{forumId:'124'});
  assert.equal((await h.call('/api/forums/124/posts',h.payload,i.body.idempotencyKey)).status,409);
  const r=await h.call('/api/forums/123/posts',h.payload,i.body.idempotencyKey);assert.equal(r.body.status,'succeeded');
  await h.call('/api/forums/remove',{forumId:'123'});
  assert.equal((await h.call('/api/forums/123/posts/'+i.body.operationId,undefined,i.body.idempotencyKey)).body.status,'succeeded');
  assert.equal(h.mock.state.writes.length,1);
});
test('unregister/re-register invalidates a not-started operation generation',async()=>{
  const h=await harness(),i=await h.call('/api/forums/123/post-intents',h.payload);
  await h.call('/api/forums/remove',{forumId:'123'});await h.call('/api/forums/register',{forumId:'123'});
  assert.equal((await h.call('/api/forums/123/posts',h.payload,i.body.idempotencyKey)).status,409);assert.equal(h.mock.state.writes.length,0);
});
test('image tickets are bound to a forum, and double submits/unknown never auto-resend',async()=>{
  const h=await harness();await h.call('/api/forums/register',{forumId:'124'});
  const p={...h.payload,apiVersion:2,officialUrl:'',imageUrl:null};
  const preview=await h.call('/api/forums/123/image-preview',{apiVersion:2,threadName:p.threadName,content:p.content,tagIds:[],officialUrl:''});
  assert.equal(preview.status,200);
  assert.equal((await h.call('/api/forums/124/post-intents',{...p,previewTicket:preview.body.previewTicket})).status,409);
  const i=await h.call('/api/forums/123/post-intents',{...p,previewTicket:preview.body.previewTicket});
  h.mock.state.mode='unknown';
  const first=await h.call('/api/forums/123/posts',p,i.body.idempotencyKey);assert.equal(first.body.status,'unknown');
  await h.call('/api/forums/123/posts',p,i.body.idempotencyKey);assert.equal(h.mock.state.writes.length,1);
});

test('short edition changes and parenthesized venue variations are warning candidates',()=>{
 assert.equal(titleMatch('第５回謎解き大会','第6回謎解き大会').differentEdition,true);
 assert.equal(titleMatch('謎解き大会（東京公演）','謎解き大会（大阪公演）').score,100);
 assert.equal(titleMatch('a','b'),null);
});
test('archive timestamp collisions remain partial instead of skipping a boundary',async()=>{
 const h=await harness();for(let i=0;i<51;i++){const t=addThread(h.mock,60000+i,'同時刻アーカイブ'+i,{archived:true});t.thread_metadata.archive_timestamp='2026-01-01T00:00:00.000Z';}
 const r=await h.sync();assert.equal(r.body.sync.complete,false);assert.equal(r.body.sync.error,'HISTORY_CURSOR_STALLED');
 assert.equal((await h.call('/api/forums/123/history/compare',{titles:['同時刻アーカイブ50']})).body.unverified,true);
 assert.equal((await h.post()).body.status,'succeeded');
});
test('rate-limited history cursor resumes after waiting, including after object recreation',async()=>{
 const h=await harness();addThread(h.mock,70000,'再開する催し');h.mock.state.historyError=true;
 assert.equal((await h.sync()).body.sync.error,'DISCORD_RATE_LIMITED');
 h.mock.state.historyError=false;h.restart();
 const real=Date.now;try{Date.now=()=>real()+2000;assert.equal((await h.sync()).body.sync.complete,true);}finally{Date.now=real;}
 assert.equal((await h.call('/api/forums/123/history/read',{})).body.items.length,1);
});
test('a cross-forum starter author is removed from history as well as warning results',async()=>{
 const h=await harness();addThread(h.mock,80000,'偽の投稿者');h.mock.state.messages[80000].author.id='888';await h.sync();
 assert.equal((await h.call('/api/forums/123/history/read',{})).body.items.length,0);
 assert.equal((await h.call('/api/forums/123/history/compare',{titles:['偽の投稿者']})).body.matches[0].length,0);
});
test('a preview from an earlier registration generation cannot be issued after re-registration',async()=>{
 const h=await harness(),p={...h.payload,apiVersion:2,officialUrl:'',imageUrl:null};
 const preview=await h.call('/api/forums/123/image-preview',{apiVersion:2,threadName:p.threadName,content:p.content,tagIds:[],officialUrl:''});
 await h.call('/api/forums/remove',{forumId:'123'});await h.call('/api/forums/register',{forumId:'123'});
 assert.equal((await h.call('/api/forums/123/post-intents',{...p,previewTicket:preview.body.previewTicket})).status,409);
});
test('new routes enforce authentication/origin and never accept a browser-provided API path',async()=>{
 const h=await harness();assert.equal((await h.call('/api/discord/channels/123')).status,404);
 assert.equal((await h.call('/api/discord/forums',{guildId:'456',apiPath:'users/@me'})).status,400);
 assert.equal((await h.call('/api/forums/999/post-intents',h.payload)).status,409);
});

for(const generation of [undefined,0]){
 test('legacy generation '+String(generation)+' works in the initial registration but not after re-registration',async()=>{
  for(const reRegister of [false,true]){
   const h=await harness(),i=await h.call('/api/forum/post-intents',h.payload);
   const key='posts:operation:'+i.body.operationId,record=await h.storage.get(key);
   if(generation===undefined)delete record.forumGeneration;else record.forumGeneration=generation;
   await h.storage.put(key,record);await h.call('/api/forums');
   if(reRegister){await h.call('/api/forums/remove',{forumId:'123'});await h.call('/api/forums/register',{forumId:'123'});}
   h.restart();await h.relogin();
   const result=await h.call('/api/forum/posts',h.payload,i.body.idempotencyKey);
   assert.equal(result.status,reRegister?409:201);assert.equal(h.mock.state.writes.length,reRegister?0:1);
  }
 });
}
for(const outcome of ['succeeded','unknown'])test('legacy '+outcome+' receipt stays inspectable and never dispatches again after re-registration',async()=>{
 const h=await harness(),i=await h.call('/api/forum/post-intents',h.payload);
 const key='posts:operation:'+i.body.operationId,record=await h.storage.get(key);delete record.forumGeneration;await h.storage.put(key,record);
 if(outcome==='unknown')h.mock.state.mode='unknown';
 assert.equal((await h.call('/api/forum/posts',h.payload,i.body.idempotencyKey)).body.status,outcome);
 await h.call('/api/forums/remove',{forumId:'123'});await h.call('/api/forums/register',{forumId:'123'});h.restart();await h.relogin();
 assert.equal((await h.call('/api/forums/123/posts/'+i.body.operationId,undefined,i.body.idempotencyKey)).body.status,outcome);
 assert.equal((await h.call('/api/forum/posts',h.payload,i.body.idempotencyKey)).body.status,outcome);
 assert.equal(h.mock.state.writes.length,1);
});
for(const failure of ['deleted','forbidden'])test('history preserves '+failure+' gap followed by 429 across restart and resume; posting stays available',async()=>{
 const h=await harness();addThread(h.mock,90000,'本文を読めない催し',{body:false});addThread(h.mock,90001,'429後に再開する催し');
 const fetch=h.mock.fetch;let limited=true;
 h.mock.fetch=(url,opts)=>String(url).includes('channels/90001/messages')&&limited?Promise.resolve(Response.json({retry_after:1},{status:429})):failure==='forbidden'&&String(url).includes('channels/90000/messages')?Promise.resolve(Response.json({code:50013},{status:403})):fetch(url,opts);
 assert.equal((await h.sync()).body.sync.error,'DISCORD_RATE_LIMITED');
 assert.equal((await h.storage.get('history:v1:123:sync')).gaps,true);
 limited=false;h.restart();await h.relogin();const real=Date.now;
 try{Date.now=()=>real()+2000;
  const result=await h.sync();assert.equal(result.body.sync.complete,false);assert.equal(result.body.sync.status,'partial');
  assert.equal((await h.call('/api/forums/123/history/compare',{titles:['本文を読めない催し']})).body.unverified,true);
  assert.equal((await h.post()).body.status,'succeeded');
 }finally{Date.now=real;}
});
test('stored incomplete rows override an incorrectly complete old synchronization record',async()=>{
 const h=await harness();addThread(h.mock,91000,'本文欠落',{body:false});await h.sync();
 const run=await h.storage.get('history:v1:123:sync');run.gaps=false;run.status='complete';await h.storage.put('history:v1:123:sync',run);
 assert.equal((await h.call('/api/forums/123/history/compare',{titles:['本文欠落']})).body.unverified,true);
});
test('older select revisions are rejected and the accepted destination survives restart/login',async()=>{
 const h=await harness();await h.call('/api/forums/register',{forumId:'124'});const snapshot=(await h.call('/api/forums')).body;
 const selection=id=>({forumId:id,expectedRevision:snapshot.revision,expectedGeneration:snapshot.forums.find(f=>f.id===id).generation});
 assert.equal((await h.call('/api/forums/select',selection('124'))).status,200);
 const stale=await h.call('/api/forums/select',selection('123'));assert.equal(stale.status,409);assert.equal(stale.body.error.code,'SELECTION_CONFLICT');
 h.restart();await h.relogin();assert.equal((await h.call('/api/forums')).body.selected,'124');
 assert.equal((await h.call('/api/forums/select',{forumId:'123',expectedGeneration:1,expectedRevision:0})).status,400);
});
test('selection cannot resurrect a removed/re-registered target or overwrite another registry update',async()=>{
 const h=await harness();const snapshot=(await h.call('/api/forums')).body;
 const old={forumId:'123',expectedRevision:snapshot.revision,expectedGeneration:snapshot.forums[0].generation};
 await h.call('/api/forums/remove',{forumId:'123'});assert.equal((await h.call('/api/forums/select',old)).status,409);
 await h.call('/api/forums/register',{forumId:'123'});assert.equal((await h.call('/api/forums/select',old)).body.error.code,'TARGET_CHANGED');
 const current=(await h.call('/api/forums')).body;
 await h.call('/api/forums/register',{forumId:'125'});
 assert.equal((await h.call('/api/forums/select',{forumId:'123',expectedRevision:current.revision,expectedGeneration:current.forums.find(f=>f.id==='123').generation})).body.error.code,'SELECTION_CONFLICT');
 assert.equal((await h.call('/api/forums')).body.selected,'');
});

test('finishing a cursor cannot mark stored pending/unavailable rows complete even without a gap flag',async()=>{
 for(const status of ['pending','unavailable']){
  const h=await harness();await h.call('/api/forums');const now=Date.now();
  await h.storage.put('history:v1:123:sync',{stage:'verify',generation:'test-generation',status:'running',gaps:false,lease:'test-lease',leaseUntil:now+10000});
  await h.storage.put('history:v1:123:row:92000',{threadId:'92000',title:'未取得の履歴',status,generation:'test-generation'});
  const result=await historyState(h.storage,h.env,{action:'history.commit',forumId:'123',lease:'test-lease',progress:{stage:'done'}},now);
  assert.equal(result.sync.complete,false);assert.equal(result.sync.status,'partial');h.restart();
  assert.equal((await h.call('/api/forums/123/history/compare',{titles:['未取得の履歴']})).body.unverified,true);
 }
});
