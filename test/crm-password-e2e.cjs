'use strict';

// Exercises one generated legacy fixture. Real legacy passwords are never loaded or guessed.
const fs=require('node:fs');
const path=require('node:path');
const cp=require('node:child_process');
const crypto=require('node:crypto');
const {validatePasswordConfig,validateContainers,loadSource,loadIam,loadLinks,supportedHash}=require('./crm-legacy-passwords.cjs');
const {fingerprint,idNumber}=require('./crm-legacy-map.cjs');
const root=path.resolve(__dirname,'..');
const PORTAL='http://localhost:4192',CRM='http://localhost:8198',ISSUER='http://localhost:8191';
const CRM_ID='90000001';
const random=()=>crypto.randomBytes(32).toString('base64url');
const literal=value=>"'"+String(value).replaceAll("'","''")+"'";
const check=(condition,message)=>{if(!condition)throw new Error(message);};
const equal=(actual,expected,message)=>check(JSON.stringify(actual)===JSON.stringify(expected),message);
function privateWrite(file,value){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file+'.tmp',JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(file+'.tmp',file);}
function command(exe,args,input){
  const value=cp.spawnSync(exe,args,{input,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
  check(value.status===0,'Owned local acceptance command failed; credentials and SQL details are suppressed.');return value.stdout.trim();
}
function sql(c,kind,query){const db=kind==='crm'?c.crm.database:c.database.iam;return command('docker',['exec','-i',db.container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',db.user,'-d',db.name],query);}
function fixtureJava(password,hash){
  check(/^[A-Za-z0-9_-]{43}$/.test(password),'Only generated fixture passwords can use this helper.');
  const profile=process.env.USERPROFILE;
  check(typeof profile==='string'&&profile.length>3,'The local dependency cache cannot be located.');
  const java='C:\\Program Files\\Android\\Android Studio\\jbr\\bin\\java.exe';
  const jars=[path.join(profile,'.gradle','caches','modules-2','files-2.1','org.springframework.security','spring-security-crypto','6.3.4','220656844844c23d07e8f0105e75c74530db2657','spring-security-crypto-6.3.4.jar'),
    path.join(profile,'.gradle','caches','modules-2','files-2.1','org.springframework','spring-jcl','6.1.14','842b2b24a375efd79af436860d22ba4e0082ff4b','spring-jcl-6.1.14.jar')];
  check([java,...jars].every(file=>fs.existsSync(file)),'The existing local Java/BCrypt runtime is unavailable.');
  const result=command(java,['--class-path',jars.join(path.delimiter),path.join(__dirname,'support','LegacyPasswordFixture.java'),...(hash?['check']:[])],password+'\n'+(hash?hash+'\n':''));
  if(hash){check(result==='true','Fixture ownership password no longer matches.');return true;}
  check(supportedHash(result),'The generated fixture hash is invalid.');return result;
}
function locations(c){const directory=path.join(root,'.local','legacy-import',c.crm.legacyImport.importId);return {fixture:path.join(root,'.local','password-sandbox','test-fixture.json'),baseline:path.join(root,'.local','password-sandbox','test-baseline.json'),report:path.join(root,'.local','password-sandbox','password-e2e-verification.json'),legacy:path.join(directory,'mapping.json'),passwords:path.join(directory,'password-migration.json')};}
function validateFixture(c,value){
  check(value?.version===1&&value.importId===c.crm.legacyImport.importId&&value.ownershipId===c.passwordSandbox.ownershipId&&
    value.crmUserId===CRM_ID&&/^legacy-pw-e2e-[a-f0-9]{12}@tagtog\.local$/.test(value.email)&&/^legacy_pw_e2e_[a-f0-9]{12}$/.test(value.username)&&
    value.email.split('@')[0].slice(-12)===value.username.slice(-12)&&(value.status==='cleaned'&&!Object.hasOwn(value,'password')||/^[A-Za-z0-9_-]{43}$/.test(value.password)),'The private fixture ownership record is invalid.');
  if(value.iamUserId)idNumber(value.iamUserId);return value;
}
function aggregate(table,where='TRUE'){
  check(/^(?:iam\.)?[a-z_][a-z0-9_]*$/.test(table),'Unexpected local table identifier.');
  return `SELECT jsonb_build_object('table',${literal(table)},'rows',count(*),'fingerprint',md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY to_jsonb(t)::text),''))) value FROM ${table} t WHERE ${where}`;
}
function snapshot(c,fixture){
  const excluded=new Set(['databasechangelog','databasechangeloglock','session_tokens','tagtog_identity_links']);
  const tables=JSON.parse(sql(c,'crm',"SELECT COALESCE(jsonb_agg(tablename ORDER BY tablename),'[]'::jsonb) FROM pg_tables WHERE schemaname='public';")).filter(table=>!excluded.has(table));
  const queries=tables.map(table=>aggregate(table,table==='app_users'?`id<>${CRM_ID}`:['user_roles','user_allowed_events'].includes(table)?`user_id<>${CRM_ID}`:'TRUE'));
  const crm=JSON.parse(sql(c,'crm',`SELECT jsonb_agg(value ORDER BY value->>'table') FROM (${queries.join(' UNION ALL ')}) records;`));
  const iamId=fixture?.iamUserId?String(idNumber(fixture.iamUserId)):null;
  const iam=JSON.parse(sql(c,'iam',`SELECT jsonb_agg(value ORDER BY value->>'table') FROM (${aggregate('iam.users',iamId?`id<>${iamId}`:'TRUE')} UNION ALL ${aggregate('iam.user_roles',iamId?`user_id<>${iamId}`:'TRUE')}) records;`));
  const links=JSON.parse(sql(c,'crm',aggregate('tagtog_identity_links',`crm_user_id<>${CRM_ID}`)+';'));
  return {crm,iam,links};
}
function assertPreserved(c,fixture,baseline){const current=snapshot(c,fixture);equal(current,baseline,'A pre-existing IAM user/role, CRM business row or identity link changed during acceptance.');return {existingIAMUnchanged:true,existingCRMBusinessTablesUnchanged:baseline.crm.length,existingCRMLinksUnchanged:true};}
function ownSource(c,fixture){
  const value=loadSource(c).find(user=>user.id===CRM_ID);
  check(value&&value.username===fixture.username&&value.email===fixture.email&&value.fullName==='Disposable legacy password acceptance'&&
    JSON.stringify(value.roles)==='["ADMIN"]'&&value.allowedEventIds.length===0,'The high-ID CRM account is not the explicitly owned fixture.');
  fixtureJava(fixture.password,value.passwordHash);return value;
}
function createFixture(c,files){
  let fixture;
  if(fs.existsSync(files.fixture))fixture=validateFixture(c,JSON.parse(fs.readFileSync(files.fixture,'utf8')));
  else{
    check(!loadSource(c).some(user=>user.id===CRM_ID),'The reserved high CRM fixture ID is occupied.');
    const suffix=crypto.randomBytes(6).toString('hex');
    fixture={version:1,importId:c.crm.legacyImport.importId,ownershipId:c.passwordSandbox.ownershipId,crmUserId:CRM_ID,email:'legacy-pw-e2e-'+suffix+'@tagtog.local',username:'legacy_pw_e2e_'+suffix,password:random(),status:'planned',createdAt:new Date().toISOString()};
    privateWrite(files.baseline,snapshot(c,null));privateWrite(files.fixture,fixture);
  }
  check(fs.existsSync(files.baseline),'The acceptance preservation baseline is missing.');
  if(!loadSource(c).some(user=>user.id===CRM_ID)){
    check(fixture.status==='planned','An owned fixture disappeared; refusing automatic replacement.');
    const hash=fixtureJava(fixture.password);
    const payload=Buffer.from(JSON.stringify({id:CRM_ID,email:fixture.email,username:fixture.username,password:hash}),'utf8').toString('base64');
    sql(c,'crm',`BEGIN; SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'; SET LOCAL lock_timeout='5s';
      LOCK TABLE app_users,user_roles IN SHARE ROW EXCLUSIVE MODE;
      CREATE TEMP TABLE _fixture ON COMMIT DROP AS SELECT * FROM jsonb_to_record(convert_from(decode('${payload}','base64'),'UTF8')::jsonb) AS r(id bigint,email text,username text,password text);
      DO $$ BEGIN IF EXISTS(SELECT 1 FROM app_users u JOIN _fixture f ON u.id=f.id OR lower(btrim(u.email))=f.email OR u.username=f.username) THEN RAISE EXCEPTION 'Fixture collision; no replacement'; END IF; END $$;
      INSERT INTO app_users(id,email,username,password,full_name,created_at) SELECT id,email,username,password,'Disposable legacy password acceptance',now() FROM _fixture;
      INSERT INTO user_roles(user_id,role) VALUES(${CRM_ID},'ADMIN'); COMMIT;`);
    fixture.status='source-created';privateWrite(files.fixture,fixture);
  }
  const source=ownSource(c,fixture),legacy=JSON.parse(fs.readFileSync(files.legacy,'utf8'));
  check(legacy.importId===c.crm.legacyImport.importId,'The explicit source audit belongs to another import.');
  const previous=legacy.entries[CRM_ID];check(!previous||previous.crmFingerprint===fingerprint(source),'The recorded fixture audit changed.');
  legacy.entries[CRM_ID]={crmUserId:CRM_ID,crmFingerprint:fingerprint(source),crm:{id:source.id,username:source.username,email:source.email,fullName:source.fullName,roles:source.roles,allowedEventIds:source.allowedEventIds},eligibility:'eligible',status:'audited'};
  legacy.crmUserCount=loadSource(c).length;privateWrite(files.legacy,legacy);
  return fixture;
}
function importAndCheck(c,files,fixture){
  const importer=path.join(__dirname,'crm-legacy-passwords.cjs');
  command(process.execPath,[importer,'import','--sandbox']);
  const migrated=JSON.parse(fs.readFileSync(files.passwords,'utf8')).entries[CRM_ID];
  check(migrated?.status==='mapped'&&migrated.email===fixture.email,'The owned fixture was not imported and explicitly mapped.');
  fixture.iamUserId=String(idNumber(migrated.iamUserId));fixture.status='mapped';privateWrite(files.fixture,fixture);
  const source=ownSource(c,fixture),identity=loadIam(c).find(value=>String(value.id)===fixture.iamUserId);
  check(identity?.email===fixture.email&&identity.passwordHash===source.passwordHash,'The importer did not preserve the exact legacy fixture hash.');
  const count=loadIam(c).length;command(process.execPath,[importer,'import','--sandbox']);
  check(loadIam(c).length===count,'Rerunning migration created an additional IAM identity.');
  return {exactFixtureHashPreserved:true,idempotentImport:true};
}
function noSecrets(value){if(!value||typeof value!=='object')return;for(const [key,child]of Object.entries(value)){check(!['token','accessToken','refreshToken','password','passwordHash','password_hash','tokenHash','token_hash','tagtogSessionId','tagtog_session_id'].includes(key),'A browser response exposed a forbidden credential field.');noSecrets(child);}}
class Client{
  constructor(c){this.c=c;this.cookies=new Map();this.portalSession=null;this.crmSession=null;}
  async request(url,{method='GET',body,headers={}}={}){
    const parsed=new URL(url);check([PORTAL,CRM].includes(parsed.origin),'Acceptance cannot leave the pinned sandbox origins.');
    check(['GET','POST'].includes(method),'Acceptance business access is read-only.');
    if(method==='POST')check(parsed.origin===PORTAL&&['/api/auth/login','/api/auth/logout'].includes(parsed.pathname)||parsed.origin===CRM&&parsed.pathname==='/api/tagtog/logout','Only authentication POSTs are allowed.');
    const jar=this.cookies.get(parsed.origin)||new Map();
    const response=await fetch(url,{method,redirect:'manual',signal:AbortSignal.timeout(30000),headers:{Accept:'application/json',...(jar.size?{Cookie:[...jar].map(([name,value])=>name+'='+value).join('; ')}:{}),...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
    for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0],separator=pair.indexOf('=');if(/Max-Age=0(?:;|$)/i.test(cookie))jar.delete(pair.slice(0,separator));else jar.set(pair.slice(0,separator),pair.slice(separator+1));}
    this.cookies.set(parsed.origin,jar);return response;
  }
  async json(url,options){const response=await this.request(url,options);check(response.status===200,'A sandbox read did not return HTTP 200.');return response.json();}
  async login(fixture){
    const wrong=await this.request(PORTAL+'/api/auth/login',{method:'POST',headers:{Origin:PORTAL},body:{email:fixture.email,password:random()}});check(wrong.status===401,'An incorrect legacy password was not rejected.');
    const response=await this.request(PORTAL+'/api/auth/login',{method:'POST',headers:{Origin:PORTAL},body:{email:fixture.email,password:fixture.password}});check(response.status===200,'The unchanged legacy fixture password could not sign in to TAGTOG.');noSecrets(await response.json());
    this.portalSession=await this.json(PORTAL+'/api/session');noSecrets(this.portalSession);
    check(String(this.portalSession.user?.id)===fixture.iamUserId,'Central identity differs from the explicitly imported fixture.');
    equal(this.portalSession.apps?.map(value=>value.id),['crm'],'The legacy fixture received access outside CRM.');check(this.portalSession.apps[0].launchUrl===CRM+'/api/tagtog/start','CRM sandbox launch URL differs.');
  }
  async open(){
    const start=await this.request(CRM+'/api/tagtog/start?returnTo=%2Fdashboard');check([302,303,307].includes(start.status),'CRM sandbox did not start SSO.');
    const authorize=new URL(start.headers.get('location'));check(authorize.origin===PORTAL&&authorize.pathname==='/sso/authorize'&&authorize.searchParams.get('client_id')===this.c.portal.crmSsoClientId&&authorize.searchParams.get('redirect_uri')===CRM+'/api/tagtog/callback'&&authorize.searchParams.get('code_challenge_method')==='S256','SSO registration or PKCE differs.');
    const authorization=await this.request(authorize.href);check([302,303,307].includes(authorization.status),'Central authorization did not redirect.');
    const callback=new URL(authorization.headers.get('location'));check(callback.origin===CRM&&callback.pathname==='/api/tagtog/callback'&&callback.searchParams.has('code')&&!callback.searchParams.has('token')&&!callback.searchParams.has('accessToken')&&!callback.searchParams.has('refreshToken'),'Invalid CRM callback or exposed bearer credential.');
    const completed=await this.request(callback.href);check([302,303,307].includes(completed.status),'CRM code exchange did not complete.');
    const landing=new URL(completed.headers.get('location'),CRM);check(landing.origin===CRM&&landing.pathname==='/dashboard','The preserved ADMIN role did not reach the CRM dashboard.');
    this.crmSession=await this.json(CRM+'/api/tagtog/session',{headers:{'X-TAGTOG-Request':'1'}});noSecrets(this.crmSession);
  }
  async logout(){
    let local=true,global=true;
    if(this.crmSession){try{const response=await this.request(CRM+'/api/tagtog/logout',{method:'POST',headers:{Origin:CRM,'X-CRM-CSRF':this.crmSession.csrfToken},body:{}});local=[200,204].includes(response.status)&&(await this.request(CRM+'/api/tagtog/session',{headers:{'X-TAGTOG-Request':'1'}})).status===401;}catch{local=false;}}
    if(this.portalSession){try{const response=await this.request(PORTAL+'/api/auth/logout',{method:'POST',headers:{Origin:PORTAL,'X-CSRF-Token':this.portalSession.csrfToken},body:{}});global=response.status===200&&(await this.request(PORTAL+'/api/session')).status===401;}catch{global=false;}}
    return {local,global};
  }
}
async function acceptance(c,fixture){
  const client=new Client(c);let logout;
  try{
    await client.login(fixture);await client.open();
    const profile=client.crmSession.user;check(String(profile?.id)===CRM_ID&&profile.username===fixture.username,'CRM did not resolve the original fixture account.');equal(profile.roles,['ADMIN'],'The original CRM fixture role changed.');equal(profile.allowedEventIds,[],'The original fixture event scope changed.');
    const me=await client.json(CRM+'/api/crm/api/auth/me');noSecrets(me);check(String(me.id)===CRM_ID&&me.username===fixture.username,'Fresh CRM profile differs.');equal(me.roles,['ADMIN'],'Fresh CRM role differs.');
    const events=await client.json(CRM+'/api/crm/api/events'),databases=await client.json(CRM+'/api/crm/api/databases'),companies=await client.json(CRM+'/api/crm/api/companies');
    check(Array.isArray(events)&&events.length===9&&Array.isArray(databases)&&databases.length===2428&&Array.isArray(companies)&&companies.length===597,'Restored business data counts differ.');
    return {syntheticFixtureOnly:true,wrongPasswordRejected:true,unchangedLegacyFixturePasswordLogin:true,crmOnly:true,pkceHandoff:true,originalCRMIdentityAndRole:true,localLogout:true,centralLogout:true,counts:{contacts:databases.length,companies:companies.length,events:events.length}};
  }finally{logout=await client.logout();check(logout.local&&logout.global,'Acceptance did not fully revoke local and central sessions.');}
}
function cleanup(c,files){
  if(!fs.existsSync(files.fixture))return {fixtureAbsent:true};
  const fixture=validateFixture(c,JSON.parse(fs.readFileSync(files.fixture,'utf8')));
  if(fixture.status==='cleaned'){check(!loadSource(c).some(value=>value.id===CRM_ID)&&!loadIam(c).some(value=>String(value.id)===fixture.iamUserId),'A cleaned fixture identity was reused.');return {fixtureRemoved:true,alreadyCleaned:true};}
  const source=loadSource(c).find(value=>value.id===CRM_ID),passwordManifest=JSON.parse(fs.readFileSync(files.passwords,'utf8'));
  const recorded=passwordManifest.entries[CRM_ID];
  if(!fixture.iamUserId&&recorded?.iamUserId){fixture.iamUserId=String(idNumber(recorded.iamUserId));privateWrite(files.fixture,fixture);}
  check(source&&fixture.iamUserId,'Owned fixture identity is incomplete; manual review is required.');ownSource(c,fixture);
  const ownedRole=JSON.parse(fs.readFileSync(files.legacy,'utf8')).iamRole?.id;
  const iam=loadIam(c).find(value=>String(value.id)===fixture.iamUserId);check(iam?.email===fixture.email&&iam.passwordHash===source.passwordHash&&iam.roleIds.length===1&&String(iam.roleIds[0])===String(ownedRole),'The IAM fixture no longer matches its owned source and role.');
  const hashLiteral=literal(source.passwordHash),email=literal(fixture.email),username=literal(fixture.username),iamId=String(idNumber(fixture.iamUserId));
  sql(c,'crm',`BEGIN; SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'; SET LOCAL lock_timeout='5s';
    LOCK TABLE app_users,user_roles,user_allowed_events,tagtog_identity_links,session_tokens IN SHARE ROW EXCLUSIVE MODE;
    DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM app_users WHERE id=${CRM_ID} AND email=${email} AND username=${username} AND password=${hashLiteral})
      OR EXISTS(SELECT 1 FROM tagtog_identity_links WHERE crm_user_id=${CRM_ID} AND (issuer<>'${ISSUER}' OR subject<>'${iamId}'))
      OR EXISTS(SELECT 1 FROM session_tokens WHERE user_id=${CRM_ID} AND (tagtog_issuer IS DISTINCT FROM '${ISSUER}' OR tagtog_subject IS DISTINCT FROM '${iamId}'))
      THEN RAISE EXCEPTION 'Cleanup fixture ownership differs'; END IF; END $$;
    DELETE FROM session_tokens WHERE user_id=${CRM_ID}; DELETE FROM tagtog_identity_links WHERE crm_user_id=${CRM_ID} AND issuer='${ISSUER}' AND subject='${iamId}';
    DELETE FROM user_allowed_events WHERE user_id=${CRM_ID}; DELETE FROM user_roles WHERE user_id=${CRM_ID};
    DELETE FROM app_users WHERE id=${CRM_ID} AND email=${email} AND username=${username} AND password=${hashLiteral}; COMMIT;`);
  sql(c,'iam',`BEGIN; SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'; SET LOCAL lock_timeout='5s';
    LOCK TABLE iam.users,iam.user_roles IN SHARE ROW EXCLUSIVE MODE;
    DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM iam.users WHERE id=${iamId} AND email=${email} AND password_hash=${hashLiteral}) THEN RAISE EXCEPTION 'Cleanup IAM fixture ownership differs'; END IF; END $$;
    DELETE FROM iam.users WHERE id=${iamId} AND email=${email} AND password_hash=${hashLiteral}; COMMIT;`);
  const legacy=JSON.parse(fs.readFileSync(files.legacy,'utf8'));check(legacy.entries[CRM_ID]?.crmFingerprint===fingerprint(source),'Owned fixture audit changed before cleanup.');delete legacy.entries[CRM_ID];legacy.crmUserCount=loadSource(c).length;privateWrite(files.legacy,legacy);
  check(passwordManifest.entries[CRM_ID]?.iamUserId===fixture.iamUserId,'Owned password fixture manifest changed.');delete passwordManifest.entries[CRM_ID];privateWrite(files.passwords,passwordManifest);
  const baseline=JSON.parse(fs.readFileSync(files.baseline,'utf8')),preserved=assertPreserved(c,null,baseline);
  fixture.status='cleaned';fixture.cleanedAt=new Date().toISOString();delete fixture.password;privateWrite(files.fixture,fixture);
  return {fixtureRemoved:true,...preserved};
}
async function main(){
  const mode=process.argv[2]||'run',keep=process.argv.includes('--keep-fixture');check(['run','cleanup'].includes(mode),'Use run [--keep-fixture] or cleanup.');check(process.argv.slice(3).every(value=>value==='--keep-fixture')&&!(mode==='cleanup'&&keep),'Unsupported acceptance arguments.');
  const c=JSON.parse(fs.readFileSync(path.join(root,'.local','password-sandbox','local-config.json'),'utf8'));check(c.localPasswordSandbox===true,'Acceptance requires the explicitly separate password sandbox.');validatePasswordConfig(c);validateContainers(c);check(c.portal.crmSsoClientId==='crm-local','Unexpected sandbox confidential client.');
  const files=locations(c);
  if(mode==='cleanup'){const result=cleanup(c,files);const report=fs.existsSync(files.report)?JSON.parse(fs.readFileSync(files.report,'utf8')):{};report.cleanup=result;privateWrite(files.report,report);process.stdout.write('Owned password acceptance fixture cleanup verified.\n');return;}
  const report={version:1,scope:'one-generated-legacy-fixture-only',realLegacyPasswordsKnown:false,startedAt:new Date().toISOString(),status:'running'};privateWrite(files.report,report);
  let fixture,stage='fixture-setup';
  try{
    fixture=createFixture(c,files);stage='hash-import-and-idempotence';report.migration=importAndCheck(c,files,fixture);stage='TAGTOG-and-CRM-flow';report.flow=await acceptance(c,fixture);
    stage='original-data-preservation';report.preservation=assertPreserved(c,fixture,JSON.parse(fs.readFileSync(files.baseline,'utf8')));report.status='passed';report.fixtureKept=keep;
  }catch(error){report.status='failed';report.failedStage=stage;report.failureMessage=error.message;throw error;}
  finally{
    try{if(!keep&&fixture)report.cleanup=cleanup(c,files);}
    catch(error){report.status='failed';report.cleanup={failed:true};report.cleanupFailureMessage=error.message;throw error;}
    finally{report.finishedAt=new Date().toISOString();privateWrite(files.report,report);}
  }
  process.stdout.write('PASS synthetic legacy fixture: exact BCrypt import, idempotence, wrong-password rejection, TAGTOG login, CRM-only PKCE handoff, original identity/role, restored data, logout and existing-data preservation.\n');
  if(keep)process.stdout.write('Fixture retained, logged out, in private .local/password-sandbox/test-fixture.json. Run cleanup after GUI verification.\n');
}
if(require.main===module)main().catch(()=>{process.stderr.write('Password acceptance stopped or failed. Inspect the private sandbox verification report; credentials, hashes and tokens are not printed.\n');process.exitCode=1;});
module.exports={Client,validateFixture,fixtureJava,snapshot,cleanup};
