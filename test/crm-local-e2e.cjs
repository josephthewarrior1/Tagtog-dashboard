'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {assertLocal,assertDisposableFixtures,api}=require('./crm-local-fixtures.cjs');
const portal='http://127.0.0.1:4180';
const crm='http://127.0.0.1:8188';
const backend='http://127.0.0.1:8186';
const iam='http://127.0.0.1:8181';
class Client{
  constructor(){this.cookies=new Map();}
  async request(url,{method='GET',body,headers={}}={}){
    const parsed=new URL(url);assert([portal,crm,backend,iam].includes(parsed.origin));
    const jar=this.cookies.get(parsed.origin)||new Map();
    const response=await fetch(url,{method,redirect:'manual',signal:AbortSignal.timeout(20000),headers:{...(jar.size?{Cookie:[...jar].map(([k,v])=>k+'='+v).join('; ')}:{}),...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
    for(const value of response.headers.getSetCookie()){
      const pair=value.split(';')[0];const i=pair.indexOf('=');
      if(/Max-Age=0(?:;|$)/i.test(value))jar.delete(pair.slice(0,i));else jar.set(pair.slice(0,i),pair.slice(i+1));
    }
    this.cookies.set(parsed.origin,jar);return response;
  }
  async login(credentials){
    const response=await this.request(portal+'/api/auth/login',{method:'POST',headers:{Origin:portal},body:{email:credentials.email,password:credentials.password}});assert.equal(response.status,200,'central local login');
    const view=await this.request(portal+'/api/session');assert.equal(view.status,200);this.portalSession=await view.json();
  }
  async start(){
    const response=await this.request(crm+'/api/tagtog/start?returnTo=%2Fdashboard');assert([302,303,307].includes(response.status),'start redirects');
    const target=new URL(response.headers.get('location'));assert.equal(target.origin,portal);assert.equal(target.pathname,'/sso/authorize');
    assert.equal(target.searchParams.get('client_id'),'crm-local');return target.href;
  }
  async authorize(){const target=await this.start();return this.request(target);}
  async open(){
    const authorization=await this.authorize();assert([302,303,307].includes(authorization.status),'CRM authorization redirects');
    const callback=new URL(authorization.headers.get('location'));assert.equal(callback.origin,crm);assert.equal(callback.pathname,'/api/tagtog/callback');
    assert(callback.searchParams.has('code'));assert(!callback.searchParams.has('token'));assert(!callback.searchParams.has('accessToken'));
    const complete=await this.request(callback.href);assert([302,303,307].includes(complete.status),'callback redirects');
    const destination=new URL(complete.headers.get('location'),crm);assert.equal(destination.origin,crm);assert(['/dashboard','/dashboard/events'].includes(destination.pathname),'successful CRM landing');this.destination=destination.pathname;
    const session=await this.request(crm+'/api/tagtog/session',{headers:{'X-TAGTOG-Request':'1'}});assert.equal(session.status,200,'CRM session');this.crmSession=await session.json();
    assert(!Object.hasOwn(this.crmSession,'token'));assert(!Object.hasOwn(this.crmSession,'accessToken'));assert(!Object.hasOwn(this.crmSession.user,'password'));return callback.href;
  }
}
async function main(){
  const c=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../.local/local-config.json'),'utf8'));assertDisposableFixtures(c);assertLocal(c);
  assert(c.crm.fixtures?.admin?.crmUserId&&c.crm.fixtures?.viewer?.iamUserId,'seed fixtures first');
  const admin=new Client();await admin.login(c.iamAdmin);assert(admin.portalSession.apps.some(app=>app.id==='crm'&&app.launchUrl===crm+'/api/tagtog/start'));
  const callback=await admin.open();assert.equal(admin.destination,'/dashboard');assert.equal(String(admin.crmSession.user.id),c.crm.fixtures.admin.crmUserId);assert(admin.crmSession.user.roles.includes('ADMIN'));console.log('PASS central login -> TAGTOG CRM card -> existing CRM user and roles; tokens stay server-side');
  const me=await admin.request(crm+'/api/crm/api/auth/me');assert.equal(me.status,200);const profile=await me.json();assert(!profile.password);console.log('PASS CRM API access through authenticated BFF');
  for(const route of ['/api/auth/me','/api/databases','/api/personal-email-domains']){
    assert.equal((await fetch(backend+route,{redirect:'manual'})).status,401,'private API rejects anonymous');
    assert.equal((await fetch(backend+route,{headers:{Authorization:'Bearer 1'},redirect:'manual'})).status,401,'numeric legacy token rejected');
  }
  assert([401,403,409].includes((await fetch(backend+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"usernameOrEmail":"unused","password":"unused"}',redirect:'manual'})).status));
  assert.equal((await fetch(backend+'/api/databases/import/preview',{method:'POST',redirect:'manual'})).status,401);console.log('PASS private APIs, import preview, and legacy login cannot bypass central SSO');
  const replay=await admin.request(callback);assert([302,303,307,400,401,409].includes(replay.status));if(replay.headers.get('location'))assert.equal(new URL(replay.headers.get('location'),crm).pathname,'/login');console.log('PASS consumed callback cannot establish another CRM session');
  const viewer=new Client();await viewer.login(c.crm.fixtures.viewer);await viewer.open();assert.equal(viewer.destination,'/dashboard/events');assert.equal(String(viewer.crmSession.user.id),c.crm.fixtures.viewer.crmUserId);assert.deepEqual(viewer.crmSession.user.roles,['USER']);
  const write=await viewer.request(crm+'/api/crm/api/companies',{method:'POST',body:{name:'denied'},headers:{Origin:crm,'X-CRM-CSRF':viewer.crmSession.csrfToken}});assert.equal(write.status,403);console.log('PASS viewer preserves local role and central read-only grant denies writes');
  const csrf=await admin.request(crm+'/api/crm/api/companies',{method:'POST',body:{name:'denied'},headers:{Origin:'https://untrusted.invalid'}});assert.equal(csrf.status,403);console.log('PASS cross-origin CRM mutation denied');
  const noaccess=new Client();await noaccess.login(c.crm.fixtures.noaccess);assert(!noaccess.portalSession.apps.some(app=>app.id==='crm'));const denial=await noaccess.authorize();assert.equal(denial.status,403);console.log('PASS no-CRM-grant identity cannot launch CRM directly or through portal');
  const unmapped=new Client();await unmapped.login(c.crm.fixtures.unmapped);const authorization=await unmapped.authorize();assert([302,303,307].includes(authorization.status));const missing=await unmapped.request(authorization.headers.get('location'));assert([302,303,307].includes(missing.status));assert.equal(new URL(missing.headers.get('location'),crm).pathname,'/login');assert.equal((await unmapped.request(crm+'/api/tagtog/session',{headers:{'X-TAGTOG-Request':'1'}})).status,401);console.log('PASS missing explicit account mapping fails closed');
  const access=await api(iam,'/api/auth/login',null,'POST',c.iamAdmin);
  try{
    const systems=await api(iam,`/api/roles/${c.crm.fixtureRoleId}/systems`,access.accessToken);
    const original=systems.filter(system=>system.hasAccess).map(system=>system.systemId);
    try{
      await api(iam,`/api/roles/${c.crm.fixtureRoleId}/systems`,access.accessToken,'PUT',{systemIds:[]});
      assert([401,403].includes((await viewer.request(crm+'/api/tagtog/session',{headers:{'X-TAGTOG-Request':'1'}})).status));console.log('PASS central grant revocation blocks an existing CRM session');
    }finally{await api(iam,`/api/roles/${c.crm.fixtureRoleId}/systems`,access.accessToken,'PUT',{systemIds:original});}
  }finally{await api(iam,'/api/auth/logout',null,'POST',{refreshToken:access.refreshToken}).catch(()=>{});}
  const signedOut=await admin.request(portal+'/api/auth/logout',{method:'POST',headers:{Origin:portal,'X-CSRF-Token':admin.portalSession.csrfToken},body:{}});assert.equal(signedOut.status,200);
  assert([401,403].includes((await admin.request(crm+'/api/tagtog/session',{headers:{'X-TAGTOG-Request':'1'}})).status));console.log('PASS global TAGTOG sign-out invalidates bound CRM access');
  const local=new Client();await local.login(c.iamAdmin);await local.open();
  const logout=await local.request(crm+'/api/tagtog/logout',{method:'POST',headers:{Origin:crm,'X-CRM-CSRF':local.crmSession.csrfToken},body:{}});assert([200,204].includes(logout.status));assert.equal((await local.request(crm+'/api/tagtog/session',{headers:{'X-TAGTOG-Request':'1'}})).status,401);console.log('PASS CRM local logout removes browser and backend sessions');
}
main().catch(error=>{process.stderr.write('CRM local acceptance failed: '+error.message+'\n');process.exitCode=1;});
