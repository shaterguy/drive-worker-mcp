import { randomBytes } from 'node:crypto';
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import type { DriveWorkerAuth } from './better-auth.ts';
import type { Connections } from './connections.ts';
import { AuthBoundaryError, OAUTH_SCOPES, type AuthConfig } from './config.ts';
import { boundedRequest, noStore } from './request-guards.ts';
import { initialFolderInputs } from './owner-prefill.ts';

const escape = (value: unknown): string => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
const labels: Record<string,string> = {
  openid: 'Confirm your signed-in identity', offline_access: 'Reconnect for up to the current 7-day session',
  'manual:publish': 'Save a manual command without executing it',
  'jobs:submit': 'Submit a direct command to your DriveWorker',
  'jobs:read': 'Read job status and bounded result/log content',
};

function page(title: string, content: string, oauthQuery = ''): Response {
  const nonce = randomBytes(18).toString('base64');
  const data = JSON.stringify(oauthQuery).replace(/</g, '\\u003c');
  // Static script; untrusted names, URLs and IDs are only escaped text or JSON data.
  const script = `const oauth_query=${data};document.querySelectorAll('form').forEach(f=>f.addEventListener('submit',async e=>{
    e.preventDefault();const button=e.submitter;const out=document.getElementById('status');out.textContent='Working…';
    const body=Object.fromEntries(new FormData(f));body.oauth_query=oauth_query;
    if(button?.name)body[button.name]=button.value;
    if('accept'in body)body.accept=body.accept==='true';
    if('consent'in body)body.consent=body.consent==='true';
    try{const r=await fetch(f.action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const result=await r.json();if(!r.ok)throw new Error(result.error||'REQUEST_FAILED');
      if(result.url){const u=new URL(result.url,location.origin);if(u.protocol!=='https:')throw new Error('INVALID_REDIRECT');location.assign(u.href);}
      else location.reload();
    }catch(error){out.textContent=error.message==='GOOGLE_REAUTH_REQUIRED'?'Google Drive access needs renewal. Use Reconnect with Google.':error.message;}
  }));`;
  return noStore(new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
    <body><main><h1>${escape(title)}</h1>${content}<p id="status" role="status"></p>
    <p>Connections expire when the original session expires (up to 7 days). Sign in again with the same Google account to recover your saved folder settings. After disconnecting, sign out and sign in again before reconnecting.</p></main>
    <script nonce="${nonce}">${script}</script></body></html>`, { headers: {
      'Content-Type':'text/html; charset=utf-8',
      'Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    } }));
}

export function createUi(auth: DriveWorkerAuth, config: AuthConfig, connections: Connections) {
  async function signed(query: unknown, optional = false): Promise<string> {
    if (optional && (query === undefined || query === '')) return '';
    if (typeof query !== 'string' || query.length > 16384 || !(await verifyOAuthQueryParams(query, (await auth.$context).secret))) {
      throw new AuthBoundaryError('INVALID_AUTHORIZATION_REQUEST');
    }
    return query;
  }
  async function session(request: Request) {
    const value = await auth.api.getSession({ headers: request.headers });
    if (!value) throw new AuthBoundaryError('AUTH_REQUIRED');
    return value;
  }
  async function forward(request: Request, path: string, body: Record<string,unknown>) {
    const headers = new Headers(request.headers);
    headers.set('Content-Type','application/json'); headers.delete('content-length');
    // Delegates all state, nonce, code, redirect, consent and token processing to Better Auth.
    return noStore(await auth.handler(new Request(`${config.issuer}${path}`, { method:'POST', headers, body:JSON.stringify(body) })));
  }
  return async (original: Request): Promise<Response> => {
    const path = new URL(original.url).pathname;
    if (original.method === 'GET') {
      const query = new URL(original.url).search.slice(1);
      if (path === '/sign-in') {
        const parameters = new URLSearchParams(query);
        let onlyErrorFields = true;
        parameters.forEach((_value,key)=>{if (!['error','error_description'].includes(key)) onlyErrorFields=false;});
        const providerError = parameters.has('error') && onlyErrorFields;
        const oauthQuery = providerError ? '' : await signed(query, true);
        return page('Connect DriveWorker MCP', `<p>Use your own Google Drive. Commands and results stay in your selected folders.</p>
          <p>Google consent includes reading your entire Drive. This app limits its operations to your connected folders, and requests per-file write access.</p>
          ${providerError ? '<p>Google sign-in was cancelled or could not finish. Both requested Drive permissions are required. You can retry or renew consent below.</p>' : ''}
          <form action="/ui/sign-in"><button type="submit">Continue with Google</button></form>
          ${providerError ? '<form action="/ui/sign-in"><button name="consent" value="true">Renew Google consent</button></form>' : ''}`, oauthQuery);
      }
      const current = await auth.api.getSession({headers:original.headers});
      if (!current) return noStore(Response.redirect(`${config.origin}/sign-in`,303));
      if (path === '/consent') {
        const oauthQuery = await signed(query);
        const params = new URLSearchParams(oauthQuery); const clientId = params.get('client_id');
        const requested = (params.get('scope') ?? '').split(' ').filter(Boolean);
        if (!clientId || !requested.every(scope => (OAUTH_SCOPES as readonly string[]).includes(scope))) throw new AuthBoundaryError('INVALID_AUTHORIZATION_REQUEST');
        const client = await auth.api.getOAuthClientPublic({ headers:original.headers, query:{client_id:clientId} });
        const claims = params.get('claims');
        return page('Approve this connection', `<p>Client: ${escape(client.client_name ?? clientId)}</p><p>Client ID: ${escape(clientId)}</p>
          <p>Signed in as ${escape(current.user.email)}. Requested access:</p><ul>${requested.map(scope=>`<li>${escape(labels[scope])}</li>`).join('')}</ul>
          ${claims ? `<p>Additional requested identity claims: ${escape(claims)}</p>` : ''}
          <form action="/ui/consent"><button name="accept" value="true">Approve</button><button name="accept" value="false">Deny</button></form>`,oauthQuery);
      }
      if (path === '/connect') {
        const oauthQuery = await signed(query,true);
        const state = await connections.list(current.user.id);
        const binding = state.binding;
        const form = binding ? `<p>Saved folder settings are preserved for this Google identity.</p><dl>${Object.entries(binding).map(([k,v])=>`<dt>${escape(k)}</dt><dd>${escape(v ?? '')}</dd>`).join('')}</dl>
          ${oauthQuery ? '<form action="/ui/continue"><button>Continue to consent</button></form>' : ''}` :
          `<p>Enter folder IDs from your own Drive. Manual and direct folders must be different. Readability does not guarantee drive.file write permission; first-write verification is still required.</p>
          <form action="/ui/connect">${initialFolderInputs(config.ownerPrefill,state.identity,Boolean(binding))}<button>Save folder settings</button></form>`;
        const grants = state.grants.map(g=>`<li>${escape(g.client_id)} ${g.revoked_at?'(disconnected)':`<form action="/ui/disconnect"><input type="hidden" name="grantId" value="${escape(g.id)}"><button>Disconnect this client</button></form>`}</li>`).join('');
        return page('Your DriveWorker connection', `<p>Signed in as ${escape(current.user.email)}</p>${form}<h2>Clients</h2>
          <p>Disconnect revokes only the selected MCP client connection. Your Google grant, saved folder settings and Drive files remain. Google access can be removed from your Google Account permissions.</p><ul>${grants}</ul>
          <form action="/ui/sign-in"><button name="consent" value="true">Reconnect with Google</button></form>
          <form action="/ui/sign-out"><button>Sign out</button></form>`,oauthQuery);
      }
    }
    if (original.method !== 'POST' || original.headers.get('origin') !== config.origin) throw new AuthBoundaryError('INVALID_ORIGIN');
    if (!original.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new AuthBoundaryError('INVALID_REQUEST');
    const request = await boundedRequest(original,32768);
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AuthBoundaryError('INVALID_REQUEST');
    const input = body as Record<string,unknown>;
    const oauthQuery = await signed(input.oauth_query,true);
    if (path === '/ui/sign-in') return forward(request,'/sign-in/social',{
      provider:'google', callbackURL:`${config.origin}/connect`, errorCallbackURL:`${config.origin}/sign-in`,
      ...(oauthQuery ? {oauth_query:oauthQuery} : {}),
      ...(input.consent === true ? {additionalParams:{prompt:'select_account consent'}} : {}),
    });
    const current = await session(request);
    if (path === '/ui/sign-out') {
      const response = await forward(request,'/sign-out',{});
      if (!response.ok) return response;
      const headers = new Headers(response.headers); headers.delete('content-length');
      return noStore(Response.json({url:'/sign-in'},{headers}));
    }
    if (path === '/ui/consent') {
      await signed(oauthQuery);
      if (typeof input.accept !== 'boolean') throw new AuthBoundaryError('INVALID_REQUEST');
      return forward(request,'/oauth2/consent',{accept:input.accept,oauth_query:oauthQuery});
    }
    if (path === '/ui/disconnect') { await connections.disconnect(current.user.id,input.grantId); return noStore(Response.json({url:'/connect'})); }
    if (path === '/ui/connect') await connections.bindInitial(current.user.id,input);
    if (path === '/ui/connect' || path === '/ui/continue') {
      const tenant = await connections.authority.ensureTenantForUser(current.user.id);
      await connections.requireGoogleGrant(tenant.id);
      if (oauthQuery) return forward(request,'/oauth2/continue',{postLogin:true,oauth_query:oauthQuery});
      return noStore(Response.json({url:'/connect'}));
    }
    return noStore(Response.json({error:'NOT_FOUND'},{status:404}));
  };
}
