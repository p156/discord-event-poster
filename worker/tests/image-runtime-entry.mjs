import worker from '../src/index.mjs';
import {findOfficialImage} from '../src/official-image-fetch.mjs';
import {discordOAuthMock} from './oauth-mock.mjs';
export {AuthState} from '../src/index.mjs';
let mode='',writes=0,external=0,embed;
const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQqzjxHwAEdAJeoWfKLgAAAABJRU5ErkJggg=='),c=>c.charCodeAt(0));
globalThis.fetch=async(url,opts={})=>{
 const u=new URL(url);
 if(u.origin==='https://discord.com'){
  if(u.pathname==='/api/oauth2/token'||u.pathname==='/api/v10/users/@me')return discordOAuthMock(url,opts);
  if(u.pathname==='/api/v10/channels/123')return Response.json({id:'123',guild_id:'456',type:15,flags:0,available_tags:[]});
  if(u.pathname!=='/api/v10/channels/123/threads'||opts.method!=='POST')throw Error('UNEXPECTED_DISCORD');writes++;const body=JSON.parse(opts.body);embed=body.message.embeds;if(body.message.allowed_mentions.parse.length)throw Error('MENTIONS');
  return Response.json({id:'789',type:11,parent_id:'123',guild_id:'456',message:{id:'790',channel_id:'789'}});
 }
 if(!['realescapegame.jp','www.scrapmagazine.com'].includes(u.hostname))throw Error('NETWORK_DISABLED');external++;
 if(opts.method!=='GET'||opts.redirect!=='manual'||Object.keys(opts.headers).join(',')!=='Accept')throw Error('SECRET_HEADERS');
 if(u.pathname.endsWith('.png')){if(mode==='thumbnail-bad')return new Response(null,{status:302,headers:{Location:'https://127.0.0.1/private'}});if(u.pathname==='/bad.png')return new Response('bad',{headers:{'Content-Type':'image/png'}});return new Response(png,{headers:{'Content-Type':'image/png','Set-Cookie':'TEST_SECRET'}});}
 if(mode==='oversize')return new Response('x'.repeat(262145),{headers:{'Content-Type':'text/html'}});
 const html=u.pathname==='/twitter'?'<head><meta property="og:image" content="/bad.png"><meta name="twitter:image" content="/twitter.png"></head>':u.pathname==='/entity'?'<head><meta property="og:image" content="/entity&#46;png"></head>':u.pathname==='/none'?'<head><base href="https://evil.test/"><script>meta</script></head><body><meta property="og:image" content="/body.png"></body>':u.pathname==='/multiple'?'<HEAD><META CONTENT="/image.png" PROPERTY="OG:IMAGE"><meta name="twitter:image" content="/twitter.png"></HEAD>':'<head><meta name="twitter:image" content="/twitter.png"><meta property="og:image" content="/image.png"></head>';
 return new Response(html,{headers:{'Content-Type':'text/html'}});
};
export default {async fetch(request,env){const h=new Headers(request.headers);h.set('Host',new URL(request.url).host);request=new Request(request,{headers:h});mode=h.get('X-Test-Mode')||'';
 const r=new URL(request.url).pathname==='/test/parse'?Response.json(await findOfficialImage('https://realescapegame.jp'+(h.get('X-Test-Path')||'/event'))):await worker.fetch(request,env);
 const out=new Response(r.body,r);out.headers.set('X-Test-Writes',String(writes));out.headers.set('X-Test-External',String(external));if(embed)out.headers.set('X-Test-Embed',JSON.stringify(embed));return out;
}};
