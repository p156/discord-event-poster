const {chromium}=require('playwright');
const fs=require('node:fs/promises');const path=require('node:path');const assert=require('node:assert/strict');
const names=['周遊型','ホール型','ルーム型','オンライン','持ち帰り','イマーシブ','謎解き','ホラー'];
const historical=name=>fs.readFile(path.join(__dirname,'fixtures/legacy-step3',name));
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
 const context=await browser.newContext({viewport:{width:390,height:900}}),page=await context.newPage();let logged=false,match=true;const posts=[],errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.type()==='confirm'?d.accept():d.dismiss());
 await context.route('**/*',async route=>{
 const r=route.request(),u=new URL(r.url());
 if(u.origin==='https://poster.test'){const name=u.pathname.split('/').pop()||'index.html';return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html',body:await historical(name)});}
 if(u.hostname==='discord-event-poster-api.monma5435.workers.dev'){
 let body,status=200;
 if(u.pathname==='/api/login'){logged=true;body={token:'TEST_ONLY_SESSION',expiresAt:Date.now()+3600000};}
 else if(!logged){status=401;body={error:'unauthorized'};}
 else if(u.pathname==='/api/logout'){logged=false;body={authenticated:true};}
 else if(u.pathname==='/api/forum/tags')body={forumId:'123',mapping:Object.fromEntries(names.map((n,i)=>[n,String(100+i)])),missing:[],duplicates:[],unknown:[]};
 else if(u.pathname==='/api/forum/webhook-check'){status=match?200:409;body=match?{forumId:'123',webhookId:'456'}:{error:'mismatch'};}
 return route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 }
 if(u.hostname==='discord.com'){posts.push(JSON.parse(r.postData()));return route.fulfill({contentType:'application/json',body:JSON.stringify({id:'789',channel_id:'123'})});}
 await route.abort();
 });
 await page.goto('https://poster.test/');await page.locator('#webhook').fill('https://discord.com/api/webhooks/456/TEST_ONLY');
 await page.locator('#source').fill('【東京】『ホラー謎解き』オンライン');await page.locator('#parse').click();
 assert.equal(await page.locator('[data-tag]:checked').count(),0);
 await page.locator('.auto-tag').click();assert.equal(await page.locator('[data-tag]:checked').count(),3);assert.match(await page.locator('.tag-field').innerText(),/一致語/);
 await page.locator('[data-tag="ホール型"]').check();await page.locator('[data-tag="周遊型"]').check();await page.locator('[data-tag="持ち帰り"]').click();assert.equal(await page.locator('[data-tag]:checked').count(),5);
 await page.locator('#review').click();await page.locator('#post').click();assert.equal(posts.length,0,'unset IDs block');
 await page.locator('#app-password').fill('TEST_ONLY_PASSWORD');await page.locator('#worker-login').click();await page.locator('#auth-status').filter({hasText:'ログインしました'}).waitFor();assert.equal(await page.locator('#app-password').inputValue(),'');
 await page.locator('#fetch-tags').click();await page.locator('#auth-status').filter({hasText:'取得しました'}).waitFor();
 match=false;await page.locator('#post').click();assert.equal(posts.length,0,'wrong forum blocks');match=true;
 await page.locator('#post').click();await page.waitForFunction(()=>!document.getElementById('post').disabled);assert.equal(posts.length,1);assert.equal(posts[0].applied_tags.length,5);
 await page.locator('#worker-logout').click();await page.locator('#auth-status').filter({hasText:'ログアウトしました'}).waitFor();assert.equal(await page.evaluate(()=>sessionStorage.getItem('discord-event-poster.session')),null);
 await page.locator('#source').fill('【東京】『タグなし』説明');await page.locator('#parse').click();await page.locator('#review').click();await page.locator('#post').click();await page.waitForFunction(()=>!document.getElementById('post').disabled);assert.equal(posts.length,2);assert.equal(posts[1].applied_tags,undefined);
 assert.deepEqual(errors,[]);await fs.mkdir(path.join(__dirname,'..','work','phase2-browser'),{recursive:true});await page.screenshot({path:path.join(__dirname,'..','work','phase2-browser','mobile.png'),fullPage:true});console.log('PASS Phase 2 browser: manual/auto tags, 5 limit, auth, forum mismatch, applied_tags, logout, fallback');
 }finally{await browser.close();}
})().catch(e=>{console.error(String(e.message).replace(/TEST_ONLY[A-Z_]*(?:PASSWORD|SESSION)?/g,'[test value]'));process.exitCode=1;});
