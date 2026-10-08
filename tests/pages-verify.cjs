const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const base='https://p156.github.io/discord-event-poster/';
const normalize=s=>s.replace(/\r\n/g,'\n').trim();
const sha=s=>crypto.createHash('sha256').update(normalize(s)).digest('hex');
async function main(){
  const result={timestamp:new Date().toISOString(),assets:[],excluded:[],browser:[]};
  for(const name of ['index.html','styles.css','app.js']){
    const response=await fetch(base+(name==='index.html'?'':name)+'?verify='+Date.now());
    assert.equal(response.status,200,name+' HTTP status');
    const remote=await response.text(),local=await fs.readFile(path.join(root,name),'utf8');
    assert.equal(sha(remote),sha(local),name+' published source mismatch');
    result.assets.push({name,status:response.status,normalizedSha256:sha(remote),match:true});
    console.log('PASS published source '+name);
  }
  for(const name of ['tests/browser-acceptance.cjs','tests/pages-verify.cjs','tests-acceptance.cjs','tests-v010.js','package.json','package-lock.json','work/browser-acceptance/results.json']){
    const response=await fetch(base+name+'?verify='+Date.now());
    assert.equal(response.status,404,name+' dev file must not be published');
    result.excluded.push({name,status:response.status});
    console.log('PASS unpublished '+name);
  }
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    for(const width of [1280,390,320]){
      const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
      const blocked=[],errors=[],logs=[],failed=[];
      await context.route('**/*',route=>{
        const request=route.request(),u=new URL(request.url());
        if(u.origin==='https://p156.github.io'&&u.pathname.startsWith('/discord-event-poster/')&&request.method()==='GET')return route.continue();
        blocked.push(u.origin);return route.abort();
      });
      const page=await context.newPage();
      page.on('pageerror',e=>errors.push(e.message));
      page.on('console',m=>{if(m.type()==='error')logs.push(m.text())});
      page.on('requestfailed',r=>failed.push(r.url()));
      try{
        const response=await page.goto(base+'?verify='+Date.now());assert.equal(response.status(),200);
        await page.getByLabel('イベント告知文').fill('【東京】『公開確認』説明 https://example.com/'+'a'.repeat(160));
        await page.getByRole('button',{name:'解析する',exact:true}).click();
        await page.getByRole('button',{name:'投稿内容を確認',exact:true}).click();
        const dom=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,scriptReady:typeof window.EventPoster==='object',preview:document.getElementById('preview').textContent}));
        assert.equal(dom.scriptReady,true);assert.match(dom.preview,/公開確認/);assert.ok(dom.scroll<=dom.width);
        assert.equal(errors.length,0);assert.equal(logs.length,0);assert.equal(failed.length,0);assert.equal(blocked.length,0);
        result.browser.push({width,status:'PASS',...dom,jsErrors:errors.length,consoleErrors:logs.length});
        await fs.mkdir(path.join(root,'work','browser-acceptance'),{recursive:true});
        await page.screenshot({path:path.join(root,'work','browser-acceptance','published-'+width+'.png'),fullPage:true});
        console.log('PASS published browser '+width);
      }finally{await context.close();}
    }
  }finally{await browser.close();}
  await fs.writeFile(path.join(root,'work','browser-acceptance','pages.json'),JSON.stringify(result,null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
