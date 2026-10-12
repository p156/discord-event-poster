// Operator-managed exact hosts. No user input can extend this policy.
// SCRAP ownership: https://realescapegame.jp/ and https://www.scrapmagazine.com/.
// Only same-site images are initially approved; no unverified shared CDN.
const sites=Object.freeze({
  'realescapegame.jp':['realescapegame.jp'],
  'www.scrapmagazine.com':['www.scrapmagazine.com'],
});
export function safeHttps(raw){
  if(typeof raw!=='string'||!raw||raw.length>2048||/[\x00-\x20\x7f\\]/.test(raw))return null;
  try{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||!Object.hasOwn(sites,u.hostname)&&!Object.values(sites).some(h=>h.includes(u.hostname)))return null;
    // Reject encoded/non-ASCII authority spellings, trailing dots and IPs before normalization.
    if(!/^https:\/\/[a-z0-9.-]+(?::443)?(?:[/?#]|$)/i.test(raw)||u.hostname.endsWith('.'))return null;
    u.hash='';return u;
  }catch{return null;}
}
export function officialPolicy(raw){const u=safeHttps(raw);return u&&Object.hasOwn(sites,u.hostname)?{url:u.href,htmlHosts:[u.hostname],imageHosts:[...sites[u.hostname]]}:null;}
export function allowedUrl(raw,hosts,{image=false}={}){const u=safeHttps(raw);if(!u||!hosts.includes(u.hostname))return null;
  if(image&&u.search)return null; // Signed, secret, ephemeral query URLs are never embedded.
  return u.href;
}
export function embedOfficialUrl(raw){try{const u=new URL(raw);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')?u.href:undefined;}catch{return undefined;}}
