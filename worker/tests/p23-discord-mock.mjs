// No real network fallback. Shared by JS and real workerd contracts.
import {discordOAuthMock} from './oauth-mock.mjs';
export const channels={
  '123':{id:'123',name:'東京フォーラム',guild_id:'456',type:15,flags:0,available_tags:[{id:'100',name:'謎解き',moderated:false},{id:'101',name:'独自タグ',moderated:false}]},
  '124':{id:'124',name:'大阪フォーラム',guild_id:'457',type:15,flags:0,available_tags:[{id:'200',name:'謎解き',moderated:false},{id:'201',name:'別タグ',moderated:false}]},
  '125':{id:'125',name:'追加フォーラム',guild_id:'456',type:15,flags:0,available_tags:[]}
};
export function createDiscordMock(){
  const state={mode:null,writes:[],reads:[],archived:[],active:[],messages:{},deleted:new Set(),historyError:false,denyUser:false,denyBot:false,historyDenied:false,tagRemoved:false,guildPages:false};
  const read=async(url,opts={})=>{
    const u=new URL(url),p=u.pathname.replace('/api/v10/',''),auth=opts.headers?.Authorization;
    if(u.origin!=='https://discord.com')throw Error('REAL_NETWORK_FORBIDDEN');
    if(u.pathname==='/api/oauth2/token'||p==='users/@me'&&auth?.startsWith('Bearer '))return discordOAuthMock(url,opts);
    if(auth!=='Bot PRIVATE_TEST_BOT')throw Error('WRONG_BOT_TOKEN');
    if(opts.method==='POST'){
      const match=p.match(/^channels\/(123|124|125)\/threads$/);if(!match)throw Error('UNEXPECTED_WRITE');
      const body=JSON.parse(opts.body);state.writes.push({forumId:match[1],body});
      if(state.mode==='unknown')return new Response(null,{status:500});
      const id=String(9000+state.writes.length);return Response.json({id,type:11,parent_id:match[1],guild_id:channels[match[1]].guild_id,message:{id,channel_id:id}});
    }
    state.reads.push(p+u.search);
    if(p==='users/@me')return Response.json({id:'777',bot:true});
    if(p==='users/@me/guilds'){
      if(state.guildPages&&!u.searchParams.has('after'))return Response.json(Array.from({length:200},(_,i)=>({id:String(1000+i),name:'サーバー'+i})));
      return Response.json([{id:'456',name:'サーバーA'},{id:'457',name:'サーバーB'}]);
    }
    let m;
    if((m=p.match(/^guilds\/(456|457)\/channels$/)))return Response.json(Object.values(channels).filter(c=>c.guild_id===m[1]));
    if((m=p.match(/^guilds\/(456|457)\/members\/(222|777)$/))){
      if(m[2]==='222'&&state.denyUser)return Response.json({code:10007},{status:404});
      if(m[2]==='777'&&state.denyBot)return Response.json({code:10007},{status:404});
      return Response.json({user:{id:m[2]},roles:[]});
    }
    if((m=p.match(/^channels\/(123|124|125)\/permissions\/member\/(222|777)$/)))return Response.json({permissions:state.historyDenied?'3072':'68608'});
    if((m=p.match(/^channels\/(123|124|125)$/))){
      const c=structuredClone(channels[m[1]]);if(state.tagRemoved)c.available_tags=[];return Response.json(c);
    }
    if((m=p.match(/^guilds\/(456|457)\/threads\/active$/))){
      if(state.historyError)return Response.json({retry_after:1,global:false},{status:429});
      return Response.json({threads:state.active.filter(t=>t.guild_id===m[1]),members:[]});
    }
    if((m=p.match(/^channels\/(123|124|125)\/threads\/archived\/public$/))){
      const rows=state.archived.filter(t=>t.parent_id===m[1]).sort((a,b)=>Date.parse(b.thread_metadata.archive_timestamp)-Date.parse(a.thread_metadata.archive_timestamp));
      const before=u.searchParams.get('before'),page=rows.filter(t=>!before||Date.parse(t.thread_metadata.archive_timestamp)<Date.parse(before)).slice(0,50);
      return Response.json({threads:page,has_more:rows.filter(t=>!before||Date.parse(t.thread_metadata.archive_timestamp)<Date.parse(before)).length>50,members:[]});
    }
    if((m=p.match(/^channels\/(\d+)\/messages\/(\d+)$/))&&m[1]===m[2]){
      const msg=state.messages[m[1]];return msg?Response.json(msg):Response.json({code:10008},{status:404});
    }
    if((m=p.match(/^channels\/(\d+)$/))){
      if(state.deleted.has(m[1]))return Response.json({code:10003},{status:404});
      const t=[...state.active,...state.archived].find(t=>t.id===m[1]);return t?Response.json(t):Response.json({code:50001},{status:403});
    }
    throw Error('UNEXPECTED_TEST_ROUTE:'+p);
  };
  return {state,fetch:read};
}
export function addThread(mock,id,title,{forumId='123',owner='777',archived=false,body=true}={}){
  const thread={id:String(id),name:title,type:11,parent_id:forumId,guild_id:channels[forumId].guild_id,owner_id:owner,thread_metadata:{archive_timestamp:new Date(1700000000000+Number(id)*1000).toISOString()}};
  mock.state[archived?'archived':'active'].push(thread);
  if(body)mock.state.messages[id]={id:String(id),channel_id:String(id),author:{id:owner},timestamp:'2026-11-09T00:00:00.000Z',content:'🔗 **公式サイト**\nhttps://example.com/event'};
  return thread;
}
