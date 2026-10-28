const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const elements={addEventListener(){},classList:{add(){},remove(){},toggle(){}}};
const c={document:{getElementById:()=>elements},window:{scrollTo(){}},sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},TextEncoder,URL,crypto:require('node:crypto').webcrypto,setTimeout,clearTimeout};
vm.createContext(c);for(const f of ['poster-client.js','app.js'])vm.runInContext(fs.readFileSync(f,'utf8'),c);
const E=c.window.EventPoster,C=c.window.PosterClient;
test('mobile bare URL survives parser, URL field model and posted content',()=>{
 for(const raw of ['example.com/event','realescapegame.jp/event','www.scrapmagazine.com/event']){
 const e=E.runAnalysis('【東京】『試験』\n説明\n'+raw).events[0];assert.equal(e.url,'https://'+raw);assert.ok(E.contentFor(e).includes('https://'+raw));assert.ok(!e.description.includes(raw));assert.equal(E.validateEvent(e).length,0);
 }
});
test('Markdown bare URLs and explicit HTTP(S) keep their intended scheme',()=>{
 for(const [raw,expected] of [['[公式](example.com/event)','https://example.com/event'],['https://example.com/event','https://example.com/event'],['http://example.com/event','http://example.com/event'],['公式URL：https://example.com/event','https://example.com/event']])assert.equal(E.runAnalysis('【東京】『試験』 '+raw).events[0].url,expected);
});
test('front and Worker normalize identically while image allowlist remains exact',async()=>{
 const W=await import('../worker/src/forum-input.mjs'),P=await import('../worker/src/official-image-policy.mjs');
 for(const raw of ['example.com/event','realescapegame.jp/event','https://example.com/event','http://example.com/event','']){
 const p={apiVersion:2,threadName:'試験',content:'本文',tagIds:[],officialUrl:raw,imageUrl:null};assert.equal(C.normalize(p).officialUrl,W.validatePostPayload(p).officialUrl);
 }
 for(const raw of ['javascript:alert(1)','data:text/html,x','//example.com/event','a@example.com/event','127.0.0.1/x','localhost/x','example.com\\x','https://a:b@example.com','https://example.com/\n']){
 const p={apiVersion:2,threadName:'試験',content:'本文',tagIds:[],officialUrl:raw,imageUrl:null};assert.throws(()=>C.normalize(p));assert.throws(()=>W.validatePostPayload(p));
 }
 assert.equal(P.officialPolicy(C.normalize({apiVersion:2,threadName:'x',content:'x',officialUrl:'example.com/event',imageUrl:null}).officialUrl),null);
 assert.ok(P.officialPolicy('https://realescapegame.jp/event'));assert.equal(P.officialPolicy('http://realescapegame.jp/event'),null);assert.equal(P.officialPolicy('https://realescapegame.jp.evil.test/event'),null);
});
