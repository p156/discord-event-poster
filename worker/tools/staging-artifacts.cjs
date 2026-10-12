'use strict';
// Offline only: no Cloudflare credentials, HTTP transport, upload or deployment.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const production=require('./oauth2-release-gate.cjs');
const ROOT=production.ROOT,BASE='61eaf3d4b1de3169bbb8c82a4118aef07df4f97a';
// Reviewed constants, never command-line/env/request supplied. Replace only in a
// separately reviewed change after real targets and effective limits are approved.
const TARGET=Object.freeze({environment:'staging-local',worker:'discord-event-poster-api-staging',api:'https://discord-event-poster-api-staging.invalid',web:'https://discord-event-poster-web-staging.invalid',clientId:'900000000000000001',forumId:'900000000000000002',guildId:'900000000000000003',cpuMs:10,deployable:false});
const ASSETS=['index.html','app.js','poster-client.js','styles.css'];
const sha=production.sha,eq=production.equal;
function stop(code){throw new Error('STAGING_'+code);}
function git(args){try{return execFileSync('git',args,{cwd:ROOT,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}catch{stop('GIT_UNAVAILABLE');}}
function source(){
 if(git(['branch','--show-current'])!=='event-poster-v2'||git(['remote','get-url','origin'])!=='https://github.com/p156/discord-event-poster.git'||path.resolve(git(['rev-parse','--show-toplevel'])).toLowerCase()!==ROOT.toLowerCase())stop('IDENTITY');
 git(['merge-base','--is-ancestor',BASE,'HEAD']);
 const names=git(['ls-files','worker/src','worker/wrangler.jsonc',...ASSETS,'package.json','package-lock.json']).split('\n').filter(Boolean).sort();
 const files=Object.fromEntries(names.map(n=>[n,sha(fs.readFileSync(path.join(ROOT,n)))]));
 // Compare Git blobs using repository clean filters (Windows CRLF checkout).
 for(const n of names)if(git(['hash-object','--path='+n,n])!==git(['rev-parse',BASE+':'+n]))stop('SOURCE_BASELINE');
 return {base:BASE,commit:git(['rev-parse','HEAD']),files};
}
function replaceOnce(s,from,to,count=1){if(s.split(from).length-1!==count)stop('SOURCE_LAYOUT');return s.split(from).join(to);}
async function render(){
 const before=source();production.localConfig();
 const {build}=require('esbuild');
const guard=`function stagingEnvironment(env){return env.ALLOWED_ORIGIN===${JSON.stringify(TARGET.web)}&&env.DISCORD_OAUTH_REDIRECT_URI===${JSON.stringify(TARGET.api+'/api/oauth/callback')}&&env.DISCORD_OAUTH_CLIENT_ID===${JSON.stringify(TARGET.clientId)}&&env.DISCORD_FORUM_CHANNEL_ID===${JSON.stringify(TARGET.forumId)};}`;
 const bundle=await build({entryPoints:[path.join(ROOT,'worker/src/index.mjs')],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent',plugins:[{name:'fixed-staging',setup(b){b.onLoad({filter:/(?:request-boundary|oauth-handler)\.mjs$/},args=>{
 let s=fs.readFileSync(args.path,'utf8');
 if(args.path.endsWith('request-boundary.mjs'))s=replaceOnce(s,'discord-event-poster-api.monma5435.workers.dev',new URL(TARGET.api).hostname);
 else {s=replaceOnce(s,'export function oauthConfigured(env){','export function oauthConfigured(env){\n  if(!stagingEnvironment(env))return false;');s+='\n'+guard+'\n';}
 return {contents:s,loader:'js'};
 });}}]});
 const files={'worker/index.mjs':Buffer.from(bundle.outputFiles[0].contents)};
 const config={...production.localConfig(),name:TARGET.worker,main:'index.mjs',vars:{FORUM_POSTS_ENABLED:'read-only'},preview_urls:false,limits:{cpu_ms:TARGET.cpuMs}};
 files['worker/wrangler.json']=Buffer.from(JSON.stringify(config,null,2)+'\n');
 for(const name of ASSETS){let s=fs.readFileSync(path.join(ROOT,name),'utf8');if(name==='poster-client.js'||name==='index.html')s=replaceOnce(s,'https://discord-event-poster-api.monma5435.workers.dev',TARGET.api,name==='index.html'?2:1);files['web/'+name]=Buffer.from(s);}
 eq(before,source(),'SOURCE_CHANGED');
 return {files,manifest:{schema:1,target:TARGET,source:before,allowedDifferences:['worker Host','OAuth environment guard','client API','CSP connect-src/form-action','Worker name/read-only/preview/limits'],hashes:Object.fromEntries(Object.entries(files).map(([n,v])=>[n,sha(v)])),toolSha256:sha(fs.readFileSync(__filename)),cloudWrites:0,constructionGo:false,productionGo:false}};
}
function directory(raw){const parent=path.join(ROOT,'work','staging'),dir=path.resolve(ROOT,raw||'');if(!dir.startsWith(parent+path.sep))stop('OUTPUT_PATH');for(let at=dir;at!==ROOT;at=path.dirname(at))if(fs.existsSync(at)&&(fs.lstatSync(at).isSymbolicLink()||!fs.lstatSync(at).isDirectory()))stop('OUTPUT_PATH');return dir;}
async function prepare(raw){const dir=directory(raw),r=await render();fs.mkdirSync(path.dirname(dir),{recursive:true});try{fs.mkdirSync(dir);}catch{stop('OUTPUT_EXISTS');}for(const [n,v]of Object.entries(r.files)){fs.mkdirSync(path.dirname(path.join(dir,n)),{recursive:true});fs.writeFileSync(path.join(dir,n),v,{flag:'wx'});}fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(r.manifest,null,2)+'\n',{flag:'wx'});return r.manifest;}
async function verify(raw){const dir=directory(raw),r=await render();eq(JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8')),r.manifest,'MANIFEST_CHANGED');const list=(d,p='')=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>{if(e.isSymbolicLink())stop('OUTPUT_PATH');return e.isDirectory()?list(path.join(d,e.name),p+e.name+'/'):[p+e.name];});eq(list(dir).sort(),[...Object.keys(r.files),'manifest.json'].sort(),'EXTRA_ASSET');for(const [n,v]of Object.entries(r.files))eq(sha(fs.readFileSync(path.join(dir,n))),sha(v),'ARTIFACT_CHANGED');return r.manifest;}
// Values stay in memory; never return values/fingerprints or store secrets.
function secrets(values,productionValues){
 eq(Object.keys(values).sort(),[...production.REQUIRED].sort(),'SECRET_NAMES');
 if(!productionValues||production.REQUIRED.some(n=>typeof productionValues[n]!=='string'||!productionValues[n]))stop('PRODUCTION_COMPARISON_MISSING');
 for(const n of production.REQUIRED){if(typeof values[n]!=='string'||!values[n]||n!=='DISCORD_ALLOWED_USER_ID'&&values[n]===productionValues[n])stop('SECRET_REUSE');}
 if(values.ALLOWED_ORIGIN!==TARGET.web||values.DISCORD_OAUTH_REDIRECT_URI!==TARGET.api+'/api/oauth/callback'||values.DISCORD_OAUTH_CLIENT_ID!==TARGET.clientId||values.DISCORD_FORUM_CHANNEL_ID!==TARGET.forumId)stop('SECRET_TARGET');
 for(const n of ['SESSION_SIGNING_KEY','AUTH_SESSION_SIGNING_KEY'])if(values[n].length<64)stop('KEY_LENGTH');
 if(values.SESSION_SIGNING_KEY===values.AUTH_SESSION_SIGNING_KEY||[values.SESSION_SIGNING_KEY,values.AUTH_SESSION_SIGNING_KEY].some(v=>[productionValues.SESSION_SIGNING_KEY,productionValues.AUTH_SESSION_SIGNING_KEY].includes(v)))stop('KEY_REUSE');
 if(values.DISCORD_BOT_TOKEN===values.DISCORD_OAUTH_CLIENT_SECRET||values.DISCORD_OAUTH_CLIENT_SECRET.length<16||!/^\d{1,20}$/.test(values.DISCORD_ALLOWED_USER_ID))stop('SECRET_SHAPE');return true;
}
function initialMetadata(m,values,productionValues){
 secrets(values,productionValues);
 eq(Object.keys(m).sort(),['main_module','compatibility_date','bindings','migrations','observability','limits'].sort(),'INITIAL_METADATA');
 eq(m.main_module,'index.mjs','INITIAL_MODULE');eq(m.compatibility_date,'2026-04-01','INITIAL_DATE');
 eq(m.migrations,{new_tag:'auth-v1',new_sqlite_classes:['AuthState']},'INITIAL_MIGRATION');
 eq(m.observability,{enabled:false},'INITIAL_OBSERVABILITY');eq(m.limits,{cpu_ms:TARGET.cpuMs},'INITIAL_LIMITS');
 const expected=[...production.REQUIRED.map(name=>({name,type:'secret_text',text:values[name]})),{name:'AUTH_STATE',type:'durable_object_namespace',class_name:'AuthState'},{name:'FORUM_POSTS_ENABLED',type:'plain_text',text:'read-only'}];
 eq(m.bindings,expected,'INITIAL_BINDINGS');return true;
}
function candidate(bytes,expectedHash,metadata,expectedMetadata){if(!Buffer.isBuffer(bytes)||sha(bytes)!==expectedHash)stop('CANDIDATE_CODE');eq(metadata,expectedMetadata,'CANDIDATE_METADATA');return true;}
function snapshot(actual,expected,productionState){
 const keys=['environment','worker','accountFingerprint','namespaceId','clientId','botId','guildId','forumId','version','bundleSha256','mode','secretNames','sqlite','migration','preview','routes','limits'];
 eq(Object.keys(expected).sort(),keys.sort(),'EXPECTATION_SHAPE');eq(actual,expected,'REMOTE_CHANGED');
 if(expected.environment!==TARGET.environment||expected.worker!==TARGET.worker||expected.clientId!==TARGET.clientId||expected.guildId!==TARGET.guildId||expected.forumId!==TARGET.forumId||!['read-only','true'].includes(expected.mode)||expected.sqlite!==true||expected.migration!=='auth-v1'||expected.preview!==false)stop('REMOTE_TARGET');
 eq(expected.routes,[],'ROUTES');eq(expected.limits,{cpu_ms:TARGET.cpuMs},'LIMITS');eq([...expected.secretNames].sort(),[...production.REQUIRED].sort(),'SECRET_NAMES');
 if(!productionState)stop('PRODUCTION_COMPARISON_MISSING');
 for(const n of ['namespaceId','clientId','botId','guildId','forumId'])if(typeof expected[n]!=='string'||!expected[n]||!productionState[n]||expected[n]===productionState[n])stop('RESOURCE_REUSE');
 if(!/^[a-f0-9]{64}$/.test(expected.accountFingerprint)||!productionState.accountFingerprint||!expected.version||!/^[a-f0-9]{64}$/.test(expected.bundleSha256))stop('REMOTE_IDENTITY');
 return true;
}
// Injected MOCK adapter only. No real executor is exposed. Recovery never picks latest.
async function mockTransition(adapter,expected,productionState,version,bundleSha256){
 if(adapter.kind!=='offline-mock'||!version||!/^[a-f0-9]{64}$/.test(bundleSha256))stop('MOCK_ONLY');
 const a=await adapter.read(),b=await adapter.read();snapshot(a,expected,productionState);snapshot(b,expected,productionState);
 await adapter.switchVersion({worker:TARGET.worker,environment:TARGET.environment,version,percentage:100});
 const after=await adapter.read();snapshot(after,{...expected,version,bundleSha256},productionState);return {status:'PASS',cloudWrites:0,productionGo:false};
}
module.exports={TARGET,ROOT,BASE,ASSETS,render,prepare,verify,secrets,initialMetadata,candidate,snapshot,mockTransition};
if(require.main===module){const [mode,out,...rest]=process.argv.slice(2);if(!['prepare','verify'].includes(mode)||!out||rest.length){console.error('STAGING_ARGUMENTS');process.exitCode=1;}else module.exports[mode](out).then(()=>console.log(JSON.stringify({status:'PASS',environment:TARGET.environment,deployable:false,cloudWrites:0,productionGo:false}))).catch(()=>{console.error('STAGING_STOPPED');process.exitCode=1;});}
