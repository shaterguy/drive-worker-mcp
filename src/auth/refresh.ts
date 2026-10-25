import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { AuthBoundaryError } from './config.ts';

const WAIT_MILLIS=5_000,MAX_QUEUED=31;
type Waiter={resolve:()=>void;timer:ReturnType<typeof setTimeout>};

/** The provider owns authentication and encrypted replay; this gate only orders refreshes. */
export function createRefreshHandler(pool:Pick<Pool,'connect'>,handle:(request:Request)=>Promise<Response>) {
  let active=false;
  const queue:Waiter[]=[];
  const enter=async()=>{
    if(!active){active=true;return;}
    if(queue.length>=MAX_QUEUED)throw new AuthBoundaryError('AUTH_UNAVAILABLE');
    await new Promise<void>((resolve,reject)=>{
      const waiter:Waiter={resolve,timer:setTimeout(()=>{
        const index=queue.indexOf(waiter);
        if(index>=0)queue.splice(index,1);
        reject(new AuthBoundaryError('AUTH_UNAVAILABLE'));
      },WAIT_MILLIS)};
      queue.push(waiter);
    });
  };
  const leave=()=>{
    const next=queue.shift();
    if(next){clearTimeout(next.timer);next.resolve();}
    else active=false;
  };
  return async(request:Request):Promise<Response>=>{
    if(request.method!=='POST'||new URL(request.url).pathname!=='/api/auth/oauth2/token'||
      request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='application/x-www-form-urlencoded')return handle(request);
    const form=new URLSearchParams(await request.clone().text());
    // Match the provider's last-value form decoding and trimmed grant type.
    const token=form.getAll('refresh_token').at(-1);
    if(form.getAll('grant_type').at(-1)?.trim()!=='refresh_token'||!token)return handle(request);
    // Raw tokens never reach SQL, logs, or a cross-request cache.
    const key=createHash('sha256').update('dwmcp-refresh-v1\0').update(token).digest().readBigInt64BE().toString();
    const deadline=performance.now()+WAIT_MILLIS;
    await enter();
    try {
      if(performance.now()>=deadline)throw new AuthBoundaryError('AUTH_UNAVAILABLE');
      const client=await pool.connect();
      let failed=false;
      const lost=()=>{failed=true;};
      client.on('error',lost);
      try {
        await client.query('BEGIN');
        // This connection is intentionally idle while auth uses the remaining pool slots.
        // Transaction-scoped settings also work through transaction-pooling proxies.
        await client.query('SET LOCAL idle_in_transaction_session_timeout = 0');
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)',[key]);
        if(failed||performance.now()>=deadline)throw new AuthBoundaryError('AUTH_UNAVAILABLE');
        const response=await handle(request);
        if(failed)throw new AuthBoundaryError('AUTH_UNAVAILABLE');
        await client.query('COMMIT');
        return response;
      } catch(error) {
        try{await client.query('ROLLBACK');}catch{failed=true;}
        throw error;
      } finally {
        client.removeListener('error',lost);
        client.release(failed);
      }
    } finally {leave();}
  };
}
