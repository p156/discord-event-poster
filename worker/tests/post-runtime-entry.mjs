// Test-only harness. Mock all Discord traffic; absent from production entrypoint.
import worker from '../src/index.mjs';
export {AuthState} from '../src/index.mjs';
let writes=0,mode=null;
globalThis.fetch=async(url,opts={})=>{
  if(!String(url).startsWith('https://discord.com/api/v10/'))throw new Error('REAL_NETWORK_DISABLED');
  if(opts.method!=='POST'){if(url!=='https://discord.com/api/v10/channels/123')throw new Error('UNEXPECTED_TEST_ROUTE');return Response.json({id:'123',guild_id:'456',type:15,flags:0,available_tags:['周遊型','ホール型','ルーム型','オンライン','持ち帰り','イマーシブ','謎解き','ホラー'].map((name,i)=>({id:String(100+i),name,moderated:false}))});}
  if(url!=='https://discord.com/api/v10/channels/123/threads')throw new Error('UNEXPECTED_TEST_DESTINATION');
  writes++;if(mode==='timeout')return new Promise(()=>{});
  if(mode==='500')return new Response(null,{status:500});
  if(mode==='429')return Response.json({retry_after:120,global:true},{status:429});
  const body=JSON.parse(opts.body);if(body.message.allowed_mentions.parse.length||body.message.allowed_mentions.replied_user!==false)throw new Error('MENTIONS_UNSAFE');
  return Response.json({id:String(789+writes),type:11,parent_id:'123',guild_id:'456',message:{id:String(790+writes),channel_id:String(789+writes)}});
};
export default {async fetch(request,env){
  const headers=new Headers(request.headers);headers.set('Host',new URL(request.url).host);
  request=new Request(request,{headers});
  mode=request.headers.get('X-Test-Mode');
  const response=await worker.fetch(request,env);const out=new Response(response.body,response);out.headers.set('X-Test-Writes',String(writes));return out;
}};
