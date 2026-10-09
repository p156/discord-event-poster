export const POST_BODY_LIMIT=16384;
export class PostInputError extends Error {
  constructor(code='INVALID_REQUEST',httpStatus=400,fields=[]) { super(code);this.name='PostInputError';this.code=code;this.httpStatus=httpStatus;this.fields=fields; }
}
export function isSnowflake(value) { return typeof value==='string'&&/^[1-9]\d{0,19}$/.test(value)&&BigInt(value)<=18446744073709551615n; }

// Small, bounded JSON grammar: detects duplicates after key escape decoding.
// JSON.parse is used ONLY for individual string/number tokens, never objects.
export function parseStrictJson(text) {
  let pos=0;
  const invalid=()=>{throw new PostInputError();};
  const space=()=>{while(/[\x20\t\r\n]/.test(text[pos]||'\0'))pos++;};
  function string(){
    const start=pos++;let escaped=false;
    while(pos<text.length){const ch=text[pos++];if(ch.charCodeAt(0)<32)invalid();if(escaped){escaped=false;continue;}if(ch==='\\'){escaped=true;continue;}if(ch==='"'){try{return JSON.parse(text.slice(start,pos));}catch{invalid();}}}
    invalid();
  }
  function value(depth){
    if(depth>3)invalid();space();const ch=text[pos];
    if(ch==='"')return string();
    if(ch==='{'){
      pos++;space();const object=Object.create(null),keys=new Set();if(text[pos]==='}'){pos++;return object;}
      while(true){space();if(text[pos]!=='"')invalid();const key=string();if(keys.has(key))invalid();keys.add(key);space();if(text[pos++]!==':')invalid();object[key]=value(depth+1);space();const end=text[pos++];if(end==='}')return object;if(end!==',')invalid();}
    }
    if(ch==='['){pos++;space();const array=[];if(text[pos]===']'){pos++;return array;}while(true){array.push(value(depth+1));space();const end=text[pos++];if(end===']')return array;if(end!==',')invalid();}}
    for(const literal of ['true','false','null'])if(text.startsWith(literal,pos)){pos+=literal.length;return JSON.parse(literal);}
    const number=text.slice(pos).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);if(!number)invalid();pos+=number[0].length;return JSON.parse(number[0]);
  }
  try{const result=value(1);space();if(pos!==text.length)invalid();return result;}catch{throw new PostInputError();}
}
function validUnicode(text){
  for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const n=text.charCodeAt(++i);if(!(n>=0xdc00&&n<=0xdfff))return false;}else if(c>=0xdc00&&c<=0xdfff)return false;}return true;
}
export function validatePostPayload(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new PostInputError();
  const allowed=['apiVersion','threadName','content','tagIds'];
  if(Object.keys(value).some(k=>!allowed.includes(k))||value.apiVersion!==1)throw new PostInputError();
  for(const name of ['threadName','content'])if(typeof value[name]!=='string')throw new PostInputError('INVALID_REQUEST',400,[name]);
  const name=value.threadName.replace(/\r\n?/g,'\n'),content=value.content.replace(/\r\n?/g,'\n');
  const threadName=name.trim();
  if(!validUnicode(name)||/[\x00-\x1f\x7f]/.test(name)||threadName.length<1||threadName.length>100)throw new PostInputError('CONTENT_INVALID',422,['threadName']);
  if(!validUnicode(content)||/[\x00-\x08\x0b-\x1f\x7f]/.test(content)||!content.trim()||content.length>2000)throw new PostInputError('CONTENT_INVALID',422,['content']);
  const tagIds=value.tagIds===undefined?[]:value.tagIds;
  if(!Array.isArray(tagIds)||tagIds.length>5||tagIds.some(t=>!isSnowflake(t))||new Set(tagIds).size!==tagIds.length)throw new PostInputError('TAG_INVALID',422,['tagIds']);
  return Object.freeze({apiVersion:1,threadName,content,tagIds:Object.freeze([...tagIds].sort())});
}
export async function readPostRequest(request,{timeoutMs=5000}={}) {
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type')||'')||request.headers.has('Content-Encoding'))throw new PostInputError('UNSUPPORTED_MEDIA',415);
  const reader=request.body?.getReader();if(!reader)throw new PostInputError();let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{void reader.cancel().catch(()=>{});reject(new PostInputError('BODY_TIMEOUT',408));},timeoutMs);});
  const task=(async()=>{let size=0;const chunks=[];while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>POST_BODY_LIMIT){void reader.cancel().catch(()=>{});throw new PostInputError('BODY_TOO_LARGE',413);}chunks.push(value);}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw new PostInputError();}return validatePostPayload(parseStrictJson(text));})();
  try{return await Promise.race([task,timeout]);}catch(error){if(error instanceof PostInputError)throw error;throw new PostInputError();}finally{clearTimeout(timer);try{reader.releaseLock();}catch{}}
}
