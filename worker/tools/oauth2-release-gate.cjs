'use strict';
// Read-only release tooling. This module has no upload/deploy/secret write path.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'../..');
const WORKER='discord-event-poster-api',REMOTE='https://github.com/p156/discord-event-poster.git';
const REQUIRED=Object.freeze(['ALLOWED_ORIGIN','DISCORD_BOT_TOKEN','DISCORD_FORUM_CHANNEL_ID','SESSION_SIGNING_KEY','AUTH_SESSION_SIGNING_KEY','DISCORD_ALLOWED_USER_ID','DISCORD_OAUTH_CLIENT_ID','DISCORD_OAUTH_CLIENT_SECRET','DISCORD_OAUTH_REDIRECT_URI']);
const TOOL_PATHS=new Set(['package.json','README.md','worker/tools/oauth2-release-gate.cjs','worker/tests/oauth2-release-gate.test.cjs','worker/docs/OAUTH2-RELEASE-RUNBOOK.md','worker/docs/OAUTH2-RELEASE-TOOLING-RESULTS.md']);
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
class GateError extends Error {constructor(code){super('OAUTH_GATE_'+code);}}
const fail=code=>{throw new GateError(code);};
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v;}
const equal=(a,b,code)=>{if(JSON.stringify(canonical(a))!==JSON.stringify(canonical(b)))fail(code);};
const HASH=/^[a-f0-9]{64}$/,COMMIT=/^[a-f0-9]{40}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function shape(v,keys,code){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail(code);}
function git(args,raw=false){try{const value=execFileSync('git',args,{cwd:ROOT,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:1048576});return raw?value:value.trim();}catch{fail('GIT_UNAVAILABLE');}}
function sourceState(expectedSha){
 if(!COMMIT.test(expectedSha))fail('SOURCE_COMMIT_INVALID');
 if(path.resolve(git(['rev-parse','--show-toplevel'])).toLowerCase()!==ROOT.toLowerCase())fail('WORKTREE_MISMATCH');
 if(git(['branch','--show-current'])!=='event-poster-v2'||git(['rev-parse','HEAD'])!==expectedSha||git(['remote','get-url','origin'])!==REMOTE)fail('SOURCE_IDENTITY_MISMATCH');
 const status=git(['status','--porcelain=v1','-z','--untracked-files=all'],true);
 for(const record of status.split('\0').filter(Boolean)){
  const name=record.slice(3);if(!TOOL_PATHS.has(name)||/[RCUD]/.test(record.slice(0,2)))fail('UNEXPECTED_LOCAL_CHANGE');
 }
 const listed=git(['ls-files','-z','worker/src','worker/wrangler.jsonc','index.html','app.js','poster-client.js','styles.css','_config.yml','package.json','package-lock.json']).split('\0').filter(Boolean).sort();
 // Changes to package.json are permitted only for npm scripts; dependencies stay pinned.
 const pkg=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8'));
 const prior=JSON.parse(git(['show',expectedSha+':package.json']));
 const {scripts:ignoredCurrent,...current}=pkg,{scripts:ignoredPrior,...base}=prior;equal(current,base,'DEPENDENCY_CHANGE');
 equal(pkg.scripts,{...prior.scripts,'test:release-gate':'node --test worker/tests/oauth2-release-gate.test.cjs','release:gate':'node worker/tools/oauth2-release-gate.cjs'},'SCRIPT_CHANGE');
 for(const name of ['esbuild','wrangler']){const installed=JSON.parse(fs.readFileSync(path.join(ROOT,'node_modules',name,'package.json'),'utf8'));if(installed.version!==pkg.devDependencies[name])fail('DEPENDENCY_VERSION_MISMATCH');}
 const files=Object.fromEntries(listed.map(name=>[name,sha(fs.readFileSync(path.join(ROOT,name)))]));
 return {commit:expectedSha,files};
}
function localConfig(){
 const c=JSON.parse(fs.readFileSync(path.join(ROOT,'worker/wrangler.jsonc'),'utf8'));
 equal(c,{name:WORKER,main:'src/index.mjs',compatibility_date:'2026-04-01',secrets:{required:REQUIRED},durable_objects:{bindings:[{name:'AUTH_STATE',class_name:'AuthState'}]},migrations:[{tag:'auth-v1',new_sqlite_classes:['AuthState']}],observability:{enabled:false}},'LOCAL_CONFIG_CHANGED');return c;
}
function artifactDirectory(raw){const dir=path.resolve(ROOT,raw||'');const parent=path.join(ROOT,'work','oauth2-release');if(!dir.startsWith(parent+path.sep)||dir===parent)fail('ARTIFACT_PATH_REJECTED');for(let at=dir;at!==ROOT;at=path.dirname(at))if(fs.existsSync(at)&&fs.lstatSync(at).isSymbolicLink())fail('ARTIFACT_PATH_REJECTED');return dir;}
async function buildBundle(){const {build}=require('esbuild');try{const r=await build({entryPoints:[path.join(ROOT,'worker/src/index.mjs')],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});return Buffer.from(r.outputFiles[0].contents);}catch{fail('BUILD_FAILED');}}
function candidateConfig(config,baseline){
 const result={...config,main:'index.mjs',vars:{FORUM_POSTS_ENABLED:'read-only'},preview_urls:false};
 if(baseline){expectations(baseline);const s=baseline.settings;
  for(const k of ['compatibility_flags','tail_consumers','streaming_tail_consumers','tags','exports','containers'])if(s[k]!==undefined&&JSON.stringify(s[k])!=='[]')fail('UNSUPPORTED_SETTING');
  for(const k of ['placement','cache_options'])if(s[k]!==undefined&&JSON.stringify(s[k])!=='{}')fail('UNSUPPORTED_SETTING');
  if(s.logpush!==undefined&&s.logpush!==false)fail('UNSUPPORTED_SETTING');
  if(s.limits!==undefined){shape(s.limits,['cpu_ms','subrequests'],'UNSUPPORTED_LIMIT');for(const v of Object.values(s.limits))if(!Number.isSafeInteger(v)||v<1)fail('UNSUPPORTED_LIMIT');result.limits=structuredClone(s.limits);}
  if(s.observability!==undefined)result.observability=structuredClone(s.observability);
 }
 return result;
}
async function prepare(out,expectedSha,baseline=null){
 const dir=artifactDirectory(out),state=sourceState(expectedSha),config=localConfig(),bundle=await buildBundle();
 equal(sourceState(expectedSha),state,'SOURCE_CHANGED_DURING_BUILD');
 const candidate=candidateConfig(config,baseline);
 const bytes=Buffer.from(JSON.stringify(candidate,null,2)+'\n');
 const manifest={schema:1,worker:WORKER,branch:'event-poster-v2',source:state,bundleSha256:sha(bundle),configSha256:sha(bytes),mode:'read-only',requiredSecrets:[...REQUIRED],baseline,toolSha256:sha(fs.readFileSync(__filename))};
 // Exclusive directory creation: never overwrite or delete an existing candidate.
 fs.mkdirSync(path.dirname(dir),{recursive:true});try{fs.mkdirSync(dir);}catch{fail('ARTIFACT_ALREADY_EXISTS');}
 for(const [name,data]of [['index.mjs',bundle],['wrangler.json',bytes],['release.json',JSON.stringify(manifest,null,2)+'\n']])fs.writeFileSync(path.join(dir,name),data,{flag:'wx'});
 return manifest;
}
async function verify(out){
 const dir=artifactDirectory(out);let m;try{m=JSON.parse(fs.readFileSync(path.join(dir,'release.json'),'utf8'));}catch{fail('MANIFEST_INVALID');}
 shape(m,['schema','worker','branch','source','bundleSha256','configSha256','mode','requiredSecrets','baseline','toolSha256'],'MANIFEST_INVALID');
 if(m.schema!==1||m.worker!==WORKER||m.branch!=='event-poster-v2'||m.mode!=='read-only'||!HASH.test(m.bundleSha256)||!HASH.test(m.configSha256)||m.toolSha256!==sha(fs.readFileSync(__filename)))fail('MANIFEST_INVALID');
 shape(m.source,['commit','files'],'MANIFEST_INVALID');equal(m.requiredSecrets,REQUIRED,'MANIFEST_INVALID');
 const state=sourceState(m.source.commit);equal(m.source,state,'SOURCE_CHANGED');
 const c=candidateConfig(localConfig(),m.baseline);
 equal(JSON.parse(fs.readFileSync(path.join(dir,'wrangler.json'),'utf8')),c,'CANDIDATE_CONFIG_CHANGED');
 if(sha(fs.readFileSync(path.join(dir,'wrangler.json')))!==m.configSha256||sha(fs.readFileSync(path.join(dir,'index.mjs')))!==m.bundleSha256||sha(await buildBundle())!==m.bundleSha256)fail('ARTIFACT_CHANGED');
 equal(sourceState(m.source.commit),state,'SOURCE_CHANGED_DURING_BUILD');return m;
}
function expectations(e,{inspection=false}={}){
 shape(e,['schema','accountSha256','worker','namespaceId','activeVersion','latestVersion','deploymentId','mode','secretNames','settings'],'EXPECTATIONS_INVALID');
 if(e.schema!==1||e.worker!==WORKER||!HASH.test(e.accountSha256)||!/^[a-f0-9]{32}$/.test(e.namespaceId)||!UUID.test(e.activeVersion)||!UUID.test(e.latestVersion)||!UUID.test(e.deploymentId)||![...(inspection?['true']:[]),'absent','false','read-only'].includes(e.mode))fail('EXPECTATIONS_INCOMPLETE');
 if(!Array.isArray(e.secretNames)||e.secretNames.length<5||e.secretNames.some(n=>typeof n!=='string'||!/^[A-Z][A-Z0-9_]{0,79}$/.test(n))||new Set(e.secretNames).size!==e.secretNames.length)fail('EXPECTATIONS_INVALID');
 for(const n of ['ALLOWED_ORIGIN','DISCORD_BOT_TOKEN','DISCORD_FORUM_CHANNEL_ID','SESSION_SIGNING_KEY','APP_PASSWORD_HASH'])if(!e.secretNames.includes(n))fail('LEGACY_SECRET_REMOVAL');
 shape(e.settings,SETTING_KEYS,'SETTINGS_INVALID');if(e.settings.compatibility_date!=='2026-04-01'||e.settings.migration_tag!=='auth-v1'||e.settings.has_assets===true||e.settings.has_modules===false||!inspection&&e.settings.observability!==undefined&&e.settings.observability?.enabled!==false)fail('SETTINGS_INVALID');
 return e;
}
const SETTING_KEYS=['compatibility_date','compatibility_flags','migration_tag','usage_model','observability','limits','placement','tail_consumers','streaming_tail_consumers','tags','exports','containers','cache_options','logpush','has_assets','has_modules'];
const META_KEYS=['id','etag','tag','handlers','named_handlers','created_on','modified_on','last_deployed_from','deployment_id'];
function settingView(runtime){shape(runtime,[...SETTING_KEYS,...META_KEYS],'UNKNOWN_SETTING');const result={};for(const k of SETTING_KEYS)if(Object.hasOwn(runtime,k))result[k]=runtime[k];return result;}
function resources(account){const root='/accounts/'+account,service=root+'/workers/services/'+WORKER,script=root+'/workers/scripts/'+WORKER,environment=service+'/environments/production';return {account:root,service,versions:script+'/versions',deployments:script+'/deployments',environment,bindings:environment+'/bindings',routes:environment+'/routes?show_zonename=true',domains:root+'/workers/domains/records?page=0&per_page=5&service='+WORKER+'&environment=production',subdomain:environment+'/subdomain',schedules:script+'/schedules',namespaces:root+'/workers/durable_objects/namespaces?page=1&per_page=100'};}
async function boundedJson(response,signal){const reader=response.body?.getReader();if(!reader)fail('RESPONSE_INVALID');let size=0;const chunks=[];const abort=()=>{void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});try{while(true){if(signal?.aborted)fail('NETWORK_OR_TIMEOUT');const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>1048576)fail('RESPONSE_TOO_LARGE');chunks.push(value);}if(signal?.aborted)fail('NETWORK_OR_TIMEOUT');return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch(error){if(error instanceof GateError)throw error;fail('RESPONSE_INVALID');}finally{signal?.removeEventListener('abort',abort);void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}}
function reader(account,token,fetcher=globalThis.fetch){
 if(!/^[a-f0-9]{32}$/.test(account||'')||typeof token!=='string'||!token||/[\s\x00-\x1f\x7f]/.test(token))fail('CREDENTIALS_UNAVAILABLE');
 const permitted=new Set(Object.values(resources(account)));
 return async(resource,init={})=>{
  if(!permitted.has(resource)||Object.keys(init).some(k=>k!=='method')||init.method!==undefined&&init.method!=='GET')fail('READ_ONLY_GUARD');
  const controller=new AbortController();let timer;
  try{return await Promise.race([(async()=>{const r=await fetcher('https://api.cloudflare.com/client/v4'+resource,{method:'GET',redirect:'manual',headers:{Authorization:'Bearer '+token},signal:controller.signal});if(!r.ok){void r.body?.cancel().catch(()=>{});fail(r.status===401||r.status===403?'AUTHORIZATION_REJECTED':r.status>=300&&r.status<400?'REDIRECT_REJECTED':'HTTP_REJECTED');}const data=await boundedJson(r,controller.signal);if(data?.success!==true||!Object.hasOwn(data,'result')||data.result_info?.total_pages>1)fail('API_RESULT_REJECTED');return data.result;})(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new GateError('NETWORK_OR_TIMEOUT'));},10000);})]);}
  catch(error){if(error instanceof GateError)throw error;fail('NETWORK_OR_TIMEOUT');}finally{clearTimeout(timer);controller.abort();}
 };
}
async function snapshot(read,account,e,{inspection=false}={}){
 expectations(e,{inspection});if(sha(account)!==e.accountSha256)fail('ACCOUNT_MISMATCH');const p=resources(account),data={};
 for(const [name,resource]of Object.entries(p))data[name]=await read(resource);
 if(data.account?.id!==account||data.service?.default_environment?.environment!=='production')fail('ACCOUNT_OR_ENVIRONMENT_MISMATCH');
 if(data.versions?.items?.[0]?.id!==e.latestVersion)fail('LATEST_VERSION_CHANGED');
 const deployment=data.deployments?.deployments?.[0];if(deployment?.id!==e.deploymentId)fail('DEPLOYMENT_CHANGED');equal(deployment.versions,[{version_id:e.activeVersion,percentage:100}],'ACTIVE_VERSION_CHANGED');
 equal(settingView(data.environment?.script),e.settings,'SETTINGS_CHANGED');
 if(!Array.isArray(data.bindings))fail('BINDINGS_INVALID');
 const secret=data.bindings.filter(b=>b.type==='secret_text');equal(secret.map(b=>b.name).sort(),[...e.secretNames].sort(),'SECRET_NAMES_CHANGED');for(const b of secret)equal(Object.keys(b).sort(),['name','type'],'SECRET_METADATA_REJECTED');
 equal(data.bindings.filter(b=>b.type==='durable_object_namespace'),[{name:'AUTH_STATE',type:'durable_object_namespace',class_name:'AuthState',namespace_id:e.namespaceId}],'DO_IDENTITY_CHANGED');
 equal(data.bindings.filter(b=>!['secret_text','durable_object_namespace'].includes(b.type)),e.mode==='absent'?[]:[{name:'FORUM_POSTS_ENABLED',type:'plain_text',text:e.mode}],'POST_MODE_OR_BINDING_CHANGED');
 equal(data.routes,[],'ROUTES_CHANGED');equal(data.domains,[],'DOMAINS_CHANGED');equal(data.schedules,{schedules:[]},'SCHEDULES_CHANGED');equal(data.subdomain,{enabled:true,previews_enabled:false},'SUBDOMAIN_CHANGED');
 if(!Array.isArray(data.namespaces)||data.namespaces.filter(n=>n.id===e.namespaceId).length!==1)fail('NAMESPACE_UNVERIFIED');const ns=data.namespaces.find(n=>n.id===e.namespaceId);if(ns.script!==WORKER||ns.class!=='AuthState'||ns.use_sqlite!==true)fail('DO_BACKEND_CHANGED');
 return {fingerprint:sha(JSON.stringify(canonical({latest:e.latestVersion,deployment,settings:e.settings,bindings:data.bindings,namespace:ns,routes:data.routes,domains:data.domains,schedules:data.schedules,subdomain:data.subdomain}))),requiredSecretsPresent:REQUIRED.every(n=>e.secretNames.includes(n))};
}
async function inspect(read,account,e){const first=await snapshot(read,account,e,{inspection:true}),second=await snapshot(read,account,e,{inspection:true});equal(first,second,'CONCURRENT_REMOTE_CHANGE');return {...first,productionGo:false,releaseEligible:false};}
async function preflight(read,account,e){const first=await snapshot(read,account,e),second=await snapshot(read,account,e);equal(first,second,'CONCURRENT_REMOTE_CHANGE');return first;}
// Validation only. A future explicitly approved executor must call this on its
// actual multipart metadata; a passing fixture is not evidence of a real upload.
function assertUploadMetadata(m,config){
 shape(m,['main_module','bindings','compatibility_date','compatibility_flags','keep_bindings','observability','limits'],'UPLOAD_METADATA_REJECTED');
 if(m.main_module!=='index.mjs'||m.compatibility_date!==config.compatibility_date)fail('UPLOAD_METADATA_REJECTED');
 equal(m.compatibility_flags||[],[],'UPLOAD_FLAGS_CHANGED');equal(m.keep_bindings,['plain_text','json','secret_text','secret_key'],'SECRET_RETENTION_REJECTED');equal(m.observability,config.observability,'UPLOAD_OBSERVABILITY_CHANGED');equal(m.limits,config.limits,'UPLOAD_LIMITS_CHANGED');
 if(!Array.isArray(m.bindings)||new Set(m.bindings.map(b=>b.name)).size!==m.bindings.length)fail('UPLOAD_BINDINGS_REJECTED');
 const newNames=REQUIRED.slice(4),oldNames=REQUIRED.slice(0,4);
 for(const name of oldNames)equal(m.bindings.find(b=>b.name===name),{name,type:'inherit'},'EXISTING_SECRET_REPLACEMENT');
 for(const name of newNames){const b=m.bindings.find(b=>b.name===name);if(!b)fail('OAUTH_SECRET_MISSING');if(b.type==='inherit')equal(b,{name,type:'inherit'},'UPLOAD_SECRET_SHAPE');else {shape(b,['name','type','text'],'UPLOAD_SECRET_SHAPE');if(b.type!=='secret_text'||typeof b.text!=='string'||!b.text)fail('UPLOAD_SECRET_SHAPE');}}
 equal(m.bindings.find(b=>b.name==='AUTH_STATE'),{name:'AUTH_STATE',type:'durable_object_namespace',class_name:'AuthState'},'UPLOAD_DO_CHANGED');equal(m.bindings.find(b=>b.name==='FORUM_POSTS_ENABLED'),{name:'FORUM_POSTS_ENABLED',type:'plain_text',text:'read-only'},'UPLOAD_POSTS_ENABLED');
 if(m.bindings.length!==REQUIRED.length+2)fail('UPLOAD_BINDINGS_REJECTED');return true;
}
function parse(args){
 const mode=args.shift();if(!['prepare','verify','preflight','inspect'].includes(mode))fail('MODE_REJECTED');
 const flags={};for(let n=0;n<args.length;n+=2){const k=args[n],v=args[n+1];if(!['--release','--expected-sha','--expectations'].includes(k)||flags[k]!==undefined||!v||v.startsWith('--'))fail('ARGUMENTS_REJECTED');flags[k]=v;}
 const expected=mode==='prepare'?['--release','--expected-sha',...(flags['--expectations']?['--expectations']:[])]:mode==='verify'?['--release']:mode==='inspect'?['--expectations']:['--release','--expectations'];equal(Object.keys(flags).sort(),expected.sort(),'ARGUMENTS_REJECTED');return {mode,...flags};
}
async function run(args,env=process.env){
 const options=parse([...args]);let result;
 let e;if(options['--expectations'])try{e=expectations(JSON.parse(fs.readFileSync(options['--expectations'],'utf8')),{inspection:options.mode==='inspect'});}catch(error){if(error instanceof GateError)throw error;fail('EXPECTATIONS_INVALID');}
 if(options.mode==='inspect'){const account=env.OAUTH_GATE_CF_ACCOUNT_ID;const state=await inspect(reader(account,env.CLOUDFLARE_API_TOKEN),account,e);return {status:'PASS',mode:'inspect',remoteFingerprint:state.fingerprint,cloudWrites:0,productionGo:false,releaseEligible:false};}
 if(options.mode==='prepare')result=await prepare(options['--release'],options['--expected-sha'],e);else result=await verify(options['--release']);
 if(options.mode==='preflight'){
  if(!result.baseline)fail('REMOTE_BASELINE_NOT_BOUND');equal(result.baseline,e,'EXPECTATIONS_CHANGED');
  const account=env.OAUTH_GATE_CF_ACCOUNT_ID,read=reader(account,env.CLOUDFLARE_API_TOKEN);const state=await preflight(read,account,e);await verify(options['--release']);
  return {status:'PASS',mode:'preflight',remoteFingerprint:state.fingerprint,oauthSecretNamesPresent:state.requiredSecretsPresent,cloudWrites:0,productionGo:false};
 }
 return {status:'PASS',mode:options.mode,sourceCommit:result.source.commit,bundleSha256:result.bundleSha256,configSha256:result.configSha256,postMode:'read-only',remoteBaselineBound:!!result.baseline,cloudWrites:0,productionGo:false};
}
module.exports={ROOT,WORKER,REQUIRED,GateError,sha,equal,sourceState,localConfig,candidateConfig,prepare,verify,reader,resources,expectations,settingView,snapshot,inspect,preflight,assertUploadMetadata,parse,run};
if(require.main===module)run(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error instanceof GateError?error.message:'OAUTH_GATE_STOPPED');process.exitCode=1;});
