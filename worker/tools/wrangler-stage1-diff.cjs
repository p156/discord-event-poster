'use strict';
const path=require('node:path');
const candidate=require('./wrangler-strict-candidate.cjs'),stage=require('./wrangler-stage1-deploy.cjs');
class DiagnosticError extends Error {constructor(phase,reason){super('STAGE1_DIFF_FAIL_CLOSED');this.phase=phase;this.reason=reason;}}
const stop=(reason='REJECTED',phase='validation')=>{throw new DiagnosticError(phase,reason);};
function failure(error,phase){return {status:'FAIL',phase:error instanceof DiagnosticError?error.phase:phase,reason:error instanceof DiagnosticError?error.reason:'STAGE_FAILED',...(error instanceof DiagnosticError&&error.endpoint?{endpoint:error.endpoint}:{}),...(error instanceof DiagnosticError&&[401,403].includes(error.httpStatus)?{httpStatus:error.httpStatus}:{})};}
function authState(credentials,envAuth,cache,now=Date.now()){
 let authMethod='UNKNOWN',oauthExpiry='UNKNOWN';
 if(envAuth&&typeof envAuth.authKey==='string'&&typeof envAuth.authEmail==='string')authMethod='GLOBAL_KEY';
 else if(envAuth&&typeof envAuth.apiToken==='string'&&envAuth.apiToken&&credentials?.apiToken===envAuth.apiToken)authMethod='API_TOKEN';
 else if(cache&&typeof cache.oauth_token==='string'&&cache.oauth_token&&credentials?.apiToken===cache.oauth_token){authMethod='OAUTH_CACHE';const time=typeof cache.expiration_time==='string'?Date.parse(cache.expiration_time):NaN;if(Number.isFinite(time))oauthExpiry=now>=time?'EXPIRED':'VALID';}
 else if(cache&&typeof cache.api_token==='string'&&cache.api_token&&credentials?.apiToken===cache.api_token)authMethod='API_TOKEN';
 return {authMethod,oauthExpiry};
}
function parse(args){if(args.length!==2||args[0]!=='--account-id'||!/^[a-f0-9]{32}$/.test(args[1]))stop();return args[1];}
function describe(diff){
 if(diff===null)return {status:'PASS',classification:'NO_DIFF',entries:[]};
 if(!diff||typeof diff!=='object'||Array.isArray(diff))stop();
 const keys=Object.keys(diff).filter(k=>k!=='toString');
 const entries=keys.map(key=>{if(!/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(key))stop();const v=diff[key];return {key,present:Object.hasOwn(diff,key),type:v===null?'null':Array.isArray(v)?'array':typeof v};});
 const only=keys.length===1&&keys[0]==='assets__added'&&Object.hasOwn(diff,'assets__added')&&diff.assets__added===undefined;
 return {status:only?'PASS':'FAIL',classification:only?'ONLY_UNDEFINED_ASSETS':'OTHER_DIFF',entries};
}
function reader(accountId,auth,fetcher){
 const root='/accounts/'+accountId,service=root+'/workers/services/'+stage.WORKER,script=root+'/workers/scripts/'+stage.WORKER;
 const permitted=new Set([root,service,script+'/versions',script+'/deployments',script+'/schedules',root+'/workers/durable_objects/namespaces?page=1&per_page=100',service+'/environments/production',service+'/environments/production/bindings',service+'/environments/production/routes?show_zonename=true',service+'/environments/production/subdomain',root+'/workers/domains/records?page=0&per_page=5&service='+stage.WORKER+'&environment=production']);
 const labels=['ACCOUNT','SERVICE','VERSIONS','DEPLOYMENTS','SCHEDULES','DO_NAMESPACES','ENVIRONMENT','BINDINGS','ROUTES','SUBDOMAIN','DOMAINS'];const endpoints=new Map([...permitted].map((p,i)=>[p,labels[i]]));
 return async(resource,init={})=>{
  try{
  if(!permitted.has(resource)||(init.method!==undefined&&init.method!=='GET')||init.body!==undefined)stop('READ_ONLY_GUARD','transport');
  if(!auth||typeof auth.apiToken!=='string'||!auth.apiToken)stop('CREDENTIALS_UNAVAILABLE','authentication');
  let res;try{res=await fetcher('https://api.cloudflare.com/client/v4'+resource,{method:'GET',redirect:'manual',headers:{Authorization:'Bearer '+auth.apiToken},signal:AbortSignal.timeout(10000)});}catch{stop('NETWORK_OR_TIMEOUT','transport');}
  if(!res.ok){const error=new DiagnosticError('transport',res.status===401||res.status===403?'AUTHORIZATION_REJECTED':res.status>=300&&res.status<400?'REDIRECT_REJECTED':'HTTP_REJECTED');if([401,403].includes(res.status))error.httpStatus=res.status;throw error;}
  let json;try{json=await res.json();}catch{stop('INVALID_JSON','response');}if(!json||json.success!==true||!Object.hasOwn(json,'result'))stop('API_RESULT_REJECTED','response');return json.result;
  }catch(error){if(error instanceof DiagnosticError)error.endpoint=endpoints.get(resource)||'UNKNOWN';throw error;}
 };
}
function engine(read){
 const {source}=candidate.original();
 // No deploy main is invoked. Replace all Wrangler API reads with the guarded
 // GET transport: no OAuth refresh, API retry, response logging, or upload.
 const api=candidate.load(stage.patchProduction(source),stage.BRIDGE+`
 init_config_diffs();init_download_worker_config();init_user3();
 exports.diffReadConfig=readConfig;
 exports.diffCredentials=getAPIToken2;
 exports.diffEnvAuth=getAuthFromEnv2;
 exports.diffCache=()=>auth.readAuthCredentials();
 exports.diffInstall=read=>{fetchResult=async(_config,resource,init={},query)=>{if(query)throw new Error('DIFF_QUERY_REJECTED');return read(resource,init);};};
 exports.diffRemote=downloadWorkerConfig;
 exports.diffCompare=getRemoteConfigDiff;
 `);
 api.stage1Install(stage.hooks({}, {dryRun:true}));if(read)api.diffInstall(read);return api;
}
async function diagnose(accountId,api,read){
 let phase='preflight';try{
 stage.localConfig();await stage.snapshot(read,accountId);
 phase='local_config';
 const local=api.diffReadConfig({config:path.join(candidate.ROOT,'worker/wrangler.jsonc'),name:stage.WORKER,strict:true,keepVars:true,var:['FORUM_POSTS_ENABLED:false']});
 phase='remote_config';
 const remote=await api.diffRemote(stage.WORKER,'production',path.join(candidate.ROOT,'worker/src/index.mjs'),accountId);
 phase='comparison';
 const result=describe(api.diffCompare(remote,{...local,routes:[]}).diff);
 phase='final_preflight';
 await stage.snapshot(read,accountId);return result;
 }catch(error){if(error instanceof DiagnosticError)throw error;throw new DiagnosticError(phase,'STAGE_FAILED');}
}
async function run(args){
 process.env.CI='true';process.env.WRANGLER_SEND_METRICS='false';process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV='false';
 // Suppress every Wrangler logger/credential warning, not just debug output.
 const out=console.log,err=console.error,saved={...console};for(const k of ['log','error','warn','info','debug'])console[k]=()=>{};
 let phase='arguments',authInfo={authMethod:'UNKNOWN',oauthExpiry:'UNKNOWN'};
 try{const accountId=parse(args);phase='local_config_guard';stage.localConfig();phase='wrangler_engine';const api=engine();phase='authentication';const auth=api.diffCredentials(),envAuth=api.diffEnvAuth();authInfo=authState(auth,envAuth,envAuth?undefined:api.diffCache());if(authInfo.authMethod==='UNKNOWN')stop('AUTH_STATE_UNKNOWN','authentication');if(authInfo.authMethod==='GLOBAL_KEY')stop('GLOBAL_KEY_UNSUPPORTED','authentication');if(authInfo.authMethod==='OAUTH_CACHE'&&authInfo.oauthExpiry!=='VALID')stop(authInfo.oauthExpiry==='EXPIRED'?'OAUTH_EXPIRED':'OAUTH_EXPIRY_UNKNOWN','authentication');if(!auth||typeof auth.apiToken!=='string'||!auth.apiToken)stop('CREDENTIALS_UNAVAILABLE','authentication');const read=reader(accountId,auth,globalThis.fetch);api.diffInstall(read);phase='diagnosis';const result=await diagnose(accountId,api,read);out(JSON.stringify({...result,...authInfo}));if(result.status!=='PASS')process.exitCode=1;}
 catch(error){err('STAGE1_DIFF_FAIL_CLOSED');err(JSON.stringify({...failure(error,phase),...authInfo}));process.exitCode=1;}
 finally{for(const k of ['log','error','warn','info','debug'])console[k]=saved[k];}
}
module.exports={parse,describe,reader,engine,diagnose,run,failure,authState};
if(require.main===module)run(process.argv.slice(2)).catch(()=>{console.error('STAGE1_DIFF_FAIL_CLOSED');process.exitCode=1;});
