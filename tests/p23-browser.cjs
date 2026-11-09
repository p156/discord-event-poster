const assert=require('node:assert/strict');
const {setup,initialize,closeBrowser}=require('./browser-acceptance.cjs');
let passed=0;
async function check(name,run){
 const h=await setup();try{await run(h);await h.verify();passed++;console.log('PASS '+name);}finally{await h.close();}
}
async function login(h){
 await h.login();await h.page.waitForFunction(()=>document.getElementById('registered-forum').value==='123');
}
async function registerSecond(h){
 await h.page.locator('summary').filter({hasText:'フォーラムを登録'}).click();
 await h.page.locator('#load-guilds').click();
 await h.page.waitForFunction(()=>document.querySelector('#guild-select option[value="457"]'));
 await h.page.locator('#guild-select').selectOption('457');
 await h.page.waitForFunction(()=>document.querySelector('#candidate-forum option[value="124"]'));
 await h.page.locator('#register-forum').click();
 await h.page.waitForFunction(()=>document.getElementById('registered-forum').value==='124'&&document.querySelector('[data-tag="201"]'));
}
(async()=>{
 await initialize('p23-runtime-entry.mjs');
 await check('own active/archive history and edition warnings remain advisory through real Bot send',async h=>{
  await h.prepare();await login(h);
  await h.page.waitForFunction(()=>document.getElementById('history-status').textContent.includes('履歴取得完了'));
  await h.page.locator('summary').filter({hasText:'選択中フォーラムのBot投稿履歴'}).click();
  const history=await h.page.locator('#history-list').innerText();
  assert.match(history,/第5回/);assert.match(history,/アーカイブ/);assert.ok(!history.includes('別の人'));
  await h.page.locator('[data-field="title"]').fill('第6回 謎解きフェスティバル');
  await h.page.locator('#review').click();await h.page.waitForFunction(()=>!document.getElementById('post').disabled);
  assert.match(await h.page.locator('#duplicate-warning').innerText(),/第5回/);
  assert.match(await h.page.locator('#duplicate-warning').innerText(),/別開催の可能性/);
  await h.post();assert.equal(h.posts().length,1);assert.match(await h.page.locator('#post-results').innerText(),/成功/);
 });
 await check('multiple guilds, arbitrary manual tags, switch/reset, reload selection and unregister persistence',async h=>{
  await h.prepare();await login(h);await registerSecond(h);
  assert.equal(await h.page.locator('[data-tag="101"]').count(),0);
  await h.page.locator('[data-tag="201"]').check();assert.equal(await h.page.locator('[data-tag]:checked').count(),1);
  await h.page.locator('#registered-forum').selectOption('123');
  await h.page.waitForFunction(()=>document.querySelector('[data-tag="101"]'));
  assert.equal(await h.page.locator('[data-tag]:checked').count(),0);
  await h.page.locator('#registered-forum').selectOption('124');
  await h.page.waitForFunction(()=>document.querySelector('[data-tag="201"]'));
  await h.page.reload();await h.page.waitForFunction(()=>document.getElementById('registered-forum').value==='124');
  await h.page.locator('#remove-forum').click();
  await h.page.waitForFunction(()=>document.getElementById('registered-forum').value==='');
  await h.page.reload();await h.page.waitForFunction(()=>document.querySelector('#registered-forum option[value="123"]'));
  assert.equal(await h.page.locator('#registered-forum').inputValue(),'');
  assert.equal(await h.page.locator('#registered-forum option[value="124"]').count(),0);
  assert.equal(h.posts().length,0);
 });
 await check('delayed old tags and image confirmation cannot cross a forum switch',async h=>{
  await h.prepare();await login(h);await registerSecond(h);
  await h.page.locator('#registered-forum').selectOption('123');
  await h.page.waitForFunction(()=>document.querySelector('[data-tag="101"]'));
  let release,arrived;
  const pending=new Promise(r=>arrived=r);
  await h.page.route('**/api/forums/123/tags',async route=>{
    const request=route.request();const response=await h.mf.dispatchFetch(request.url(),{headers:await request.allHeaders()});
    const body=Buffer.from(await response.arrayBuffer());arrived();await new Promise(r=>release=r);
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body});
  });
  await h.page.locator('#fetch-tags').click();await pending;
  await h.page.locator('#registered-forum').selectOption('124');
  await h.page.waitForFunction(()=>document.querySelector('[data-tag="201"]'));release();
  await h.page.waitForFunction(()=>document.querySelector('[data-tag="201"]')&&!document.querySelector('[data-tag="101"]'));
  await h.page.unroute('**/api/forums/123/tags');
  h.holdPreview=true;await h.page.locator('#review').click();
  await h.page.waitForFunction(()=>document.getElementById('post').disabled);
  while(!h.releasePreview)await new Promise(r=>setTimeout(r,10));
  await h.page.locator('#registered-forum').selectOption('123');
  await h.page.waitForFunction(()=>document.querySelector('[data-tag="101"]'));
  h.holdPreview=false;h.releasePreview();
  await h.page.waitForFunction(()=>!document.getElementById('post').disabled);
  await h.post();assert.equal(h.posts().length,1);
  assert.match(await h.page.locator('#post-results').innerText(),/成功/);
 });
 await check('history permission failure says unverified yet permits selected-forum post',async h=>{
  await h.prepare();await login(h);
  await h.mf.dispatchFetch('https://discord-event-poster-api.monma5435.workers.dev/__test/history-error',{method:'POST'});
  await h.page.locator('#review').click();await h.page.waitForFunction(()=>!document.getElementById('post').disabled);
  assert.match(await h.page.locator('#duplicate-status').innerText(),/重複未確認/);
  await h.post();assert.equal(h.posts().length,1);assert.match(await h.page.locator('#post-results').innerText(),/成功/);
 });
 console.log('PASS P2/P3 browser contracts: '+passed+'; zero real Discord requests');
 await closeBrowser();
})().catch(async e=>{console.error(e);await closeBrowser();process.exitCode=1;});
