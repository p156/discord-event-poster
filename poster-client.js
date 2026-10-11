/* Fixed Worker transport. No Discord/Webhook transport or automatic POST retry. */
(function(){
  'use strict';
  const API='https://discord-event-poster-api.monma5435.workers.dev';
  const SESSION='discord-event-poster.session.oauth2',OPERATIONS='discord-event-poster.operations.v1';
  const SESSION_TOKEN=/^oauth2\.[a-f0-9]{64}\.\d{13}\.[a-f0-9]{64}$/;
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
    try{sessionStorage.removeItem('discord-event-poster.session');const s=JSON.parse(sessionStorage.getItem(SESSION)||'null');if(s&&typeof s.token==='string'&&SESSION_TOKEN.test(s.token)&&Number.isSafeInteger(s.expiresAt)&&Number(s.token.split('.')[2])===s.expiresAt)session=s;}catch{}
    try{const saved=JSON.parse(sessionStorage.getItem(OPERATIONS)||'[]');if(!Array.isArray(saved)||saved.length>200||saved.some(m=>!validMeta(m))||new Set(saved.map(m=>m.operationId)).size!==saved.length)throw fail('STORAGE_INVALID');operations=saved.filter(m=>Date.parse(m.expiresAt)>Date.now());if(operations.length!==saved.length)save();}catch{storageError=true;}
    function forgetSession(){session=null;try{sessionStorage.removeItem(SESSION);}catch{}}
    function save(){const text=JSON.stringify(operations);try{sessionStorage.setItem(OPERATIONS,text);if(sessionStorage.getItem(OPERATIONS)!==text)throw fail('STORAGE_UNAVAILABLE');storageError=false;}catch{storageError=true;throw fail('STORAGE_UNAVAILABLE');}}
    function remember(meta){if(!validMeta(meta))throw fail('RESPONSE_INVALID');const clean={operationId:meta.operationId,idempotencyKey:meta.idempotencyKey,payloadHash:meta.payloadHash,issuedAt:meta.issuedAt,expiresAt:meta.expiresAt,status:meta.status};const i=operations.findIndex(x=>x.operationId===clean.operationId);if(i<0){if(operations.length>=200)throw fail('STORAGE_FULL');operations.push(clean);}else operations[i]=clean;save();return clean;}
    async function api(path,method='GET',body,key){
      if(path!=='/api/oauth/complete'&&(!session||session.expiresAt<=Date.now())){forgetSession();throw fail('SESSION_REQUIRED');}
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
      async login(){
        forgetSession();
        const name='poster_oauth_'+Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');
        const popup=window.open('about:blank',name,'popup,width=520,height=720');
        if(!popup)throw fail('LOGIN_FAILED');
        let verifier=Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join(''),cleanup;
        try{
          const challenge=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))),x=>x.toString(16).padStart(2,'0')).join('');
          const handoff=await new Promise((resolve,reject)=>{
            const listener=e=>{
              if(e.origin!==API||e.source!==popup||!e.data||e.data.type!=='discord-event-poster.oauth2')return;
              if(e.data.error){reject(fail('LOGIN_FAILED'));return;}
              if(typeof e.data.state!=='string'||typeof e.data.handoff!=='string'||!/^[a-f0-9]{64}$/.test(e.data.state)||!/^[a-f0-9]{64}$/.test(e.data.handoff))return;
              resolve(e.data.handoff);
            };
            const deadline=setTimeout(()=>reject(fail('LOGIN_FAILED')),300000);
            const closed=setInterval(()=>{if(popup.closed)reject(fail('LOGIN_FAILED'));},500);
            cleanup=()=>{window.removeEventListener('message',listener);clearTimeout(deadline);clearInterval(closed);};
            window.addEventListener('message',listener);
            const form=document.createElement('form'),input=document.createElement('input');
            form.method='POST';form.action=API+'/api/oauth/start';form.target=name;form.hidden=true;
            input.type='hidden';input.name='challenge';input.value=challenge;form.appendChild(input);document.body.appendChild(form);
            try{form.submit();}catch{reject(fail('LOGIN_FAILED'));}finally{form.remove();}
          });
          cleanup?.();
          const r=await api('/api/oauth/complete','POST',{handoff,verifier});
          if(!r.ok||typeof r.data.token!=='string'||!SESSION_TOKEN.test(r.data.token)||!Number.isSafeInteger(r.data.expiresAt)||Number(r.data.token.split('.')[2])!==r.data.expiresAt||r.data.expiresAt<=Date.now()||r.data.expiresAt>Date.now()+3600000)throw fail('LOGIN_FAILED');
          session={token:r.data.token,expiresAt:r.data.expiresAt};
          try{const saved=JSON.stringify(session);sessionStorage.setItem(SESSION,saved);if(sessionStorage.getItem(SESSION)!==saved)throw fail('STORAGE_UNAVAILABLE');}catch{forgetSession();throw fail('STORAGE_UNAVAILABLE');}
          return true;
        }finally{verifier='';cleanup?.();popup.close();}
      },
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
