/* Fixed Worker transport. No Discord/Webhook transport or automatic POST retry. */
(function(){
  'use strict';
  const API='https://discord-event-poster-api.monma5435.workers.dev';
  const SESSION='discord-event-poster.session',OPERATIONS='discord-event-poster.operations.v1';
  const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  const states=['not_started','preparing','sending','succeeded','retryable','failed','unknown','expired','unconfirmed'];
  const snowflake=s=>typeof s==='string'&&/^[1-9]\d{0,19}$/.test(s)&&BigInt(s)<=18446744073709551615n;
  const fail=code=>Object.assign(new Error(code),{code});
  function normalize(raw){
    const p={apiVersion:1,threadName:raw.threadName.replace(/\r\n?/g,'\n').trim(),content:raw.content.replace(/\r\n?/g,'\n'),tagIds:[...(raw.tagIds||[])].sort()};
    const paired=s=>{for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const n=s.charCodeAt(++i);if(!(n>=0xdc00&&n<=0xdfff))return false;}else if(c>=0xdc00&&c<=0xdfff)return false;}return true;};
    if(!p.threadName||p.threadName.length>100||/[\x00-\x1f\x7f]/.test(raw.threadName)||!paired(p.threadName))throw fail('CONTENT_INVALID');
    if(!p.content.trim()||p.content.length>2000||/[\x00-\x08\x0b-\x1f\x7f]/.test(p.content)||!paired(p.content))throw fail('CONTENT_INVALID');
    if(p.tagIds.length>5||p.tagIds.some(id=>!snowflake(id))||new Set(p.tagIds).size!==p.tagIds.length)throw fail('TAG_INVALID');
    if(new TextEncoder().encode(JSON.stringify(p)).length>16384)throw fail('BODY_TOO_LARGE');return p;
  }
  async function hash(raw){const p=normalize(raw);return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([1,p.threadName,p.content,p.tagIds])))),x=>x.toString(16).padStart(2,'0')).join('');}
  function validMeta(m){return m&&typeof m.operationId==='string'&&UUID.test(m.operationId)&&typeof m.idempotencyKey==='string'&&m.idempotencyKey.length<=1024&&/^v1\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(m.idempotencyKey)&&typeof m.payloadHash==='string'&&/^[a-f0-9]{64}$/.test(m.payloadHash)&&typeof m.issuedAt==='string'&&typeof m.expiresAt==='string'&&Number.isFinite(Date.parse(m.issuedAt))&&Date.parse(m.expiresAt)-Date.parse(m.issuedAt)===2592000000&&states.includes(m.status);}
  function create(){
    let session=null,operations=[],storageError=false;
    try{const s=JSON.parse(sessionStorage.getItem(SESSION)||'null');if(s&&typeof s.token==='string'&&/^[a-f0-9.]{1,160}$/.test(s.token)&&Number.isSafeInteger(s.expiresAt))session=s;}catch{}
    try{const saved=JSON.parse(sessionStorage.getItem(OPERATIONS)||'[]');if(!Array.isArray(saved)||saved.length>200||saved.some(m=>!validMeta(m))||new Set(saved.map(m=>m.operationId)).size!==saved.length)throw fail('STORAGE_INVALID');operations=saved.filter(m=>Date.parse(m.expiresAt)>Date.now());if(operations.length!==saved.length)save();}catch{storageError=true;}
    function forgetSession(){session=null;try{sessionStorage.removeItem(SESSION);}catch{}}
    function save(){const text=JSON.stringify(operations);try{sessionStorage.setItem(OPERATIONS,text);if(sessionStorage.getItem(OPERATIONS)!==text)throw fail('STORAGE_UNAVAILABLE');storageError=false;}catch{storageError=true;throw fail('STORAGE_UNAVAILABLE');}}
    function remember(meta){if(!validMeta(meta))throw fail('RESPONSE_INVALID');const clean={operationId:meta.operationId,idempotencyKey:meta.idempotencyKey,payloadHash:meta.payloadHash,issuedAt:meta.issuedAt,expiresAt:meta.expiresAt,status:meta.status};const i=operations.findIndex(x=>x.operationId===clean.operationId);if(i<0){if(operations.length>=200)throw fail('STORAGE_FULL');operations.push(clean);}else operations[i]=clean;save();return clean;}
    async function api(path,method='GET',body,key){
      if(path!=='/api/login'&&(!session||session.expiresAt<=Date.now())){forgetSession();throw fail('SESSION_REQUIRED');}
      const controller=new AbortController();let timer;
      try{
        const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('NETWORK_UNKNOWN'));},15000);});
        const task=(async()=>{const r=await fetch(API+path,{method,credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal,headers:{'Content-Type':'application/json',...(session?{Authorization:'Bearer '+session.token}:{}),...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});if(r.status===401){forgetSession();throw fail('SESSION_EXPIRED');}let data;try{data=await r.json();}catch{throw fail('RESPONSE_INVALID');}const h=Number(r.headers.get('Retry-After'));return {data,status:r.status,ok:r.ok,retryAfterSeconds:Number.isFinite(h)&&h>0?h:null};})();
        return await Promise.race([task,timeout]);
      }catch(e){throw fail(['SESSION_REQUIRED','SESSION_EXPIRED','RESPONSE_INVALID','NETWORK_UNKNOWN'].includes(e.code)?e.code:'NETWORK_UNKNOWN');}finally{clearTimeout(timer);controller.abort();}
    }
    return {
      operations:()=>operations.map(m=>({...m})),storageReady:()=>!storageError&&operations.length<200,
      remember,save,normalize,hash,
      async login(password){forgetSession();const r=await api('/api/login','POST',{password});if(!r.ok||typeof r.data.token!=='string'||!Number.isSafeInteger(r.data.expiresAt))throw fail('LOGIN_FAILED');session=r.data;try{sessionStorage.setItem(SESSION,JSON.stringify(session));}catch{forgetSession();throw fail('STORAGE_UNAVAILABLE');}return true;},
      async logout(){const r=await api('/api/logout','POST');if(!r.ok)throw fail('LOGOUT_FAILED');forgetSession();},
      async session(){const r=await api('/api/session');if(!r.ok||r.data.authenticated!==true)throw fail('SESSION_REQUIRED');return r.data;},
      tags:()=>api('/api/forum/tags'),
      async issue(p){if(!this.storageReady())throw fail('STORAGE_UNAVAILABLE');const expected=await hash(p),r=await api('/api/forum/post-intents','POST',normalize(p));if(!r.ok)throw fail(r.data.error?.code==='STATE_UNAVAILABLE'?'STATE_UNAVAILABLE':r.status===404?'POSTS_DISABLED':'INPUT_REJECTED');const m={...r.data,status:'not_started'};if(r.data.apiVersion!==1||r.data.status!=='not_started'||!validMeta(m)||m.payloadHash!==expected)throw fail('RESPONSE_INVALID');return remember(m);},
      async post(meta,p){if(await hash(p)!==meta.payloadHash)throw fail('KEY_PAYLOAD_CONFLICT');remember({...meta,status:'unconfirmed'});return api('/api/forum/posts','POST',normalize(p),meta.idempotencyKey);},
      status(meta){if(!validMeta(meta))throw fail('RESPONSE_INVALID');return api('/api/forum/posts/'+meta.operationId,'GET',null,meta.idempotencyKey);}
    };
  }
  window.PosterClient={create,normalize,hash,snowflake,UUID};
}());
