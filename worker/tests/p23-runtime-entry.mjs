import worker from '../src/index.mjs';
export {AuthState} from '../src/index.mjs';
import {createDiscordMock,addThread} from './p23-discord-mock.mjs';
const mock=createDiscordMock();
addThread(mock,50000,'【東京】第5回 謎解きフェスティバル');
addThread(mock,50001,'別の人のイベント',{owner:'888'});
addThread(mock,50002,'アーカイブの催し',{archived:true});
globalThis.fetch=mock.fetch;
export default {async fetch(request,env){
  const h=new Headers(request.headers);h.set('Host',new URL(request.url).host);
  request=new Request(request,{headers:h});
  const mode=h.get('X-Test-Mode');
  if(mode)mock.state.mode=mode==='500'?'unknown':mode;
  // Test-only: control advisory read failures without any production route.
  if(new URL(request.url).pathname==='/__test/history-error'){mock.state.historyDenied=true;return Response.json({ok:true});}
  const response=await worker.fetch(request,env),out=new Response(response.body,response);
  out.headers.set('X-Test-Writes',String(mock.state.writes.length));
  return out;
}};
