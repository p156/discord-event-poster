'use strict';
// Bootstrap only. Credentials and unprojected API objects never leave memory.
const gate=require('./oauth2-release-gate.cjs');
const stop=()=>{throw new Error('OWNER_EVIDENCE_STOPPED');};
async function collect(account,token,fetcher=globalThis.fetch){
 const read=gate.reader(account,token,fetcher),p=gate.resources(account);
 const versions=await read(p.versions),deployments=await read(p.deployments);
 const environment=await read(p.environment),bindings=await read(p.bindings);
 if(!Array.isArray(bindings))stop();
 const ds=bindings.filter(b=>b.type==='durable_object_namespace');
 const modes=bindings.filter(b=>b.name==='FORUM_POSTS_ENABLED');
 if(ds.length!==1||modes.length>1)stop();
 const deployment=deployments?.deployments?.[0];
 if(deployment?.versions?.length!==1||deployment.versions[0].percentage!==100)stop();
 const e={schema:1,accountSha256:gate.sha(account),worker:gate.WORKER,
  namespaceId:ds[0].namespace_id,activeVersion:deployment.versions[0].version_id,
  latestVersion:versions?.items?.[0]?.id,deploymentId:deployment.id,
  mode:modes.length?modes[0].text:'absent',
  secretNames:bindings.filter(b=>b.type==='secret_text').map(b=>b.name).sort(),
  settings:gate.settingView(environment?.script)};
 gate.expectations(e,{inspection:true});
 // Names from an unexpected binding must not be echoed, even if syntactically valid.
 if(e.secretNames.some(n=>![...gate.REQUIRED,'APP_PASSWORD_HASH'].includes(n)))stop();
 const inspected=await gate.inspect(read,account,e);
 const numeric={};
 if(e.settings.limits!==undefined){
  const limits=e.settings.limits;
  if(!limits||typeof limits!=='object'||Array.isArray(limits)||Object.keys(limits).some(k=>!['cpu_ms','subrequests'].includes(k)))stop();
  for(const [k,v] of Object.entries(limits)){if(!Number.isSafeInteger(v)||v<1)stop();numeric[k]=v;}
 }
 return {schema:1,status:'PASS',scope:'metadata-inspection-only',worker:gate.WORKER,
  accountSha256:e.accountSha256,activeVersion:e.activeVersion,latestVersion:e.latestVersion,
  deploymentId:e.deploymentId,namespaceId:e.namespaceId,mode:e.mode,secretNames:e.secretNames,
  remoteFingerprint:inspected.fingerprint,configuredLimits:numeric,
  effectiveLimits:'NOT VERIFIED',allModuleHashes:'NOT VERIFIED',
  botForum:'NOT VERIFIED',secretValueIdentity:'NOT VERIFIED',
  callbackObservationProtection:'NOT VERIFIED',stopCandidateS:'NOT VERIFIED',
  cloudWrites:0,releaseEligible:false,productionGo:false};
}
async function input(stream){
 let size=0;const chunks=[];
 for await(const chunk of stream){size+=chunk.length;if(size>8192)stop();chunks.push(chunk);}
 const bytes=Buffer.concat(chunks);let value;
 try{value=JSON.parse(bytes.toString('utf8'));}finally{bytes.fill(0);for(const c of chunks)c.fill(0);}
 if(!value||Object.keys(value).sort().join()!=='account,token')stop();
 return value;
}
const SAFE_CODES=new Set(['CREDENTIALS_UNAVAILABLE','AUTHORIZATION_REJECTED','REDIRECT_REJECTED','HTTP_REJECTED','NETWORK_OR_TIMEOUT','RESPONSE_INVALID','RESPONSE_TOO_LARGE','API_RESULT_REJECTED']);
async function run(stream,fetcher=globalThis.fetch,args=process.argv){
 let phase='INPUT',attempted=false;
 try {
 if(args.length!==2||stream.isTTY)stop();
 let credentials;
 try{credentials=await input(stream);phase='COLLECT';return {result:await collect(credentials.account,credentials.token,(...a)=>{attempted=true;return fetcher(...a);})};}
 finally{if(credentials){credentials.account=null;credentials.token=null;}}
 } catch(error) {
 const code=error instanceof gate.GateError&&SAFE_CODES.has(error.message.slice('OAUTH_GATE_'.length))?error.message.slice('OAUTH_GATE_'.length):'VALIDATION_OR_INTERNAL';
 return {diagnostic:`OWNER_EVIDENCE_STOPPED phase=${phase} apiAttempted=${attempted?'YES':'NO'} code=${code}`};
 }
}
module.exports={collect,input,run};
if(require.main===module)run(process.stdin).then(({result,diagnostic})=>{
 if(diagnostic){console.error(diagnostic);process.exitCode=1;}else console.log(JSON.stringify(result));
});
