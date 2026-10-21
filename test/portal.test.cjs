'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createPortalServer,safeReturnTo,validateSsoRequest}=require('../server.cjs');
const origin='http://127.0.0.1:4180';
async function fixture(t, options={}){
  const state={active:true,admin:true,grant:true,logoutFailure:false,me401:false,refreshes:0,calls:[]};
  const mock=async(url,options={})=>{
    if(state.offline)throw new Error('upstream unavailable');
    const route=new URL(url).pathname;state.calls.push({route,origin:new URL(url).origin,method:options.method,body:options.body});
    const data=value=>Response.json({data:value});
    if(route==='/api/auth/login')return data({accessToken:'private-access-token',refreshToken:'private-refresh-token',expiresIn:3600});
    if(route==='/api/auth/refresh'){state.refreshes++;return data({accessToken:'rotated-access-token',refreshToken:'rotated-refresh-token',expiresIn:3600});}
    if(route==='/api/me'){if(state.me401){state.me401=false;return Response.json({}, {status:401});}return data({id:1,email:'test@example.invalid',fullName:'Test Member',status:state.active?'ACTIVE':'INACTIVE',roles:state.admin?[{code:'SUPER_ADMIN',name:'Administrator'}]:[{code:'VIEWER',name:'Viewer'}]});}
    if(route==='/api/me/systems')return data([...(state.grant?[{id:1,code:'PMS',name:'PMS'}]:[]),...(state.crmGrant?[{id:2,code:'CRM',name:'CRM'}]:[])]);
    if(route==='/api/me/permissions')return data([]);
    if(route==='/api/roles')return data([{id:1,code:'SUPER_ADMIN',status:'ACTIVE'}]);
    if(route==='/api/sso/authorize')return state.grant?data({code:'one-use-auth-code',expiresIn:60}):Response.json({}, {status:403});
    if(route==='/api/sso/logout')return state.logoutFailure?Response.json({}, {status:503}):new Response(null,{status:204});
    if(route==='/api/auth/logout')return new Response(null,{status:204});
    return data([]);
  };
  const server=createPortalServer({fetch:mock,root:require('node:path').resolve(__dirname,'..'),...options});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const address='http://127.0.0.1:'+server.address().port;
  const request=(route,options={})=>new Promise((resolve,reject)=>{const req=require('node:http').request(address+route,{method:options.method||'GET',headers:{Host:'127.0.0.1:4180',...(options.headers||{})}},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{const headers=new Headers();for(const [key,value]of Object.entries(response.headers)){if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(', '):value);}resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers}));});});req.on('error',reject);if(options.body)req.write(options.body);req.end();});
  async function login(){const response=await request('/api/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:'test@example.invalid',password:'private-fixture-password'})});assert.equal(response.status,200);const cookie=response.headers.get('set-cookie').split(';')[0];const info=await request('/api/session',{headers:{Cookie:cookie}});return{cookie,session:await info.json(),response};}
  return{state,request,login};
}
test('anonymous pages redirect and session API rejects; private paths are not served',async t=>{const f=await fixture(t);const home=await f.request('/');assert.equal(home.status,303);assert.match(home.headers.get('location'),/^\/login/);assert.equal((await f.request('/api/session')).status,401);for(const path of['/.local/local-config.json','/.git/config','/server.cjs','/admin.html'])assert.equal((await f.request(path)).status,404);});
test('login requires same-origin and never returns upstream credentials',async t=>{const f=await fixture(t);assert.equal((await f.request('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);const auth=await f.login();const body=JSON.stringify(auth.session);assert.doesNotMatch(body,/private-access-token|private-refresh-token/);assert.match(auth.response.headers.get('set-cookie'),/HttpOnly/);assert.match(auth.response.headers.get('set-cookie'),/SameSite=Lax/);assert.equal(auth.session.apps[0].launchUrl,'http://127.0.0.1:8184/api/tagtog/start');});
test('fresh system grants determine visible apps and inactive users lose session',async t=>{const f=await fixture(t);const auth=await f.login();f.state.grant=false;assert.deepEqual((await(await f.request('/api/session',{headers:{Cookie:auth.cookie}})).json()).apps,[]);f.state.active=false;assert.equal((await f.request('/api/session',{headers:{Cookie:auth.cookie}})).status,401);f.state.active=true;assert.equal((await f.request('/api/session',{headers:{Cookie:auth.cookie}})).status,401);});
test('admin API checks fresh current roles on every request',async t=>{const f=await fixture(t);const auth=await f.login();assert.equal((await f.request('/api/admin/users',{headers:{Cookie:auth.cookie}})).status,200);f.state.admin=false;assert.equal((await f.request('/api/admin/users',{headers:{Cookie:auth.cookie}})).status,403);});
test('admin mutations require origin and CSRF, including malformed unicode tokens',async t=>{const f=await fixture(t);const auth=await f.login();const headers={Cookie:auth.cookie,Origin:origin,'Content-Type':'application/json'};assert.equal((await f.request('/api/admin/roles',{method:'POST',headers,body:'{}'})).status,403);assert.equal((await f.request('/api/admin/roles',{method:'POST',headers:{...headers,'X-CSRF-Token':'é'.repeat(43)},body:'{}'})).status,403);assert.equal((await f.request('/api/admin/roles',{method:'POST',headers:{...headers,'X-CSRF-Token':auth.session.csrfToken},body:'{}'})).status,200);});
test('self admin account and SUPER_ADMIN role cannot be disabled or removed',async t=>{const f=await fixture(t);const auth=await f.login();const headers={Cookie:auth.cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':auth.session.csrfToken};for(const [route,method,body]of[['/api/admin/users/1/status','PATCH',{status:'INACTIVE'}],['/api/admin/users/1/roles','PUT',{roleIds:[]}],['/api/admin/users/1','DELETE',null],['/api/admin/roles/1','DELETE',null],['/api/admin/roles/1','PUT',{status:'INACTIVE'}]])assert.equal((await f.request(route,{method,headers,...(body?{body:JSON.stringify(body)}:{})})).status,409);});
test('SSO validates exact callback, duplicate params, S256 and state before upstream',async t=>{const f=await fixture(t);const auth=await f.login();const q=new URLSearchParams({client_id:'pms-local',redirect_uri:'http://127.0.0.1:8184/api/tagtog/callback',code_challenge:'a'.repeat(43),code_challenge_method:'S256',state:'b'.repeat(43)});const good=await f.request('/sso/authorize?'+q,{headers:{Cookie:auth.cookie}});assert.equal(good.status,303);const target=new URL(good.headers.get('location'));assert.equal(target.searchParams.get('code'),'one-use-auth-code');assert.equal(target.searchParams.get('state'),'b'.repeat(43));assert.doesNotMatch(target.href,/private-access|private-refresh/);q.set('redirect_uri','https://evil.invalid/callback');assert.equal((await f.request('/sso/authorize?'+q,{headers:{Cookie:auth.cookie}})).status,400);q.set('redirect_uri','http://127.0.0.1:8184/api/tagtog/callback');q.append('state','b'.repeat(43));assert.equal((await f.request('/sso/authorize?'+q)).status,400);});
test('upstream denial cannot launch PMS',async t=>{const f=await fixture(t);const auth=await f.login();f.state.grant=false;const q=new URLSearchParams({client_id:'pms-local',redirect_uri:'http://127.0.0.1:8184/api/tagtog/callback',code_challenge:'a'.repeat(43),code_challenge_method:'S256',state:'b'.repeat(43)});const result=await f.request('/sso/authorize?'+q,{headers:{Cookie:auth.cookie}});assert.equal(result.status,403);assert.equal(result.headers.get('location'),null);});
test('401 triggers one server-side refresh and rotated tokens remain private',async t=>{const f=await fixture(t);const auth=await f.login();f.state.me401=true;const result=await f.request('/api/session',{headers:{Cookie:auth.cookie}});assert.equal(result.status,200);assert.equal(f.state.refreshes,1);assert.doesNotMatch(await result.text(),/rotated-access|rotated-refresh/);});
test('logout revokes central workspace sessions and invalidates local cookie',async t=>{const f=await fixture(t);const auth=await f.login();const result=await f.request('/api/auth/logout',{method:'POST',headers:{Cookie:auth.cookie,Origin:origin,'X-CSRF-Token':auth.session.csrfToken}});assert.equal(result.status,200);assert.match(result.headers.get('set-cookie'),/Max-Age=0/);assert.equal((await f.request('/api/session',{headers:{Cookie:auth.cookie}})).status,401);assert(f.state.calls.some(call=>call.route==='/api/sso/logout'));});
test('upstream logout failure still clears local session and reports partial failure',async t=>{const f=await fixture(t);const auth=await f.login();f.state.logoutFailure=true;const result=await f.request('/api/auth/logout',{method:'POST',headers:{Cookie:auth.cookie,Origin:origin,'X-CSRF-Token':auth.session.csrfToken}});assert.equal(result.status,503);assert.match(result.headers.get('set-cookie'),/Max-Age=0/);assert.equal((await f.request('/api/session',{headers:{Cookie:auth.cookie}})).status,401);});
test('an IAM outage cannot prevent local sign-out',async t=>{const f=await fixture(t);const auth=await f.login();f.state.offline=true;const result=await f.request('/api/auth/logout',{method:'POST',headers:{Cookie:auth.cookie,Origin:origin,'X-CSRF-Token':auth.session.csrfToken}});assert.equal(result.status,503);assert.match(result.headers.get('set-cookie'),/Max-Age=0/);f.state.offline=false;assert.equal((await f.request('/api/session',{headers:{Cookie:auth.cookie}})).status,401);});
test('account switches require an explicit global sign-out',async t=>{const f=await fixture(t);const auth=await f.login();assert.equal((await f.request('/login',{headers:{Cookie:auth.cookie}})).status,303);assert.equal((await f.request('/api/auth/login',{method:'POST',headers:{Cookie:auth.cookie,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:'other@example.invalid',password:'password'})})).status,409);});
test('returnTo remains a local URL',()=>{for(const value of['https://evil.invalid','//evil.invalid','/\\evil.invalid','/\nfoo'])assert.equal(safeReturnTo(value),'/');assert.equal(safeReturnTo('/admin'),'/admin');});

test('CRM launches only with an active IAM grant and enabled client',async t=>{
  const f=await fixture(t,{crmEnabled:true}); f.state.crmGrant=true;
  const auth=await f.login();
  assert.equal(auth.session.apps.find(app=>app.id==='crm').launchUrl,'http://127.0.0.1:8188/api/tagtog/start');
  f.state.crmGrant=false;
  const view=await(await f.request('/api/session',{headers:{Cookie:auth.cookie}})).json();
  assert(!view.apps.some(app=>app.id==='crm'));
});

test('CRM callback registration is exact and cannot use the PMS callback',async t=>{
  const f=await fixture(t,{crmEnabled:true});const auth=await f.login();
  const q=new URLSearchParams({client_id:'crm-local',redirect_uri:'http://127.0.0.1:8188/api/tagtog/callback',code_challenge:'c'.repeat(43),code_challenge_method:'S256',state:'d'.repeat(43)});
  const result=await f.request('/sso/authorize?'+q,{headers:{Cookie:auth.cookie}});
  assert.equal(result.status,303);assert.equal(new URL(result.headers.get('location')).origin,'http://127.0.0.1:8188');
  const authorize=f.state.calls.find(call=>call.route==='/api/sso/authorize');assert.equal(JSON.parse(authorize.body).clientId,'crm-local');
  q.set('redirect_uri','http://127.0.0.1:8184/api/tagtog/callback');
  assert.equal((await f.request('/sso/authorize?'+q,{headers:{Cookie:auth.cookie}})).status,400);
  q.set('redirect_uri','http://127.0.0.1:8188/api/tagtog/callback');q.set('client_id','pms-local');
  assert.equal((await f.request('/sso/authorize?'+q,{headers:{Cookie:auth.cookie}})).status,400);
});

test('disabled CRM client rejects authorization and mapping routes',async t=>{
  const f=await fixture(t);const auth=await f.login();
  const q=new URLSearchParams({client_id:'crm-local',redirect_uri:'http://127.0.0.1:8188/api/tagtog/callback',code_challenge:'c'.repeat(43),code_challenge_method:'S256',state:'d'.repeat(43)});
  assert.equal((await f.request('/sso/authorize?'+q,{headers:{Cookie:auth.cookie}})).status,400);
  assert.equal((await f.request('/api/admin/crm/users',{headers:{Cookie:auth.cookie}})).status,404);
});

test('CRM mapping proxy preserves administrator and CSRF boundaries and fixed upstream',async t=>{
  const f=await fixture(t,{crmEnabled:true});const auth=await f.login();
  const headers={Cookie:auth.cookie,Origin:origin,'Content-Type':'application/json'};
  assert.equal((await f.request('/api/admin/crm/links/2',{method:'PUT',headers,body:'{"crmUserId":9}'})).status,403);
  assert.equal((await f.request('/api/admin/crm/links/2',{method:'PUT',headers:{...headers,'X-CSRF-Token':auth.session.csrfToken},body:'{"crmUserId":9}'})).status,200);
  const call=f.state.calls.find(item=>item.route==='/api/tagtog/admin/links/2');
  assert.equal(call.origin,'http://127.0.0.1:8186');assert.deepEqual(JSON.parse(call.body),{crmUserId:9});
  f.state.admin=false;assert.equal((await f.request('/api/admin/crm/users',{headers:{Cookie:auth.cookie}})).status,403);
});
