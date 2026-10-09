'use strict';
// Separate Stage 1 executor. --execute is for a future, separately approved run.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const candidate=require('./wrangler-strict-candidate.cjs');
const WORKER='discord-event-poster-api',NAMESPACE='5157fbc20842458f8e8269b821e51f47',VERSION='a9901f55-6b22-4a67-8ce6-4c2dca5e4e3d';
const SECRET_NAMES=['ALLOWED_ORIGIN','DISCORD_BOT_TOKEN','DISCORD_FORUM_CHANNEL_ID','APP_PASSWORD_HASH','SESSION_SIGNING_KEY'];
const CONFIG_SHA='d4d5326b330b36950fd47320e246e46c9a9a27626055614053a77445b620505f';
class Stage1Error extends Error {}
const fail=code=>{throw new Stage1Error('STAGE1_'+code);};
function same(a,b,code){try{assert.deepEqual(a,b);}catch{fail(code);}}
function defaultsMatch(actual,defaults){
 if(!actual||typeof actual!=='object'||Array.isArray(actual))fail('REMOTE_SETTINGS_MISMATCH');
 for(const [key,value]of Object.entries(actual)){if(!Object.hasOwn(defaults,key))fail('UNKNOWN_REMOTE_SETTINGS');if(typeof defaults[key]==='object')defaultsMatch(value,defaults[key]);else if(value!==defaults[key])fail('REMOTE_SETTINGS_MISMATCH');}
}
function parse(args){
 if(args.length===1&&args[0]==='--dry-run')return {dryRun:true};
 const expected=['--execute','--preflight','--account-id','--expected-version','--approval'];const seen=new Map();
 for(let i=0;i<args.length;i++){const k=args[i];if(!expected.includes(k)||seen.has(k))fail('ARGUMENTS_REJECTED');if(['--execute','--preflight'].includes(k))seen.set(k,true);else{const v=args[++i];if(!v||v.startsWith('--'))fail('ARGUMENTS_REJECTED');seen.set(k,v);}}
 const preflight=seen.has('--preflight');
 if(seen.has('--execute')===preflight||seen.size!==(preflight?3:4)||!/^[a-f0-9]{32}$/.test(seen.get('--account-id')||'')||seen.get('--expected-version')!==VERSION||(!preflight&&seen.get('--approval')!=='STAGE1-POSTS-OFF'))fail('EXECUTION_APPROVAL_REQUIRED');
 return {dryRun:false,preflight,accountId:seen.get('--account-id'),version:VERSION};
}
function localConfig(){
 const filename=path.join(candidate.ROOT,'worker/wrangler.jsonc'),bytes=fs.readFileSync(filename);
 if(candidate.sha(bytes)!==CONFIG_SHA)fail('LOCAL_CONFIG_CHANGED');
 const config=JSON.parse(bytes.toString('utf8'));
 same(config,{name:WORKER,main:'src/index.mjs',compatibility_date:'2026-04-01',secrets:{required:SECRET_NAMES},durable_objects:{bindings:[{name:'AUTH_STATE',class_name:'AuthState'}]},migrations:[{tag:'auth-v1',new_sqlite_classes:['AuthState']}],preview_urls:false,observability:{enabled:false}},'LOCAL_CONFIG_REJECTED');
 return config;
}
function allowedDiff(diff){return diff===null||JSON.stringify(diff)===JSON.stringify({vars:{FORUM_POSTS_ENABLED__added:'false'}});}
function assertNoMigration(migrations){if(migrations!==undefined)fail('MIGRATION_FORBIDDEN');}
function assertUpload(metadata){
 if(!metadata||metadata.migrations!==undefined||metadata.exports!==undefined)fail('MIGRATION_FORBIDDEN');
 const allowed=['main_module','bindings','compatibility_date','compatibility_flags','keep_bindings','observability','logpush','package_dependencies'];
 if(Object.keys(metadata).some(key=>!allowed.includes(key)))fail('UNKNOWN_UPLOAD_SETTINGS');
 same(metadata.bindings,[...SECRET_NAMES.map(name=>({name,type:'inherit'})),{name:'FORUM_POSTS_ENABLED',type:'plain_text',text:'false'},{name:'AUTH_STATE',type:'durable_object_namespace',class_name:'AuthState'}],'UPLOAD_BINDINGS_REJECTED');
 same(metadata.keep_bindings,['plain_text','json','secret_text','secret_key'],'SECRET_OR_VARS_RETENTION_REJECTED');
 if(metadata.compatibility_date!=='2026-04-01')fail('UPLOAD_COMPATIBILITY_REJECTED');
 if(metadata.compatibility_flags!==undefined)same(metadata.compatibility_flags,[],'UPLOAD_COMPATIBILITY_REJECTED');
 if(metadata.logpush!==undefined&&metadata.logpush!==false)fail('UNKNOWN_UPLOAD_SETTINGS');
 if(metadata.observability!==undefined)defaultsMatch(metadata.observability,{enabled:false,head_sampling_rate:1,redact_query_string:false,logs:{enabled:false,head_sampling_rate:1,invocation_logs:true,persist:true},traces:{enabled:false,persist:true,head_sampling_rate:1}});
 if(metadata.package_dependencies!==undefined){const manifest=JSON.parse(fs.readFileSync(path.join(candidate.ROOT,'package.json'),'utf8'));const versions={...manifest.dependencies,...manifest.devDependencies};if(!Array.isArray(metadata.package_dependencies)||metadata.package_dependencies.length>Object.keys(versions).length)fail('UNKNOWN_UPLOAD_SETTINGS');for(const dep of metadata.package_dependencies){if(Object.keys(dep).sort().join(',')!=='installedVersion,name,packageJsonVersion'||versions[dep.name]!==dep.packageJsonVersion||dep.installedVersion!==dep.packageJsonVersion)fail('UNKNOWN_UPLOAD_SETTINGS');}}
}
async function snapshot(read,accountId){
 if(!/^[a-f0-9]{32}$/.test(accountId))fail('ACCOUNT_REJECTED');
 const root='/accounts/'+accountId,script=root+'/workers/scripts/'+WORKER,service=root+'/workers/services/'+WORKER;
 const account=await read(root);if(account?.id!==accountId)fail('ACCOUNT_MISMATCH');
 const versions=await read(script+'/versions');if(!Array.isArray(versions?.items)||versions.items[0]?.id!==VERSION)fail('LATEST_VERSION_CHANGED');
 const deployments=await read(script+'/deployments');const latest=deployments?.deployments?.[0];
 same(latest?.versions,[{version_id:VERSION,percentage:100}],'ACTIVE_DEPLOYMENT_CHANGED');
 if(typeof latest.id!=='string'||!latest.id)fail('DEPLOYMENT_METADATA_INVALID');
 const svc=await read(service);const environment=svc?.default_environment?.environment;
 if(environment!=='production')fail('ENVIRONMENT_UNVERIFIED');
 const env=await read(service+'/environments/'+environment);const runtime=env?.script;
 if(!runtime||runtime.migration_tag!=='auth-v1'||runtime.compatibility_date!=='2026-04-01')fail('MIGRATION_OR_COMPATIBILITY_MISMATCH');
 const knownScriptFields=['id','etag','tag','handlers','named_handlers','created_on','modified_on','last_deployed_from','usage_model','compatibility_date','compatibility_flags','migration_tag','observability','limits','placement','tail_consumers','streaming_tail_consumers','tags','exports','containers','cache_options','logpush'];
 if(Object.keys(runtime).some(key=>!knownScriptFields.includes(key)))fail('UNKNOWN_REMOTE_SETTINGS');
 for(const key of ['compatibility_flags','tail_consumers','streaming_tail_consumers','tags'])if(runtime[key]!==undefined&&(!Array.isArray(runtime[key])||runtime[key].length))fail('REMOTE_SETTINGS_MISMATCH');
 if(runtime.observability?.enabled!==false)fail('OBSERVABILITY_UNVERIFIED');
 defaultsMatch(runtime.observability,{enabled:false,head_sampling_rate:1,redact_query_string:false,logs:{enabled:false,head_sampling_rate:1,invocation_logs:true,persist:true},traces:{enabled:false,persist:true,head_sampling_rate:1}});
 if(runtime.limits!==undefined)defaultsMatch(runtime.limits,{});
 if(runtime.placement!==undefined)defaultsMatch(runtime.placement,{});
 for(const key of ['exports','containers','cache_options','logpush'])if(runtime[key]!==undefined&&runtime[key]!==false)fail('UNKNOWN_REMOTE_SETTINGS');
 const bindings=await read(service+'/environments/'+environment+'/bindings');
 if(!Array.isArray(bindings))fail('BINDINGS_UNVERIFIED');
 const secrets=bindings.filter(b=>b.type==='secret_text');same(secrets.map(b=>b.name).sort(),[...SECRET_NAMES].sort(),'SECRET_NAMES_MISMATCH');
 for(const secret of secrets)if(Object.keys(secret).some(k=>!['name','type'].includes(k)))fail('SECRET_METADATA_SHAPE_REJECTED');
 const objects=bindings.filter(b=>b.type==='durable_object_namespace');
 same(objects,[{name:'AUTH_STATE',type:'durable_object_namespace',class_name:'AuthState',namespace_id:NAMESPACE}],'NAMESPACE_OR_BINDING_MISMATCH');
 const other=bindings.filter(b=>!['secret_text','durable_object_namespace'].includes(b.type));
 if(other.length&&!(other.length===1&&other[0].name==='FORUM_POSTS_ENABLED'&&other[0].type==='plain_text'&&other[0].text==='false'))fail('UNKNOWN_BINDING_OR_VARS');
 same(await read(service+'/environments/'+environment+'/routes?show_zonename=true'),[],'ROUTES_MISMATCH');
 same(await read(root+'/workers/domains/records?page=0&per_page=5&service='+WORKER+'&environment='+environment),[],'DOMAINS_MISMATCH');
 same(await read(service+'/environments/'+environment+'/subdomain'),{enabled:true,previews_enabled:false},'PUBLIC_URL_SETTINGS_MISMATCH');
 same(await read(script+'/schedules'),{schedules:[]},'SCHEDULES_MISMATCH');
 const namespaces=await read(root+'/workers/durable_objects/namespaces?page=1&per_page=100');
 if(!Array.isArray(namespaces))fail('NAMESPACE_METADATA_INVALID');
 const matching=namespaces.filter(n=>n.id===NAMESPACE);if(matching.length!==1)fail('NAMESPACE_UNVERIFIED');
 const ns=matching[0];if(ns.script!==WORKER||ns.class!=='AuthState'||ns.use_sqlite!==true)fail('NAMESPACE_BACKEND_MISMATCH');
 // Recheck both ends; a different deployment/version during GETs fails closed.
 const endVersions=await read(script+'/versions'),endDeployments=await read(script+'/deployments');
 if(endVersions?.items?.[0]?.id!==VERSION||endDeployments?.deployments?.[0]?.id!==latest.id)fail('CONCURRENT_DEPLOYMENT');
 return {accountId,worker:WORKER,namespaceId:NAMESPACE,version:VERSION,deploymentId:latest.id};
}
function patchProduction(source){
 let output=candidate.patch(source);
 const replace=(oldText,newText)=>{if(output.split(oldText).length!==2)fail('PATCH_ANCHOR_MISMATCH');output=output.replace(oldText,newText);};
 replace('    nonDestructive: isNonDestructive(diff)\n  };\n}\nfunction normalizeLocalResolvedConfigAsRemote','    nonDestructive: __stage1AllowedDiff(diff)\n  };\n}\nfunction normalizeLocalResolvedConfigAsRemote');
 replace('async function preUploadApiChecks(props, config2) {','async function preUploadApiChecks(props, config2) {\n  if (!props.dryRun) await __stage1Preflight(props, config2);');
 replace('  return migrations;\n}\nasync function resolveDoLifecyclePayload','  __stage1NoMigration(migrations);\n  return migrations;\n}\nasync function resolveDoLifecyclePayload');
 replace('async () => fetchResult(\n            config2,\n            `/accounts/${accountId}/workers/scripts/${scriptName}/versions`,','async () => __stage1Upload(\n            config2,\n            `/accounts/${accountId}/workers/scripts/${scriptName}/versions`,');
 // Legacy PUT path may recreate resources; never permit that upload path.
 replace('async () => fetchResult(\n            config2,\n            workerUrl,','async () => __stage1LegacyUploadRejected(\n            config2,\n            workerUrl,');
 return output;
}
const BRIDGE=`
var __stage1AllowedDiff = () => false;
var __stage1NoMigration = () => { throw new Error('STAGE1_GUARD_NOT_INSTALLED'); };
var __stage1Preflight = async () => { throw new Error('STAGE1_GUARD_NOT_INSTALLED'); };
var __stage1Upload = async () => { throw new Error('STAGE1_GUARD_NOT_INSTALLED'); };
var __stage1ValidateMetadata = () => { throw new Error('STAGE1_GUARD_NOT_INSTALLED'); };
var __stage1OriginalForm = createWorkerUploadForm;
createWorkerUploadForm = (...args) => { const form=__stage1OriginalForm(...args);__stage1ValidateMetadata(JSON.parse(form.get('metadata')));return form; };
var __stage1LegacyUploadRejected = async () => { throw new Error('STAGE1_LEGACY_UPLOAD_FORBIDDEN'); };
exports.stage1Install = hooks => { __stage1AllowedDiff=hooks.allowedDiff;__stage1NoMigration=hooks.noMigration;__stage1Preflight=hooks.preflight;__stage1Upload=hooks.upload;__stage1ValidateMetadata=hooks.validateMetadata; };
exports.stage1Read = (config, resource) => fetchResult(config,resource,{method:'GET'},undefined,AbortSignal.timeout(10000));
exports.stage1Write = (...args) => fetchResult(...args);
exports.stage1Main = main;
`;
function cliArgs(dryRun){return ['deploy','--config',path.join(candidate.ROOT,'worker/wrangler.jsonc'),'--name',WORKER,'--strict','--keep-vars','--var','FORUM_POSTS_ENABLED:false',...(dryRun?['--dry-run','--outdir',path.join(candidate.ROOT,'worker/work/stage1-production-wrapper-dry-run')]:[])];}
function hooks(api,options){
 const check=async(config,accountId)=>{localConfig();if(accountId!==options.accountId)fail('ACCOUNT_MISMATCH');try{return await snapshot(resource=>api.stage1Read(config,resource),options.accountId);}catch(error){if(error instanceof Stage1Error)throw error;fail('PREFLIGHT_REJECTED');}};
 return {allowedDiff, noMigration:assertNoMigration,validateMetadata:assertUpload,
  preflight:async(props,config)=>{if(options.dryRun)fail('UNEXPECTED_WRITE_PATH');if(props.name!==WORKER||props.accountId!==options.accountId||!props.keepVars||!props.strict)fail('DEPLOY_OPTIONS_REJECTED');await check(config,props.accountId);},
  upload:async(config,resource,init,query)=>{if(options.dryRun||options.preflight)fail('UNEXPECTED_WRITE_PATH');if(resource!=='/accounts/'+options.accountId+'/workers/scripts/'+WORKER+'/versions'||init?.method!=='POST')fail('UPLOAD_ROUTE_REJECTED');assertUpload(JSON.parse(init.body.get('metadata')));await check(config,options.accountId);return api.stage1Write(config,resource,init,query);}
 };
}
async function run(args){
 const options=parse(args);localConfig();
 process.env.CI='true';process.env.WRANGLER_SEND_METRICS='false';process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV='false';
 if(!options.dryRun)process.env.CLOUDFLARE_ACCOUNT_ID=options.accountId;
 const {source}=candidate.original(),api=candidate.load(patchProduction(source),BRIDGE);api.stage1Install(hooks(api,options));
 if(options.preflight){await snapshot(resource=>api.stage1Read(localConfig(),resource),options.accountId);console.log('STAGE1_READ_ONLY_PREFLIGHT_PASS');return;}
 console.error(options.dryRun?'Stage 1 wrapper: offline dry-run only':'Stage 1 wrapper: guarded posts-disabled deployment');
 await api.stage1Main(cliArgs(options.dryRun));
}
module.exports={WORKER,NAMESPACE,VERSION,SECRET_NAMES,CONFIG_SHA,parse,localConfig,allowedDiff,assertNoMigration,assertUpload,snapshot,patchProduction,BRIDGE,cliArgs,hooks,run};
if(require.main===module)run(process.argv.slice(2)).catch(error=>{console.error(error instanceof Stage1Error?error.message:'STAGE1_STOPPED_NO_AUTOMATIC_RETRY');process.exitCode=1;});
