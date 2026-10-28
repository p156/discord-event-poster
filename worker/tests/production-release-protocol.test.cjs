const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const p=require('../tools/production-release-protocol.cjs'),g=require('../tools/oauth2-release-gate.cjs');
test('single attempt reserves durably before sending and never retries unknown outcome',async()=>{
 const journal=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'poster-attempt-')),'attempt.json');let calls=0;
 const options={journal,operationSha256:'a'.repeat(64),send:async()=>{calls++;assert.equal(JSON.parse(fs.readFileSync(journal)).status,'unknown');throw Error('PRIVATE_RESPONSE');}};
 await assert.rejects(()=>p.singleAttempt(options),/OUTCOME_UNKNOWN_NO_RETRY/);await assert.rejects(()=>p.singleAttempt(options),/ATTEMPT_ALREADY/);assert.equal(calls,1);assert.ok(!fs.readFileSync(journal,'utf8').includes('PRIVATE'));
});
test('successful send still requires independent readback and forbids another send',async()=>{
 const journal=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'poster-attempt-')),'attempt.json');let calls=0;const options={journal,operationSha256:'b'.repeat(64),send:async()=>{calls++;}};assert.equal((await p.singleAttempt(options)).status,'READBACK_REQUIRED');await assert.rejects(()=>p.singleAttempt(options));assert.equal(calls,1);
});
test('candidate readback binds full version, code, secrets, DO, settings and mode',()=>{
 const e={versionId:'11111111-1111-4111-8111-111111111111',bundleSha256:'a'.repeat(64),namespaceId:'b'.repeat(32),className:'AuthState',sqlite:true,migrationTag:'auth-v1',mode:'read-only',settings:{observability:{enabled:false}},secretNames:[...g.REQUIRED,'APP_PASSWORD_HASH']};assert.equal(p.verifyCandidate(e,e).productionGo,false);
 for(const key of Object.keys(e)){const a=structuredClone(e);delete a[key];assert.throws(()=>p.verifyCandidate(e,a));}for(const [key,value]of [['mode','true'],['bundleSha256','c'.repeat(64)],['sqlite',false],['versionId','11111111']])assert.throws(()=>p.verifyCandidate(e,{...e,[key]:value}));
 assert.equal(p.switchPayload(e.versionId).versions[0].percentage,100);assert.throws(()=>p.switchPayload('11111111'));
});
test('OAuth input accepts only new five names and exact callback, never replacement of old keys',()=>{
 const v={AUTH_SESSION_SIGNING_KEY:'a'.repeat(64),DISCORD_ALLOWED_USER_ID:'123',DISCORD_OAUTH_CLIENT_ID:'456',DISCORD_OAUTH_CLIENT_SECRET:'DUMMY_ONLY_SECRET_VALUE',DISCORD_OAUTH_REDIRECT_URI:'https://discord-event-poster-api.monma5435.workers.dev/api/oauth/callback'};assert.equal(p.oauthBindings(v).length,5);for(const a of [{...v,SESSION_SIGNING_KEY:'x'},{...v,AUTH_SESSION_SIGNING_KEY:'short'},{...v,DISCORD_OAUTH_REDIRECT_URI:'https://evil.test'}])assert.throws(()=>p.oauthBindings(a));
});
test('timeout aborts once, keeps durable unknown and cannot resend',async()=>{
 const journal=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'poster-attempt-')),'attempt.json');let calls=0,signal;const o={journal,operationSha256:'c'.repeat(64),timeoutMs:5,send:s=>{calls++;signal=s;return new Promise(()=>{});}};await assert.rejects(()=>p.singleAttempt(o),/OUTCOME_UNKNOWN/);assert.equal(signal.aborted,true);await assert.rejects(()=>p.singleAttempt(o));assert.equal(calls,1);
});
test('trial requires independently verified recovery with identical code, DO, secrets and settings',()=>{
 const r={versionId:'11111111-1111-4111-8111-111111111111',bundleSha256:'a'.repeat(64),namespaceId:'b'.repeat(32),className:'AuthState',sqlite:true,migrationTag:'auth-v1',mode:'read-only',settings:{observability:{enabled:false},limits:{cpu_ms:50}},secretNames:[...g.REQUIRED,'APP_PASSWORD_HASH']};
 const t={...structuredClone(r),versionId:'22222222-2222-4222-8222-222222222222',mode:'true'};
 assert.equal(p.verifyRecoveryPair(r,r,t,t).productionGo,false);
 for(const patch of [{bundleSha256:'c'.repeat(64)},{namespaceId:'c'.repeat(32)},{settings:{observability:{enabled:false},limits:{cpu_ms:51}}},{secretNames:[...g.REQUIRED,'APP_PASSWORD_HASH','EXTRA']}]){
  const changed={...structuredClone(t),...patch};assert.throws(()=>p.verifyRecoveryPair(r,r,changed,changed),/RECOVERY_PAIR_CHANGED/);
 }
 assert.throws(()=>p.verifyRecoveryPair(r,r,t,{...t,bundleSha256:'d'.repeat(64)}),/CANDIDATE_READBACK_CHANGED/);
 assert.throws(()=>p.verifyRecoveryPair(r,r,r,r),/RECOVERY_PAIR_INVALID/);
 assert.throws(()=>p.verifyRecoveryPair(t,t,r,r),/RECOVERY_PAIR_INVALID/);
 const sameId={...t,versionId:r.versionId};assert.throws(()=>p.verifyRecoveryPair(r,r,sameId,sameId),/RECOVERY_PAIR_INVALID/);
});
