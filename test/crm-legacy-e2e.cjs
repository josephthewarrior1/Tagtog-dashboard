'use strict';

// Business data is only read. Authentication creates/revokes sessions in the owned local prototype.
const fs=require('node:fs');
const path=require('node:path');
const cp=require('node:child_process');
const {validateConfig,pathsFor,fingerprint}=require('./crm-legacy-map.cjs');
const root=path.resolve(__dirname,'..');
const PORTAL='http://127.0.0.1:4180';
const CRM='http://127.0.0.1:8188';
const pause=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const sorted=values=>[...values].map(String).sort();
function check(condition,message){if(!condition)throw new Error(message);}
function sameList(actual,expected,message){check(Array.isArray(actual)&&Array.isArray(expected)&&JSON.stringify(sorted(actual))===JSON.stringify(sorted(expected)),message);}
function noSecrets(value){
  if(!value||typeof value!=='object')return;
  for(const [key,child]of Object.entries(value)){
    check(!['token','accessToken','refreshToken','password','passwordHash','password_hash','tokenHash','token_hash','tagtogSessionId','tagtog_session_id'].includes(key),'An authentication response exposed a forbidden credential field.');
    noSecrets(child);
  }
}
function validateContainers(c){
  validateConfig(c);
  for(const [container,port]of [['tagtog-local-crm-db',55433],['tagtog-local-iam-db',55431]]){
    const result=cp.spawnSync('docker',['inspect','--format','{{json .}}',container],{windowsHide:true,encoding:'utf8'});
    check(result.status===0,'Owned local container cannot be inspected.');
    const info=JSON.parse(result.stdout);
    const bindings=info.HostConfig?.PortBindings;
    const entries=bindings?.['5432/tcp'];
    check(info.Config?.Labels?.['com.tagtog.local']==='true'&&info.State?.Running===true&&
      Object.keys(bindings||{}).length===1&&Array.isArray(entries)&&entries.length===1&&
      entries[0].HostIp==='127.0.0.1'&&entries[0].HostPort===String(port),'Owned container label/state/loopback binding differs.');
  }
}
function writePrivate(file,value){
  fs.writeFileSync(file+'.tmp',JSON.stringify(value,null,2),{mode:0o600});
  fs.renameSync(file+'.tmp',file);
}
class LocalClient{
  constructor(){this.cookies=new Map();this.portalSession=null;this.crmSession=null;}
  async request(url,{method='GET',body,headers={}}={}){
    const parsed=new URL(url);
    check([PORTAL,CRM].includes(parsed.origin),'An acceptance request tried to leave the pinned loopback services.');
    check(['GET','POST'].includes(method),'Acceptance is limited to reads and authentication POSTs.');
    if(method==='POST')check((parsed.origin===PORTAL&&['/api/auth/login','/api/auth/logout'].includes(parsed.pathname))||
      (parsed.origin===CRM&&parsed.pathname==='/api/tagtog/logout'),'Acceptance cannot mutate business data.');
    const jar=this.cookies.get(parsed.origin)||new Map();
    const response=await fetch(url,{method,redirect:'manual',signal:AbortSignal.timeout(30000),
      headers:{Accept:'application/json',...(jar.size?{Cookie:[...jar].map(([name,value])=>name+'='+value).join('; ')}:{}),
        ...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
    for(const cookie of response.headers.getSetCookie()){
      const pair=cookie.split(';')[0];const separator=pair.indexOf('=');
      if(/Max-Age=0(?:;|$)/i.test(cookie))jar.delete(pair.slice(0,separator));
      else jar.set(pair.slice(0,separator),pair.slice(separator+1));
    }
    this.cookies.set(parsed.origin,jar);return response;
  }
  async json(url,options){const response=await this.request(url,options);check(response.status===200,'A read-only acceptance endpoint did not return HTTP 200.');return response.json();}
  async login(account){
    let response;
    for(let attempt=0;attempt<5;attempt++){
      response=await this.request(PORTAL+'/api/auth/login',{method:'POST',headers:{Origin:PORTAL},body:{email:account.email,password:account.password}});
      if(response.status!==429)break;
      if(attempt<4){process.stdout.write('Local authentication rate window reached; waiting before retry.\n');await pause(16000);}
    }
    check(response?.status===200,'Central legacy-account login failed.');
    const login=await response.json();noSecrets(login);
    this.portalSession=await this.json(PORTAL+'/api/session');noSecrets(this.portalSession);
    check(String(this.portalSession.user?.id)===String(account.iamUserId),'Central identity differs from the owned mapping.');
    sameList(this.portalSession.apps?.map(application=>application.id),['crm'],'Mapped legacy identity has access outside CRM.');
    check(this.portalSession.apps[0].launchUrl===CRM+'/api/tagtog/start','CRM launch URL differs from the pinned prototype.');
  }
  async open(){
    const start=await this.request(CRM+'/api/tagtog/start?returnTo=%2Fdashboard');
    check([302,303,307].includes(start.status),'CRM did not begin the SSO redirect.');
    const authorize=new URL(start.headers.get('location'));
    check(authorize.origin===PORTAL&&authorize.pathname==='/sso/authorize'&&authorize.searchParams.get('client_id')==='crm-local'&&
      authorize.searchParams.get('redirect_uri')===CRM+'/api/tagtog/callback'&&authorize.searchParams.get('code_challenge_method')==='S256','SSO registration or PKCE differs.');
    const authorization=await this.request(authorize.href);
    check([302,303,307].includes(authorization.status),'Central CRM authorization failed.');
    const callback=new URL(authorization.headers.get('location'));
    check(callback.origin===CRM&&callback.pathname==='/api/tagtog/callback'&&callback.searchParams.has('code')&&
      !callback.searchParams.has('token')&&!callback.searchParams.has('accessToken')&&!callback.searchParams.has('refreshToken'),'CRM callback contains an invalid destination or credential field.');
    const complete=await this.request(callback.href);
    check([302,303,307].includes(complete.status),'CRM code exchange failed.');
    const landing=new URL(complete.headers.get('location'),CRM);
    check(landing.origin===CRM&&['/dashboard','/dashboard/events'].includes(landing.pathname),'CRM did not reach an allowed dashboard.');
    this.crmSession=await this.json(CRM+'/api/tagtog/session',{headers:{'X-TAGTOG-Request':'1'}});noSecrets(this.crmSession);
    return landing.pathname;
  }
  async cleanup(){
    let local=true,global=true;
    if(this.crmSession){
      try{
        const response=await this.request(CRM+'/api/tagtog/logout',{method:'POST',headers:{Origin:CRM,'X-CRM-CSRF':this.crmSession.csrfToken},body:{}});
        local=response.status===200||response.status===204;
        const session=await this.request(CRM+'/api/tagtog/session',{headers:{'X-TAGTOG-Request':'1'}});local=local&&session.status===401;
      }catch{local=false;}
    }
    if(this.portalSession){
      try{
        const response=await this.request(PORTAL+'/api/auth/logout',{method:'POST',headers:{Origin:PORTAL,'X-CSRF-Token':this.portalSession.csrfToken},body:{}});
        global=response.status===200;
        const session=await this.request(PORTAL+'/api/session');global=global&&session.status===401;
      }catch{global=false;}
    }
    return {local,global};
  }
}
async function main(){
  const c=JSON.parse(fs.readFileSync(path.join(root,'.local','local-config.json'),'utf8'));validateContainers(c);
  const locations=pathsFor(c);
  const manifest=JSON.parse(fs.readFileSync(locations.manifest,'utf8'));
  const credentials=JSON.parse(fs.readFileSync(locations.credentials,'utf8'));
  const source=JSON.parse(fs.readFileSync(path.join(locations.directory,'source-manifest.json'),'utf8'));
  check([manifest,credentials,source].every(value=>value.sourceKind==='local-crm-copy'&&value.importId===c.crm.legacyImport.importId),'Acceptance manifests do not refer to the active local copy.');
  const counts=Object.fromEntries(source.counts.map(item=>[item.entity,Number(item.records)]));
  const accounts=credentials.accounts.filter(account=>account.status==='mapped').sort((left,right)=>Number(right.roles.includes('ADMIN'))-Number(left.roles.includes('ADMIN'))||Number(left.crmUserId)-Number(right.crmUserId));
  check(accounts.length===counts.app_users&&accounts.length===manifest.crmUserCount,'The acceptance manifest does not contain every restored CRM user.');
  check(new Set(accounts.map(account=>String(account.crmUserId))).size===accounts.length,'Duplicate CRM account in acceptance manifest.');
  for(const account of accounts){
    const entry=manifest.entries[String(account.crmUserId)];
    check(entry?.status==='mapped'&&entry.crmFingerprint===fingerprint(entry.crm)&&String(entry.iam?.userId)===String(account.iamUserId)&&
      entry.iam?.email===account.email&&entry.iam?.password===account.password,'Private credentials differ from the explicit legacy mapping.');
    sameList(account.roles,entry.crm.roles,'Private role snapshot differs.');
    sameList(account.allowedEventIds,entry.crm.allowedEventIds,'Private event scope snapshot differs.');
  }
  const verification={version:1,sourceKind:'local-crm-copy',importId:manifest.importId,startedAt:new Date().toISOString(),
    businessRequests:'GET only',accountsExpected:accounts.length,accountsPassed:0,accountsFailed:0,
    expectedCounts:{databases:counts.databases,companies:counts.companies,events:counts.events},actualCounts:null,accounts:[],status:'running'};
  const reportFile=path.join(locations.directory,'verification.json');
  writePrivate(reportFile,verification);
  let eventIds=null;
  for(let index=0;index<accounts.length;index++){
    const account=accounts[index];const expected=manifest.entries[String(account.crmUserId)].crm;
    const client=new LocalClient();const result={crmUserId:String(account.crmUserId),profileMatched:false,crmOnly:false,eventScopeMatched:false,logout:null,passed:false};
    let stage='central-login';
    try{
      await client.login(account);result.crmOnly=true;
      stage='CRM-code-handoff';const landing=await client.open();
      stage='CRM-profile';const profile=client.crmSession.user;
      check(String(profile.id)===String(account.crmUserId)&&profile.username===expected.username,'CRM profile is not the original mapped legacy user.');
      sameList(profile.roles,expected.roles,'CRM roles differ from the original account.');
      sameList(profile.allowedEventIds,expected.allowedEventIds,'CRM allowed event IDs differ from the original account.');
      const isAdmin=expected.roles.includes('ADMIN');const isManager=expected.roles.includes('MANAGER');
      check(landing===(isAdmin||isManager?'/dashboard':'/dashboard/events'),'Role precedence changed the allowed landing page.');
      const me=await client.json(CRM+'/api/crm/api/auth/me');noSecrets(me);
      check(String(me.id)===String(profile.id)&&me.username===expected.username,'Fresh CRM API profile differs from the mapped user.');
      sameList(me.roles,expected.roles,'Fresh CRM API roles differ.');sameList(me.allowedEventIds,expected.allowedEventIds,'Fresh CRM API event scope differs.');
      result.profileMatched=true;result.roleClass=isAdmin?'ADMIN':isManager?'MANAGER':'USER';
      stage='event-data';const events=await client.json(CRM+'/api/crm/api/events');check(Array.isArray(events),'CRM events response is not an array.');
      const actualIds=events.map(event=>String(event.id));check(new Set(actualIds).size===actualIds.length,'CRM event response contains duplicate IDs.');
      if(isAdmin){
        check(events.length===counts.events,'Admin event count differs from the imported source.');
        if(!eventIds)eventIds=new Set(actualIds);else sameList(actualIds,[...eventIds],'Admin event set changed during acceptance.');
      }else{
        check(eventIds!==null,'An admin event snapshot is required before scoped accounts.');
        // Existing CRM list endpoint grants all events only to ADMIN. MANAGER keeps its legacy assigned-event list.
        const allowed=expected.allowedEventIds.map(String).filter(id=>eventIds.has(id));
        sameList(actualIds,allowed,'Assigned legacy event scope is not preserved.');
      }
      result.eventScopeMatched=true;result.visibleEvents=events.length;
      if(isAdmin&&!verification.actualCounts){
        stage='admin-business-counts';const databases=await client.json(CRM+'/api/crm/api/databases');const companies=await client.json(CRM+'/api/crm/api/companies');
        check(Array.isArray(databases)&&databases.length===counts.databases,'Admin contact count differs from the imported source.');
        check(Array.isArray(companies)&&companies.length===counts.companies,'Admin company count differs from the imported source.');
        verification.actualCounts={databases:databases.length,companies:companies.length,events:events.length};
      }
      result.passed=true;
    }catch{result.failedStage=stage;}
    finally{
      result.logout=await client.cleanup();
      if(!result.logout.local||!result.logout.global){result.passed=false;result.failedStage=result.failedStage||'session-cleanup';}
    }
    verification.accounts.push(result);if(result.passed)verification.accountsPassed++;else verification.accountsFailed++;
    writePrivate(reportFile,verification);
    process.stdout.write(`${result.passed?'PASS':'FAIL'} legacy account ${index+1}/${accounts.length}: profile, CRM-only access, event scope, and session cleanup.\n`);
    if(index<accounts.length-1)await pause(6500);
  }
  verification.finishedAt=new Date().toISOString();verification.status=verification.accountsFailed===0&&verification.actualCounts?'passed':'failed';
  writePrivate(reportFile,verification);
  process.stdout.write(`Legacy acceptance: ${verification.accountsPassed}/${accounts.length} accounts passed; business data was only read.\n`);
  if(verification.actualCounts)process.stdout.write(`Verified imported counts: contacts=${verification.actualCounts.databases}, companies=${verification.actualCounts.companies}, events=${verification.actualCounts.events}.\n`);
  check(verification.status==='passed','Legacy account acceptance did not fully pass.');
}
if(require.main===module)main().catch(()=>{process.stderr.write('Legacy acceptance stopped or failed. Inspect the private verification.json; credentials and tokens are not printed.\n');process.exitCode=1;});
