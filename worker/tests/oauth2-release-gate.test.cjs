'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const gate=require('../tools/oauth2-release-gate.cjs');
globalThis.fetch=()=>{throw Error('REAL_NETWORK_FORBIDDEN');};
const ACCOUNT='a'.repeat(32),NS='b'.repeat(32),VERSION='11111111-1111-4111-8111-111111111111',DEPLOYMENT='22222222-2222-4222-8222-222222222222';
const SECRETS=['ALLOWED_ORIGIN','DISCORD_BOT_TOKEN','DISCORD_FORUM_CHANNEL_ID','SESSION_SIGNING_KEY','APP_PASSWORD_HASH'];
function setup(){
 const e={schema:1,worker:gate.WORKER,accountSha256:gate.sha(ACCOUNT),namespaceId:NS,activeVersion:VERSION,latestVersion:VERSION,deploymentId:DEPLOYMENT,mode:'false',secretNames:SECRETS,settings:{compatibility_date:'2026-04-01',migration_tag:'auth-v1',observability:{enabled:false},limits:{cpu_ms:10},usage_model:'standard'}};
 const p=gate.resources(ACCOUNT),f={
  [p.account]:{id:ACCOUNT},[p.service]:{default_environment:{environment:'production'}},[p.versions]:{items:[{id:VERSION}]},[p.deployments]:{deployments:[{id:DEPLOYMENT,versions:[{version_id:VERSION,percentage:100}]}]},[p.environment]:{script:{...structuredClone(e.settings),etag:'OPAQUE_METADATA'}},
  [p.bindings]:[...SECRETS.map(name=>({name,type:'secret_text'})),{name:'AUTH_STATE',type:'durable_object_namespace',class_name:'AuthState',namespace_id:NS},{name:'FORUM_POSTS_ENABLED',type:'plain_text',text:'false'}],
  [p.routes]:[],[p.domains]:[],[p.schedules]:{schedules:[]},[p.subdomain]:{enabled:true,previews_enabled:false},[p.namespaces]:[{id:NS,script:gate.WORKER,class:'AuthState',use_sqlite:true}]
 };return {e,p,f,read:async resource=>{assert.ok(Object.hasOwn(f,resource));return structuredClone(f[resource]);}};
}
test('CLI accepts only prepare/verify/read-only preflight and rejects all mutation flags',()=>{
 for(const args of [[],['--execute'],['deploy'],['upload'],['verify','--release','work/x','--approval','yes'],['prepare','--release','work/x','--release','work/y'],['preflight','--release','work/x'],['verify','--release']])assert.throws(()=>gate.parse(args),gate.GateError);
 assert.equal(gate.parse(['verify','--release','work/oauth2-release/test']).mode,'verify');
});
test('legacy baseline accepts exact five secrets and retains explicit CPU limits; no OAuth readiness claim',async()=>{const h=setup(),r=await gate.preflight(h.read,ACCOUNT,h.e);assert.equal(r.requiredSecretsPresent,false);assert.match(r.fingerprint,/^[a-f0-9]{64}$/);});
test('OAuth-ready baseline requires all nine names plus preserved legacy secrets',async()=>{const h=setup();h.e.secretNames=[...new Set([...SECRETS,...gate.REQUIRED])];h.f[h.p.bindings]=[...h.e.secretNames.map(name=>({name,type:'secret_text'})),...h.f[h.p.bindings].filter(b=>b.type!=='secret_text')];assert.equal((await gate.preflight(h.read,ACCOUNT,h.e)).requiredSecretsPresent,true);});
test('incomplete expectations and already-live posting mode stop before any remote request',async()=>{
 for(const alter of [e=>e.namespaceId=null,e=>e.accountSha256=null,e=>e.activeVersion=null,e=>e.deploymentId=null,e=>e.mode='true',e=>e.secretNames=e.secretNames.filter(x=>x!=='APP_PASSWORD_HASH'),e=>e.settings.observability={enabled:true},e=>e.settings.compatibility_date='2027-01-01']){const h=setup();alter(h.e);let calls=0;await assert.rejects(()=>gate.preflight(async()=>{calls++;},ACCOUNT,h.e),gate.GateError);assert.equal(calls,0);}
});
test('exact account/version/deployment/100 percent identity guards fail closed',async()=>{
 for(const alter of [h=>h.f[h.p.account].id='OTHER',h=>h.f[h.p.versions].items[0].id=DEPLOYMENT,h=>h.f[h.p.deployments].deployments[0].id=VERSION,h=>h.f[h.p.deployments].deployments[0].versions[0].percentage=99,h=>h.f[h.p.service].default_environment.environment='staging']){const h=setup();alter(h);await assert.rejects(()=>gate.preflight(h.read,ACCOUNT,h.e),gate.GateError);}
 const h=setup();let calls=0;await assert.rejects(()=>gate.preflight(async()=>{calls++;},'c'.repeat(32),h.e));assert.equal(calls,0);
});
test('namespace/class/backend and binding duplicates or unknown bindings are rejected',async()=>{
 for(const alter of [h=>h.f[h.p.bindings].find(b=>b.name==='AUTH_STATE').namespace_id='c'.repeat(32),h=>h.f[h.p.bindings].push({...h.f[h.p.bindings][0]}),h=>h.f[h.p.bindings].push({name:'EXTRA',type:'plain_text',text:'SECRET_DO_NOT_PRINT'}),h=>h.f[h.p.namespaces][0].use_sqlite=false,h=>h.f[h.p.namespaces].push({...h.f[h.p.namespaces][0]}),h=>h.f[h.p.namespaces][0].class='OTHER']){const h=setup();alter(h);await assert.rejects(()=>gate.preflight(h.read,ACCOUNT,h.e),gate.GateError);}
});
test('secret response values and unexpected secret names are refused without echoing contents',async()=>{for(const alter of [h=>h.f[h.p.bindings][0].text='SECRET_DO_NOT_PRINT',h=>h.f[h.p.bindings][0].name='SECRET_DO_NOT_PRINT']){const h=setup();alter(h);await assert.rejects(()=>gate.preflight(h.read,ACCOUNT,h.e),e=>e instanceof gate.GateError&&!e.message.includes('SECRET_DO_NOT_PRINT'));}});
test('known setting changes and unknown settings stop; absent versus null is not normalized',async()=>{
 for(const alter of [h=>h.f[h.p.environment].script.limits.cpu_ms=300000,h=>h.f[h.p.environment].script.observability={enabled:true},h=>h.f[h.p.environment].script.danger='SECRET_DO_NOT_PRINT',h=>h.f[h.p.environment].script.compatibility_flags=['nodejs_compat'],h=>h.f[h.p.environment].script.migration_tag='new',h=>h.f[h.p.environment].script.tail_consumers=null]){const h=setup();alter(h);await assert.rejects(()=>gate.preflight(h.read,ACCOUNT,h.e),gate.GateError);}
});
test('routes/domains/schedules/public preview changes cannot hide in known metadata',async()=>{for(const alter of [h=>h.f[h.p.routes].push({pattern:'SECRET_DO_NOT_PRINT'}),h=>h.f[h.p.domains].push({hostname:'PRIVATE'}),h=>h.f[h.p.schedules].schedules.push({cron:'* * * * *'}),h=>h.f[h.p.subdomain].previews_enabled=true]){const h=setup();alter(h);await assert.rejects(()=>gate.preflight(h.read,ACCOUNT,h.e),gate.GateError);}});
test('two complete snapshots detect mid-read version change; no retries',async()=>{const h=setup();let calls=0;const read=async resource=>{calls++;if(calls>Object.keys(h.p).length)h.f[h.p.versions].items[0].id=DEPLOYMENT;return h.read(resource);};await assert.rejects(()=>gate.preflight(read,ACCOUNT,h.e));assert.equal(calls,Object.keys(h.p).length*2);});
test('GET transport permits only fixed endpoints and never POST/body/query/redirect expansion',async()=>{
 let calls=0;const read=gate.reader(ACCOUNT,'TEST_ONLY',async(url,o)=>{calls++;assert.equal(o.method,'GET');assert.equal(o.redirect,'manual');assert.deepEqual(Object.keys(o.headers),['Authorization']);return Response.json({success:true,result:{id:ACCOUNT}});});
 for(const [resource,init]of [[gate.resources(ACCOUNT).account,{method:'POST'}],[gate.resources(ACCOUNT).account,{body:'SECRET'}],['/accounts/'+ACCOUNT+'/tokens',{}],[gate.resources(ACCOUNT).account+'?anything',{}]])await assert.rejects(()=>read(resource,init),/READ_ONLY_GUARD/);
 assert.equal(calls,0);assert.equal((await read(gate.resources(ACCOUNT).account)).id,ACCOUNT);assert.equal(calls,1);
});
test('HTTP auth/429/5xx/redirect and network failures are sanitized, attempted once only',async()=>{
 for(const status of [301,302,401,403,429,500]){let calls=0;const read=gate.reader(ACCOUNT,'TEST_ONLY',async()=>{calls++;return new Response('SECRET_DO_NOT_PRINT',{status});});await assert.rejects(()=>read(gate.resources(ACCOUNT).account),e=>e instanceof gate.GateError&&!e.message.includes('SECRET_DO_NOT_PRINT'));assert.equal(calls,1);}
 let calls=0;await assert.rejects(()=>gate.reader(ACCOUNT,'TEST_ONLY',async()=>{calls++;throw Error('SECRET_DO_NOT_PRINT');})(gate.resources(ACCOUNT).account),/NETWORK_OR_TIMEOUT/);assert.equal(calls,1);
});
test('malformed/error/oversize/paginated API responses stop without response-body exposure',async()=>{
 for(const response of [()=>new Response('SECRET_DO_NOT_PRINT'),()=>Response.json({success:false,result:'SECRET'}),()=>Response.json({success:true,result:[],result_info:{total_pages:2}}),()=>new Response('x'.repeat(1048577))])await assert.rejects(()=>gate.reader(ACCOUNT,'TEST_ONLY',async()=>response())(gate.resources(ACCOUNT).account),gate.GateError);
});
test('preflight has no credential refresh/global-key fallback or production GO claim',async()=>{assert.throws(()=>gate.reader(ACCOUNT,''),/CREDENTIALS_UNAVAILABLE/);const src=fs.readFileSync(require.resolve('../tools/oauth2-release-gate.cjs'),'utf8');assert.ok(!src.includes('stage1Write'));assert.ok(!src.includes('getAPIToken'));assert.ok(src.includes('productionGo:false'));});
test('candidate is reproducible, read-only, offline, immutable and detects bundle/manifest/config edits',async()=>{
 const {execFileSync}=require('node:child_process');const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:gate.ROOT,encoding:'utf8'}).trim();
 const relative='work/oauth2-release/test-'+require('node:crypto').randomUUID(),dir=path.join(gate.ROOT,relative);
 await gate.prepare(relative,commit);const m=await gate.verify(relative);assert.equal(m.mode,'read-only');const config=JSON.parse(fs.readFileSync(path.join(dir,'wrangler.json'),'utf8'));assert.equal(config.vars.FORUM_POSTS_ENABLED,'read-only');assert.equal(config.preview_urls,false);assert.deepEqual(config.secrets.required,gate.REQUIRED);
 await assert.rejects(()=>gate.prepare(relative,commit),/ARTIFACT_ALREADY_EXISTS/);
 const original=fs.readFileSync(path.join(dir,'index.mjs'));fs.appendFileSync(path.join(dir,'index.mjs'),'\n// edited');await assert.rejects(()=>gate.verify(relative),/ARTIFACT_CHANGED/);fs.writeFileSync(path.join(dir,'index.mjs'),original);
 const manifest=path.join(dir,'release.json'),stored=fs.readFileSync(manifest);fs.writeFileSync(manifest,JSON.stringify({...m,bundleSha256:gate.sha('fake')}));await assert.rejects(()=>gate.verify(relative),/ARTIFACT_CHANGED/);fs.writeFileSync(manifest,stored);
 const candidate=path.join(dir,'wrangler.json'),raw=fs.readFileSync(candidate);config.vars.FORUM_POSTS_ENABLED='true';fs.writeFileSync(candidate,JSON.stringify(config));await assert.rejects(()=>gate.verify(relative),/CANDIDATE_CONFIG_CHANGED/);fs.writeFileSync(candidate,raw);
 const result=await gate.run(['verify','--release',relative]);assert.equal(result.productionGo,false);assert.equal(result.cloudWrites,0);
});
test('wrong commit or artifact outside the isolated output tree is rejected',async()=>{await assert.rejects(()=>gate.prepare('../outside','a'.repeat(40)),/ARTIFACT_PATH_REJECTED/);await assert.rejects(()=>gate.prepare('work/oauth2-release/wrong-source','a'.repeat(40)),/SOURCE_IDENTITY_MISMATCH/);});
test('candidate binds the reviewed baseline and preserves explicit CPU limits',async()=>{
 const h=setup(),{execFileSync}=require('node:child_process'),commit=execFileSync('git',['rev-parse','HEAD'],{cwd:gate.ROOT,encoding:'utf8'}).trim();const relative='work/oauth2-release/baseline-'+require('node:crypto').randomUUID();await gate.prepare(relative,commit,h.e);const m=await gate.verify(relative);assert.deepEqual(m.baseline,h.e);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(gate.ROOT,relative,'wrangler.json'),'utf8')).limits,{cpu_ms:10});
 for(const alter of [e=>e.settings.compatibility_flags=['nodejs_compat'],e=>e.settings.limits.extra=1,e=>e.settings.limits.cpu_ms=0,e=>e.settings.tags=['extra']]){const e=structuredClone(h.e);alter(e);assert.throws(()=>gate.candidateConfig(gate.localConfig(),e),gate.GateError);}
});
test('actual pinned Wrangler form retains old keys and bundles five new OAuth secrets with read-only code',()=>{
 const candidate=require('../tools/wrangler-strict-candidate.cjs'),{source}=candidate.original();const api=candidate.load(source,'\ninit_create_worker_upload_form();init_secrets_validation();exports.form=createWorkerUploadForm;exports.inherit=addRequiredSecretsInheritBindings;');
 const config=gate.candidateConfig(gate.localConfig(),setup().e),bindings={AUTH_STATE:{type:'durable_object_namespace',class_name:'AuthState'},FORUM_POSTS_ENABLED:{type:'plain_text',value:'read-only'}};
 for(const name of gate.REQUIRED.slice(4))bindings[name]={type:'secret_text',value:'TEST_ONLY_DUMMY_'+name};api.inherit(config,bindings,{type:'upload'});
 const worker={main:{name:'index.mjs',type:'esm',content:'export {AuthState}; export default {}'},modules:[],compatibility_date:config.compatibility_date,compatibility_flags:[],keepVars:true,keepSecrets:true,observability:config.observability,limits:config.limits};
 const metadata=JSON.parse(api.form(worker,bindings).get('metadata'));assert.equal(gate.assertUploadMetadata(metadata,config),true);assert.equal(metadata.bindings.filter(b=>b.type==='inherit').length,4);assert.equal(metadata.bindings.filter(b=>b.type==='secret_text').length,5);
 for(const mutate of [m=>m.migrations={new_sqlite_classes:['AuthState']},m=>m.exports=[],m=>m.bindings.find(b=>b.name==='SESSION_SIGNING_KEY').type='secret_text',m=>m.keep_bindings=[],m=>m.bindings.find(b=>b.name==='FORUM_POSTS_ENABLED').text='true',m=>m.limits.cpu_ms=300000,m=>m.bindings.push({...m.bindings[0]})]){const m=structuredClone(metadata);mutate(m);assert.throws(()=>gate.assertUploadMetadata(m,config),gate.GateError);}
});
test('slow response body is cancelled at the transport deadline without another request',async()=>{
 let calls=0,cancelled=false;const read=gate.reader(ACCOUNT,'TEST_ONLY',async()=>{calls++;return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;}}));});
 await assert.rejects(()=>read(gate.resources(ACCOUNT).account),/NETWORK_OR_TIMEOUT/);assert.equal(calls,1);assert.equal(cancelled,true);
});
