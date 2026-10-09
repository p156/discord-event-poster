import worker from '../src/index.mjs';
export {AuthState,passwordHash} from '../src/index.mjs';
export default {
  fetch(request,env,ctx) {
    // Miniflare dispatchFetch replaces Host with its loopback transport address.
    // Simulate the incoming public Host; production code remains unmodified.
    const headers=new Headers(request.headers);
    headers.set('Host',new URL(request.url).host);
    return worker.fetch(new Request(request,{headers}),env,ctx);
  }
};
