'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {Readable}=require('node:stream'),{spawnSync}=require('node:child_process');
const gate=require('../tools/oauth2-release-gate.cjs'),owner=require('../tools/owner-readonly-evidence.cjs');
globalThis.fetch=()=>{throw Error('REAL_NETWORK_FORBIDDEN');};
const A='a'.repeat(32),N='b'.repeat(32),V='11111111-1111-4111-8111-111111111111',D='22222222-2222-4222-8222-222222222222';
const marker='SECRET_MARKER_DO_NOT_PRINT';
function fixture(){
 const p=gate.resources(A),secrets=['ALLOWED_ORIGIN','DISCORD_BOT_TOKEN','DISCORD_FORUM_CHANNEL_ID','SESSION_SIGNING_KEY','APP_PASSWORD_HASH'];
 const f={
 [p.account]:{id:A},[p.service]:{default_environment:{environment:'production'}},
 [p.versions]:{items:[{id:V}]},[p.deployments]:{deployments:[{id:D,versions:[{version_id:V,percentage:100}]}]},
 [p.environment]:{script:{compatibility_date:'2026-04-01',migration_tag:'auth-v1',observability:{enabled:true},limits:{cpu_ms:10}}},
 [p.bindings]:[...secrets.map(name=>({name,type:'secret_text'})),{name:'AUTH_STATE',type:'durable_object_namespace',class_name:'AuthState',namespace_id:N},{name:'FORUM_POSTS_ENABLED',type:'plain_text',text:'true'}],
 [p.routes]:[],[p.domains]:[],[p.schedules]:{schedules:[]},[p.subdomain]:{enabled:true,previews_enabled:false},[p.namespaces]:[{id:N,script:gate.WORKER,class:'AuthState',use_sqlite:true}]
 };let calls=0;
 return {p,f,get calls(){return calls;},fetch:async(url,init)=>{
 calls++;assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.headers.Authorization,'Bearer '+marker);
 assert.ok(url.startsWith('https://api.cloudflare.com/client/v4/'));const key=url.slice('https://api.cloudflare.com/client/v4'.length);
 assert.ok(Object.hasOwn(f,key));return new Response(JSON.stringify({success:true,result:f[key]}));
 }};
}
test('bootstrap observes live true/Logs without relaxing release guard; only allowlisted evidence is output',async()=>{
 const h=fixture();h.f[h.p.deployments].deployments[0].annotations={message:marker};
 const r=await owner.collect(A,marker,h.fetch);
 assert.equal(h.calls,4+2*Object.keys(h.p).length);assert.equal(r.activeVersion,V);assert.equal(r.deploymentId,D);
 assert.equal(r.productionGo,false);assert.equal(r.releaseEligible,false);assert.equal(r.allModuleHashes,'NOT VERIFIED');
 assert.equal(JSON.stringify(r).includes(marker),false);assert.equal(JSON.stringify(r).includes(A),false);
});
test('permission failures stop once and do not disclose API body',async()=>{
 for(const status of [401,403,429,500,302]){let calls=0;await assert.rejects(()=>owner.collect(A,marker,async()=>{calls++;return new Response(marker,{status});}),gate.GateError);assert.equal(calls,1);}
});
test('invalid credentials fail before network; no fallback',async()=>{
 for(const [a,t] of [['bad',marker],[A,''],[A,'bad\ntoken']]){let calls=0;await assert.rejects(()=>owner.collect(a,t,async()=>{calls++;}));assert.equal(calls,0);}
});
test('unknown schema, secret values, extra names and split deployments fail closed',async()=>{
 for(const change of [h=>h.f[h.p.environment].script.new_setting=marker,h=>h.f[h.p.bindings][0].text=marker,h=>h.f[h.p.bindings][0].name=marker,h=>h.f[h.p.deployments].deployments[0].versions[0].percentage=99,h=>h.f[h.p.bindings].push({name:'EXTRA',type:'plain_text',text:marker}),h=>h.f[h.p.environment].script.limits.extra=3]){
 const h=fixture();change(h);await assert.rejects(()=>owner.collect(A,marker,h.fetch));}
});
test('independent scan detects deployment changes',async()=>{
 const h=fixture();let n=0;await assert.rejects(()=>owner.collect(A,marker,async(u,i)=>{if(++n===10)h.f[h.p.deployments].deployments[0].id=V;return h.fetch(u,i);}));
});
test('pagination and oversized responses stop rather than silently truncate',async()=>{
 for(const body of [JSON.stringify({success:true,result:{},result_info:{total_pages:2}}),'x'.repeat(1048577)])await assert.rejects(()=>owner.collect(A,marker,async()=>new Response(body)));
});
test('stdin schema and size are bounded',async()=>{
 assert.deepEqual(await owner.input(Readable.from([Buffer.from(JSON.stringify({account:A,token:marker}))])),{account:A,token:marker});
 for(const s of ['{',JSON.stringify({account:A,token:marker,extra:true}),'x'.repeat(8193)])await assert.rejects(()=>owner.input(Readable.from([Buffer.from(s)])));
});
test('CLI rejects arguments and malformed credential input with constant output',()=>{
 const script=require.resolve('../tools/owner-readonly-evidence.cjs');
 for(const args of [[script,'--execute'],[script]]){
 const r=spawnSync(process.execPath,args,{input:marker,encoding:'utf8',env:{}});assert.equal(r.status,1);assert.equal(r.stdout,'');assert.equal(r.stderr.trim(),'OWNER_EVIDENCE_STOPPED');
 }
});
test('PowerShell wrapper is blocked by policy or cancels without connection',{skip:process.platform!=='win32'},()=>{
 const script=require('node:path').resolve(__dirname,'../tools/owner-readonly-evidence.ps1').replaceAll("'","''");
 // A private console is normally required. Static validation below also binds that guard.
 const source=require('node:fs').readFileSync(script,'utf8');
 assert.match(source,/Read-Host \$label -AsSecureString/);assert.match(source,/IsInputRedirected/);
 assert.match(source,/RedirectStandardInput = \$true/);assert.match(source,/ZeroFreeBSTR/);
 const r=spawnSync('powershell',['-NoProfile','-Command',`function Read-Host { 'CANCEL' }; & '${script}'`],{encoding:'utf8'});
 assert.equal(r.status,1);
 if(r.stdout.trim()==='OWNER_EVIDENCE_STOPPED')assert.equal(r.stderr,'');
 else {assert.equal(r.stdout,'');assert.match(r.stderr,/PSSecurityException|UnauthorizedAccess/);}
});
