// Browser-only transport mocks. No test hook is added to the production app.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'work','browser-acceptance');
const url='http://poster.test/discord-event-poster/';
const token='FAKE_BROWSER_TEST_ONLY';
const webhook='https://discord.com/api/webhooks/123456789/'+token;
const results=[];
let browser;
async function setup(steps, width=1280) {
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
  const blocked=[],consoleLogs=[],errors=[];
  await context.route('**/*',async route=>{
    const u=new URL(route.request().url());
    const name=u.pathname.split('/').pop()||'index.html';
    if(u.origin==='http://poster.test'&&['index.html','styles.css','app.js'].includes(name)){
      await route.fulfill({status:200,contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html',body:await fs.readFile(path.join(root,name))});
    }else{blocked.push(u.origin);await route.abort();}
  });
  await context.addInitScript(({steps,token})=>{
    window.__calls=[];
    window.__steps=steps;
    window.fetch=async(input,options)=>{
      window.__calls.push({url:String(input),method:options.method,body:JSON.parse(options.body),time:Date.now()});
      const step=window.__steps.shift()||{status:200};
      if(step.pending)return new Promise(()=>{});
      if(step.network)throw new TypeError('mock network failure '+token);
      return new Response(JSON.stringify(step.status===200?{id:String(100+window.__calls.length),channel_id:'789'}:step.body||{message:token}),{status:step.status,headers:{'Content-Type':'application/json',...step.headers}});
    };
  },{steps,token});
  const page=await context.newPage();
  page.on('console',msg=>consoleLogs.push({type:msg.type(),text:msg.text(),location:msg.location()}));
  page.on('pageerror',e=>errors.push(e.message));
  page.on('dialog',async d=>d.type()==='confirm'?d.accept():d.dismiss());
  await page.clock.install({time:new Date('2026-10-09T09:00:00+09:00')});
  await page.goto(url);
  await page.clock.pauseAt(new Date('2026-10-09T09:00:01+09:00'));
  await page.getByLabel('Webhook URL',{exact:true}).fill(webhook);
  async function prepare(count=1){
    await page.getByLabel('イベント告知文').fill(Array.from({length:count},(_,i)=>`【東京】『ブラウザ試験${i+1}』説明`).join('\n'));
    await page.getByRole('button',{name:'解析する',exact:true}).click();
    await page.getByRole('button',{name:'投稿内容を確認',exact:true}).click();
  }
  const status=()=>page.locator('#post-results').innerText();
  async function ready(){await page.waitForFunction(()=>!document.getElementById('post').disabled);}
  async function verify(){
    assert.equal(blocked.length,0,'unexpected external request');
    assert.equal(errors.length,0,'browser JavaScript errors');
    assert.ok(!JSON.stringify(consoleLogs).includes(token),'console credential exposure');
    assert.ok(!(await page.locator('body').innerText()).includes(token),'visible UI credential exposure');
    assert.ok(await page.getByRole('button',{name:'解析する',exact:true}).isEnabled(),'parser locked after error');
    const calls=await page.evaluate(()=>window.__calls);
    for(const c of calls){assert.equal(c.method,'POST');assert.deepEqual(c.body.allowed_mentions,{parse:[]});assert.ok(c.url.endsWith('?wait=true'));}
    return calls;
  }
  return {context,page,prepare,status,ready,verify};
}
async function check(name,fn){try{await fn();results.push({name,status:'PASS'});console.log('PASS '+name);}catch(e){results.push({name,status:'FAIL',error:e.message});console.error('FAIL '+name+': '+e.message);}}
async function main(){
  await fs.mkdir(output,{recursive:true});
  browser=await chromium.launch({channel:'msedge',headless:true});
  for(const code of [400,401,403,404,500,502,503])await check('HTTP '+code,async()=>{
    const h=await setup([{status:code}]);
    try{
      await h.prepare();await h.page.locator('#post').click();await h.ready();
      const text=await h.status();assert.match(text,new RegExp('HTTP '+code));assert.match(text,code>=500?/結果不明/:/失敗/);assert.match(text,/[ぁ-んァ-ン]/);
      const explanation={400:/不正なリクエスト/,401:/認証に失敗/,403:/権限がありません/,404:/Webhookが見つかりません/};
      if(explanation[code])assert.match(text,explanation[code]);
      assert.equal(await h.page.locator('#retry-failed').isVisible(),code<500);
      assert.match(await h.page.locator('.card').innerText(),code>=500?/状態：結果不明/:/状態：失敗/);
      assert.equal(await h.page.locator('#review').isEnabled(),false);
      await h.page.locator('#post').click();await h.ready();
      assert.equal((await h.verify()).length,1,'completed event unexpectedly resent');
      await h.page.screenshot({path:path.join(output,'http-'+code+'.png'),fullPage:true});
    }finally{await h.context.close();}
  });
  await check('network error: unknown, no retry',async()=>{
    const h=await setup([{network:true}]);try{await h.prepare();await h.page.locator('#post').click();await h.ready();assert.match(await h.status(),/結果不明/);assert.match(await h.status(),/ネットワーク/);await h.page.locator('#post').click();assert.equal((await h.verify()).length,1);assert.equal(await h.page.locator('#retry-failed').isVisible(),false);}finally{await h.context.close();}
  });
  await check('timeout + double execution lock + unknown',async()=>{
    const h=await setup([{pending:true}]);try{
      await h.prepare();await h.page.locator('#post').click();
      await h.page.waitForFunction(()=>window.__calls.length===1);
      assert.equal(await h.page.locator('#post').isEnabled(),false);assert.equal(await h.page.locator('#parse').isEnabled(),false);
      assert.equal(await h.page.locator('#review').isEnabled(),false,'review must stay disabled while posting');
      assert.equal(await h.page.locator('.select-event').isEnabled(),false,'selection must be frozen while posting');
      assert.equal(await h.page.getByLabel('タイトル',{exact:true}).isEnabled(),false,'editor must be frozen while posting');
      assert.match(await h.status(),/送信中/);
      await h.page.evaluate(()=>{document.getElementById('post').click();});
      assert.equal((await h.page.evaluate(()=>window.__calls)).length,1);
      await h.page.clock.runFor(29999);assert.match(await h.status(),/送信中/);
      await h.page.clock.runFor(1);await h.ready();assert.match(await h.status(),/結果不明/);assert.match(await h.status(),/タイムアウト/);
      await h.page.locator('#post').click();assert.equal((await h.verify()).length,1);
      await h.page.screenshot({path:path.join(output,'timeout.png'),fullPage:true});
    }finally{await h.context.close();}
  });
  await check('429 waiting + Retry-After + retry success',async()=>{
    const h=await setup([{status:429,body:{retry_after:1},headers:{'Retry-After':'2'}},{status:200}]);try{
      await h.prepare();await h.page.locator('#post').click();
      await h.page.waitForFunction(()=>document.getElementById('result-summary').textContent.includes('2秒待機'));
      assert.equal(await h.page.locator('#post').isEnabled(),false);
      await h.page.clock.runFor(1999);assert.equal((await h.page.evaluate(()=>window.__calls)).length,1);
      await h.page.clock.runFor(1);await h.ready();assert.match(await h.status(),/成功/);
      const calls=await h.verify();assert.equal(calls.length,2);assert.equal(calls[1].time-calls[0].time,2000);
    }finally{await h.context.close();}
  });
  await check('partial failure + failure-only retry + success never resent',async()=>{
    const h=await setup([{status:200},{status:400},{status:200}],390);try{
      await h.prepare(2);await h.page.locator('#post').click();await h.ready();
      assert.equal(await h.page.locator('#post-results .result.ok').count(),1);assert.equal(await h.page.locator('#post-results .result.error').count(),1);
      assert.equal(await h.page.locator('#retry-failed').isVisible(),true);
      await h.page.screenshot({path:path.join(output,'partial-failure-390.png'),fullPage:true});
      await h.page.locator('#status-panel').screenshot({path:path.join(output,'partial-failure-results.png')});
      await h.page.locator('#retry-failed').click();await h.ready();
      assert.equal(await h.page.locator('#post-results .result.ok').count(),2);assert.equal(await h.page.locator('#retry-failed').isVisible(),false);
      await h.page.locator('#select-all').click();await h.page.locator('#post').click();
      const calls=await h.verify();assert.equal(calls.length,3);assert.equal(calls[2].body.thread_name,'【東京】ブラウザ試験2');
      assert.equal(await h.page.locator('#post-results a').count(),2);
    }finally{await h.context.close();}
  });
  for(const width of [1280,390,320])await check('layout '+width,async()=>{
    const h=await setup([{status:400}],width);try{await h.prepare();await h.page.locator('#post').click();await h.ready();const dims=await h.page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(dims.scroll<=dims.width);await h.verify();}finally{await h.context.close();}
  });
  await browser.close();
  await fs.writeFile(path.join(output,'results.json'),JSON.stringify({timestamp:new Date().toISOString(),environment:{browser:'Microsoft Edge (headless)',playwright:require('playwright/package.json').version,transport:'browser fetch mock; all requests intercepted; no external continue',clock:'Playwright Clock 30000ms virtual timeout'},results},null,2));
  console.log(JSON.stringify({tests:results.length,pass:results.filter(x=>x.status==='PASS').length,fail:results.filter(x=>x.status==='FAIL').length}));
  if(results.some(x=>x.status==='FAIL'))process.exitCode=1;
}
main().catch(async e=>{console.error(e);if(browser)await browser.close();process.exitCode=1;});
