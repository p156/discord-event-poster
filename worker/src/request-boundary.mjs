// No client header or body may expand the deployed Worker host allowlist.
export const WORKER_HOST = 'discord-event-poster-api.monma5435.workers.dev';
export function hasAllowedHost(request) {
  try {
    const url=new URL(request.url);
    if(url.protocol!=='https:'||url.hostname!==WORKER_HOST||url.port||url.username||url.password)return false;
    const host=request.headers.get('Host');
    return host===null||host.toLowerCase()===WORKER_HOST||host.toLowerCase()===WORKER_HOST+':443';
  } catch { return false; }
}
