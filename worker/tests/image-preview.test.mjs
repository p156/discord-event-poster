import {test} from 'node:test';
import assert from 'node:assert/strict';
import {officialPolicy,allowedUrl} from '../src/official-image-policy.mjs';
import {findOfficialImage,fetchThumbnail,fetchAttachment,boundedBytes,imageMagic} from '../src/official-image-fetch.mjs';
import {forumUpload,sendFixedForum} from '../src/discord-client.mjs';
import {createImagePreviewHandler,imageCall} from '../src/image-preview-handler.mjs';
import {createPreviewClaims,signPreview,verifyPreview} from '../src/image-preview-ticket.mjs';
import {fixture,payload} from './post-fixtures.mjs';
import {payloadHash} from '../src/post-keys.mjs';
import {validatePostPayload} from '../src/forum-input.mjs';
const official='https://realescapegame.jp/event',image='https://realescapegame.jp/image.png';
const png=Uint8Array.from([137,80,78,71,13,10,26,10,...Array(16).fill(0)]);
const v2=()=>({...payload(),apiVersion:2,officialUrl:official,imageUrl:null});
// Node tests inject already-parsed metadata only. Real HTMLRewriter is exercised
// separately in image-runtime.mjs; this double makes no HTML parsing claim.
class MetadataRewriter{on(selector,handler){assert.equal(selector,'head meta');this.handler=handler;return this;}transform(response){this.handler.element({getAttribute:k=>k==='property'?'og:image':k==='content'?'/image.png':null});return response;}}
const previewRequest=(h,p=v2(),headers={})=>h.request('/api/forum/image-preview','POST',p,undefined,h.token,headers);
async function setup(options={}){let h;h=await fixture({...options,imageFetchImpl:async(url,opts)=>{h.attachmentGets=(h.attachmentGets||0)+1;assert.deepEqual(Object.keys(opts.headers),['Accept']);return options.imageFetchImpl?options.imageFetchImpl(url,opts):new Response(png,{headers:{'Content-Type':'image/png'}});}});h.external=[];h.previewHandler=createImagePreviewHandler({Rewriter:MetadataRewriter,fetchImpl:async(url,opts)=>{h.external.push({url,opts});return url===official?new Response('<head></head>',{headers:{'Content-Type':'text/html'}}):new Response(png,{headers:{'Content-Type':'image/png'}});}});h.preview=async p=>{const {imageUrl,...raw}=p||v2();const r=await h.previewHandler(previewRequest(h,raw),h.env);return {response:r,...await r.json()};};h.env.FORUM_POSTS_ENABLED='true';return h;}
function intent(preview,p=v2()){return {...p,imageUrl:preview.imageUrl,previewTicket:preview.previewTicket};}

