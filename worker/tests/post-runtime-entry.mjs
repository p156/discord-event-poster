// Test-only harness. Mock all Discord traffic; absent from production entrypoint.
import worker from '../src/index.mjs';
import {createPostHandler} from '../src/post-handler.mjs';
export {AuthState} from '../src/index.mjs';
let writes=0;
export default {async fetch(request,env){
  const headers=new Headers(request.headers);headers.set('Host',new URL(request.url).host);
  request=new Request(request,{headers});
  if(!new URL(request.url).pathname.startsWith('/api/forum/post'))return worker.fetch(request,env);
  const handler=createPostHandler({timeoutMs:20,fetchImpl:async(url,opts)=>{
    if(opts.method!=='POST'){if(url!=='https://discord.com/api/v10/channels/123')throw new Error('UNEXPECTED_TEST_ROUTE');return Response.json({id:'123',guild_id:'456',type:15,flags:0,available_tags:[]});}
    if(url!=='https://discord.com/api/v10/channels/123/threads')throw new Error('UNEXPECTED_TEST_DESTINATION');
    writes++;const mode=request.headers.get('X-Test-Mode');
    if(mode==='timeout')return new Promise(()=>{});
    if(mode==='500')return new Response(null,{status:500});
    if(mode==='429')return Response.json({retry_after:120,global:true},{status:429});
    return Response.json({id:'789',type:11,parent_id:'123',guild_id:'456',message:{id:'790',channel_id:'789'}});
  }});
  const response=await handler(request,env);const out=new Response(response.body,response);out.headers.set('X-Test-Writes',String(writes));return out;
}};
