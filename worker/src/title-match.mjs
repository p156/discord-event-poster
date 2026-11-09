// Warning-only matching. Keep edition digits: similar names can be different runs.
export function titleKey(value){
  return String(value||'').normalize('NFKC').toLowerCase()
    .replace(/【[^】]*】/gu,'').replace(/[[(（](?:北海道|東京都?|大阪府?|京都府?|神奈川県?|埼玉県?|千葉県?|愛知県?|兵庫県?|福岡県?|東京|大阪|京都|名古屋|神戸|横浜|札幌|仙台|広島|福岡)(?:公演|会場|開催)?[)）\]]/gu,'').replace(/[\p{P}\p{S}\s]/gu,'');
}
function grams(value){
  const chars=Array.from(value),out=new Set();
  for(let i=0;i<chars.length-1;i++)out.add(chars[i]+chars[i+1]);
  return out;
}
export function titleMatch(left,right){
  const a=titleKey(left),b=titleKey(right);
  if(!a||!b)return null;
  const x=grams(a),y=grams(b);let shared=0;for(const g of x)if(y.has(g))shared++;
  const score=a===b?1:x.size+y.size?2*shared/(x.size+y.size):0;
  const substring=Math.min(a.length,b.length)>=4&&(a.includes(b)||b.includes(a));
  const numbers=s=>Array.from(s.matchAll(/第([0-9一二三四五六七八九十百]+)回|(?:vol\.?|case|part)([0-9]+)/giu),m=>m[1]||m[2]).join(',');
  const editionBase=s=>titleKey(s).replace(/第[0-9一二三四五六七八九十百]+回|(?:vol|case|part)[0-9]+/giu,'');
  const sameSeries=editionBase(left).length>=4&&editionBase(left)===editionBase(right);
  if(score<0.72&&!substring&&!sameSeries)return null;
  const n=numbers(left.normalize('NFKC')),m=numbers(right.normalize('NFKC'));
  return {score:Math.round(score*100),differentEdition:Boolean(n&&m&&n!==m)};
}