test('attachment prefix across one-byte chunks preserves every supported image and rejects truncated signatures',async()=>{
 const samples=[['image/png',png],['image/jpeg',new Uint8Array([255,216,255,0])],['image/gif',new Uint8Array([...new TextEncoder().encode('GIF89a'),...Array(7).fill(0)])],['image/webp',new Uint8Array([...new TextEncoder().encode('RIFF0000WEBP'),0,0,0,0])]];
 for(const [mime,bytes]of samples){
  const fetchImpl=async()=>{let i=0;return new Response(new ReadableStream({pull(c){if(i===bytes.length)c.close();else{c.enqueue(bytes.slice(i,i+1));i++;}}}),{headers:{'Content-Type':mime}});};
  const result=await fetchAttachment(official,image,{fetchImpl});assert.equal(result.mime,mime);assert.equal(result.bytes,undefined);assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()),bytes);
  await assert.rejects(()=>fetchAttachment(official,image,{fetchImpl:async()=>new Response(bytes.slice(0,3),{headers:{'Content-Type':mime}})}),/IMAGE_TYPE_REJECTED/);
 }
});
test('attachment size cap cancels an oversize stream before a multipart body is built',async()=>{
 let cancelled=false;await assert.rejects(()=>fetchAttachment(official,image,{fetchImpl:async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(2097153));},cancel(){cancelled=true;}}),{headers:{'Content-Type':'image/png'}})}),/IMAGE_TOO_LARGE/);assert.ok(cancelled);
});
test('multipart Blob snapshots input bytes and preserves Unicode JSON without embeds or flags',async()=>{
 const bytes=png.slice(),body={name:'日本語📍',message:{content:'行1\r\nhttps://example.invalid/?a="b"',allowed_mentions:{parse:[],replied_user:false}},applied_tags:[]};
 const upload=await forumUpload(body,{mime:'image/png',bytes});assert.ok(upload.body instanceof Blob);bytes.fill(0);
 const form=await new Response(upload.body,{headers:{'Content-Type':upload.contentType}}).formData();assert.deepEqual(new Uint8Array(await form.get('files[0]').arrayBuffer()),png);assert.deepEqual(JSON.parse(form.get('payload_json')),{...body,message:{...body.message,attachments:[{id:0,filename:'official-image.png'}]}});
});
test('one-use upload reference is released on success, rejection and network failure',async()=>{
 const env={DISCORD_BOT_TOKEN:'TEST_ONLY',DISCORD_FORUM_CHANNEL_ID:'123'},body={name:'TEST_ONLY',message:{content:'TEST_ONLY'},applied_tags:[]};
 for(const mode of ['success',400,413,'network']){
  const upload=await forumUpload(body,{mime:'image/png',bytes:png});let called=0;
  const task=sendFixedForum(env,body,{upload,fetchImpl:async(url,opts)=>{called++;assert.ok(opts.body instanceof Blob);if(mode==='network')throw Error('NETWORK');return new Response('{}',{status:mode==='success'?200:mode});}});
  if(mode==='success')await task;else await assert.rejects(()=>task);assert.equal(upload.body,null);assert.equal(called,1);
 }
});

