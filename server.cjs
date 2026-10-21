'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const randomId = () => crypto.randomBytes(32).toString('base64url');
const json = (res, status, data) => {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(data));
};
const redirect = (res, destination) => {
  res.writeHead(303, {Location:destination,'Cache-Control':'no-store'}); res.end();
};
const cookieValue = request => {
  const cookies = String(request.headers.cookie || '').split(';').map(item => item.trim());
  const entry = cookies.find(item => item.startsWith('tagtog_session='));
  return entry ? entry.slice('tagtog_session='.length) : '';
};
function safeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value)) return '/';
  try { const parsed = new URL(value, 'http://tagtog.invalid'); return parsed.origin === 'http://tagtog.invalid' ? parsed.pathname + parsed.search : '/'; }
  catch { return '/'; }
}
function validateSsoRequest(url, config) {
  const expected = ['client_id','redirect_uri','code_challenge','code_challenge_method','state'];
  for (const key of expected) if (url.searchParams.getAll(key).length !== 1) throw new HttpError(400,'Incomplete sign-in request. Start again from PMS.');
  const clientId = url.searchParams.get('client_id');
  const redirectUri = url.searchParams.get('redirect_uri');
  const challenge = url.searchParams.get('code_challenge');
  const state = url.searchParams.get('state');
  if (clientId !== config.ssoClientId || redirectUri !== config.pmsCallbackUri || url.searchParams.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || !/^[A-Za-z0-9_-]{32,128}$/.test(state)) throw new HttpError(400,'The application sign-in request is not valid. Start again from PMS.');
  return {clientId,redirectUri,codeChallenge:challenge,codeChallengeMethod:'S256',state};
}
async function readJson(request) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new HttpError(415,'Use a JSON request.');
  let bytes=0; const chunks=[];
  for await (const chunk of request) { bytes+=chunk.length; if (bytes>16384) throw new HttpError(413,'Request is too large.'); chunks.push(chunk); }
  try { const value=JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new HttpError(400,'Invalid request.'); }
}
function roleCodes(user) { return (user?.roles || []).map(role => typeof role==='string'?role:role.code); }
function isAdmin(user) { return roleCodes(user).includes('SUPER_ADMIN'); }

