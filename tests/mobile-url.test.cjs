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

test('copied labels and Japanese trailing punctuation yield clean official URLs',()=>{
 for(const prefix of ['公式URL：','公式URL:','公式サイト：','URL：','詳細：','予約：','チケット：',''])for(const suffix of ['。','、','！？','，．','']){
  const raw=prefix+'i-ku-kan.com/department'+suffix;
  const e=E.runAnalysis('『試験』\n説明\n'+raw).events[0];
  assert.equal(e.url,'https://i-ku-kan.com/department',raw);
  assert.ok(!e.description.includes('i-ku-kan.com'),raw);
 }
 for(const raw of ['https://example.com/event。','http://example.com/event、','[公式](example.com/event)。'])assert.equal(E.extractLinks(raw)[0].url,raw.startsWith('http:')?'http://example.com/event':'https://example.com/event');
 assert.equal(E.extractLinks('公式URL：example.com/event?x=1&y=2#ticket。')[0].url,'https://example.com/event?x=1&y=2#ticket');
 assert.equal(E.extractLinks('公式URL：example.com/event。\n[公式](https://example.com/event)').length,1);
});
test('rejected schemes and email tokens never yield a DNS suffix',()=>{
 for(const raw of ['javascript:example.com/event','data:text/html,example.com/event','ftp://example.com/event','//example.com/event','a@example.com/event','https://a:b@example.com','localhost/x','127.0.0.1/x'])for(const prefix of ['', '公式URL：'])assert.equal(E.extractLinks(prefix+raw).length,0,prefix+raw);
 assert.equal(E.extractLinks('https://t.co/abc').length,0);
});
test('optional region preserves titles, body quotations and regional headings',()=>{
 const result=E.runAnalysis('前置き\n『地域なし』説明に「引用」があります\n> 『引用行』\n本文で【東京】『引用』を紹介\n【大阪】『地域あり』説明\n  「次のイベント」本文');
 assert.equal(result.events.length,3);
 assert.equal(result.warnings.length,1);
 assert.deepEqual(Array.from(result.events,e=>[e.region,e.title]),[['','地域なし'],['大阪','地域あり'],['','次のイベント']]);
 assert.match(result.events[0].description,/説明に「引用」/);
 assert.match(result.events[0].description,/> 『引用行』/);
 assert.match(result.events[0].description,/本文で【東京】『引用』/);
 assert.ok(!result.events[0].description.startsWith('『地域なし』'));
 assert.ok(!E.contentFor(result.events[0]).includes('開催地域'));
 assert.ok(E.contentFor(result.events[1]).startsWith('📍 **開催地域：大阪**'));
 assert.equal(E.validateEvent(result.events[0]).length,0);
 for(const quote of ['『題』','「題」','“題”','"題"'])assert.equal(E.runAnalysis(quote+'説明').events[0].title,'題');
 assert.equal(E.runAnalysis('説明中の『引用』のみ').events.length,0);
});

test('regional headings separated by LF/CRLF keep the main parser region and preserve P1',()=>{
 for(const gap of ['',' ','\n','\r\n','\n  ']){
  const e=E.runAnalysis('【東京】'+gap+'『試験公演』\nイベント本文').events[0];
  assert.equal(e.region,'東京');assert.equal(e.title,'試験公演');assert.equal(e.description,'イベント本文');assert.match(E.contentFor(e),/開催地域：東京/);
 }
 const events=E.runAnalysis('【東京】\n『試験公演』\n本文中の『引用』と【大阪】「紹介」\n> 『引用行』\n『地域なし公演』\n本文').events;
 assert.equal(events.length,2);assert.equal(events[1].region,'');assert.equal(events[1].title,'地域なし公演');assert.match(events[0].description,/> 『引用行』/);
 assert.equal(E.validateEvent(events[1]).length,0);
});