async function decodeWrite(call){
 const {opts}=call;
 if(opts.headers['Content-Type']==='application/json')return {body:JSON.parse(opts.body),file:null};
 const form=await new Response(opts.body,{headers:{'Content-Type':opts.headers['Content-Type']}}).formData();
 return {body:JSON.parse(form.get('payload_json')),file:form.get('files[0]')};
}
test('attachment GET occurs only after durable sending; invalid, oversized, unsafe and failed images fall back before one write',async()=>{
 for(const imageFetchImpl of [
  async()=>{throw Error('IMAGE_NETWORK_FAILURE');},
  async()=>new Response('<html>bad</html>',{headers:{'Content-Type':'image/png'}}),
  async()=>new Response(png,{headers:{'Content-Type':'image/svg+xml'}}),
  async()=>new Response(new Uint8Array(2097153),{headers:{'Content-Type':'image/png','Content-Length':'1'}}),
  async()=>new Response(null,{status:302,headers:{Location:'https://127.0.0.1/private'}}),
 ]){
  let h;h=await setup({imageFetchImpl:async(...args)=>{assert.equal([...h.storage.data].find(([k])=>k.startsWith('posts:operation:'))[1].status,'sending');return imageFetchImpl(...args);}});
  const base={...v2(),content:'本文\n'+official},p=await h.preview(base),i=await h.issue(intent(p,base)),send={...base,imageUrl:p.imageUrl};
  assert.equal((await h.submit(i,send)).status,201);assert.equal(h.writes,1);const {body,file}=await decodeWrite(h.calls.find(c=>c.opts.method==='POST'));assert.equal(file,null);assert.equal(body.message.content,base.content);assert.equal(body.message.embeds,undefined);assert.equal(body.message.flags,undefined);assert.equal(body.message.attachments,undefined);
  assert.equal((await h.submit(i,send)).status,200);assert.equal(h.writes,1);assert.equal(h.attachmentGets,1);
 }
});
test('target realdgame URL remains plain content without fetching or explicit embeds',async()=>{
 const h=await setup(),base={...v2(),officialUrl:'https://realdgame.jp/s/fgo2026/',content:'公式サイト\nhttps://realdgame.jp/s/fgo2026/'},p=await h.preview(base);
 assert.equal(p.reasonCode,'IMAGE_HOST_REJECTED');const i=await h.issue(intent(p,base));assert.equal((await h.submit(i,{...base,imageUrl:null})).status,201);
 assert.equal(h.external.length,0);assert.equal(h.attachmentGets,undefined);const {body,file}=await decodeWrite(h.calls.find(c=>c.opts.method==='POST'));assert.equal(file,null);assert.equal(body.message.content,base.content);assert.equal(body.message.embeds,undefined);assert.equal(body.message.flags,undefined);
});
test('definite multipart 400/413 rejection falls back once in the same durable attempt, concurrent callers never create twice',async()=>{
 for(const status of [400,413]){
  let h;h=await setup({post:async(url,opts)=>{const {file}=await decodeWrite({opts});if(file)return new Response(null,{status});return Response.json({id:'789',type:11,parent_id:'123',guild_id:'456',message:{id:'790',channel_id:'789'}});}});
  const p=await h.preview(),i=await h.issue(intent(p)),send={...v2(),imageUrl:p.imageUrl};const results=await Promise.all(Array.from({length:12},()=>h.submit(i,send)));
  assert.ok(results.every(r=>[200,201,202].includes(r.status)));assert.equal(h.writes,2);assert.equal(h.attachmentGets,1);const writes=h.calls.filter(c=>c.opts.method==='POST');assert.ok((await decodeWrite(writes[0])).file);assert.equal((await decodeWrite(writes[1])).file,null);
  const state=await (await h.status(i)).json();assert.equal(state.status,'succeeded');assert.equal(state.attempt,1);assert.equal((await h.submit(i,send)).status,200);assert.equal(h.writes,2);
 }
});
test('ambiguous multipart results never trigger text fallback or resend, including a lost fallback response',async()=>{
 for(const mode of ['network','timeout',200,201,301,401,403,404,429,500,502,503,'fallback-lost']){
  let h;h=await setup({timeoutMs:15,post:async()=>{
   if(mode==='network')throw Error('LOST');if(mode==='timeout')return new Promise(()=>{});
   if(mode==='fallback-lost'){if(h.writes===1)return new Response(null,{status:400});throw Error('LOST_TEXT_RESPONSE');}
   if(mode===200||mode===201)return Response.json({wrong:'receipt'},{status:mode});
   if(mode===429)return Response.json({retry_after:60},{status:429});return new Response(null,{status:mode});
  }});
  const p=await h.preview(),i=await h.issue(intent(p)),send={...v2(),imageUrl:p.imageUrl};await h.submit(i,send);
  assert.equal(h.writes,mode==='fallback-lost'?2:1,String(mode));await h.submit(i,send);assert.equal(h.writes,mode==='fallback-lost'?2:1,String(mode));
 }
});
test('local multipart construction failure sends text once without a partial Discord request',async()=>{
 const h=await setup(),p=await h.preview(),i=await h.issue(intent(p)),original=globalThis.Blob;let constructions=0;
 try{globalThis.Blob=class extends original {constructor(...args){if(++constructions===2)throw Error('LOCAL_FORM_FAILURE');super(...args);}};assert.equal((await h.submit(i,{...v2(),imageUrl:p.imageUrl})).status,201);assert.equal(constructions,2);}
 finally{globalThis.Blob=original;}
 assert.equal(h.writes,1);assert.equal((await decodeWrite(h.calls.find(c=>c.opts.method==='POST'))).file,null);
});
test('exact HTTPS public host policy rejects all SSRF spellings before any fetch',async()=>{
 const bad=['http://realescapegame.jp/','https://realescapegame.jp.evil.test/','https://realescapegame.jp./','https://user:pass@realescapegame.jp/','https://realescapegame.jp:8443/','https://127.0.0.1/','https://2130706433/','https://0x7f000001/','https://0177.0.0.1/','https://[::1]/','https://localhost/','https://metadata.google.internal/','file:///etc/passwd','https://%72ealescapegame.jp/','https://realescapegame.jp\\@evil.test/','https://ｒealescapegame.jp/'];
 let calls=0;for(const url of bad){assert.equal(officialPolicy(url),null,url);const r=await findOfficialImage(url,{fetchImpl:async()=>{calls++;throw Error();}});assert.equal(r.imageUrl,null);}assert.equal(calls,0);
 assert.equal(allowedUrl(image+'?token=SECRET',['realescapegame.jp'],{image:true}),null);assert.equal(allowedUrl('https://unapproved.cdn.test/a.png',['realescapegame.jp'],{image:true}),null);
});
test('redirect destinations, loops, missing Location and redirect budgets fail closed',async()=>{
 for(const location of ['http://realescapegame.jp/a','https://127.0.0.1/','https://evil.test/a',official]){let count=0;const r=await findOfficialImage(official,{fetchImpl:async()=>{count++;return new Response('redirect',{status:302,headers:{Location:location}});}});assert.equal(r.imageUrl,null);assert.equal(count,1);}
 let count=0;const r=await findOfficialImage(official,{fetchImpl:async()=>new Response(null,{status:302,headers:{Location:'/hop'+(++count)}})});assert.equal(r.imageUrl,null);assert.equal(count,3);
 assert.equal((await findOfficialImage(official,{fetchImpl:async()=>new Response(null,{status:302})})).imageUrl,null);
});
test('bounded streams cancel after size and enforce slow headers/body deadline; no secrets forwarded',async()=>{
 let cancelled=false;const response=new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(262145));},cancel(){cancelled=true;}}));await assert.rejects(()=>boundedBytes(response,262144),/IMAGE_TOO_LARGE/);assert.ok(cancelled);
 assert.equal((await findOfficialImage(official,{timeoutMs:10,fetchImpl:async()=>new Promise(()=>{})})).reasonCode,'IMAGE_TIMEOUT');
 let aborted=false;const r=await findOfficialImage(official,{timeoutMs:10,fetchImpl:async(url,o)=>{assert.deepEqual(Object.keys(o.headers),['Accept']);assert.equal(o.redirect,'manual');assert.equal(o.method,'GET');o.signal.addEventListener('abort',()=>aborted=true);return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([60]));}}),{headers:{'Content-Type':'text/html'}});}});assert.equal(r.reasonCode,'IMAGE_TIMEOUT');assert.ok(aborted);
 for(const mime of ['image/svg+xml','text/html','image/png'])await assert.rejects(()=>fetchThumbnail(official,image,{fetchImpl:async()=>new Response('<svg>evil</svg>',{headers:{'Content-Type':mime}})}));assert.ok(imageMagic(png,'image/png'));
});
test('image lookup success uses new headerless GET; signed snapshot persists; parallel same-key sends once',async()=>{
 const h=await setup(),p=await h.preview();assert.equal(p.response.status,200);assert.equal(p.status,'image');assert.equal(h.external.length,2);for(const c of h.external)assert.deepEqual(Object.keys(c.opts.headers),['Accept']);
 const input=intent(p),i=await h.issue(input);assert.equal(i.response.status,201);const frozen=await h.storage.get('posts:operation:'+i.operationId);assert.deepEqual(frozen.imageSnapshot,{officialUrl:official,imageUrl:image,source:'og:image'});
 const sendPayload={...input};delete sendPayload.previewTicket;const results=await Promise.all(Array.from({length:12},()=>h.submit(i,sendPayload)));assert.ok(results.every(r=>[200,201,202].includes(r.status)));assert.equal(h.writes,1);assert.equal(h.external.length,2);const write=h.calls.find(c=>c.opts.method==='POST');const form=await new Response(write.opts.body,{headers:{'Content-Type':write.opts.headers['Content-Type']}}).formData();const sent=JSON.parse(form.get('payload_json'));assert.equal(sent.message.embeds,undefined);assert.equal(sent.message.flags,undefined);assert.deepEqual(sent.message.attachments,[{id:0,filename:'official-image.png'}]);assert.deepEqual(new Uint8Array(await form.get('files[0]').arrayBuffer()),png);assert.equal(h.attachmentGets,1);
 h.restart();assert.equal((await h.submit(i,sendPayload)).status,200);assert.equal(h.writes,1);
});
test('confirmation tamper, mismatch, expiry, signature domain and replay never issue another operation',async()=>{
 const h=await setup(),p=await h.preview();for(const change of [x=>({...x,content:'CHANGED'}),x=>({...x,imageUrl:'https://realescapegame.jp/other.png'}),x=>({...x,officialUrl:official+'/other'}),x=>({...x,previewTicket:x.previewTicket.slice(0,-1)+'Z'})]){const i=await h.issue(change(intent(p)));assert.equal(i.response.status,409);}
 const c=await verifyPreview(p.previewTicket,h.env.SESSION_SIGNING_KEY);await assert.rejects(()=>verifyPreview(p.previewTicket,h.env.SESSION_SIGNING_KEY,c.expiresAt));await assert.rejects(()=>verifyPreview(p.previewTicket.replace('ip1.','v1.'),h.env.SESSION_SIGNING_KEY));
 const different=await signPreview({...c,forumId:'999'},h.env.SESSION_SIGNING_KEY);assert.equal((await h.issue({...intent(p),previewTicket:different})).response.status,409);
 const two=await Promise.all([h.issue(intent(p)),h.issue(intent(p))]);assert.deepEqual(two.map(i=>i.response.status).sort(),[201,409]);assert.equal(h.writes,0);
});
test('image-less fallback is signed; user image/unknown/duplicate fields rejected; OAuth and boundary failures perform zero GET',async()=>{
 const h=await setup();const none={...v2(),officialUrl:'https://not-allowed.example/event'};const p=await h.preview(none);assert.equal(p.status,'no_image');assert.equal(h.external.length,0);const i=await h.issue(intent(p,none));assert.equal(i.response.status,201);const sendPayload={...intent(p,none)};delete sendPayload.previewTicket;assert.equal((await h.submit(i,sendPayload)).status,201);assert.equal(JSON.parse(h.calls.find(c=>c.opts.method==='POST').opts.body).message.embeds,undefined);
 for(const raw of [{...v2(),imageUrl:image},{...v2(),upload:'x'},{...v2(),embeds:[]}])assert.equal((await h.previewHandler(previewRequest(h,raw),h.env)).status,400);
 for(const headers of [{Authorization:'Bearer old-session'},{Origin:'https://evil.test'},{Host:'evil.test'}])assert.ok((await h.previewHandler(previewRequest(h,{},headers),h.env)).status>=400);
 const duplicate=new Request(previewRequest(h),{body:'{"apiVersion":2,"apiVersion":2}'});assert.equal((await h.previewHandler(duplicate,h.env)).status,400);assert.equal(h.external.length,0);
 const q=new Request(previewRequest(h),{method:'POST'});assert.equal((await h.previewHandler(new Request(q.url+'?x=1',q),h.env)).status,400);
});
test('thumbnail failure replaces and retires old confirmation; logout after lookup rejects ticket issuance',async()=>{
 const h=await setup(),p=await h.preview();const raw={apiVersion:2,threadName:'題',content:'PRIVATE_EVENT_BODY',tagIds:[],officialUrl:official,previewTicket:p.previewTicket,withoutImage:true};const r=await h.previewHandler(previewRequest(h,raw),h.env);const none=await r.json();assert.equal(none.status,'no_image');assert.equal((await h.issue(intent(p))).response.status,409);assert.equal((await h.issue(intent(none))).response.status,201);
 const revoked=await setup();let calls=0;const handler=createImagePreviewHandler({Rewriter:MetadataRewriter,fetchImpl:async()=>{calls++;await imageCall(revoked.env,{action:'logout',token:revoked.token},false);return new Response('<head></head>',{headers:{'Content-Type':'text/html'}});}});const result=await handler(previewRequest(revoked,{...v2(),imageUrl:undefined}),revoked.env);assert.equal(result.status,401);assert.ok(calls>0);
});
test('shared limiter max two/ten per minute, missing releases expire; persistence failures block writes',async()=>{
 const h=await setup();const a=await imageCall(h.env,{action:'image.reserve',token:h.token}),b=await imageCall(h.env,{action:'image.reserve',token:h.token});await assert.rejects(()=>imageCall(h.env,{action:'image.reserve',token:h.token}),/IMAGE_RATE_LIMITED/);await imageCall(h.env,{action:'image.release',token:h.token,leaseId:a.leaseId});await imageCall(h.env,{action:'image.release',token:h.token,leaseId:b.leaseId});
 for(let n=0;n<8;n++){const l=await imageCall(h.env,{action:'image.reserve',token:h.token});await imageCall(h.env,{action:'image.release',token:h.token,leaseId:l.leaseId});}await assert.rejects(()=>imageCall(h.env,{action:'image.reserve',token:h.token}),/IMAGE_RATE_LIMITED/);
 const rate=await h.storage.get('images:rate');rate.slots=[];rate.leases=[{id:'lost',until:Date.now()-1}];await h.storage.put('images:rate',rate);assert.ok((await imageCall(h.env,{action:'image.reserve',token:h.token})).leaseId);
 const broken=await setup(),p=await broken.preview();broken.storage.fail=(k)=>k.startsWith('posts:operation:');assert.equal((await broken.issue(intent(p))).response.status,503);assert.equal(broken.writes,0);
});
test('v1 normalization/hash unchanged; v2 ignores ticket freshness; changed images conflict; unknown never resends',async()=>{
 assert.deepEqual(validatePostPayload(payload()),payload());assert.equal(await payloadHash(payload()),await payloadHash({...payload(),tagIds:[]}));
 const h=await setup({post:()=>new Response(null,{status:500})}),p=await h.preview(),i=await h.issue(intent(p));const sendPayload={...v2(),imageUrl:p.imageUrl};assert.equal((await h.submit(i,{...sendPayload,imageUrl:null})).status,409);assert.equal((await h.submit(i,sendPayload)).status,502);assert.equal((await h.submit(i,sendPayload)).status,502);assert.equal(h.writes,1);
 const c=await createPreviewClaims(sendPayload,{imageUrl:image,source:'og:image',reasonCode:null},'123');assert.notEqual(c.ticketId,(await verifyPreview(p.previewTicket,h.env.SESSION_SIGNING_KEY)).ticketId);assert.equal(await payloadHash(sendPayload),await payloadHash({...sendPayload}));
});
test('issued image operation resumes without preview storage across logout/relogin; one validated image fetch',async()=>{
 const h=await setup(),p=await h.preview(),i=await h.issue(intent(p));const claims=await verifyPreview(p.previewTicket,h.env.SESSION_SIGNING_KEY);await h.storage.delete('images:ticket:'+claims.ticketId);await imageCall(h.env,{action:'logout',token:h.token},false);h.token=await h.session();h.restart();assert.equal((await h.submit(i,{...v2(),imageUrl:p.imageUrl},h.token)).status,201);assert.equal(h.external.length,2);assert.equal(h.attachmentGets,1);assert.equal(h.writes,1);
});
test('image bytes cap ignores Content-Length; invalid MIME and thumbnail secret headers never pass',async()=>{
 await assert.rejects(()=>fetchThumbnail(official,image,{fetchImpl:async()=>new Response(new Uint8Array(2097153),{headers:{'Content-Type':'image/png','Content-Length':'1'}})}),/IMAGE_TOO_LARGE/);
 let calls=0;await assert.rejects(()=>fetchThumbnail(official,image,{fetchImpl:async(url,opts)=>{calls++;assert.deepEqual(Object.keys(opts.headers),['Accept']);return new Response(null,{status:302,headers:{Location:'https://169.254.169.254/latest/meta-data'}});}}));assert.equal(calls,1);
 for(const mime of ['application/json','text/plain','image/svg+xml'])assert.equal((await findOfficialImage(official,{fetchImpl:async()=>new Response('<head></head>',{headers:{'Content-Type':mime}})})).reasonCode,'IMAGE_TYPE_REJECTED');
});
test('preview disabled/read-only, method, JSON size/media and unauthenticated thumbnail fail without network',async()=>{
 const h=await setup();for(const gate of [undefined,'false','read-only']){h.env.FORUM_POSTS_ENABLED=gate;assert.equal((await h.previewHandler(previewRequest(h),h.env)).status,404);}h.env.FORUM_POSTS_ENABLED='true';
 assert.equal((await h.previewHandler(h.request('/api/forum/image-preview','GET'),h.env)).status,405);
 assert.equal((await h.previewHandler(previewRequest(h,v2(),{'Content-Type':'text/plain'}),h.env)).status,415);
 const r=new Request(previewRequest(h),{body:' '.repeat(16385)});assert.equal((await h.previewHandler(r,h.env)).status,413);
 const thumbnail=h.request('/api/forum/image-thumbnail','POST',{previewTicket:'forged'},undefined,'old');assert.equal((await h.previewHandler(thumbnail,h.env)).status,401);assert.equal(h.external.length,0);
});