function createPortalServer(options={}) {
  const config={
    root:__dirname, portalOrigin:'http://127.0.0.1:4180', iamBaseUrl:'http://127.0.0.1:8181',
    pmsBaseUrl:'http://127.0.0.1:8182', pmsFrontendUrl:'http://127.0.0.1:8184',
    pmsCallbackUri:'http://127.0.0.1:8184/api/tagtog/callback', ssoClientId:'pms-local',
    sessionTtlMs:12*60*60*1000, fetch:globalThis.fetch, ...options
  };
  for (const name of ['portalOrigin','iamBaseUrl','pmsBaseUrl','pmsFrontendUrl']) {
    const parsed=new URL(config[name]);
    if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid '+name);
    config[name]=parsed.origin;
  }
  const secure=new URL(config.portalOrigin).protocol==='https:';
  const sessions=new Map(); const loginAttempts=new Map();
  function setCookie(res, id, ttl=Math.floor(config.sessionTtlMs/1000)) { res.setHeader('Set-Cookie',`tagtog_session=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttl}${secure?'; Secure':''}`); }
  function clearCookie(res) {setCookie(res,'',0);}
  function assertOrigin(request) {if (request.headers.origin!==config.portalOrigin) throw new HttpError(403,'This request must come from the TAGTOG portal.');}
  function assertCsrf(request, session) {
    const supplied=String(request.headers['x-csrf-token']||'');
    if (!/^[A-Za-z0-9_-]{43}$/.test(supplied) || !crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(session.csrfToken))) throw new HttpError(403,'Reload the portal and try again.');
  }
  async function upstream(base, endpoint, {token,method='GET',body}={}) {
    let response;
    try {response=await config.fetch(base+endpoint,{method,headers:{Accept:'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(8000),redirect:'error'});}
    catch {throw new HttpError(503,'The sign-in service is unavailable. Try again shortly.');}
    let payload=null;
    if (response.status!==204) {try {payload=await response.json();} catch {if(response.ok)throw new HttpError(502,'The sign-in service returned an invalid response.');}}
    if (!response.ok) {
      const message=response.status===401?'Your sign-in details or session are not valid.':response.status===403?'You do not have permission for this action.':response.status===409?'This account needs to be linked to an existing PMS user.':response.status===400?'Please check the entered details.':'The request could not be completed.';
      throw new HttpError([400,401,403,404,409,422,429].includes(response.status)?response.status:502,message);
    }
    return payload && Object.hasOwn(payload,'data') ? payload.data : payload;
  }
  async function refresh(session,force=false) {
    if (!force && session.accessExpiresAt>Date.now()+30000) return;
    if (!session.refreshing) session.refreshing=(async()=>{
      const result=await upstream(config.iamBaseUrl,'/api/auth/refresh',{method:'POST',body:{refreshToken:session.refreshToken}});
      if (!result?.accessToken || !result.refreshToken || !Number.isFinite(result.expiresIn)) throw new HttpError(502,'The sign-in service returned an invalid session.');
      session.accessToken=result.accessToken; session.refreshToken=result.refreshToken; session.accessExpiresAt=Date.now()+result.expiresIn*1000;
    })().finally(()=>{session.refreshing=null;});
    return session.refreshing;
  }
  async function iam(session,endpoint,options={}) {
    await refresh(session);
    try {return await upstream(config.iamBaseUrl,endpoint,{...options,token:session.accessToken});}
    catch(error) {if(error.status!==401)throw error;await refresh(session,true);return upstream(config.iamBaseUrl,endpoint,{...options,token:session.accessToken});}
  }
  async function authenticate(request,res,{optional=false,admin=false}={}) {
    const id=cookieValue(request); const session=sessions.get(id);
    if (!session || session.expiresAt<=Date.now()) {sessions.delete(id);if(id)clearCookie(res);if(optional)return null;throw new HttpError(401,'Please sign in to TAGTOG.');}
    try {session.user=await iam(session,'/api/me');} catch(error) {if(error.status===401 || error.status===403){sessions.delete(id);clearCookie(res);if(optional)return null;}throw error;}
    if (session.user?.status!=='ACTIVE') {sessions.delete(id);clearCookie(res);if(optional)return null;throw new HttpError(401,'Your account is not active.');}
    if (admin && !isAdmin(session.user)) throw new HttpError(403,'Administrator access is required.');
    return session;
  }
  async function sessionView(session) {
    const [systems,permissions]=await Promise.all([iam(session,'/api/me/systems'),iam(session,'/api/me/permissions')]);
    const aliases={pms:['PMS'],crm:['CRM'],ems:['EMS','EVENT_ADMIN']};
    const apps=Object.entries(aliases).filter(([,codes])=>(systems||[]).some(system=>codes.includes(system.code))).map(([id])=>({id,launchUrl:id==='pms'?config.pmsFrontendUrl+'/api/tagtog/start':null}));
    return {user:session.user,isAdmin:isAdmin(session.user),csrfToken:session.csrfToken,apps,systems:systems||[],permissions:permissions||[]};
  }
  const publicFiles=new Set(['login.js','auth.css','styles.css','app.js','config.js','admin.js','admin.css']);
  const contentTypes={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon'};
  async function serve(res,relative) {
    const absolute=path.resolve(config.root,relative);
    if (!absolute.startsWith(path.resolve(config.root)+path.sep)) throw new HttpError(404,'Not found.');
    let content;try {content=await fs.readFile(absolute);} catch {throw new HttpError(404,'Not found.');}
    res.writeHead(200,{'Content-Type':contentTypes[path.extname(absolute)]||'application/octet-stream','Cache-Control':'no-store'});res.end(content);
  }
  const server=http.createServer(async(request,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
    try {
      if (request.headers.host!==new URL(config.portalOrigin).host) throw new HttpError(400,'Open the configured local TAGTOG address.');
      const url=new URL(request.url,config.portalOrigin); const pathname=url.pathname;
      if (pathname==='/api/health' && request.method==='GET') return json(res,200,{service:'tagtog-portal',status:'up'});
      if (pathname==='/api/auth/login' && request.method==='POST') {
        assertOrigin(request);
        const ip=request.socket.remoteAddress||'local';const attempts=loginAttempts.get(ip)||{start:Date.now(),count:0};if(Date.now()-attempts.start>60000){attempts.start=Date.now();attempts.count=0;}attempts.count++;loginAttempts.set(ip,attempts);if(attempts.count>30)throw new HttpError(429,'Too many sign-in attempts. Wait one minute.');
        const body=await readJson(request);
        const previous=cookieValue(request);
        if(sessions.has(previous))throw new HttpError(409,'Sign out of all workspaces before switching accounts.');
        if(typeof body.email!=='string'||typeof body.password!=='string'||!body.email.trim()||body.email.length>320||body.password.length<1||body.password.length>2048)throw new HttpError(400,'Enter your email and password.');
        const result=await upstream(config.iamBaseUrl,'/api/auth/login',{method:'POST',body:{email:body.email.trim(),password:body.password}});
        if(!result?.accessToken||!result.refreshToken||!Number.isFinite(result.expiresIn))throw new HttpError(502,'The sign-in service returned an invalid session.');
        const id=randomId();const session={accessToken:result.accessToken,refreshToken:result.refreshToken,accessExpiresAt:Date.now()+result.expiresIn*1000,expiresAt:Date.now()+config.sessionTtlMs,csrfToken:randomId(),user:null};
        session.user=await iam(session,'/api/me');if(session.user.status!=='ACTIVE')throw new HttpError(403,'Your account is not active.');
        if(sessions.size>=1000)throw new HttpError(503,'The portal is busy. Try again shortly.');
        sessions.set(id,session);setCookie(res,id);return json(res,200,{user:session.user,returnTo:safeReturnTo(body.returnTo)});
      }
      if (pathname==='/api/session' && request.method==='GET') {const session=await authenticate(request,res);return json(res,200,await sessionView(session));}
      if (pathname==='/api/auth/logout' && request.method==='POST') {
        assertOrigin(request);const session=sessions.get(cookieValue(request));
        if(!session){clearCookie(res);return json(res,200,{signedOut:true});}
        assertCsrf(request,session);
        try {
          await iam(session,'/api/sso/logout',{method:'POST',body:{}});
          await upstream(config.iamBaseUrl,'/api/auth/logout',{method:'POST',body:{refreshToken:session.refreshToken}});
        }catch{throw new HttpError(503,'Signed out of TAGTOG. PMS sign-out could not be confirmed; contact your administrator.');}
        finally{sessions.delete(cookieValue(request));clearCookie(res);}
        return json(res,200,{signedOut:true});
      }
      if (pathname==='/sso/authorize' && request.method==='GET') {
        const sso=validateSsoRequest(url,config);const session=await authenticate(request,res,{optional:true});
        if(!session)return redirect(res,'/login?returnTo='+encodeURIComponent(url.pathname+url.search));
        const authorization=await iam(session,'/api/sso/authorize',{method:'POST',body:{clientId:sso.clientId,redirectUri:sso.redirectUri,codeChallenge:sso.codeChallenge,codeChallengeMethod:'S256'}});
        if(typeof authorization?.code!=='string')throw new HttpError(502,'Unable to open PMS. Please try again.');
        const target=new URL(sso.redirectUri);target.searchParams.set('code',authorization.code);target.searchParams.set('state',sso.state);return redirect(res,target.href);
      }
      if(pathname.startsWith('/api/admin/')) {
        const session=await authenticate(request,res,{admin:true});
        if(!['GET','POST','PUT','PATCH','DELETE'].includes(request.method))throw new HttpError(405,'Method not allowed.');
        if(request.method!=='GET'){assertOrigin(request);assertCsrf(request,session);}
        const route=pathname.slice('/api/admin'.length);
        if(/^\/(users(?:\/\d+(?:\/(?:roles|status))?)?|roles(?:\/\d+(?:\/(?:systems|permissions))?)?)$/.test(route)) {
          const body=request.method==='GET'||request.method==='DELETE'?undefined:await readJson(request);
          if(route===`/users/${session.user.id}`&&request.method==='DELETE')throw new HttpError(409,'Keep your own administrator account active.');
          if(route===`/users/${session.user.id}/status`&&body?.status!=='ACTIVE')throw new HttpError(409,'Keep your own administrator account active.');
          if(route===`/users/${session.user.id}/roles`&&request.method==='PUT') {const roles=await iam(session,'/api/roles');const adminRole=roles.find(role=>role.code==='SUPER_ADMIN');if(!Array.isArray(body?.roleIds)||!body.roleIds.includes(adminRole?.id))throw new HttpError(409,'Keep administrator access on your own account.');}
          if(/^\/roles\/\d+$/.test(route)&&['PUT','DELETE'].includes(request.method)){const roles=await iam(session,'/api/roles');const role=roles.find(item=>String(item.id)===route.split('/')[2]);if(role?.code==='SUPER_ADMIN'&&(request.method==='DELETE'||body?.status!=='ACTIVE'))throw new HttpError(409,'Keep the administrator role active.');}
          const result=await iam(session,'/api'+route,{method:request.method,body});return json(res,200,result??{saved:true});
        }
        if(/^\/pms\/(users|links(?:\/\d+)?)$/.test(route)) {
          const body=request.method==='GET'||request.method==='DELETE'?undefined:await readJson(request);
          const endpoint='/api/tagtog/admin'+route.slice('/pms'.length);
          const result=await upstream(config.pmsBaseUrl,endpoint,{method:request.method,token:session.accessToken,body});return json(res,200,result??{saved:true});
        }
        throw new HttpError(404,'Unknown access-management action.');
      }
      if(request.method!=='GET'&&request.method!=='HEAD')throw new HttpError(405,'Method not allowed.');
      if(pathname==='/login'){
        const session=await authenticate(request,res,{optional:true});
        if(session)return redirect(res,safeReturnTo(url.searchParams.get('returnTo')));
        return serve(res,'login.html');
      }
      if(pathname==='/'||pathname==='/index.html'||pathname==='/admin'){
        const session=await authenticate(request,res,{optional:true,admin:pathname==='/admin'});
        if(!session)return redirect(res,'/login?returnTo='+encodeURIComponent(pathname));
        return serve(res,pathname==='/admin'?'admin.html':'index.html');
      }
      const relative=pathname.slice(1);
      if(publicFiles.has(relative)||/^assets\/[A-Za-z0-9._-]+\.(svg|png|jpg|ico)$/.test(relative))return serve(res,relative);
      throw new HttpError(404,'Not found.');
    } catch(error) {
      const status=error instanceof HttpError?error.status:500;
      const message=error instanceof HttpError?error.message:'The portal could not complete this request.';
      if(request.url.startsWith('/api/'))return json(res,status,{error:{message}});
      res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end(message);
    }
  });
  const cleanup=setInterval(()=>{const now=Date.now();for(const[id,session]of sessions)if(session.expiresAt<=now)sessions.delete(id);for(const[ip,attempts]of loginAttempts)if(now-attempts.start>60000)loginAttempts.delete(ip);},60000);cleanup.unref();server.on('close',()=>clearInterval(cleanup));
  return server;
}
async function loadConfig() {
  let local={};try{local=JSON.parse(await fs.readFile(process.env.TAGTOG_LOCAL_CONFIG||path.join(__dirname,'.local','local-config.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  return {...(local.portal||{}),...(process.env.TAGTOG_IAM_URL?{iamBaseUrl:process.env.TAGTOG_IAM_URL}:{}),...(process.env.TAGTOG_PMS_API_URL?{pmsBaseUrl:process.env.TAGTOG_PMS_API_URL}:{}),...(process.env.TAGTOG_PMS_URL?{pmsFrontendUrl:process.env.TAGTOG_PMS_URL}:{}),...(process.env.TAGTOG_ORIGIN?{portalOrigin:process.env.TAGTOG_ORIGIN}:{})};
}
if(require.main===module)loadConfig().then(config=>{const server=createPortalServer(config);const origin=new URL(config.portalOrigin||'http://127.0.0.1:4180');server.listen(Number(origin.port||80),'127.0.0.1',()=>process.stdout.write(`TAGTOG portal: ${origin.origin}\n`));}).catch(()=>{process.stderr.write('TAGTOG configuration is invalid. Check the local setup.\n');process.exitCode=1;});
module.exports={createPortalServer,safeReturnTo,validateSsoRequest};
