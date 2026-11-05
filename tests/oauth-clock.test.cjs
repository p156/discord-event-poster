const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {webcrypto}=require('node:crypto');
const expiry=1793874313061,issued=expiry-3600000;
async function login(now,patch={}){
 const store=new Map();let listener;
 const popup={closed:false,close(){this.closed=true;}};
 const data={token:`oauth2.${'a'.repeat(64)}.${expiry}.${'b'.repeat(64)}`,expiresAt:expiry,...patch};
 const window={open:()=>popup,addEventListener:(type,fn)=>listener=fn,removeEventListener:()=>{}};
 const context={window,crypto:webcrypto,TextEncoder,Uint8Array,AbortController,Date:class extends Date{static now(){return now;}},setTimeout,clearTimeout,setInterval,clearInterval,sessionStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},fetch:async()=>({ok:true,status:200,headers:new Headers(),json:async()=>data}),document:{body:{appendChild(){}},createElement:()=>({appendChild(){},remove(){},submit(){queueMicrotask(()=>listener({origin:'https://discord-event-poster-api.monma5435.workers.dev',source:popup,data:{type:'discord-event-poster.oauth2',state:'c'.repeat(64),handoff:'d'.repeat(64)}}));}})}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../poster-client.js'),'utf8'),context);
 try{await window.PosterClient.create().login();return 'OK';}catch(e){assert.equal(store.size,0);return e.code;}
}
for(const skew of [0,1,1000,30000,30001,60000])test(`clock behind ${skew}ms`,async()=>{
 assert.equal(await login(issued-skew),skew<=30000?'OK':'LOGIN_CLOCK_AHEAD');
});
test('reported later measurement passes',async()=>{const now=expiry-58.76315*60000;assert.equal(await login(now),'OK');});
test('expiry boundary still rejects',async()=>{assert.equal(await login(expiry),'LOGIN_EXPIRED');});
test('invalid and mismatching expiry still reject',async()=>{assert.equal(await login(issued,{expiresAt:expiry+1}),'LOGIN_EXPIRY_MISMATCH');assert.equal(await login(issued,{expiresAt:String(expiry)}),'LOGIN_EXPIRY_INVALID');assert.equal(await login(issued,{token:'invalid'}),'LOGIN_TOKEN_INVALID');});
test('real signed Worker token expires exactly at one hour despite browser skew',async()=>{
 const {issueSession,authenticatedSession,SESSION_MS}=await import('../worker/src/auth-session.mjs');
 const {TestStorage}=await import('../worker/tests/post-fixtures.mjs');
 const env={DISCORD_ALLOWED_USER_ID:'222',AUTH_SESSION_SIGNING_KEY:'a'.repeat(64),SESSION_SIGNING_KEY:'b'.repeat(64)},storage=new TestStorage();
 const s=await issueSession(storage,env,issued);assert.equal(s.expiresAt-issued,SESSION_MS);
 const real=Date.now;try{Date.now=()=>expiry-1;assert.ok(await authenticatedSession(storage,env,s.token));Date.now=()=>expiry;assert.equal(await authenticatedSession(storage,env,s.token),null);Date.now=()=>expiry+30000;assert.equal(await authenticatedSession(storage,env,s.token),null);}finally{Date.now=real;}
});
