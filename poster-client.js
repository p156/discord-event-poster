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
  function normalizeOfficialUrl(raw){
    if(typeof raw!=='string'||raw.length>2048||/[\x00-\x20\x7f\\]/.test(raw))return null;
    if(!raw)return '';
    let value=raw;
    if(!/^https?:\/\//i.test(value)){
      // Only a DNS name with an alphabetic TLD may omit the scheme.
      if(!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:[/?#]|$)/i.test(value))return null;
      value='https://'+value;
    }
    if(value.length>2048)return null;
    try{const u=new URL(value);if(!/^https?:$/.test(u.protocol)||!u.hostname||u.username||u.password)return null;return value;}catch{return null;}
  }
  function normalize(raw){
    const p={apiVersion:raw.apiVersion===2?2:1,threadName:raw.threadName.replace(/\r\n?/g,'\n').trim(),content:raw.content.replace(/\r\n?/g,'\n'),tagIds:[...(raw.tagIds||[])].sort()};
    const paired=s=>{for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const n=s.charCodeAt(++i);if(!(n>=0xdc00&&n<=0xdfff))return false;}else if(c>=0xdc00&&c<=0xdfff)return false;}return true;};
    if(!p.threadName||p.threadName.length>100||/[\x00-\x1f\x7f]/.test(raw.threadName)||!paired(p.threadName))throw fail('CONTENT_INVALID');
    if(!p.content.trim()||p.content.length>2000||/[\x00-\x08\x0b-\x1f\x7f]/.test(p.content)||!paired(p.content))throw fail('CONTENT_INVALID');
    if(p.tagIds.length>5||p.tagIds.some(id=>!snowflake(id))||new Set(p.tagIds).size!==p.tagIds.length)throw fail('TAG_INVALID');
    if(p.apiVersion===2){if(typeof raw.officialUrl!=='string'||raw.officialUrl.length>2048||/[\x00-\x20\x7f]/.test(raw.officialUrl)||raw.imageUrl!==null&&(typeof raw.imageUrl!=='string'||raw.imageUrl.length>2048))throw fail('CONTENT_INVALID');p.officialUrl=normalizeOfficialUrl(raw.officialUrl);if(p.officialUrl===null)throw fail('CONTENT_INVALID');p.imageUrl=raw.imageUrl;}
    if(new TextEncoder().encode(JSON.stringify(p)).length>16384)throw fail('BODY_TOO_LARGE');return p;
  }
  async function hash(raw){const p=normalize(raw);return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(p.apiVersion===1?[1,p.threadName,p.content,p.tagIds]:[2,p.threadName,p.content,p.tagIds,p.officialUrl,p.imageUrl])))),x=>x.toString(16).padStart(2,'0')).join('');}
  function validMeta(m){return m&&typeof m.operationId==='string'&&UUID.test(m.operationId)&&typeof m.idempotencyKey==='string'&&m.idempotencyKey.length<=1024&&/^v1\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(m.idempotencyKey)&&typeof m.payloadHash==='string'&&/^[a-f0-9]{64}$/.test(m.payloadHash)&&typeof m.issuedAt==='string'&&typeof m.expiresAt==='string'&&Number.isFinite(Date.parse(m.issuedAt))&&Date.parse(m.expiresAt)-Date.parse(m.issuedAt)===2592000000&&states.includes(m.status)&&(m.basePayloadHash===undefined||/^[a-f0-9]{64}$/.test(m.basePayloadHash));}
  function create(){
    let session=null,operations=[],storageError=false;
    try{sessionStorage.removeItem('discord-event-poster.session');const s=JSON.parse(sessionStorage.getItem(SESSION)||'null');if(s&&typeof s.token==='string'&&SESSION_TOKEN.test(s.token)&&Number.isSafeInteger(s.expiresAt)&&Number(s.token.split('.')[2])===s.expiresAt)session=s;}catch{}
    try{const saved=JSON.parse(sessionStorage.getItem(OPERATIONS)||'[]');if(!Array.isArray(saved)||saved.length>200||saved.some(m=>!validMeta(m))||new Set(saved.map(m=>m.operationId)).size!==saved.length)throw fail('STORAGE_INVALID');operations=saved.filter(m=>Date.parse(m.expiresAt)>Date.now());if(operations.length!==saved.length)save();}catch{storageError=true;}
    function forgetSession(){session=null;try{sessionStorage.removeItem(SESSION);}catch{}}
    function save(){const text=JSON.stringify(operations);try{sessionStorage.setItem(OPERATIONS,text);if(sessionStorage.getItem(OPERATIONS)!==text)throw fail('STORAGE_UNAVAILABLE');storageError=false;}catch{storageError=true;throw fail('STORAGE_UNAVAILABLE');}}
    function remember(meta){if(!validMeta(meta))throw fail('RESPONSE_INVALID');const clean={operationId:meta.operationId,idempotencyKey:meta.idempotencyKey,payloadHash:meta.payloadHash,issuedAt:meta.issuedAt,expiresAt:meta.expiresAt,status:meta.status,...(meta.basePayloadHash?{basePayloadHash:meta.basePayloadHash}:{})};const i=operations.findIndex(x=>x.operationId===clean.operationId);if(i<0){if(operations.length>=200)throw fail('STORAGE_FULL');operations.push(clean);}else operations[i]=clean;save();return clean;}
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
      async imagePreview(p,previous){const r=await api('/api/forum/image-preview','POST',{apiVersion:2,threadName:p.threadName,content:p.content,tagIds:p.tagIds,officialUrl:p.officialUrl,...(previous?{previewTicket:previous,withoutImage:true}:{})});if(!r.ok)throw fail(r.data.error?.code||'INPUT_REJECTED');const d=r.data;if(d.apiVersion!==2||!['image','no_image'].includes(d.status)||typeof d.previewTicket!=='string'||d.previewTicket.length>8192||!Number.isSafeInteger(d.expiresAt)||d.expiresAt<=Date.now()||d.officialUrl!==p.officialUrl||d.status==='no_image'&&d.imageUrl!==null||d.status==='image'&&(typeof d.imageUrl!=='string'||!d.imageUrl.startsWith('https://')))throw fail('RESPONSE_INVALID');return d;},
      async thumbnail(ticket){if(!session||session.expiresAt<=Date.now())throw fail('SESSION_REQUIRED');const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);try{const r=await fetch(API+'/api/forum/image-thumbnail',{method:'POST',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal,headers:{'Content-Type':'application/json',Authorization:'Bearer '+session.token},body:JSON.stringify({previewTicket:ticket})});if(r.status===401){forgetSession();throw fail('SESSION_EXPIRED');}if(!r.ok){const d=await r.json();throw fail(d.error?.code||'THUMBNAIL_UNAVAILABLE');}if(!['image/png','image/jpeg','image/gif','image/webp'].includes(r.headers.get('Content-Type')))throw fail('THUMBNAIL_UNAVAILABLE');const blob=await r.blob();if(blob.size>2097152)throw fail('THUMBNAIL_UNAVAILABLE');try{const bitmap=await createImageBitmap(blob);bitmap.close();}catch{throw fail('THUMBNAIL_UNAVAILABLE');}return blob;}catch(e){if(e.code)throw e;throw fail('THUMBNAIL_UNAVAILABLE');}finally{clearTimeout(timer);controller.abort();}},
      async issue(p){if(!this.storageReady())throw fail('STORAGE_UNAVAILABLE');const expected=await hash(p),r=await api('/api/forum/post-intents','POST',{...normalize(p),...(p.apiVersion===2?{previewTicket:p.previewTicket}:{})});if(!r.ok)throw fail(r.data.error?.code==='STATE_UNAVAILABLE'?'STATE_UNAVAILABLE':r.status===404?'POSTS_DISABLED':'INPUT_REJECTED');const m={...r.data,status:'not_started',basePayloadHash:await hash({...p,apiVersion:1})};if(r.data.apiVersion!==1||r.data.status!=='not_started'||!validMeta(m)||m.payloadHash!==expected)throw fail('RESPONSE_INVALID');return remember(m);},
      async post(meta,p){if(await hash(p)!==meta.payloadHash)throw fail('KEY_PAYLOAD_CONFLICT');remember({...meta,status:'unconfirmed'});return api('/api/forum/posts','POST',normalize(p),meta.idempotencyKey);},
      status(meta){if(!validMeta(meta))throw fail('RESPONSE_INVALID');return api('/api/forum/posts/'+meta.operationId,'GET',null,meta.idempotencyKey);}
    };
  }
  window.PosterClient={create,normalize,normalizeOfficialUrl,hash,snowflake,UUID};
}());
