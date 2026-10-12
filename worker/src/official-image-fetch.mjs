import {allowedUrl,officialPolicy} from './official-image-policy.mjs';
export class ImageFetchError extends Error {constructor(code){super(code);this.code=code;}}
const reject=code=>{throw new ImageFetchError(code);};
export async function boundedBytes(response,max,signal){
  const reader=response.body?.getReader();if(!reader)return new Uint8Array();const parts=[];let size=0;
  const abort=()=>{void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
  try{while(true){if(signal?.aborted)reject('IMAGE_TIMEOUT');const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max)reject('IMAGE_TOO_LARGE');parts.push(value);}if(signal?.aborted)reject('IMAGE_TIMEOUT');const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;}
  finally{signal?.removeEventListener('abort',abort);void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
}
async function timed(fn,timeoutMs){const controller=new AbortController();let timer;const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new ImageFetchError('IMAGE_TIMEOUT'));},timeoutMs);});try{return await Promise.race([fn(controller.signal),deadline]);}finally{clearTimeout(timer);controller.abort();}}
async function retrieve(raw,hosts,kind,signal,fetchImpl){
  const seen=new Set();let url=raw;
  for(let hop=0;hop<=2;hop++){
    url=allowedUrl(url,hosts,{image:kind==='image'});if(!url)reject('IMAGE_HOST_REJECTED');if(seen.has(url))reject('IMAGE_REDIRECT_REJECTED');seen.add(url);
    // New GET, never clone incoming Request/headers. Workers fetch does not expose
    // peer IP; restrict to audited operator-owned public hosts, never arbitrary DNS.
    const r=await fetchImpl(url,{method:'GET',redirect:'manual',credentials:'omit',referrerPolicy:'no-referrer',signal,headers:{Accept:kind==='html'?'text/html':'image/jpeg,image/png,image/gif,image/webp'}});
    if(signal.aborted){void r.body?.cancel().catch(()=>{});reject('IMAGE_TIMEOUT');}
    if([301,302,303,307,308].includes(r.status)){void r.body?.cancel().catch(()=>{});if(hop===2||!r.headers.get('Location'))reject('IMAGE_REDIRECT_REJECTED');try{url=new URL(r.headers.get('Location'),url).href;}catch{reject('IMAGE_REDIRECT_REJECTED');}continue;}
    if(!r.ok){void r.body?.cancel().catch(()=>{});reject('IMAGE_FETCH_FAILED');}
    const mime=(r.headers.get('Content-Type')||'').split(';')[0].trim().toLowerCase();
    if(kind==='html'?mime!=='text/html':!['image/jpeg','image/png','image/gif','image/webp'].includes(mime)){void r.body?.cancel().catch(()=>{});reject('IMAGE_TYPE_REJECTED');}
    const bytes=await boundedBytes(r,kind==='html'?262144:2097152,signal);return {url,mime,bytes};
  }reject('IMAGE_REDIRECT_REJECTED');
}
export function imageMagic(bytes,mime){
 const ascii=(start,length)=>String.fromCharCode(...bytes.slice(start,start+length));
 return mime==='image/png'?bytes.length>=24&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v):mime==='image/jpeg'?bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255:mime==='image/gif'?bytes.length>=13&&['GIF87a','GIF89a'].includes(ascii(0,6)):mime==='image/webp'?bytes.length>=16&&ascii(0,4)==='RIFF'&&ascii(8,4)==='WEBP':false;
}
function decodeAttribute(value){return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|quot|apos|lt|gt);/gi,(raw,entity)=>{if(entity[0]!=='#')return ({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>'})[entity.toLowerCase()]||raw;const n=entity[1].toLowerCase()==='x'?parseInt(entity.slice(2),16):Number(entity.slice(1));return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):raw;});}
export async function parseImageMeta(bytes,{Rewriter=globalThis.HTMLRewriter,signal}={}){
 if(!Rewriter)reject('IMAGE_PARSE_FAILED');const candidates=[];
 const parsed=new Rewriter().on('head meta',{element(e){const source=(e.getAttribute('property')||e.getAttribute('name')||'').toLowerCase();if(['og:image','twitter:image'].includes(source)&&candidates.length<8){const value=e.getAttribute('content');if(value&&value.length<=2048)candidates.push({source,value:decodeAttribute(value)});}}}).transform(new Response(bytes,{headers:{'Content-Type':'text/html;charset=utf-8'}}));
 await boundedBytes(parsed,262144,signal);return [...candidates.filter(c=>c.source==='og:image'),...candidates.filter(c=>c.source==='twitter:image')];
}
export async function fetchThumbnail(officialUrl,imageUrl,{fetchImpl=fetch,timeoutMs=5000}={}){
 const policy=officialPolicy(officialUrl);if(!policy)reject('IMAGE_HOST_REJECTED');
 return timed(async signal=>{const result=await retrieve(imageUrl,policy.imageHosts,'image',signal,fetchImpl);if(!imageMagic(result.bytes,result.mime))reject('IMAGE_TYPE_REJECTED');return result;},timeoutMs);
}
export async function findOfficialImage(officialUrl,{fetchImpl=fetch,timeoutMs=5000,Rewriter}={}){
 const none=reasonCode=>({imageUrl:null,source:null,reasonCode});const policy=officialPolicy(officialUrl);if(!policy)return none(officialUrl?'IMAGE_HOST_REJECTED':'NO_OFFICIAL_URL');
 try{return await timed(async signal=>{
   const html=await retrieve(policy.url,policy.htmlHosts,'html',signal,fetchImpl);const candidates=await parseImageMeta(html.bytes,{Rewriter,signal});let reason='NO_IMAGE_META';
   // At most eight candidates, within one total five-second budget.
   for(const candidate of candidates){let url;try{url=new URL(candidate.value,html.url).href;}catch{continue;}url=allowedUrl(url,policy.imageHosts,{image:true});if(!url){reason='IMAGE_HOST_REJECTED';continue;}
     try{const image=await retrieve(url,policy.imageHosts,'image',signal,fetchImpl);if(!imageMagic(image.bytes,image.mime)){reason='IMAGE_TYPE_REJECTED';continue;}return {imageUrl:image.url,source:candidate.source,reasonCode:null};}catch(e){reason=e instanceof ImageFetchError?e.code:'IMAGE_FETCH_FAILED';if(signal.aborted)throw e;}
   }return none(reason);
 },timeoutMs);}catch(e){return none(e instanceof ImageFetchError?e.code:'IMAGE_FETCH_FAILED');}
}
