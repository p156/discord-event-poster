/* Discord Event Poster v0.1.0 - no external runtime dependencies. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const STORE = "discord-event-poster.webhook";
  const MAX_TAGS = 5;
  let forumConfig = null;
  const TAG_RULES = Object.freeze({周遊型:/周遊|街歩き|まち歩き/,ホール型:/ホール|劇場|会館/,ルーム型:/ルーム型|室内型|部屋からの脱出/,オンライン:/オンライン|配信|リモート|web開催/i,持ち帰り:/持ち帰り|お持ち帰り|キット販売/,イマーシブ:/イマーシブ|没入型|没入体験/,謎解き:/謎解き|脱出|ミステリー/,ホラー:/ホラー|恐怖|怪異|お化け屋敷/});
  const state = { events: [], posting: false, managed:false, forumId:'', forumGeneration:0, forumReady:false, registry:null, historyItems:[], historySync:null, duplicateMatches:[], historyUnverified:true };
  const today = new Date();

  function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
  // Regionless headings must begin a line; inline quotations remain description.
  const EVENT_HEADING = /(?:【([^】\n]{1,40})】\s*)?[『「“"]([^』」”"\r\n]+)[』」”"]/;
  function splitEvents(text) { const re = new RegExp('^[ \t]*' + EVENT_HEADING.source, 'gm'); const starts = []; let m; while ((m = re.exec(text))) starts.push({ index:m.index, region:(m[1]||"").trim(), title:m[2].trim(), end:re.lastIndex }); if (!starts.length) return { events:[], warnings:["イベント開始形式（行頭の『タイトル』、【地域】は任意）を認識できませんでした。"] }; const events = starts.map((s, i) => ({ raw:text.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : text.length).trim(), region:s.region, title:s.title })); const prefix = text.slice(0, starts[0].index).trim(); return { events, warnings:prefix ? [`先頭にイベントとして認識できない文章があります（${prefix.length}文字）。`] : [] }; }
  function extractLinks(raw) {
    const links=[],normalize=window.PosterClient.normalizeOfficialUrl;
    const add=(label,value)=>{const url=normalize(value.replace(/[。、，．！？]+$/u,''));if(url&&!links.some(x=>x.url===url))links.push({label,url,source:value});};
    const md=/\[([^\]]+)\]\(([^\s)]+)\)/g;let m;
    while((m=md.exec(raw)))add(m[1],m[2]);
    for(const url of raw.match(/https?:\/\/[^\s)]+/gi)||[])add(url,url);
    // Consume whole tokens so a rejected scheme/email cannot yield a DNS suffix.
    for(const token of raw.replace(md,' ').split(/[\s<>「」『』【】]+/))if(token)add(token,token.replace(/^(?:公式(?:URL|サイト|ホームページ)?|URL|詳細|予約|チケット)[：:]/i,''));
    return links.filter(x=>!/^https?:\/\/(?:t\.co(?:\/|$)|[^/]+\/(?:hashtag|emoji)\b)/i.test(x.url));
  }
  function datePart(raw) { const m = raw.match(/(?:^|[\s\n])((?:\d{4}[年\/-])?\d{1,2})[月\/-](\d{1,2})(?:日)?/); return m ? { month:m[1].replace(/^\d{4}[年\/-]/, ""), day:m[2], explicitYear:/^\d{4}/.test(m[1]) } : null; }
  function parsePeriod(raw) { const match = raw.match(/(\d{1,2})\s*[月\/]\s*(\d{1,2})(?:日)?\s*(?:〜|～|-|~)\s*(?:(\d{1,2})\s*[月\/]\s*)?(\d{1,2})?(?:日)?/); const opening = raw.match(/(\d{1,2})\s*[月\/]\s*(\d{1,2})(?:日)?\s*(?:開幕|スタート)/); const onlyEnd = raw.match(/〜\s*(\d{1,2})\s*[月\/]\s*(\d{1,2})/); if (match) { const sm=match[1], sd=match[2], em=match[3] || sm, ed=match[4]; const startYear=today.getFullYear(), endYear=(Number(em)<Number(sm)?startYear+1:startYear); return { start:`${startYear}/${sm}/${sd}`, end:`${endYear}/${em}/${ed || ""}`, warning:!match[4]?"終了日が不明です。":(!match[3]&&Number(ed)<Number(sd)?"年またぎの可能性があります。":"") }; } if (opening) return { start:`${today.getFullYear()}/${opening[1]}/${opening[2]}`, end:"", warning:"「開幕」表記から開始日のみ抽出しました。年は推定です。" }; if (onlyEnd) return { start:"", end:`${today.getFullYear()}/${onlyEnd[1]}/${onlyEnd[2]}`, warning:"開始日が不明です。" }; const relative = raw.match(/(明日|明後日)開幕/); if (relative) { const d=new Date(today); d.setDate(d.getDate()+(relative[1]==="明日"?1:2)); return { start:d.toISOString().slice(0,10).replaceAll("-","/"), end:"", warning:`「${relative[1]}」を解析基準日から推定しました。` }; } return { start:"", end:"", warning:"開催期間を抽出できませんでした。" }; }
  function analyze(raw, index) { const heading=raw.match(new RegExp('^'+EVENT_HEADING.source)); const links=extractLinks(raw); const p=parsePeriod(raw); const tags=(raw.match(/#[^\s#]+/g)||[]).join(" "); const desc=links.reduce((text,link)=>text.split(link.source).join(' '),raw).replace(new RegExp('^'+EVENT_HEADING.source+'[ \t]*'),"" ).replace(/\[[^\]]+\]\([^)]*\)|https?:\/\/[^\s)]+/g," ").replace(/#[^\s#]+/g," ").trim(); return { id:`event-${index+1}`, selected:true, status:"未送信", region:"", title:"", start:p.start,end:p.end,description:desc, url:links[0]?.url||"", tags, selectedTags:[], tagReasons:[], raw, warnings:p.warning?[p.warning]:[], candidates:links.map((x)=>x.url), duplicate:false, ...{ region:heading?.[1]?.trim()||"", title:heading?.[2]?.trim()||"" } }; }
  function runAnalysis(text) { const split=splitEvents(text); const events=split.events.map((x,i)=>analyze(x.raw,i)); const seen=new Map(); events.forEach((e)=>{ const key=`${e.region}|${e.title}`; e.duplicate=seen.has(key); seen.set(key,true); if(e.duplicate)e.warnings.push("同じ入力内に同じ地域・タイトルがあります。"); }); return { events, warnings:split.warnings }; }
  function autoTagEvent(e) { const text=`${e.title} ${e.description}`; const matched=Object.keys(TAG_RULES).filter(tag=>TAG_RULES[tag].test(text)); e.selectedTags=state.managed?matched.flatMap(name=>(forumConfig?.tags||[]).filter(t=>t.name===name).map(t=>t.id)).slice(0,MAX_TAGS):matched.slice(0,MAX_TAGS); e.tagReasons=matched.map(tag=>`「${tag}」一致語：${text.match(TAG_RULES[tag])[0]}${(e.selectedTags.includes(tag)||state.managed&&(forumConfig?.tags||[]).some(t=>t.name===tag&&e.selectedTags.includes(t.id)))?"":"（上限で未選択）"}`); e.warnings=e.warnings.filter(x=>!x.startsWith("自動判定：")); if(matched.length)e.warnings.push(`自動判定：${matched.join("・")}`); return matched; }
  function appliedTagsFor(e) { return (e.selectedTags||[]).map(tag=>({tag,id:state.managed?(forumConfig?.tags||[]).some(t=>t.id===tag)?tag:"":forumConfig?.mapping?.[tag]||""})); }
  function contentFor(e) { const period=e.start||e.end?`${e.start||"不明"}〜${e.end||""}`:"不明"; return `${e.region?`📍 **開催地域：${e.region}**\n\n`:""}📅 **開催期間：${period}**\n\n${e.description||""}\n\n${e.url?`🔗 **公式サイト**\n${window.PosterClient.normalizeOfficialUrl(e.url)||e.url}\n\n`:""}${e.tags||""}`.trim(); }
  function threadName(e) { return `${e.region?`【${e.region}】`:""}${e.title}`; }
  function validateEvent(e) { const errors=[]; if((e.selectedTags||[]).length>5)errors.push("タグは最大5件です"); if(!e.title)errors.push("タイトルがありません"); if(threadName(e).length>100)errors.push("スレッド名が100文字を超えています"); if(contentFor(e).length>2000)errors.push("本文が2000文字を超えています"); if(e.url&&window.PosterClient.normalizeOfficialUrl(e.url)===null)errors.push("公式URLが不正です（http/httpsのみ）"); return errors; }
  function renderCards() { $("count").textContent=`${state.events.length}件`; $("cards").innerHTML=state.events.map((e,i)=>`<article class="card ${e.selected?"selected":""} ${e.duplicate?"duplicate":""}" data-id="${e.id}"><div class="card-top"><input ${(state.posting||e.operation)?"disabled":""} class="select-event" type="checkbox" ${e.selected?"checked":""} aria-label="${escapeHtml(e.title)}を投稿対象にする"><div><h3>${escapeHtml(e.title||"無題のイベント")}</h3><p class="hint">元文 ${e.raw.length}文字・状態：${e.status}</p></div></div><div class="card-grid"><label>地域<input ${(state.posting||e.operation)?"disabled":""} data-field="region" value="${escapeHtml(e.region)}"></label><label>タイトル<input ${(state.posting||e.operation)?"disabled":""} data-field="title" value="${escapeHtml(e.title)}"></label><label>開始日<input ${(state.posting||e.operation)?"disabled":""} data-field="start" value="${escapeHtml(e.start)}" placeholder="2026/10/23"></label><label>終了日<input ${(state.posting||e.operation)?"disabled":""} data-field="end" value="${escapeHtml(e.end)}" placeholder="2027/01/17"></label><label>公式URL<input ${(state.posting||e.operation)?"disabled":""} data-field="url" value="${escapeHtml(e.url)}" placeholder="https://..."></label><label>ハッシュタグ<input ${(state.posting||e.operation)?"disabled":""} data-field="tags" value="${escapeHtml(e.tags)}"></label><label class="description-field">説明<textarea ${(state.posting||e.operation)?"disabled":""} data-field="description">${escapeHtml(e.description)}</textarea></label><fieldset class="tag-field"><legend>イベントタグ（手動）</legend>${(state.managed?(forumConfig?.tags||[]).map(t=>t.id):Object.keys(TAG_RULES)).map(tag=>`<label><input ${(state.posting||e.operation)?"disabled":""} type="checkbox" data-tag="${escapeHtml(tag)}" ${(e.selectedTags||[]).includes(tag)?"checked":""}>${escapeHtml(state.managed?forumConfig.tags.find(t=>t.id===tag)?.name:tag)}</label>`).join("")}<button type="button" class="small-button auto-tag" ${(state.posting||e.operation)?"disabled":""}>本文から自動判定</button><p class="hint">${e.tagReasons?.length?`判定根拠：${e.tagReasons.map(escapeHtml).join("／")}`:"自動判定はこのボタンを押した時だけ実行します。"}</p></fieldset></div>${e.warnings.length?`<p class="warning">⚠ ${e.warnings.map(escapeHtml).join(" / ")}</p>`:""}</article>`).join(""); $("selected-count").textContent=`投稿予定 ${state.events.filter(e=>e.selected).length}件`; $("review").disabled=state.posting||!state.events.some(e=>e.selected); }
  function disposeImages(){state.previewGeneration=(state.previewGeneration||0)+1;for(const e of state.events){if(e.imageBlob)URL.revokeObjectURL(e.imageBlob);e.imageBlob=null;e.imagePreview=null;}state.reviewed=null;state.previewing=false;if(!state.posting)$('post').disabled=false;}
  async function reviewImages(){
    if(state.managed&&(!state.forumId||!state.forumReady)){$('input-status').textContent='投稿先フォーラムを選択してください。';return;}
    const forumGeneration=state.forumGeneration;
    for(const e of state.events.filter(e=>e.selected&&!e.operation)){const url=window.PosterClient.normalizeOfficialUrl(e.url);if(url===null){alert("公式URLが不正です（http/httpsのみ）");return;}e.url=url;}renderCards();
    if(state.managed){state.previewing=true;$('post').disabled=true;await compareHistory();if(forumGeneration!==state.forumGeneration)return;}
    const generation=(state.previewGeneration||0)+1;state.previewGeneration=generation;const before=fingerprint();state.reviewed=null;state.previewing=true;$('post').disabled=true;
    $('confirm-panel').classList.remove('hidden');renderPreview();$('input-status').textContent='公式サイトの画像を確認中です。';
    try{await enabledSession();const session=await client.session();if(session.capabilities?.officialImagePreview!==true||!session.capabilities?.postPayloadVersions?.includes(2))throw Object.assign(new Error(),{code:'POSTS_DISABLED'});
      if(generation!==state.previewGeneration||before!==fingerprint())return;
      for(const e of state.events.filter(e=>e.selected&&!e.operation)){
        const p={...payloadFor(e),apiVersion:2,officialUrl:e.url||'',imageUrl:null};let preview=await client.imagePreview(p),blob=null;
        if(preview.imageUrl){try{blob=await client.thumbnail(preview.previewTicket,e.forumId||state.forumId);}catch(error){if(error.code!=='THUMBNAIL_UNAVAILABLE')throw error;preview=await client.imagePreview(p,preview.previewTicket);}}
        if(generation!==state.previewGeneration||before!==fingerprint())return;
        if(e.imageBlob)URL.revokeObjectURL(e.imageBlob);e.imageBlob=blob?URL.createObjectURL(blob):null;e.imagePreview=preview;renderPreview();
      }
      if(generation===state.previewGeneration&&before===fingerprint()){state.reviewed=before;$('input-status').textContent='画像を含む投稿内容を確認し、投稿ボタンを押してください。';}
    }catch(error){if(generation===state.previewGeneration)$('auth-status').textContent=message(error.code);}
    finally{if(generation===state.previewGeneration){state.previewing=false;$('post').disabled=state.posting;renderPreview();}}
  }
  function renderPreview() { const selected=state.events.filter(e=>e.selected); $("preview").innerHTML=selected.map((e)=>`<article><strong>${escapeHtml(threadName(e).replace(/\r\n?/g,'\n').trim())}</strong><br><br>${escapeHtml(contentFor(e).replace(/\r\n?/g,'\n'))}<br>タグ：${escapeHtml((e.selectedTags||[]).join("・")||"なし")}<p class="image-status" role="status">${e.imagePreview?(e.imagePreview.imageUrl?"公式画像あり":"画像なしで投稿できます"):"画像は未確認です"}</p>${e.imageBlob?`<img class="official-preview-image" alt="公式サイトの投稿画像" referrerpolicy="no-referrer" src="${escapeHtml(e.imageBlob)}">`:""}</article>`).join(""); }

  const client=window.PosterClient.create();
  state.history=client.operations().map((m,i)=>({id:'restored-'+m.operationId,title:'復元した操作 '+(i+1),status:'状態未確認',operation:m,error:'ログイン後、同じ操作IDで状態を確認してください。'}));
  state.reviewed=null;
  const controls=['post','parse','review','select-all','clear-all','worker-login','worker-logout','fetch-tags','back','reload-forums'];
  const labels={not_started:'未開始',preparing:'投稿準備中',sending:'投稿送信中',succeeded:'成功',retryable:'再試行待ち',failed:'失敗',unknown:'結果不明',expired:'期限切れ'};
  const messages={STATE_UNAVAILABLE:'永続化障害。投稿を開始できません。既存操作の状態を確認してください。',STORAGE_UNAVAILABLE:'端末の操作情報を保存できません。投稿は開始しません。',STORAGE_FULL:'操作情報の保存上限です。未解決操作を保護するため、新規投稿を停止します。',SESSION_REQUIRED:'投稿にはログインが必要です。',SESSION_EXPIRED:'認証切れです。再ログイン後、同じ操作の状態を確認してください。',POSTS_DISABLED:'本番投稿機能はまだ公開されていません。',APP_RATE_LIMITED:'全体の投稿制限です。待機後、同じ操作を確認してください。',DISCORD_RATE_LIMITED:'Discordの投稿制限です。待機後、同じ操作を確認してください。',CONTENT_INVALID:'入力エラー。タイトル・本文の文字数と制御文字を確認してください。',TAG_INVALID:'入力エラー。対象フォーラムのタグ設定を確認してください。',TAG_REQUIRED:'入力エラー。タグの選択が必要です。',TAG_PERMISSION_UNVERIFIED:'タグの使用権限を確認できません。',KEY_PAYLOAD_CONFLICT:'発行済み操作と本文が一致しません。内容を変更した操作は送信しません。',TARGET_CHANGED:'投稿先の設定が変更されています。既存キーは使えません。',OPERATION_EXPIRING:'操作の有効期限が近いため投稿を開始できません。',OPERATION_EXPIRED:'操作の30日期限が切れています。古い操作は再送しません。',NETWORK_UNKNOWN:'ネットワーク障害・タイムアウト。自動再送せず、同じ操作の状態を確認してください。',RESPONSE_INVALID:'応答を確認できません。同じ操作の状態を確認してください。',OUTCOME_UNKNOWN:'投稿結果不明です。自動再送せず、Discordと操作状態を確認してください。',INPUT_REJECTED:'入力エラー。タイトル・本文・タグ設定を確認してください。',DISCORD_REQUEST_REJECTED:'入力エラー。Discordが投稿内容を拒否しました。',DISCORD_PERMISSION_DENIED:'Botの投稿権限を確認してください。',DISCORD_CREDENTIAL_REJECTED:'Botの認証設定を確認してください。',DISCORD_TARGET_UNAVAILABLE:'固定投稿先を確認できません。',SERVICE_UNAVAILABLE:'投稿の事前確認を完了できません。状態を確認してください。'};
  const loginErrors={LOGIN_FAILED:'ポップアップ・Discord承認を確認してください。',LOGIN_COMPLETE_REJECTED:'ログイン完了APIが認証を拒否しました。',LOGIN_TOKEN_INVALID:'ログイン応答のトークン形式が仕様と一致しません。',LOGIN_EXPIRY_INVALID:'ログイン応答の有効期限の型が仕様と一致しません。',LOGIN_EXPIRY_MISMATCH:'ログイン応答とトークンの有効期限が一致しません。',LOGIN_EXPIRED:'受信したログイン応答は期限切れです。端末時刻を確認してください。',LOGIN_CLOCK_AHEAD:'ログイン応答の期限が端末時刻から1時間を超えています。端末時刻を確認してください。',STORAGE_UNAVAILABLE:'このタブにログイン情報を保存できません。端末の保存設定を確認してください。',SESSION_REQUIRED:'保存後のセッション確認が認証を確認できませんでした。',SESSION_EXPIRED:'サーバーがセッションを無効と判定しました。',NETWORK_UNKNOWN:'通信またはブラウザの応答読み取りに失敗しました。',RESPONSE_INVALID:'API応答をJSONとして読み取れませんでした。'};
  const message=code=>messages[code]||'処理を完了できません。設定と操作状態を確認してください。';
  function fingerprint(){return JSON.stringify(state.events.filter(e=>e.selected&&!e.operation).map(e=>[state.managed?state.forumId:'',e.id,threadName(e),contentFor(e),e.selectedTags]));}
  function lock(value){state.posting=value;controls.forEach(id=>$(id).disabled=value);for(const id of ['registered-forum','remove-forum','register-forum','guild-select','candidate-forum','load-guilds'])if($(id))$(id).disabled=value;renderCards();renderResults();}
  function payloadFor(e){const normalized=client.normalize({threadName:threadName(e),content:contentFor(e),tagIds:appliedTagsFor(e).map(t=>t.id)});const p=state.managed?{...normalized,forumId:e.forumId||state.forumId}:normalized;return e.imagePreview?{...p,apiVersion:2,officialUrl:e.url||'',imageUrl:e.imagePreview.imageUrl,previewTicket:e.imagePreview.previewTicket}:p;}
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
  async function enabledSession(){const s=await client.session();if(s.capabilities?.forumPosts!==true||s.capabilities?.apiVersion!==1)throw Object.assign(new Error(),{code:'POSTS_DISABLED'});if(s.capabilities?.multiForum&&!state.managed)await loadRegistry();}
  async function send(e){
    try{apply(e,await client.post(e.operation,e.payload));}
    catch(error){showError(e,error);if(!['SESSION_REQUIRED','SESSION_EXPIRED','STORAGE_UNAVAILABLE','KEY_PAYLOAD_CONFLICT'].includes(error.code))await checkOperation(e);}
  }
  async function postSelected(){
    if(state.posting||state.previewing)return;
    if(state.managed&&(!state.forumId||!state.forumReady)){$('input-status').textContent='投稿先フォーラムを選択してください。';return;}
    const selected=state.events.filter(e=>e.selected&&!e.operation);
    if(!selected.length){$('input-status').textContent='成功・結果不明・発行済み操作は通常の投稿ボタンで再送しません。';return;}
    if(state.reviewed!==fingerprint()||selected.some(e=>!e.imagePreview||e.imagePreview.expiresAt<=Date.now())){await reviewImages();return;}
    const invalid=selected.flatMap(e=>validateEvent(e).map(x=>e.title+': '+x));
    const unset=selected.flatMap(e=>(e.selectedTags||[]).filter(tag=>state.managed?!(forumConfig?.tags||[]).some(t=>t.id===tag):!forumConfig?.mapping?.[tag]).map(tag=>e.title+': '+tag+'のタグIDが未設定です'));
    if(invalid.length||unset.length){alert([...invalid,...unset].join('\n'));return;}
    let queue;try{queue=selected.map(e=>({e,payload:payloadFor(e)}));}catch{alert(message('CONTENT_INVALID'));return;}
    lock(true);
    try{
      await enabledSession();
      if(state.managed)await compareHistory();
      if(!confirm(queue.length+'件をBot名義で投稿します。\n'+queue.map(x=>x.e.title).join('\n')+'\nよろしいですか？'))return;
      $('status-panel').classList.remove('hidden');
      for(const {e,payload} of queue){
        if(state.managed)e.forumId=payload.forumId;
        e.payload=payload;e.status='投稿準備中';renderCards();renderResults();
        try{
          const hash=await client.hash({...payload,apiVersion:1}),known=!e.forceNewOperation&&client.operations().find(m=>(m.forumId||(state.managed?state.registry?.legacyForumId:'')||'')===(payload.forumId||'')&&(m.basePayloadHash||m.payloadHash)===hash);
          if(known){e.operation=known;await checkOperation(e);e.payload=null;continue;}
          else e.operation=await client.issue(payload);
          e.status='投稿送信中';e.selected=false;renderCards();renderResults();await send(e);
          if(e.status==='認証切れ')break;
        }catch(error){showError(e,error);}
        renderResults();
      }
    }catch(error){$('auth-status').textContent=message(error.code);if(['SESSION_REQUIRED','SESSION_EXPIRED'].includes(error.code))$('worker-login').focus?.();}
    finally{lock(false);if(state.managed&&selected.some(e=>e.status==='成功'))void refreshHistory();}
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
      const copy={...original,id:'event-'+crypto.randomUUID(),selected:true,status:'未送信',operation:null,payload:null,result:null,error:'',safeToRetry:false,forceNewOperation:true,forumId:state.managed?state.forumId:undefined,imagePreview:null,imageBlob:null,selectedTags:[...(original.selectedTags||[])]};
      state.events.forEach(x=>x.selected=false);state.events.push(copy);state.reviewed=null;renderCards();await reviewImages();return;
    }
    if(!e)return;lock(true);
    try{if(button.dataset.check)await checkOperation(e);else{await enabledSession();await checkOperation(e);if(e.safeToRetry&&!e.wait&&e.payload&&confirm('「'+e.title+'」を同じ操作キーで再開しますか？'))await send(e);}}
    catch(error){showError(e,error);}finally{lock(false);}
  });
  $('parse').onclick=()=>{if(state.posting)return;for(const e of state.events)if(e.operation&&!state.history.some(h=>h.operation.operationId===e.operation.operationId))state.history.push(e);disposeImages();const result=runAnalysis($('source').value);state.events=result.events;state.reviewed=null;if(!state.events.length){$('input-status').textContent=result.warnings.join(' ');return;}$('results-panel').classList.remove('hidden');$('confirm-panel').classList.add('hidden');renderCards();renderResults();$('input-status').textContent=result.warnings.join(' ')||state.events.length+'件を認識しました。';};
  function edited(ev){if(state.posting||ev.type==='input'&&!ev.target.dataset.field)return;const card=ev.target.closest('.card'),e=state.events.find(x=>x.id===card?.dataset.id);if(!e||e.operation)return;
    if(ev.target.classList.contains('select-event'))e.selected=ev.target.checked;
    else if(ev.target.dataset.field)e[ev.target.dataset.field]=ev.target.value;
    else if(ev.target.dataset.tag){e.selectedTags=e.selectedTags||[];if(ev.target.checked&&e.selectedTags.length>=5&&!e.selectedTags.includes(ev.target.dataset.tag)){ev.target.checked=false;alert('タグは最大5件です');return;}e.selectedTags=ev.target.checked?[...new Set([...e.selectedTags,ev.target.dataset.tag])]:e.selectedTags.filter(x=>x!==ev.target.dataset.tag);}
    if(state.managed){state.duplicateMatches=[];state.historyUnverified=true;renderHistory();}
    disposeImages();renderPreview();card.classList.toggle('selected',e.selected);$('selected-count').textContent='投稿予定 '+state.events.filter(x=>x.selected&&!x.operation).length+'件';$('review').disabled=!state.events.some(x=>x.selected&&!x.operation);
  }
  $('cards').addEventListener('change',edited);$('cards').addEventListener('input',edited);
  $('cards').addEventListener('click',ev=>{if(state.posting||!ev.target.classList.contains('auto-tag'))return;const e=state.events.find(x=>x.id===ev.target.closest('.card').dataset.id);if(!e||e.operation)return;autoTagEvent(e);disposeImages();renderCards();});
  $('select-all').onclick=()=>{state.events.forEach(e=>e.selected=!e.operation);disposeImages();renderCards();};
  $('clear-all').onclick=()=>{state.events.forEach(e=>e.selected=false);disposeImages();renderCards();};
  $('review').onclick=async()=>{await reviewImages();window.scrollTo({top:$('confirm-panel').offsetTop-20,behavior:'smooth'});};
  $('back').onclick=()=>$('confirm-panel').classList.add('hidden');
  $('post').onclick=postSelected;
  $('worker-login').onclick=async()=>{if(state.posting)return;lock(true);let loginStage='complete';try{forumConfig=null;await client.login();loginStage='session';const s=await client.session();$('auth-status').textContent='ログインしました（有効期限1時間・延長なし）。'+(s.capabilities?.forumPosts?'':' 本番投稿機能はまだ公開されていません。');for(const e of allResults().filter(x=>x.operation))await checkOperation(e);if(s.capabilities?.multiForum)await loadRegistry(true);}catch(error){const code=Object.hasOwn(loginErrors,error?.code)?error.code:'LOGIN_UNKNOWN';$('auth-status').textContent='Discordログインできませんでした。'+(loginErrors[code]||'予期しないエラーです。')+'（診断：'+loginStage+'/'+code+'）';}finally{lock(false);}};
  $('worker-logout').onclick=async()=>{if(state.posting)return;lock(true);try{await client.logout();clearForum();state.registry=null;renderRegistry();disposeImages();renderPreview();forumConfig=null;$('auth-status').textContent='ログアウトしました。操作キーはこのタブに保持し、再ログイン後に照会できます。';}catch{$('auth-status').textContent='サーバーでの失効を確認できません。再試行してください。';}finally{lock(false);}};
  $('fetch-tags').onclick=async()=>{if(state.posting)return;try{await loadTags();}catch{$('auth-status').textContent='タグを取得できませんでした。';}};
  function clearForum(){
    state.forumGeneration++;state.forumReady=false;state.forumId='';forumConfig=null;state.historyItems=[];state.historySync=null;state.duplicateMatches=[];state.historyUnverified=true;
    for(const e of state.events.filter(e=>!e.operation)){e.selectedTags=[];e.forumId=undefined;}
    disposeImages();renderCards();renderPreview();renderHistory();
  }
  function renderRegistry(){
    if(!$('registered-forum'))return;
    $('registered-forum').innerHTML='<option value="">投稿先を選択</option>'+(state.registry?.forums||[]).map(f=>'<option value="'+escapeHtml(f.id)+'">'+escapeHtml(f.name)+' ('+escapeHtml(f.id)+')</option>').join('');
    $('registered-forum').value=state.forumId;
  }
  async function loadRegistry(fromLogin=false){
    if(state.posting&&!fromLogin)return;state.managed=true;const generation=state.forumGeneration;
    try{const r=await client.management('/api/forums');if(generation!==state.forumGeneration)return;state.registry=r;await activateForum(r.selected||'',false,fromLogin);}
    catch{clearForum();$('forum-status').textContent='投稿先一覧を取得できませんでした。再読込してください。';}
  }
  async function loadTags(){
    const id=state.forumId,generation=state.forumGeneration;
    if(state.managed&&!id)return;
    const r=await client.tags(state.managed?id:undefined),data=r.data;
    if(generation!==state.forumGeneration||id!==state.forumId)return;
    if(!r.ok||!window.PosterClient.snowflake(data.forumId)||state.managed&&data.forumId!==id||!data.mapping)throw new Error('TAGS_UNAVAILABLE');
    forumConfig=data;disposeImages();renderCards();$(state.managed?'forum-status':'auth-status').textContent='タグを取得しました。';
  }
  async function activateForum(id,save=true,fromLogin=false){
    if(state.posting&&!fromLogin)return;const expectedGeneration=state.registry?.forums.find(f=>f.id===id)?.generation;clearForum();state.forumId=id;const generation=state.forumGeneration;renderRegistry();
    if(!id)return;
    try{
      if(save){
        for(let attempt=0;attempt<3;attempt++){
          if(generation!==state.forumGeneration)return;
          try{
            const selected=await client.management('/api/forums/select',{forumId:id,expectedRevision:state.registry?.revision,expectedGeneration});
            if(generation!==state.forumGeneration)return;
            state.registry=selected;break;
          }catch(error){
            if(generation!==state.forumGeneration)return;
            if(error.code!=='SELECTION_CONFLICT'||attempt===2)throw error;
            const latest=await client.management('/api/forums');
            if(generation!==state.forumGeneration)return;
            state.registry=latest;
            if(latest.forums.find(f=>f.id===id)?.generation!==expectedGeneration)throw new Error('TARGET_CHANGED');
          }
        }
      }
      if(generation!==state.forumGeneration)return;
      await loadTags();if(generation!==state.forumGeneration)return;state.forumReady=true;
      $('forum-status').textContent='投稿先を選択しました。';await readHistory();void refreshHistory();
    }catch{if(generation===state.forumGeneration){if(save)await loadRegistry();else {state.forumReady=false;renderRegistry();}$('forum-status').textContent='投稿先の登録または権限が変更されました。選択を確認してください。';}}
  }
  function renderHistory(){
    if(!$('history-list'))return;
    $('duplicate-status').textContent=state.managed&&state.historyUnverified?'重複未確認：履歴の取得が完了していません。警告のみで投稿できます。':'';
    $('history-status').textContent=state.historyUnverified?'重複未確認：履歴は未取得・取得途中・取得不能です。警告のみで投稿できます。':'履歴取得完了（取得時点）。警告のみで投稿できます。';
    if(state.historySync?.error)$('history-status').textContent+=' 取得失敗・途中状態です。時間をおいて「履歴を取得・続きから再開」を押してください。';
    if(state.historySync?.retryAfterSeconds)$('history-status').textContent+=' 待機目安 '+Math.ceil(state.historySync.retryAfterSeconds)+'秒。';
    $('history-list').innerHTML=state.historyItems.filter(r=>r.status!=='foreign').map(r=>'<li><a target="_blank" rel="noopener noreferrer" href="'+escapeHtml(r.url)+'">'+escapeHtml(r.title)+'</a> '+escapeHtml(r.createdAt)+' '+escapeHtml({deleted:'削除済み',body_deleted:'最初の本文は削除済み',unavailable:'取得不能',pending:'本文確認中'}[r.status]||'')+'</li>').join('');
    const warnings=[];state.events.filter(e=>e.selected&&!e.operation).forEach((e,i)=>{for(const m of state.duplicateMatches[i]||[])warnings.push('<li>'+escapeHtml(e.title)+' → <a target="_blank" rel="noopener noreferrer" href="'+escapeHtml(m.url)+'">'+escapeHtml(m.title)+'</a>（類似度 '+m.score+'%'+(m.differentEdition?'・回数等が異なるため別開催の可能性':'')+'）</li>');});
    $('duplicate-warning').innerHTML=warnings.length?'<p class="warning">重複候補があります。警告のみで投稿は続行できます。</p><ul>'+warnings.join('')+'</ul>':'';
  }
  async function readHistory(after=null,append=false){
    if(!state.managed||!state.forumId)return;
    const id=state.forumId,generation=state.forumGeneration;
    try{
      const r=await client.management('/api/forums/'+id+'/history/read',after?{after}:{});
      if(id!==state.forumId||generation!==state.forumGeneration)return;
      state.historyItems=append?[...state.historyItems,...(r.items||[])]:r.items||[];state.historyAfter=r.after;state.historySync=r.sync;state.historyUnverified=!r.sync?.complete;
    }catch{if(generation===state.forumGeneration)state.historyUnverified=true;}
    if(generation===state.forumGeneration){renderHistory();await compareHistory();}
  }
  async function refreshHistory(){
    if(!state.forumId||state.syncingGeneration===state.forumGeneration)return;
    const id=state.forumId,g=state.forumGeneration;state.syncingGeneration=g;
    try{
      for(let step=0;step<20;step++){
        const r=await client.management('/api/forums/'+id+'/history/sync',{});
        if(g!==state.forumGeneration)return;
        state.historySync=r.sync;await readHistory();
        if(r.busy||!r.sync?.more||r.sync.status==='partial')break;
      }
    }catch{if(g===state.forumGeneration){state.historyUnverified=true;renderHistory();}}
    finally{if(state.syncingGeneration===g)state.syncingGeneration=null;}
  }
  async function compareHistory(){
    if(!state.managed||!state.forumId)return;
    const id=state.forumId,generation=state.forumGeneration,titles=state.events.filter(e=>e.selected&&!e.operation).map(e=>e.title),signature=JSON.stringify(titles);
    try{
      const r=await client.management('/api/forums/'+id+'/history/compare',{titles:titles.slice(0,100)});
      if(generation!==state.forumGeneration||id!==state.forumId||signature!==JSON.stringify(state.events.filter(e=>e.selected&&!e.operation).map(e=>e.title)))return;
      state.duplicateMatches=r.matches||[];state.historyUnverified=r.unverified!==false||titles.length>100;
    }catch{if(generation===state.forumGeneration){state.duplicateMatches=[];state.historyUnverified=true;}}
    if(generation===state.forumGeneration)renderHistory();
  }
  if($('registered-forum')){
    $('registered-forum').onchange=()=>{if(!state.posting)activateForum($('registered-forum').value);};
    $('reload-forums').onclick=()=>{if(!state.posting)loadRegistry();};
    $('remove-forum').onclick=async()=>{if(state.posting||!state.forumId)return;const id=state.forumId;clearForum();try{state.registry=await client.management('/api/forums/remove',{forumId:id});renderRegistry();}catch{$('forum-status').textContent='登録解除できませんでした。一覧を再読込してください。';}};
    $('load-guilds').onclick=async()=>{
      const generation=state.forumGeneration;try{
        let after=null,guilds=[];do{const r=await client.management('/api/discord/guilds',after?{after}:{});if(generation!==state.forumGeneration)return;guilds.push(...r.guilds);after=r.after;}while(after);
        $('guild-select').innerHTML='<option value="">サーバーを選択</option>'+guilds.map(g=>'<option value="'+escapeHtml(g.id)+'">'+escapeHtml(g.name)+'</option>').join('');
      }catch{$('forum-status').textContent='サーバー一覧を取得できませんでした。時間をおいて再取得してください。';}
    };
    let candidateGeneration=0;
    $('guild-select').onchange=async()=>{const g=++candidateGeneration;const guildId=$('guild-select').value;$('candidate-forum').innerHTML='';if(!guildId)return;try{const r=await client.management('/api/discord/forums',{guildId});if(g!==candidateGeneration)return;$('candidate-forum').innerHTML=r.forums.map(f=>'<option value="'+escapeHtml(f.id)+'">'+escapeHtml(f.name)+'</option>').join('');}catch{$('forum-status').textContent='利用可能なフォーラムを取得できませんでした。';}};
    $('register-forum').onclick=async()=>{if(state.posting)return;const id=$('candidate-forum').value;if(!id)return;try{state.registry=await client.management('/api/forums/register',{forumId:id});renderRegistry();await activateForum(id);}catch{$('forum-status').textContent='所属と権限を確認できず、登録できませんでした。';}};
    $('refresh-history').onclick=()=>refreshHistory();
    $('more-history').onclick=()=>{if(state.historyAfter)readHistory(state.historyAfter,true);};
  }
  try{localStorage.removeItem(STORE);}catch{$('input-status').textContent='旧保存URLを削除できません。サイトデータから削除してください。新バージョンでは利用しません。';}
  if(!client.storageReady())$('input-status').textContent='操作情報の保存を利用できません。投稿は停止します。';
  window.addEventListener?.('pagehide',disposeImages);
  renderResults();
  client.session().then(async s=>{for(const e of state.history)await checkOperation(e);if(s.capabilities?.multiForum)await loadRegistry();}).catch(()=>{});
  window.EventPoster={splitEvents,extractLinks,parsePeriod,runAnalysis,autoTagEvent,appliedTagsFor,contentFor,validateEvent,MAX_TAGS,TAG_RULES};
}());
