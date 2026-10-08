/* Discord Event Poster v0.1.0 - no external runtime dependencies. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const STORE = "discord-event-poster.webhook";
  const MAX_EVENTS = 5;
  const FORUM_TAG_IDS = Object.freeze({周遊型:"",ホール型:"",ルーム型:"",オンライン:"",持ち帰り:"",イマーシブ:"",謎解き:"",ホラー:""});
  const TAG_RULES = Object.freeze({周遊型:/周遊|街歩き|まち歩き/,ホール型:/ホール|劇場|会館/,ルーム型:/ルーム型|室内型|部屋からの脱出/,オンライン:/オンライン|配信|リモート|web開催/i,持ち帰り:/持ち帰り|お持ち帰り|キット販売/,イマーシブ:/イマーシブ|没入型|没入体験/,謎解き:/謎解き|脱出|ミステリー/,ホラー:/ホラー|恐怖|怪異|お化け屋敷/});
  const state = { events: [], posting: false };
  const today = new Date();

  function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
  function parseWebhook(raw) {
    try { const u = new URL(raw.trim()); if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash || !/^(discord\.com|discordapp\.com|canary\.discord\.com|ptb\.discord\.com)$/.test(u.hostname) || !/^\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(u.pathname)) return null; return u; } catch { return null; }
  }
  function splitEvents(text) { const re = /【([^】\n]{1,40})】\s*[『「“"]([^』」”"]+)[』」”"]/g; const starts = []; let m; while ((m = re.exec(text))) starts.push({ index:m.index, region:m[1].trim(), title:m[2].trim(), end:re.lastIndex }); if (!starts.length) return { events:[], warnings:["イベント開始形式（【地域】『タイトル』）を認識できませんでした。"] }; const events = starts.map((s, i) => ({ raw:text.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : text.length).trim(), region:s.region, title:s.title })); const prefix = text.slice(0, starts[0].index).trim(); return { events, warnings:prefix ? [`先頭にイベントとして認識できない文章があります（${prefix.length}文字）。`] : [] }; }
  function extractLinks(raw) { const links = []; const md = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g; let m; while ((m = md.exec(raw))) links.push({ label:m[1], url:m[2] }); const plain = raw.match(/https?:\/\/[^\s)]+/g) || []; plain.forEach((url) => { if (!links.some((x) => x.url === url)) links.push({ label:url, url }); }); return links.filter((x) => !/^(https?:\/\/t\.co|https?:\/\/[^/]+\/(?:hashtag|emoji)\b)/i.test(x.url)); }
  function datePart(raw) { const m = raw.match(/(?:^|[\s\n])((?:\d{4}[年\/-])?\d{1,2})[月\/-](\d{1,2})(?:日)?/); return m ? { month:m[1].replace(/^\d{4}[年\/-]/, ""), day:m[2], explicitYear:/^\d{4}/.test(m[1]) } : null; }
  function parsePeriod(raw) { const match = raw.match(/(\d{1,2})\s*[月\/]\s*(\d{1,2})(?:日)?\s*(?:〜|～|-|~)\s*(?:(\d{1,2})\s*[月\/]\s*)?(\d{1,2})?(?:日)?/); const opening = raw.match(/(\d{1,2})\s*[月\/]\s*(\d{1,2})(?:日)?\s*(?:開幕|スタート)/); const onlyEnd = raw.match(/〜\s*(\d{1,2})\s*[月\/]\s*(\d{1,2})/); if (match) { const sm=match[1], sd=match[2], em=match[3] || sm, ed=match[4]; const startYear=today.getFullYear(), endYear=(Number(em)<Number(sm)?startYear+1:startYear); return { start:`${startYear}/${sm}/${sd}`, end:`${endYear}/${em}/${ed || ""}`, warning:!match[4]?"終了日が不明です。":(!match[3]&&Number(ed)<Number(sd)?"年またぎの可能性があります。":"") }; } if (opening) return { start:`${today.getFullYear()}/${opening[1]}/${opening[2]}`, end:"", warning:"「開幕」表記から開始日のみ抽出しました。年は推定です。" }; if (onlyEnd) return { start:"", end:`${today.getFullYear()}/${onlyEnd[1]}/${onlyEnd[2]}`, warning:"開始日が不明です。" }; const relative = raw.match(/(明日|明後日)開幕/); if (relative) { const d=new Date(today); d.setDate(d.getDate()+(relative[1]==="明日"?1:2)); return { start:d.toISOString().slice(0,10).replaceAll("-","/"), end:"", warning:`「${relative[1]}」を解析基準日から推定しました。` }; } return { start:"", end:"", warning:"開催期間を抽出できませんでした。" }; }
  function analyze(raw, index) { const links=extractLinks(raw); const p=parsePeriod(raw); const tags=(raw.match(/#[^\s#]+/g)||[]).join(" "); const desc=raw.replace(/^【[^】]+】\s*[『「“"][^』」”"]+[』」”"]\s*/,"" ).replace(/\[[^\]]+\]\([^)]*\)|https?:\/\/[^\s)]+/g," ").replace(/#[^\s#]+/g," ").trim(); return { id:`event-${index+1}`, selected:true, status:"未送信", region:"", title:"", start:p.start,end:p.end,description:desc, url:links[0]?.url||"", tags, selectedTags:[], tagReasons:[], raw, warnings:p.warning?[p.warning]:[], candidates:links.map((x)=>x.url), duplicate:false, ...{ region:raw.match(/^【([^】]+)】/)?.[1]?.trim()||"", title:raw.match(/^【[^】]+】\s*[『「“"]([^』」”"]+)[』」”"]/)?.[1]?.trim()||"" } }; }
  function runAnalysis(text) { const split=splitEvents(text); const events=split.events.slice(0,MAX_EVENTS).map((x,i)=>analyze(x.raw,i)); const seen=new Map(); events.forEach((e)=>{ const key=`${e.region}|${e.title}`; e.duplicate=seen.has(key); seen.set(key,true); if(e.duplicate)e.warnings.push("同じ入力内に同じ地域・タイトルがあります。"); }); if(split.events.length>MAX_EVENTS)split.warnings.push(`最大${MAX_EVENTS}件まで認識しました。`); return { events, warnings:split.warnings }; }
  function autoTagEvent(e) { const text=`${e.title} ${e.description} ${e.raw}`; const matched=Object.keys(TAG_RULES).filter(tag=>TAG_RULES[tag].test(text)); e.selectedTags=matched; e.tagReasons=matched.map(tag=>`「${tag}」のルールに一致`); e.warnings=e.warnings.filter(x=>!x.startsWith("自動判定：")); if(matched.length)e.warnings.push(`自動判定：${matched.join("・")}`); return matched; }
  function appliedTagsFor(e) { return (e.selectedTags||[]).map(tag=>({tag,id:FORUM_TAG_IDS[tag]})); }
  function contentFor(e) { const period=e.start||e.end?`${e.start||"不明"}〜${e.end||""}`:"不明"; return `📍 **開催地域：${e.region||"不明"}**\n\n📅 **開催期間：${period}**\n\n${e.description||""}\n\n${e.url?`🔗 **公式サイト**\n${e.url}\n\n`:""}${e.tags||""}`.trim(); }
  function threadName(e) { return `【${e.region||"不明"}】${e.title}`; }
  function validateEvent(e) { const errors=[]; if(!e.title)errors.push("タイトルがありません"); if(threadName(e).length>100)errors.push("スレッド名が100文字を超えています"); if(contentFor(e).length>2000)errors.push("本文が2000文字を超えています"); if(e.url){try{const u=new URL(e.url);if(!/^https?:$/.test(u.protocol))errors.push("公式URLはhttp/httpsのみです")}catch{errors.push("公式URLが不正です")}} return errors; }
  function renderCards() { $("count").textContent=`${state.events.length}件`; $("cards").innerHTML=state.events.map((e,i)=>`<article class="card ${e.selected?"selected":""} ${e.duplicate?"duplicate":""}" data-id="${e.id}"><div class="card-top"><input ${state.posting?"disabled":""} class="select-event" type="checkbox" ${e.selected?"checked":""} aria-label="${escapeHtml(e.title)}を投稿対象にする"><div><h3>${escapeHtml(e.title||"無題のイベント")}</h3><p class="hint">元文 ${e.raw.length}文字・状態：${e.status}</p></div></div><div class="card-grid"><label>地域<input ${state.posting?"disabled":""} data-field="region" value="${escapeHtml(e.region)}"></label><label>タイトル<input ${state.posting?"disabled":""} data-field="title" value="${escapeHtml(e.title)}"></label><label>開始日<input ${state.posting?"disabled":""} data-field="start" value="${escapeHtml(e.start)}" placeholder="2026/10/23"></label><label>終了日<input ${state.posting?"disabled":""} data-field="end" value="${escapeHtml(e.end)}" placeholder="2027/01/17"></label><label>公式URL<input ${state.posting?"disabled":""} data-field="url" value="${escapeHtml(e.url)}" placeholder="https://..."></label><label>ハッシュタグ<input ${state.posting?"disabled":""} data-field="tags" value="${escapeHtml(e.tags)}"></label><label style="grid-column:1/-1">説明<textarea ${state.posting?"disabled":""} data-field="description">${escapeHtml(e.description)}</textarea></label><fieldset class="tag-field"><legend>イベントタグ（手動）</legend>${Object.keys(TAG_RULES).map(tag=>`<label><input type="checkbox" data-tag="${tag}" ${(e.selectedTags||[]).includes(tag)?"checked":""}>${tag}</label>`).join("")}<button type="button" class="small-button auto-tag">本文から自動判定</button><p class="hint">${e.tagReasons?.length?`判定根拠：${e.tagReasons.map(escapeHtml).join("／")}`:"自動判定はこのボタンを押した時だけ実行します。"}</p></fieldset></div>${e.warnings.length?`<p class="warning">⚠ ${e.warnings.map(escapeHtml).join(" / ")}</p>`:""}</article>`).join(""); $("selected-count").textContent=`投稿予定 ${state.events.filter(e=>e.selected).length}件`; $("review").disabled=state.posting||!state.events.some(e=>e.selected); }
  function renderPreview() { const selected=state.events.filter(e=>e.selected); $("preview").innerHTML=selected.map((e)=>`<article><strong>${escapeHtml(threadName(e))}</strong><br><br>${escapeHtml(contentFor(e))}</article>`).join(""); }
  function saveUrl() {
    try { const u=parseWebhook($("webhook").value); if($("remember").checked&&u)localStorage.setItem(STORE,u.href); else localStorage.removeItem(STORE); }
    catch { $("input-status").textContent="端末保存を利用できません。URLはこの画面内だけで使用します。"; $("remember").checked=false; }
  }
  async function postOne(e, endpoint) {
    for (let attempt=0; attempt<4; attempt++) {
      const controller=new AbortController();
      let timer;
      try {
        const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(new Error("タイムアウト。投稿された可能性があります。Discordで確認してください。"),{unknown:true}));},30000);});
        const task=(async()=>{
          const configured=appliedTagsFor(e); const invalid=configured.filter(x=>x.id&&!/^\d+$/.test(x.id)); if(invalid.length) throw Object.assign(new Error("フォーラムタグ設定が不正です。設定を確認してください。"),{known:true}); const applied_tags=configured.filter(x=>x.id).map(x=>x.id); const payload={content:contentFor(e),thread_name:threadName(e),allowed_mentions:{parse:[]}}; if(applied_tags.length)payload.applied_tags=applied_tags; const response=await fetch(endpoint,{method:"POST",redirect:"error",credentials:"omit",referrerPolicy:"no-referrer",signal:controller.signal,headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
          let body=null;try{body=await response.json()}catch{}
          if(response.status===429) {
            const header=response.headers.get("Retry-After");
            const numeric=Number(header);
            const headerWait=header && !Number.isFinite(numeric)?Math.max(0,(Date.parse(header)-Date.now())/1000):numeric;
            const seconds=Math.max(Number(body?.retry_after)||0,headerWait||0);
            return {rate:true,seconds};
          }
          if(!response.ok) {
            const hints={400:"不正なリクエストです。投稿内容を確認してください。",401:"Webhookの認証に失敗しました。URLを確認してください。",403:"投稿する権限がありません。Webhookの権限を確認してください。",404:"Webhookが見つかりません。削除されていないか確認してください。"};
            throw Object.assign(new Error("HTTP "+response.status+"。"+(hints[response.status]||(response.status>=500?"サーバー障害。投稿結果をDiscordで確認してください。":"Webhook設定・投稿内容を確認してください。"))),{known:true,unknown:response.status>=500});
          }
          if(!body?.id || !body?.channel_id) throw Object.assign(new Error("成功応答の投稿IDを確認できません。Discordで確認してください。"),{unknown:true});
          return {body};
        })();
        const result=await Promise.race([task,timeout]);
        clearTimeout(timer);
        if(result.rate){
          if(attempt===3 || !Number.isFinite(result.seconds) || result.seconds>60) throw Object.assign(new Error("HTTP 429。レート制限。時間を置いて失敗イベントを再送信してください。"),{known:true});
          $("result-summary").textContent="レート制限のため "+Math.ceil(result.seconds)+"秒待機中…";
          await new Promise(resolve=>setTimeout(resolve,Math.max(1,result.seconds*1000)));
          continue;
        }
        return result.body;
      } catch(error) {
        if(error.unknown || error.known) throw error;
        if(error instanceof TypeError || error.name==="AbortError") throw Object.assign(new Error("CORS・ネットワーク障害。投稿結果は不明です。Discordで確認してください。"),{unknown:true});
        throw Object.assign(new Error("通信を完了できませんでした。投稿結果は不明です。Discordで確認してください。"),{unknown:true});
      } finally {clearTimeout(timer);}
    }
  }
  async function postSelected(failedOnly=false) {
    if(state.posting)return;
    const url=parseWebhook($("webhook").value);
    if(!url){$("input-status").textContent="Webhook URLを確認してください。";alert("Webhook URLを確認してください。");return}
    const selected=state.events.filter(e=>failedOnly?e.status==="失敗":e.selected&&(e.status==="未送信"||e.status==="失敗"));
    if(!selected.length){alert("送信可能なイベントがありません。成功・結果不明は再送信しません。");return;}
    const invalid=selected.flatMap(e=>validateEvent(e).map(x=>e.title+": "+x));
    const unconfigured=selected.flatMap(e=>(e.selectedTags||[]).filter(tag=>!FORUM_TAG_IDS[tag]).map(tag=>`${e.title}: ${tag}のタグIDが対象フォーラムに未設定です`));
    if(unconfigured.length){alert("投稿できないタグ設定があります。\n"+unconfigured.join("\n"));return;}
    if(invalid.length){alert("投稿できないイベントがあります。\n"+invalid.join("\n"));return;}
    if(!confirm(selected.length+"件をDiscordへ投稿します。よろしいですか？"))return;
    const queue=selected.map(e=>({original:e,snapshot:{...e}}));
    url.searchParams.set("wait","true");
    saveUrl(); state.posting=true;
    const controls=["post","parse","webhook","remember","forget","review","select-all","clear-all","retry-failed"];
    controls.forEach(id=>$(id).disabled=true);
    $("status-panel").classList.remove("hidden");
    try {
      for(const {original:e,snapshot} of queue){
        e.status="送信中";renderCards();renderResults();
        try{const body=await postOne(snapshot,url.href);e.status="成功";e.messageId=body.id;e.channelId=body.channel_id;e.error="";e.selected=false;}
        catch(error){e.status=error.unknown?"結果不明":"失敗";e.error=error.message;e.selected=false;}
        renderResults();
      }
    } finally {
      state.posting=false;controls.forEach(id=>$(id).disabled=false);renderCards();renderResults();
    }
  }
  function renderResults() {
    const results=state.events.filter(e=>e.status!=="未送信");
    $("result-summary").textContent=results.filter(e=>e.status==="成功").length+"/"+results.length+"件が成功しました。";
    $("post-results").innerHTML=results.map(e=>'<div class="result '+(e.status==="成功"?"ok":"error")+'"><strong>'+escapeHtml(e.status)+'：</strong>'+escapeHtml(e.title)+(e.status==="成功"?'<br><a target="_blank" rel="noopener noreferrer" href="https://discord.com/channels/@me/'+encodeURIComponent(e.channelId)+'/'+encodeURIComponent(e.messageId)+'">投稿を開く</a>':'<br><small>'+escapeHtml(e.error||"")+'</small>')+'</div>').join("");
    $("retry-failed").classList.toggle("hidden",!state.events.some(e=>e.status==="失敗"));
    $("retry-failed").onclick=()=>postSelected(true);
  }
  $("toggle-secret").onclick=()=>{const input=$("webhook");input.type=input.type==="password"?"text":"password";$("toggle-secret").textContent=input.type==="password"?"表示":"隠す"}; $("remember").onchange=saveUrl; $("forget").onclick=()=>{localStorage.removeItem(STORE);$("webhook").value="";$("remember").checked=false}; $("parse").onclick=()=>{const result=runAnalysis($("source").value);state.events=result.events;if(!state.events.length){$("input-status").textContent=result.warnings.join(" ");return}$("results-panel").classList.remove("hidden");$("confirm-panel").classList.add("hidden");renderCards();$("input-status").textContent=result.warnings.join(" ")||`${state.events.length}件を認識しました。`}; $("cards").addEventListener("change",(ev)=>{const card=ev.target.closest(".card");if(!card)return;const e=state.events.find(x=>x.id===card.dataset.id);if(ev.target.classList.contains("select-event"))e.selected=ev.target.checked;else if(ev.target.dataset.field)e[ev.target.dataset.field]=ev.target.value;card.classList.toggle("selected",e.selected);$("selected-count").textContent=`投稿予定 ${state.events.filter(x=>x.selected).length}件`;$("review").disabled=!state.events.some(x=>x.selected)}); $("cards").addEventListener("input",(ev)=>{const card=ev.target.closest(".card"),e=state.events.find(x=>x.id===card?.dataset.id);if(e&&ev.target.dataset.field)e[ev.target.dataset.field]=ev.target.value}); $("select-all").onclick=()=>{state.events.forEach(e=>e.selected=true);renderCards()};$("clear-all").onclick=()=>{state.events.forEach(e=>e.selected=false);renderCards()};$("review").onclick=()=>{renderPreview();$("confirm-panel").classList.remove("hidden");window.scrollTo({top:$('confirm-panel').offsetTop-20,behavior:"smooth"})};$("back").onclick=()=>$("confirm-panel").classList.add("hidden");$("post").onclick=postSelected;
  $("webhook").addEventListener("input",saveUrl);
  $("post").onclick=()=>postSelected();
  const removeSaved=()=>{try{localStorage.removeItem(STORE);}catch{$("input-status").textContent="保存済みURLを削除できません。ブラウザのサイトデータを削除してください。";}};
  $("forget").onclick=()=>{removeSaved();$("webhook").value="";$("remember").checked=false;};
  try {const stored=localStorage.getItem(STORE);if(stored&&parseWebhook(stored)){$("webhook").value=stored;$("remember").checked=true;}}catch{$("input-status").textContent="端末保存を利用できません。";}

  $("cards").addEventListener("click",(ev)=>{if(!ev.target.classList.contains("auto-tag"))return;const e=state.events.find(x=>x.id===ev.target.closest(".card").dataset.id);autoTagEvent(e);renderCards()});
  $("cards").addEventListener("change",(ev)=>{const card=ev.target.closest(".card");if(!card)return;const e=state.events.find(x=>x.id===card.dataset.id);if(ev.target.classList.contains("select-event")){e.selected=ev.target.checked;return}if(!ev.target.dataset||!ev.target.dataset.tag)return;e.selectedTags=e.selectedTags||[];e.selectedTags=ev.target.checked?[...new Set([...e.selectedTags,ev.target.dataset.tag])]:e.selectedTags.filter(x=>x!==ev.target.dataset.tag)});
  window.EventPoster={splitEvents,extractLinks,parsePeriod,runAnalysis,autoTagEvent,appliedTagsFor,contentFor,validateEvent,parseWebhook,MAX_EVENTS,TAG_RULES};
}());
