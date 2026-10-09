/* Discord Event Poster v0.1.0 - no external runtime dependencies. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const STORE = "discord-event-poster.webhook";
  const MAX_TAGS = 5;
  let forumConfig = null;
  const TAG_RULES = Object.freeze({周遊型:/周遊|街歩き|まち歩き/,ホール型:/ホール|劇場|会館/,ルーム型:/ルーム型|室内型|部屋からの脱出/,オンライン:/オンライン|配信|リモート|web開催/i,持ち帰り:/持ち帰り|お持ち帰り|キット販売/,イマーシブ:/イマーシブ|没入型|没入体験/,謎解き:/謎解き|脱出|ミステリー/,ホラー:/ホラー|恐怖|怪異|お化け屋敷/});
  const state = { events: [], posting: false };
  const today = new Date();

  function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
  function splitEvents(text) { const re = /【([^】\n]{1,40})】\s*[『「“"]([^』」”"]+)[』」”"]/g; const starts = []; let m; while ((m = re.exec(text))) starts.push({ index:m.index, region:m[1].trim(), title:m[2].trim(), end:re.lastIndex }); if (!starts.length) return { events:[], warnings:["イベント開始形式（【地域】『タイトル』）を認識できませんでした。"] }; const events = starts.map((s, i) => ({ raw:text.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : text.length).trim(), region:s.region, title:s.title })); const prefix = text.slice(0, starts[0].index).trim(); return { events, warnings:prefix ? [`先頭にイベントとして認識できない文章があります（${prefix.length}文字）。`] : [] }; }
  function extractLinks(raw) { const links = []; const md = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g; let m; while ((m = md.exec(raw))) links.push({ label:m[1], url:m[2] }); const plain = raw.match(/https?:\/\/[^\s)]+/g) || []; plain.forEach((url) => { if (!links.some((x) => x.url === url)) links.push({ label:url, url }); }); return links.filter((x) => !/^(https?:\/\/t\.co|https?:\/\/[^/]+\/(?:hashtag|emoji)\b)/i.test(x.url)); }
  function datePart(raw) { const m = raw.match(/(?:^|[\s\n])((?:\d{4}[年\/-])?\d{1,2})[月\/-](\d{1,2})(?:日)?/); return m ? { month:m[1].replace(/^\d{4}[年\/-]/, ""), day:m[2], explicitYear:/^\d{4}/.test(m[1]) } : null; }
  function parsePeriod(raw) { const match = raw.match(/(\d{1,2})\s*[月\/]\s*(\d{1,2})(?:日)?\s*(?:〜|～|-|~)\s*(?:(\d{1,2})\s*[月\/]\s*)?(\d{1,2})?(?:日)?/); const opening = raw.match(/(\d{1,2})\s*[月\/]\s*(\d{1,2})(?:日)?\s*(?:開幕|スタート)/); const onlyEnd = raw.match(/〜\s*(\d{1,2})\s*[月\/]\s*(\d{1,2})/); if (match) { const sm=match[1], sd=match[2], em=match[3] || sm, ed=match[4]; const startYear=today.getFullYear(), endYear=(Number(em)<Number(sm)?startYear+1:startYear); return { start:`${startYear}/${sm}/${sd}`, end:`${endYear}/${em}/${ed || ""}`, warning:!match[4]?"終了日が不明です。":(!match[3]&&Number(ed)<Number(sd)?"年またぎの可能性があります。":"") }; } if (opening) return { start:`${today.getFullYear()}/${opening[1]}/${opening[2]}`, end:"", warning:"「開幕」表記から開始日のみ抽出しました。年は推定です。" }; if (onlyEnd) return { start:"", end:`${today.getFullYear()}/${onlyEnd[1]}/${onlyEnd[2]}`, warning:"開始日が不明です。" }; const relative = raw.match(/(明日|明後日)開幕/); if (relative) { const d=new Date(today); d.setDate(d.getDate()+(relative[1]==="明日"?1:2)); return { start:d.toISOString().slice(0,10).replaceAll("-","/"), end:"", warning:`「${relative[1]}」を解析基準日から推定しました。` }; } return { start:"", end:"", warning:"開催期間を抽出できませんでした。" }; }
  function analyze(raw, index) { const links=extractLinks(raw); const p=parsePeriod(raw); const tags=(raw.match(/#[^\s#]+/g)||[]).join(" "); const desc=raw.replace(/^【[^】]+】\s*[『「“"][^』」”"]+[』」”"]\s*/,"" ).replace(/\[[^\]]+\]\([^)]*\)|https?:\/\/[^\s)]+/g," ").replace(/#[^\s#]+/g," ").trim(); return { id:`event-${index+1}`, selected:true, status:"未送信", region:"", title:"", start:p.start,end:p.end,description:desc, url:links[0]?.url||"", tags, selectedTags:[], tagReasons:[], raw, warnings:p.warning?[p.warning]:[], candidates:links.map((x)=>x.url), duplicate:false, ...{ region:raw.match(/^【([^】]+)】/)?.[1]?.trim()||"", title:raw.match(/^【[^】]+】\s*[『「“"]([^』」”"]+)[』」”"]/)?.[1]?.trim()||"" } }; }
  function runAnalysis(text) { const split=splitEvents(text); const events=split.events.map((x,i)=>analyze(x.raw,i)); const seen=new Map(); events.forEach((e)=>{ const key=`${e.region}|${e.title}`; e.duplicate=seen.has(key); seen.set(key,true); if(e.duplicate)e.warnings.push("同じ入力内に同じ地域・タイトルがあります。"); }); return { events, warnings:split.warnings }; }
  function autoTagEvent(e) { const text=`${e.title} ${e.description}`; const matched=Object.keys(TAG_RULES).filter(tag=>TAG_RULES[tag].test(text)); e.selectedTags=matched.slice(0,MAX_TAGS); e.tagReasons=matched.map(tag=>`「${tag}」一致語：${text.match(TAG_RULES[tag])[0]}${e.selectedTags.includes(tag)?"":"（上限で未選択）"}`); e.warnings=e.warnings.filter(x=>!x.startsWith("自動判定：")); if(matched.length)e.warnings.push(`自動判定：${matched.join("・")}`); return matched; }
  function appliedTagsFor(e) { return (e.selectedTags||[]).map(tag=>({tag,id:forumConfig?.mapping?.[tag]||""})); }
  function contentFor(e) { const period=e.start||e.end?`${e.start||"不明"}〜${e.end||""}`:"不明"; return `📍 **開催地域：${e.region||"不明"}**\n\n📅 **開催期間：${period}**\n\n${e.description||""}\n\n${e.url?`🔗 **公式サイト**\n${e.url}\n\n`:""}${e.tags||""}`.trim(); }
  function threadName(e) { return `【${e.region||"不明"}】${e.title}`; }
  function validateEvent(e) { const errors=[]; if((e.selectedTags||[]).length>5)errors.push("タグは最大5件です"); if(!e.title)errors.push("タイトルがありません"); if(threadName(e).length>100)errors.push("スレッド名が100文字を超えています"); if(contentFor(e).length>2000)errors.push("本文が2000文字を超えています"); if(e.url){try{const u=new URL(e.url);if(!/^https?:$/.test(u.protocol))errors.push("公式URLはhttp/httpsのみです")}catch{errors.push("公式URLが不正です")}} return errors; }
  function renderCards() { $("count").textContent=`${state.events.length}件`; $("cards").innerHTML=state.events.map((e,i)=>`<article class="card ${e.selected?"selected":""} ${e.duplicate?"duplicate":""}" data-id="${e.id}"><div class="card-top"><input ${(state.posting||e.operation)?"disabled":""} class="select-event" type="checkbox" ${e.selected?"checked":""} aria-label="${escapeHtml(e.title)}を投稿対象にする"><div><h3>${escapeHtml(e.title||"無題のイベント")}</h3><p class="hint">元文 ${e.raw.length}文字・状態：${e.status}</p></div></div><div class="card-grid"><label>地域<input ${(state.posting||e.operation)?"disabled":""} data-field="region" value="${escapeHtml(e.region)}"></label><label>タイトル<input ${(state.posting||e.operation)?"disabled":""} data-field="title" value="${escapeHtml(e.title)}"></label><label>開始日<input ${(state.posting||e.operation)?"disabled":""} data-field="start" value="${escapeHtml(e.start)}" placeholder="2026/10/23"></label><label>終了日<input ${(state.posting||e.operation)?"disabled":""} data-field="end" value="${escapeHtml(e.end)}" placeholder="2027/01/17"></label><label>公式URL<input ${(state.posting||e.operation)?"disabled":""} data-field="url" value="${escapeHtml(e.url)}" placeholder="https://..."></label><label>ハッシュタグ<input ${(state.posting||e.operation)?"disabled":""} data-field="tags" value="${escapeHtml(e.tags)}"></label><label style="grid-column:1/-1">説明<textarea ${(state.posting||e.operation)?"disabled":""} data-field="description">${escapeHtml(e.description)}</textarea></label><fieldset class="tag-field"><legend>イベントタグ（手動）</legend>${Object.keys(TAG_RULES).map(tag=>`<label><input ${(state.posting||e.operation)?"disabled":""} type="checkbox" data-tag="${tag}" ${(e.selectedTags||[]).includes(tag)?"checked":""}>${tag}</label>`).join("")}<button type="button" class="small-button auto-tag" ${(state.posting||e.operation)?"disabled":""}>本文から自動判定</button><p class="hint">${e.tagReasons?.length?`判定根拠：${e.tagReasons.map(escapeHtml).join("／")}`:"自動判定はこのボタンを押した時だけ実行します。"}</p></fieldset></div>${e.warnings.length?`<p class="warning">⚠ ${e.warnings.map(escapeHtml).join(" / ")}</p>`:""}</article>`).join(""); $("selected-count").textContent=`投稿予定 ${state.events.filter(e=>e.selected).length}件`; $("review").disabled=state.posting||!state.events.some(e=>e.selected); }
  function renderPreview() { const selected=state.events.filter(e=>e.selected); $("preview").innerHTML=selected.map((e)=>`<article><strong>${escapeHtml(threadName(e).replace(/\r\n?/g,'\n').trim())}</strong><br><br>${escapeHtml(contentFor(e).replace(/\r\n?/g,'\n'))}<br>タグ：${escapeHtml((e.selectedTags||[]).join("・")||"なし")}</article>`).join(""); }

  const client=window.PosterClient.create();
  state.history=client.operations().map((m,i)=>({id:'restored-'+m.operationId,title:'復元した操作 '+(i+1),status:'状態未確認',operation:m,error:'ログイン後、同じ操作IDで状態を確認してください。'}));
  state.reviewed=null;
  const controls=['post','parse','review','select-all','clear-all','worker-login','worker-logout','fetch-tags','back'];
  const labels={not_started:'未開始',preparing:'投稿準備中',sending:'投稿送信中',succeeded:'成功',retryable:'再試行待ち',failed:'失敗',unknown:'結果不明',expired:'期限切れ'};
  const messages={STATE_UNAVAILABLE:'永続化障害。投稿を開始できません。既存操作の状態を確認してください。',STORAGE_UNAVAILABLE:'端末の操作情報を保存できません。投稿は開始しません。',STORAGE_FULL:'操作情報の保存上限です。未解決操作を保護するため、新規投稿を停止します。',SESSION_REQUIRED:'投稿にはログインが必要です。',SESSION_EXPIRED:'認証切れです。再ログイン後、同じ操作の状態を確認してください。',POSTS_DISABLED:'本番投稿機能はまだ公開されていません。',APP_RATE_LIMITED:'全体の投稿制限です。待機後、同じ操作を確認してください。',DISCORD_RATE_LIMITED:'Discordの投稿制限です。待機後、同じ操作を確認してください。',CONTENT_INVALID:'入力エラー。タイトル・本文の文字数と制御文字を確認してください。',TAG_INVALID:'入力エラー。対象フォーラムのタグ設定を確認してください。',TAG_REQUIRED:'入力エラー。タグの選択が必要です。',TAG_PERMISSION_UNVERIFIED:'タグの使用権限を確認できません。',KEY_PAYLOAD_CONFLICT:'発行済み操作と本文が一致しません。内容を変更した操作は送信しません。',TARGET_CHANGED:'投稿先の設定が変更されています。既存キーは使えません。',OPERATION_EXPIRING:'操作の有効期限が近いため投稿を開始できません。',OPERATION_EXPIRED:'操作の30日期限が切れています。古い操作は再送しません。',NETWORK_UNKNOWN:'ネットワーク障害・タイムアウト。自動再送せず、同じ操作の状態を確認してください。',RESPONSE_INVALID:'応答を確認できません。同じ操作の状態を確認してください。',OUTCOME_UNKNOWN:'投稿結果不明です。自動再送せず、Discordと操作状態を確認してください。',INPUT_REJECTED:'入力エラー。タイトル・本文・タグ設定を確認してください。',DISCORD_REQUEST_REJECTED:'入力エラー。Discordが投稿内容を拒否しました。',DISCORD_PERMISSION_DENIED:'Botの投稿権限を確認してください。',DISCORD_CREDENTIAL_REJECTED:'Botの認証設定を確認してください。',DISCORD_TARGET_UNAVAILABLE:'固定投稿先を確認できません。',SERVICE_UNAVAILABLE:'投稿の事前確認を完了できません。状態を確認してください。'};
  const message=code=>messages[code]||'処理を完了できません。設定と操作状態を確認してください。';
  function fingerprint(){return JSON.stringify(state.events.filter(e=>e.selected&&!e.operation).map(e=>[e.id,threadName(e),contentFor(e),e.selectedTags]));}
  function lock(value){state.posting=value;controls.forEach(id=>$(id).disabled=value);renderCards();renderResults();}
  function payloadFor(e){return client.normalize({threadName:threadName(e),content:contentFor(e),tagIds:appliedTagsFor(e).map(t=>t.id)});}
  function allResults(){const ids=new Set(state.events.filter(e=>e.operation).map(e=>e.operation.operationId));return [...state.events.filter(e=>e.status!=='未送信'),...state.history.filter(e=>!ids.has(e.operation.operationId))];}
  function safeResult(r){if(!r||['guildId','forumId','threadId','messageId'].some(k=>!window.PosterClient.snowflake(r[k])))return null;return {guildId:r.guildId,forumId:r.forumId,threadId:r.threadId,messageId:r.messageId,url:'https://discord.com/channels/'+r.guildId+'/'+r.threadId+'/'+r.messageId};}
  function apply(e,packet){
    const b=packet.data;
    if(packet.status===410){e.status='期限切れ';e.error=message('OPERATION_EXPIRED');e.safeToRetry=false;return;}
    if(!b||b.apiVersion!==1||(b.operationId&&b.operationId!==e.operation.operationId)||(!labels[b.status]&&b.status!=='not_accepted'))throw Object.assign(new Error(),{code:'RESPONSE_INVALID'});
    if(b.status==='not_accepted'){e.status=b.error?.code==='STATE_UNAVAILABLE'?'永続化障害':packet.status===422||packet.status===400?'入力エラー':'状態未確認';e.error=message(b.error?.code);e.safeToRetry=false;return;}
    if(b.operationId!==e.operation.operationId)throw Object.assign(new Error(),{code:'RESPONSE_INVALID'});
    e.status=labels[b.status];e.safeToRetry=b.safeToRetry===true&&['not_started','retryable'].includes(b.status);
    e.wait=Math.max(Number(b.retryAfterSeconds)||0,packet.retryAfterSeconds||0);if(!Number.isFinite(e.wait)||e.wait<0)e.wait=0;
    e.error=b.error?message(b.error.code):'';e.selected=false;
    if(b.status==='succeeded'){e.result=safeResult(b.result);if(!e.result)throw Object.assign(new Error(),{code:'RESPONSE_INVALID'});}
    e.operation=client.remember({...e.operation,status:b.status});
  }
  function showError(e,error){e.safeToRetry=false;e.selected=false;e.status=['SESSION_REQUIRED','SESSION_EXPIRED'].includes(error.code)?'認証切れ':error.code==='STORAGE_UNAVAILABLE'?'保存障害':e.operation?'状態未確認':'投稿準備失敗';e.error=message(error.code);}
  async function checkOperation(e){
    try{apply(e,await client.status(e.operation));}catch(error){showError(e,error);}renderCards();renderResults();
  }
  async function enabledSession(){const s=await client.session();if(s.capabilities?.forumPosts!==true||s.capabilities?.apiVersion!==1)throw Object.assign(new Error(),{code:'POSTS_DISABLED'});}
  async function send(e){
    try{apply(e,await client.post(e.operation,e.payload));}
    catch(error){showError(e,error);if(!['SESSION_REQUIRED','SESSION_EXPIRED','STORAGE_UNAVAILABLE','KEY_PAYLOAD_CONFLICT'].includes(error.code))await checkOperation(e);}
  }
  async function postSelected(){
    if(state.posting)return;
    const selected=state.events.filter(e=>e.selected&&!e.operation);
    if(!selected.length){$('input-status').textContent='成功・結果不明・発行済み操作は通常の投稿ボタンで再送しません。';return;}
    if(state.reviewed!==fingerprint()){renderPreview();state.reviewed=fingerprint();$('confirm-panel').classList.remove('hidden');$('input-status').textContent='投稿内容をプレビューで確認してから、もう一度投稿を押してください。';return;}
    const invalid=selected.flatMap(e=>validateEvent(e).map(x=>e.title+': '+x));
    const unset=selected.flatMap(e=>(e.selectedTags||[]).filter(tag=>!forumConfig?.mapping?.[tag]).map(tag=>e.title+': '+tag+'のタグIDが未設定です'));
    if(invalid.length||unset.length){alert([...invalid,...unset].join('\n'));return;}
    let queue;try{queue=selected.map(e=>({e,payload:payloadFor(e)}));}catch{alert(message('CONTENT_INVALID'));return;}
    lock(true);
    try{
      await enabledSession();
      if(!confirm(queue.length+'件をBot名義で投稿します。\n'+queue.map(x=>x.e.title).join('\n')+'\nよろしいですか？'))return;
      $('status-panel').classList.remove('hidden');
      for(const {e,payload} of queue){
        e.payload=payload;e.status='投稿準備中';renderCards();renderResults();
        try{
          const hash=await client.hash(payload),known=!e.forceNewOperation&&client.operations().find(m=>m.payloadHash===hash);
          if(known){e.operation=known;await checkOperation(e);if(!e.safeToRetry||e.wait>0)continue;}
          else e.operation=await client.issue(payload);
          e.status='投稿送信中';e.selected=false;renderCards();renderResults();await send(e);
          if(e.status==='認証切れ')break;
        }catch(error){showError(e,error);}
        renderResults();
      }
    }catch(error){$('auth-status').textContent=message(error.code);if(['SESSION_REQUIRED','SESSION_EXPIRED'].includes(error.code))$('app-password').focus?.();}
    finally{lock(false);}
  }
  function renderResults(){
    const rows=allResults();if(rows.length)$('status-panel').classList.remove('hidden');
    $('result-summary').textContent=rows.filter(e=>e.status==='成功').length+'/'+rows.length+'件が成功しました。';
    $('post-results').innerHTML=rows.map(e=>{
      const m=e.operation,link=e.result?.url?'<br><a target="_blank" rel="noopener noreferrer" href="'+escapeHtml(e.result.url)+'">投稿を開く</a>':'';
      const actions=m?'<div class="actions"><button class="small-button" data-check="'+m.operationId+'" '+(state.posting?'disabled':'')+'>同じ操作の状態を確認</button>'+(e.payload&&e.safeToRetry&&!e.wait?'<button class="small-button" data-retry="'+m.operationId+'" '+(state.posting?'disabled':'')+'>同じ操作キーで再開</button>':'')+(state.events.includes(e)?'<button class="small-button" data-repost="'+e.id+'" '+(state.posting?'disabled':'')+'>新しい操作として再投稿</button>':'')+'</div>':'';
      return '<div class="result '+(e.status==='成功'?'ok':'error')+'"><strong>'+escapeHtml(e.status)+'：</strong>'+escapeHtml(e.title)+link+'<br><small>'+escapeHtml(e.error||'')+(e.wait?' 待機時間：'+Math.ceil(e.wait)+'秒。待機後に状態を確認してください。':'')+'</small>'+actions+'</div>';
    }).join('');
  }
  $('post-results').addEventListener('click',async ev=>{
    if(state.posting)return;const button=ev.target.closest('button');if(!button)return;
    const rows=allResults(),id=button.dataset.check||button.dataset.retry,e=rows.find(x=>x.operation?.operationId===id);
    if(button.dataset.repost){
      const original=state.events.find(x=>x.id===button.dataset.repost);if(!original)return;
      if(!confirm('「'+original.title+'」を新しい操作として再投稿します。\n既存の成功・結果不明の投稿と重複する可能性があります。Discordで確認しましたか？'))return;
      const copy={...original,id:'event-'+crypto.randomUUID(),selected:true,status:'未送信',operation:null,payload:null,result:null,error:'',safeToRetry:false,forceNewOperation:true,selectedTags:[...(original.selectedTags||[])]};
      state.events.forEach(x=>x.selected=false);state.events.push(copy);state.reviewed=null;renderCards();renderPreview();state.reviewed=fingerprint();$('confirm-panel').classList.remove('hidden');return;
    }
    if(!e)return;lock(true);
    try{if(button.dataset.check)await checkOperation(e);else{await enabledSession();await checkOperation(e);if(e.safeToRetry&&!e.wait&&e.payload&&confirm('「'+e.title+'」を同じ操作キーで再開しますか？'))await send(e);}}
    catch(error){showError(e,error);}finally{lock(false);}
  });
  $('parse').onclick=()=>{if(state.posting)return;for(const e of state.events)if(e.operation&&!state.history.some(h=>h.operation.operationId===e.operation.operationId))state.history.push(e);const result=runAnalysis($('source').value);state.events=result.events;state.reviewed=null;if(!state.events.length){$('input-status').textContent=result.warnings.join(' ');return;}$('results-panel').classList.remove('hidden');$('confirm-panel').classList.add('hidden');renderCards();renderResults();$('input-status').textContent=result.warnings.join(' ')||state.events.length+'件を認識しました。';};
  function edited(ev){if(state.posting||ev.type==='input'&&!ev.target.dataset.field)return;const card=ev.target.closest('.card'),e=state.events.find(x=>x.id===card?.dataset.id);if(!e||e.operation)return;
    if(ev.target.classList.contains('select-event'))e.selected=ev.target.checked;
    else if(ev.target.dataset.field)e[ev.target.dataset.field]=ev.target.value;
    else if(ev.target.dataset.tag){e.selectedTags=e.selectedTags||[];if(ev.target.checked&&e.selectedTags.length>=5&&!e.selectedTags.includes(ev.target.dataset.tag)){ev.target.checked=false;alert('タグは最大5件です');return;}e.selectedTags=ev.target.checked?[...new Set([...e.selectedTags,ev.target.dataset.tag])]:e.selectedTags.filter(x=>x!==ev.target.dataset.tag);}
    state.reviewed=null;card.classList.toggle('selected',e.selected);$('selected-count').textContent='投稿予定 '+state.events.filter(x=>x.selected&&!x.operation).length+'件';$('review').disabled=!state.events.some(x=>x.selected&&!x.operation);
  }
  $('cards').addEventListener('change',edited);$('cards').addEventListener('input',edited);
  $('cards').addEventListener('click',ev=>{if(state.posting||!ev.target.classList.contains('auto-tag'))return;const e=state.events.find(x=>x.id===ev.target.closest('.card').dataset.id);if(!e||e.operation)return;autoTagEvent(e);state.reviewed=null;renderCards();});
  $('select-all').onclick=()=>{state.events.forEach(e=>e.selected=!e.operation);state.reviewed=null;renderCards();};
  $('clear-all').onclick=()=>{state.events.forEach(e=>e.selected=false);state.reviewed=null;renderCards();};
  $('review').onclick=()=>{renderPreview();state.reviewed=fingerprint();$('confirm-panel').classList.remove('hidden');window.scrollTo({top:$('confirm-panel').offsetTop-20,behavior:'smooth'});};
  $('back').onclick=()=>$('confirm-panel').classList.add('hidden');
  $('post').onclick=postSelected;
  $('worker-login').onclick=async()=>{if(state.posting)return;const input=$('app-password'),password=input.value;input.value='';lock(true);try{forumConfig=null;await client.login(password);const s=await client.session();$('auth-status').textContent='ログインしました（有効期限1時間）。'+(s.capabilities?.forumPosts?'':' 本番投稿機能はまだ公開されていません。');for(const e of allResults().filter(x=>x.operation))await checkOperation(e);}catch{$('auth-status').textContent='ログインできません。設定・パスワード・試行制限・端末保存を確認してください。';}finally{lock(false);}};
  $('worker-logout').onclick=async()=>{if(state.posting)return;lock(true);try{await client.logout();forumConfig=null;$('auth-status').textContent='ログアウトしました。操作キーはこのタブに保持し、再ログイン後に照会できます。';}catch{$('auth-status').textContent='サーバーでの失効を確認できません。再試行してください。';}finally{lock(false);}};
  $('fetch-tags').onclick=async()=>{if(state.posting)return;lock(true);forumConfig=null;try{const r=await client.tags(),data=r.data;if(!r.ok||!window.PosterClient.snowflake(data.forumId)||!data.mapping||Object.entries(data.mapping).some(([name,id])=>!TAG_RULES[name]||!window.PosterClient.snowflake(id)))throw Object.assign(new Error(),{code:r.status===429?'DISCORD_RATE_LIMITED':'TAG_INVALID'});forumConfig=data;$('auth-status').textContent='タグを取得しました。'+(data.missing?.length?' 未登録：'+data.missing.join('・'):'')+(data.duplicates?.length?' 重複：'+data.duplicates.join('・'):'');}catch(error){$('auth-status').textContent=message(error.code);}finally{lock(false);}};
  try{localStorage.removeItem(STORE);}catch{$('input-status').textContent='旧保存URLを削除できません。サイトデータから削除してください。新バージョンでは利用しません。';}
  if(!client.storageReady())$('input-status').textContent='操作情報の保存を利用できません。投稿は停止します。';
  renderResults();
  if(state.history.length)client.session().then(async()=>{for(const e of state.history)await checkOperation(e);}).catch(()=>{});
  window.EventPoster={splitEvents,extractLinks,parsePeriod,runAnalysis,autoTagEvent,appliedTagsFor,contentFor,validateEvent,MAX_TAGS,TAG_RULES};
}());
