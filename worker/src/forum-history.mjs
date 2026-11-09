import {OperationError} from './post-keys.mjs';
import {isSnowflake} from './forum-input.mjs';
import {readDiscord} from './discord-client.mjs';
import {managementCall,registeredTarget} from './forum-registry.mjs';
import {titleMatch,titleKey} from './title-match.mjs';
const root=id=>'history:v1:'+id+':';
const rowKey=(id,thread)=>root(id)+'row:'+thread;
const pendingKey=(id,thread)=>root(id)+'pending:'+thread;
const syncKey=id=>root(id)+'sync';
export async function historyState(storage,env,input,now=Date.now()){
  await registeredTarget(storage,env,input.forumId);
  const id=input.forumId;
  let run=await storage.get(syncKey(id));
  if(input.action==='history.read'){
    if(input.after&&!isSnowflake(input.after))throw new OperationError('INVALID_REQUEST');
    const prefix=root(id)+'row:',entries=await storage.list({prefix,limit:101,...(input.after?{startAfter:rowKey(id,input.after)}:{})});
    const rows=Array.from(entries.values()),more=rows.length>100;rows.splice(100);
    return {forumId:id,items:rows.filter(r=>r.status!=='foreign'),sync:publicRun(run),after:more?rows.at(-1).threadId:null};
  }
  if(input.action==='history.compare'){
    if(!Array.isArray(input.titles)||input.titles.length>100||input.titles.some(t=>typeof t!=='string'||t.length>100))throw new OperationError('INVALID_REQUEST');
    const matches=input.titles.map(()=>[]);let cursor,scanned=0,limited=false;
    while(true){
      const entries=await storage.list({prefix:root(id)+'row:',limit:100,...(cursor?{startAfter:cursor}:{})});
      for(const [k,row]of entries){
        cursor=k;scanned++;
        if(row.status==='deleted'||row.status==='foreign')continue;
        input.titles.forEach((title,i)=>{const match=titleMatch(title,row.title);if(match){matches[i].push({...match,title:row.title,url:row.url,threadId:row.threadId,status:row.status});matches[i].sort((a,b)=>b.score-a.score);matches[i].splice(20);}});
      }
      if(entries.size<100)break;
      if(scanned>=10000){limited=true;break;}
    }
    return {forumId:id,matches,unverified:limited||!run||run.stage!=='done'||run.gaps||run.status!=='complete',checkedAt:run?.finishedAt||null,limited};
  }
  if(input.action==='history.acquire'){
    if(run?.leaseUntil>now)return {busy:true,sync:publicRun(run)};
    if(!run||run.stage==='done'||input.restart===true){
      // Old pending entries are ignored by generation; cleared incrementally below.
      run={generation:crypto.randomUUID(),stage:'active',before:null,status:'running',gaps:false,startedAt:now,finishedAt:null};
    }
    run.lease=crypto.randomUUID();run.leaseUntil=now+45000;run.status='running';
    const pending=await storage.list({prefix:root(id)+'pending:',limit:2});
    const items=[];
    for(const [k,v]of pending)if(v.generation===run.generation)items.push(v);else await storage.delete(k);
    await storage.put(syncKey(id),run);await storage.sync();
    return {run,items};
  }
  if(input.action!=='history.commit'||!run||input.lease!==run.lease||run.leaseUntil<=now)throw new OperationError('HISTORY_STALE',409);
  // Commands originate only in the signed internal handler. Every row is scoped here.
  for(const row of input.rows||[]){
    if(!isSnowflake(row.threadId))throw new OperationError('INVALID_REQUEST');
    const prior=await storage.get(rowKey(id,row.threadId));
    if(row.status==='pending'&&prior?.generation===run.generation&&prior.status!=='pending')continue;
    await storage.put(rowKey(id,row.threadId),{...row,generation:run.generation});
    if(row.status==='pending')await storage.put(pendingKey(id,row.threadId),{...row,generation:run.generation});
    else await storage.delete(pendingKey(id,row.threadId));
  }
  if(input.error){run.status='partial';run.error=input.error;run.retryAfterSeconds=input.retryAfterSeconds||0;}
  else{
    Object.assign(run,input.progress||{});delete run.error;delete run.retryAfterSeconds;
    run.gaps=run.gaps||Boolean(input.gaps);
    if(run.stage==='done'){
      run.finishedAt=now;run.status=run.gaps?'partial':'complete';
    }
  }
  run.lease=null;run.leaseUntil=0;await storage.put(syncKey(id),run);await storage.sync();
  return {sync:publicRun(run)};
}
function publicRun(run){if(!run)return {status:'not_started',complete:false};return {status:run.status,complete:run.stage==='done'&&!run.gaps&&run.status==='complete',more:run.stage!=='done',startedAt:run.startedAt,finishedAt:run.finishedAt,error:run.error||null,retryAfterSeconds:run.retryAfterSeconds||0};}
function rowFor(thread,guildId){
  if(!isSnowflake(thread?.id)||typeof thread.name!=='string'||thread.name.length>100)throw new OperationError('DISCORD_RESPONSE_INVALID',502);
  return {threadId:thread.id,title:thread.name,titleKey:titleKey(thread.name),createdAt:new Date(Number((BigInt(thread.id)>>22n)+1420070400000n)).toISOString(),url:'https://discord.com/channels/'+guildId+'/'+thread.id,status:'pending',officialUrl:'',checkedAt:Date.now()};
}
export async function syncHistory(env,token,forumId,access,options){
  const lock=await managementCall(env,token,{action:'history.acquire',forumId});
  if(lock.busy)return lock;
  const {run,items}=lock,rows=[];let progress={},gaps=false;
  try{
    if(items.length){
      for(const row of items){
        try{
          const message=await readDiscord(env,'channels/'+row.threadId+'/messages/'+row.threadId,options);
          if(message?.id!==row.threadId||message.channel_id!==row.threadId||!isSnowflake(message.author?.id))throw new OperationError('HISTORY_AUTHOR_INVALID',502);
          if(message.author.id!==access.self.id){rows.push({...row,status:'foreign'});continue;}
          rows.push({...row,createdAt:message.timestamp||row.createdAt,status:'ok',checkedAt:Date.now(),officialUrl:(message.content||'').match(/https?:\/\/[^\s<>]+/i)?.[0]||''});
        }catch(error){
          if(error.status===429||error.kind==='TIMEOUT'||error.kind==='NETWORK')throw error;
          rows.push({...row,status:error.discordCode===10008?'body_deleted':'unavailable',checkedAt:Date.now()});gaps=true;
        }
      }
    }else if(run.stage==='active'||run.stage==='archive'){
      const data=run.stage==='active'?await readDiscord(env,'guilds/'+access.channel.guild_id+'/threads/active',options):await readDiscord(env,'channels/'+forumId+'/threads/archived/public?'+new URLSearchParams({limit:'50',...(run.before?{before:run.before}:{})}),options);
      if(!Array.isArray(data?.threads)||run.stage==='archive'&&typeof data.has_more!=='boolean')throw new OperationError('DISCORD_RESPONSE_INVALID',502);
      for(const t of data.threads){
        if(t.parent_id!==forumId)continue;
        if(t.owner_id===access.self.id)rows.push(rowFor(t,access.channel.guild_id));
        else if(!isSnowflake(t.owner_id))gaps=true;
      }
      if(run.stage==='active')progress={stage:'archive'};
      else if(data.has_more){
        const last=data.threads.at(-1)?.thread_metadata?.archive_timestamp;
        const before=Number.isFinite(Date.parse(last))?new Date(Date.parse(last)+1).toISOString():null;
        if(!before||!Number.isFinite(Date.parse(before))||run.before&&Date.parse(before)>=Date.parse(run.before))throw new OperationError('HISTORY_CURSOR_STALLED',502);
        progress={before};
      }else progress={stage:'verify',verifyAfter:null};
    }else if(run.stage==='verify'){
      const batch=await managementCall(env,token,{action:'history.read',forumId,after:run.verifyAfter||null});
      // Missing list entries are not evidence of deletion: confirm the channel.
      for(const row of batch.items.filter(r=>r.generation!==run.generation).slice(0,5)){
        try{
          const thread=await readDiscord(env,'channels/'+row.threadId,options);
          if(thread.parent_id!==forumId||thread.owner_id!==access.self.id){rows.push({...row,status:'foreign'});continue;}
          rows.push(rowFor(thread,access.channel.guild_id));
        }catch(e){
          if(e.status===429||e.kind==='NETWORK'||e.kind==='TIMEOUT')throw e;
          const deleted=e.discordCode===10003;
          rows.push({...row,status:deleted?'deleted':'unavailable'});if(!deleted)gaps=true;
        }
      }
      // Advance only past rows inspected in this step.
      const unseen=batch.items.filter(r=>r.generation!==run.generation);
      if(unseen.length>5)progress={verifyAfter:unseen[4].threadId};
      else progress=batch.after?{verifyAfter:batch.items.at(-1)?.threadId}:rows.some(r=>r.status==='pending')?{}:{stage:'done'};
    }
    return await managementCall(env,token,{action:'history.commit',forumId,lease:run.lease,rows,progress,gaps});
  }catch(e){
    return managementCall(env,token,{action:'history.commit',forumId,lease:run.lease,rows,error:e.status===429?'DISCORD_RATE_LIMITED':e.code||'HISTORY_UNAVAILABLE',retryAfterSeconds:e.rate?.retryAfterSeconds||0,gaps});
  }
}
