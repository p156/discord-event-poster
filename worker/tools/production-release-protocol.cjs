'use strict';
// Offline protocol only: no default network transport, CLI, credential discovery or live executor.
const fs=require('node:fs'),gate=require('./oauth2-release-gate.cjs');
const stop=code=>{throw new Error('PRODUCTION_RELEASE_'+code);};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function oauthBindings(values){
 const names=gate.REQUIRED.slice(4);
 if(!values||Object.keys(values).length!==5||Object.keys(values).some(n=>!names.includes(n)))stop('SECRET_SET');
 for(const n of names)if(typeof values[n]!=='string'||!values[n]||/[\x00-\x20\x7f]/.test(values[n]))stop('SECRET_INPUT');
 if(values.AUTH_SESSION_SIGNING_KEY.length<64||!/^\d{1,20}$/.test(values.DISCORD_ALLOWED_USER_ID)||!/^\d{1,20}$/.test(values.DISCORD_OAUTH_CLIENT_ID)||values.DISCORD_OAUTH_CLIENT_SECRET.length<16||values.DISCORD_OAUTH_REDIRECT_URI!=='https://discord-event-poster-api.monma5435.workers.dev/api/oauth/callback')stop('SECRET_INPUT');
 return names.map(name=>({name,type:'secret_text',text:values[name]}));
}
function verifyCandidate(expected,actual){
 // Only reviewed, complete readback is accepted; no tag/message/short-ID substitutions.
 const keys=['versionId','bundleSha256','settings','secretNames','namespaceId','className','sqlite','migrationTag','mode'];
 if(!expected||!actual||Object.keys(expected).sort().join()!==keys.sort().join()||Object.keys(actual).sort().join()!==keys.sort().join())stop('READBACK_INCOMPLETE');
 if(!UUID.test(expected.versionId)||!/^[a-f0-9]{64}$/.test(expected.bundleSha256)||!/^[a-f0-9]{32}$/.test(expected.namespaceId)||expected.className!=='AuthState'||expected.sqlite!==true||expected.migrationTag!=='auth-v1'||!['read-only','true'].includes(expected.mode)||!expected.settings||typeof expected.settings!=='object'||!Array.isArray(expected.secretNames)||!gate.REQUIRED.every(n=>expected.secretNames.includes(n))||!expected.secretNames.includes('APP_PASSWORD_HASH'))stop('READBACK_INCOMPLETE');
 gate.equal(actual,expected,'CANDIDATE_READBACK_CHANGED');return {verified:true,productionGo:false};
}
function switchPayload(versionId){if(!UUID.test(versionId))stop('VERSION_INCOMPLETE');return {strategy:'percentage',versions:[{version_id:versionId,percentage:100}]};}
async function singleAttempt({journal,operationSha256,send,timeoutMs=10000}){
 if(!/^[a-f0-9]{64}$/.test(operationSha256)||typeof send!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)stop('ATTEMPT_INVALID');
 // Exclusive durable reservation BEFORE any send. A crash or unknown outcome consumes the attempt.
 let fd;try{fd=fs.openSync(journal,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({operationSha256,status:'unknown',automaticRetry:false})+'\n');fs.fsyncSync(fd);}catch{stop('ATTEMPT_ALREADY_RESERVED_OR_UNWRITABLE');}finally{if(fd!==undefined)fs.closeSync(fd);}
 const controller=new AbortController();let timer;
 try{await Promise.race([Promise.resolve().then(()=>send(controller.signal)),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error());},timeoutMs);})]);}catch{stop('OUTCOME_UNKNOWN_NO_RETRY');}finally{clearTimeout(timer);controller.abort();}
 // Deliberately keep unknown until an independently reviewed readback confirms success.
 return {status:'READBACK_REQUIRED',automaticRetry:false,productionGo:false};
}
module.exports={oauthBindings,verifyCandidate,switchPayload,singleAttempt};
