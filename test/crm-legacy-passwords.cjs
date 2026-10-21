'use strict';

// Offline, insert-only migration for the owned LOCAL CRM and IAM copies.
// Hashes pass through process memory/stdin only; reports contain no credentials.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const cp=require('node:child_process');
const {validateConfig,canonicalUser,fingerprint,eligibility,normalizeEmail,validEmail,idNumber}=require('./crm-legacy-map.cjs');
const root=path.resolve(__dirname,'..');
const IAM='http://127.0.0.1:8181';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const literal=value=>"'"+String(value).replaceAll("'","''")+"'";
function supportedHash(value){
  if(typeof value!=='string'||!/^\$2[aby]\$(?:0[4-9]|1[0-6])\$[./A-Za-z0-9]{53}$/.test(value))return false;
  // BCrypt's last salt/hash characters have canonical encodings.
  return /[.Oeu]/.test(value[28])&&/[.CGKOSWaeimquy26]/.test(value[59]);
}
function run(args,input){
  const result=cp.spawnSync('docker',args,{input,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
  if(result.status!==0)throw new Error('Owned local password migration command failed; database details and credentials are suppressed.');
  return result.stdout.trim();
}
function validatePasswordConfig(c){
  if(c.localPasswordSandbox!==true)return validateConfig(c);
  const imported=c.crm?.legacyImport,db=c.crm?.database,iam=c.database?.iam;
  if(c.crm?.enabled!==true||imported?.active!==true||imported.sourceKind!=='local-crm-copy'||
      typeof imported.importId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(imported.importId)||
      db?.container!=='tagtog-local-crm-db'||db.name!=='tagtog_crm_passwords'||db.user!=='tagtog_local'||Number(db.port)!==55433||
      iam?.container!=='tagtog-local-iam-db'||iam.name!=='tagtog_iam_passwords'||iam.user!=='tagtog_local'||Number(iam.port)!==55431||
      typeof c.passwordSandbox?.ownershipId!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(c.passwordSandbox.ownershipId)||
      c.portal?.portalOrigin!=='http://localhost:4192'||c.portal?.iamBaseUrl!=='http://localhost:8191'||
      c.portal?.crmBaseUrl!=='http://localhost:8196'||c.portal?.crmFrontendUrl!=='http://localhost:8198')
    throw new Error('Only the explicitly marked, fixed loopback password sandbox is allowed.');
  return imported;
}
function validateContainers(c){
  validatePasswordConfig(c);
  for(const [container,port]of [['tagtog-local-crm-db',55433],['tagtog-local-iam-db',55431]]){
    const value=JSON.parse(run(['inspect','--format','{{json .}}',container]));
    const bindings=value.HostConfig?.PortBindings,ports=bindings?.['5432/tcp'];
    if(value.Config?.Labels?.['com.tagtog.local']!=='true'||value.State?.Running!==true||
        Object.keys(bindings||{}).length!==1||!Array.isArray(ports)||ports.length!==1||
        ports[0].HostIp!=='127.0.0.1'||ports[0].HostPort!==String(port))throw new Error('Owned local database running state, label or loopback binding differs.');
  }
  if(c.localPasswordSandbox===true){
    const expected='TAGTOG password sandbox '+c.passwordSandbox.ownershipId;
    for(const kind of['crm','iam'])if(sql(c,kind,"SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database();")!==expected)
      throw new Error('Password sandbox database ownership marker differs.');
  }
}
function sql(c,kind,query){
  const db=kind==='crm'?c.crm.database:c.database.iam;
  return run(['exec','-i',db.container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',db.user,'-d',db.name],query);
}
function loadSource(c){
  return JSON.parse(sql(c,'crm',`SELECT COALESCE(jsonb_agg(value ORDER BY id),'[]'::jsonb) FROM (
    SELECT u.id,jsonb_build_object('id',u.id::text,'username',u.username,'email',u.email,'fullName',u.full_name,'passwordHash',u.password,
      'roles',COALESCE((SELECT jsonb_agg(r.role ORDER BY r.role) FROM user_roles r WHERE r.user_id=u.id),'[]'::jsonb),
      'allowedEventIds',COALESCE((SELECT jsonb_agg(a.event_id::text ORDER BY a.event_id) FROM user_allowed_events a WHERE a.user_id=u.id),'[]'::jsonb)) value
    FROM app_users u) source;`)).map(value=>({...canonicalUser(value),passwordHash:value.passwordHash}));
}
function loadIam(c){
  return JSON.parse(sql(c,'iam',`SELECT COALESCE(jsonb_agg(value ORDER BY id),'[]'::jsonb) FROM (
    SELECT u.id,to_jsonb(u)||jsonb_build_object('id',u.id::text,'passwordHash',u.password_hash,
      'roleIds',COALESCE((SELECT jsonb_agg(ur.role_id::text ORDER BY ur.role_id) FROM iam.user_roles ur WHERE ur.user_id=u.id),'[]'::jsonb)) value
    FROM iam.users u) source;`));
}
function loadLinks(c){return JSON.parse(sql(c,'crm',`SELECT COALESCE(jsonb_agg(jsonb_build_object('crmUserId',crm_user_id::text,'subject',subject,'issuer',issuer) ORDER BY id),'[]'::jsonb) FROM tagtog_identity_links;`));}
function roleFromManifest(c,legacy){
  const code='TAGTOG_CRM_LEGACY_'+sha(c.crm.legacyImport.importId).slice(0,10).toUpperCase();
  if(legacy.importId!==c.crm.legacyImport.importId||legacy.iamRole?.code!==code||legacy.iamRole.status!=='created'||
      typeof legacy.iamRole.intent!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(legacy.iamRole.intent)||!legacy.entries)throw new Error('The explicit legacy CRM audit and owned CRM-only IAM role must exist first.');
  return {id:String(idNumber(legacy.iamRole.id)),code,description:'Owned local CRM copy '+legacy.importId+' '+legacy.iamRole.intent,issuer:c.portal?.iamBaseUrl||IAM};
}
function manifestPath(c){return path.join(root,'.local','legacy-import',validatePasswordConfig(c).importId,'password-migration.json');}
function bindManifestTarget(c,value){
  validatePasswordConfig(c);
  const expected={iamDatabase:c.database.iam.name,crmDatabase:c.crm.database.name,issuer:c.portal.iamBaseUrl,
    ...(c.localPasswordSandbox===true?{ownershipFingerprint:sha(c.passwordSandbox.ownershipId)}:{})};
  if(!value.target){
    if(Object.keys(value.entries||{}).length)throw new Error('A populated password manifest lacks target ownership; manual review is required.');
    value.target=expected;
  }else if(Object.keys(value.target).length!==Object.keys(expected).length||Object.entries(expected).some(([key,entry])=>value.target[key]!==entry))
    throw new Error('Password migration manifest belongs to another target database or issuer.');
  return value;
}
function readManifest(c){
  const file=manifestPath(c);
  if(!fs.existsSync(file))return bindManifestTarget(c,{version:1,importId:c.crm.legacyImport.importId,sourceKind:'local-crm-password-copy',entries:{}});
  const value=JSON.parse(fs.readFileSync(file,'utf8'));
  if(value.version!==1||value.importId!==c.crm.legacyImport.importId||value.sourceKind!=='local-crm-password-copy'||
      !value.entries||typeof value.entries!=='object'||Array.isArray(value.entries))throw new Error('Password migration manifest belongs to a different local import.');
  return bindManifestTarget(c,value);
}
function saveManifest(c,value){
  const file=manifestPath(c),temporary=file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  fs.writeFileSync(temporary,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});fs.renameSync(temporary,file);
}
function makePlan(source,iam,links,legacy,manifest,role){
  const issuer=role.issuer||IAM;
  const counts=new Map();for(const user of source){const email=normalizeEmail(user.email);counts.set(email,(counts.get(email)||0)+1);}
  return source.map(user=>{
    const email=normalizeEmail(user.email),record={crmUserId:user.id,email,sourceFingerprint:fingerprint(user)};
    const audited=legacy.entries[user.id],previous=manifest.entries[user.id];
    const reject=reason=>({...record,action:'skip',reason});
    if(!audited||audited.crmFingerprint!==record.sourceFingerprint)return reject('source-not-explicitly-audited');
    if(eligibility(user)!=='eligible')return reject('unsupported-CRM-identity-or-role');
    if(!validEmail(email))return reject('invalid-email');
    if(counts.get(email)!==1)return reject('duplicate-CRM-email');
    if(!supportedHash(user.passwordHash))return reject('unsupported-BCrypt-hash');
    const occupied=iam.filter(identity=>normalizeEmail(identity.email)===email);
    if(previous?.iamUserId){
      const identity=iam.find(value=>String(value.id)===String(previous.iamUserId));
      if(previous.sourceFingerprint!==record.sourceFingerprint||previous.email!==email||occupied.length!==1||
          !identity||String(identity.id)!==String(occupied[0].id)||identity.email!==email||identity.status!=='ACTIVE'||
          identity.passwordHash!==user.passwordHash||identity.roleIds.length!==1||String(identity.roleIds[0])!==role.id)
        return reject('tracked-import-changed-review-required');
      const collision=links.find(link=>String(link.crmUserId)===user.id||link.issuer===issuer&&String(link.subject)===String(identity.id));
      if(collision&&(String(collision.crmUserId)!==user.id||collision.issuer!==issuer||String(collision.subject)!==String(identity.id)))return reject('CRM-link-conflict');
      return {...record,action:collision?'already-imported':'link-pending',iamUserId:String(identity.id)};
    }
    // An occupied email NEVER grants ownership, even when the hash happens to match.
    if(occupied.length)return reject('existing-IAM-email');
    if(links.some(link=>String(link.crmUserId)===user.id))return reject('CRM-link-conflict');
    return {...record,action:'insert',fullName:(user.fullName.trim()||user.username).slice(0,160),passwordHash:user.passwordHash};
  });
}
function publicPlan(plan){return plan.map(({passwordHash,fullName,...value})=>value);}
function buildInsertSql(plan,role){
  const requests=plan.filter(value=>value.action==='insert');
  for(const item of requests)if(!supportedHash(item.passwordHash)||!validEmail(item.email)||item.email!==normalizeEmail(item.email))throw new Error('Unsafe password import request.');
  if(new Set(requests.map(value=>value.email)).size!==requests.length||new Set(requests.map(value=>value.crmUserId)).size!==requests.length)throw new Error('Duplicate password import request.');
  idNumber(role.id);
  const payload=Buffer.from(JSON.stringify(requests.map(value=>({crm_id:value.crmUserId,email:value.email,password_hash:value.passwordHash,full_name:value.fullName}))),'utf8').toString('base64');
  return `BEGIN;
SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'; SET LOCAL client_min_messages='error';
SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic';
DO $$ BEGIN PERFORM pg_advisory_xact_lock(1934676291,139777); END $$;
LOCK TABLE iam.users,iam.user_roles,iam.roles,iam.role_system_access,iam.role_feature_permissions,ems.systems,ems.features IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE _before_users ON COMMIT DROP AS SELECT id,md5(to_jsonb(u)::text) fingerprint FROM iam.users u;
CREATE TEMP TABLE _before_roles ON COMMIT DROP AS SELECT user_id,role_id FROM iam.user_roles;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM iam.roles WHERE id=${role.id} AND code=${literal(role.code)} AND description=${literal(role.description)} AND status='ACTIVE')
 OR (SELECT count(*) FROM iam.role_system_access WHERE role_id=${role.id})<>1
 OR NOT EXISTS(SELECT 1 FROM iam.role_system_access r JOIN ems.systems s ON s.id=r.system_id WHERE r.role_id=${role.id} AND s.code='CRM' AND s.status='ENABLED')
 OR NOT EXISTS(SELECT 1 FROM iam.role_feature_permissions p JOIN ems.features f ON f.id=p.feature_id JOIN ems.systems s ON s.id=f.system_id WHERE p.role_id=${role.id} AND s.code='CRM' AND f.code='workspace' AND p.can_view)
 OR EXISTS(SELECT 1 FROM iam.role_feature_permissions p LEFT JOIN ems.features f ON f.id=p.feature_id LEFT JOIN ems.systems s ON s.id=f.system_id WHERE p.role_id=${role.id} AND (p.can_view OR p.can_create OR p.can_edit OR p.can_delete) AND (s.code IS DISTINCT FROM 'CRM' OR f.code IS DISTINCT FROM 'workspace'))
 THEN RAISE EXCEPTION 'Owned CRM-only role does not match'; END IF;
END $$;
CREATE TEMP TABLE _requests ON COMMIT DROP AS SELECT * FROM jsonb_to_recordset(convert_from(decode('${payload}','base64'),'UTF8')::jsonb) AS r(crm_id text,email text,password_hash text,full_name text);
CREATE TEMP TABLE _inserted ON COMMIT DROP AS WITH inserted AS (
 INSERT INTO iam.users(email,password_hash,full_name,status)
 SELECT r.email,r.password_hash,r.full_name,'ACTIVE' FROM _requests r
 WHERE NOT EXISTS(SELECT 1 FROM iam.users u WHERE lower(btrim(u.email))=r.email)
 ON CONFLICT(email) DO NOTHING RETURNING id,email
) SELECT i.id,i.email,r.crm_id FROM inserted i JOIN _requests r ON r.email=i.email;
INSERT INTO iam.user_roles(user_id,role_id) SELECT id,${role.id} FROM _inserted;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM _before_users b FULL JOIN iam.users u ON u.id=b.id WHERE b.id IS NOT NULL AND (u.id IS NULL OR md5(to_jsonb(u)::text)<>b.fingerprint))
 OR EXISTS(SELECT user_id,role_id FROM _before_roles EXCEPT SELECT user_id,role_id FROM iam.user_roles)
 OR EXISTS(SELECT ur.user_id,ur.role_id FROM iam.user_roles ur JOIN _before_users b ON b.id=ur.user_id EXCEPT SELECT user_id,role_id FROM _before_roles)
 THEN RAISE EXCEPTION 'Pre-existing IAM users or roles changed; rolling back'; END IF;
END $$;
SELECT jsonb_build_object('existingIAMUnchanged',true,'inserted',COALESCE((SELECT jsonb_agg(jsonb_build_object('crmUserId',crm_id,'iamUserId',id::text,'email',email) ORDER BY id) FROM _inserted),'[]'::jsonb));
COMMIT;`;
}
function buildLinkSql(pending,source,issuer=IAM){
  if(![IAM,'http://localhost:8191'].includes(issuer))throw new Error('Unsupported local IAM issuer.');
  const requests=pending.map(entry=>{
    const user=source.find(value=>value.id===entry.crmUserId);
    idNumber(entry.crmUserId);idNumber(entry.iamUserId);
    if(!user||fingerprint(user)!==entry.sourceFingerprint||!supportedHash(user.passwordHash))throw new Error('Invalid explicit CRM mapping source.');
    return {crm_id:entry.crmUserId,subject:entry.iamUserId,username:user.username,original_email:user.email,full_name:user.fullName,
      password_hash:user.passwordHash,roles:user.roles,allowed_event_ids:user.allowedEventIds};
  });
  if(new Set(requests.map(value=>value.crm_id)).size!==requests.length||new Set(requests.map(value=>value.subject)).size!==requests.length)throw new Error('Duplicate new identity mapping request.');
  const payload=Buffer.from(JSON.stringify(requests),'utf8').toString('base64');
  return `BEGIN;
SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='5s'; SET LOCAL client_min_messages='error';
SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic';
DO $$ BEGIN PERFORM pg_advisory_xact_lock(1934676291,139778); END $$;
LOCK TABLE app_users,user_roles,user_allowed_events,tagtog_identity_links IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE _before_links ON COMMIT DROP AS SELECT id,md5(to_jsonb(l)::text) fingerprint FROM tagtog_identity_links l;
CREATE TEMP TABLE _link_requests ON COMMIT DROP AS SELECT * FROM jsonb_to_recordset(convert_from(decode('${payload}','base64'),'UTF8')::jsonb)
 AS r(crm_id bigint,subject text,username text,original_email text,full_name text,password_hash text,roles jsonb,allowed_event_ids jsonb);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM _link_requests r LEFT JOIN app_users u ON u.id=r.crm_id WHERE u.id IS NULL
  OR u.username IS DISTINCT FROM r.username OR COALESCE(u.email,'') IS DISTINCT FROM r.original_email
  OR COALESCE(u.full_name,'') IS DISTINCT FROM r.full_name OR u.password IS DISTINCT FROM r.password_hash
  OR COALESCE((SELECT jsonb_agg(role ORDER BY role) FROM (SELECT DISTINCT ur.role FROM user_roles ur WHERE ur.user_id=u.id) existing_roles),'[]'::jsonb) IS DISTINCT FROM r.roles
  OR COALESCE((SELECT jsonb_agg(event_id ORDER BY event_id) FROM (SELECT DISTINCT ua.event_id::text event_id FROM user_allowed_events ua WHERE ua.user_id=u.id) existing_events),'[]'::jsonb) IS DISTINCT FROM r.allowed_event_ids)
 THEN RAISE EXCEPTION 'CRM source identity, password or scope changed before mapping'; END IF;
 IF EXISTS(SELECT 1 FROM _link_requests r JOIN tagtog_identity_links l ON l.crm_user_id=r.crm_id OR (l.issuer='${issuer}' AND l.subject=r.subject)
  WHERE l.crm_user_id<>r.crm_id OR l.issuer<>'${issuer}' OR l.subject<>r.subject)
 THEN RAISE EXCEPTION 'CRM mapping collision; existing links were not replaced'; END IF;
END $$;
INSERT INTO tagtog_identity_links(issuer,subject,crm_user_id,updated_at)
 SELECT '${issuer}',r.subject,r.crm_id,now() FROM _link_requests r
 WHERE NOT EXISTS(SELECT 1 FROM tagtog_identity_links l WHERE l.crm_user_id=r.crm_id OR (l.issuer='${issuer}' AND l.subject=r.subject))
 ON CONFLICT DO NOTHING;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM _link_requests r WHERE NOT EXISTS(SELECT 1 FROM tagtog_identity_links l WHERE l.issuer='${issuer}' AND l.subject=r.subject AND l.crm_user_id=r.crm_id))
 OR EXISTS(SELECT 1 FROM _before_links b LEFT JOIN tagtog_identity_links l ON l.id=b.id WHERE l.id IS NULL OR md5(to_jsonb(l)::text)<>b.fingerprint)
 THEN RAISE EXCEPTION 'New mapping not exact or pre-existing link changed; rolling back'; END IF;
END $$;
SELECT jsonb_build_object('existingCRMLinksUnchanged',true,'mapped',COALESCE((SELECT jsonb_agg(jsonb_build_object('crmUserId',crm_id::text,'iamUserId',subject) ORDER BY crm_id) FROM _link_requests),'[]'::jsonb));
COMMIT;`;
}
async function linkPending(c,manifest,source,role){
  const pending=Object.values(manifest.entries).filter(value=>value.status==='pending-link');
  if(!pending.length)return;
  const identityState=loadIam(c),currentSource=loadSource(c);
  for(const entry of pending){
      const user=currentSource.find(value=>value.id===entry.crmUserId),original=source.find(value=>value.id===entry.crmUserId),identity=identityState.find(value=>String(value.id)===entry.iamUserId);
      if(!user||!original||fingerprint(user)!==entry.sourceFingerprint||user.passwordHash!==original.passwordHash||
          !identity||identity.email!==entry.email||identity.status!=='ACTIVE'||identity.passwordHash!==user.passwordHash||
          identity.roleIds.length!==1||String(identity.roleIds[0])!==role.id)throw new Error('Newly imported identity changed before CRM linking; manual review is required.');
  }
  const result=JSON.parse(sql(c,'crm',buildLinkSql(pending,currentSource,role.issuer||IAM)));
  if(result.existingCRMLinksUnchanged!==true||result.mapped.length!==pending.length)throw new Error('Existing CRM link preservation could not be verified.');
  for(const entry of pending){
      entry.status='mapped';entry.mappedAt=new Date().toISOString();saveManifest(c,manifest);
  }
}
async function main(){
  const mode=process.argv[2];if(!['audit','import'].includes(mode))throw new Error('Use audit or import for the owned local CRM password migration.');
  const sandbox=process.argv.includes('--sandbox');
  if(process.argv.slice(3).some(value=>value!=='--sandbox')||process.argv.filter(value=>value==='--sandbox').length>1)throw new Error('Unknown local migration arguments.');
  const configFile=path.join(root,'.local',...(sandbox?['password-sandbox']:[]),'local-config.json');
  const c=JSON.parse(fs.readFileSync(configFile,'utf8'));
  if(sandbox!==Boolean(c.localPasswordSandbox===true))throw new Error('Password sandbox profile and explicit marker must agree.');
  validateContainers(c);
  const directory=path.dirname(manifestPath(c)),legacy=JSON.parse(fs.readFileSync(path.join(directory,'mapping.json'),'utf8'));
  const role=roleFromManifest(c,legacy),manifest=readManifest(c),source=loadSource(c);
  const plan=makePlan(source,loadIam(c),loadLinks(c),legacy,manifest,role);
  let inserted=0;
  if(mode==='import'){
    const requests=plan.filter(value=>value.action==='insert');
    if(requests.length){
      // An orphan after an interrupted commit is intentionally a conflict, never an email-based relink.
      const result=JSON.parse(sql(c,'iam',buildInsertSql(requests,role)));
      if(result.existingIAMUnchanged!==true)throw new Error('Existing IAM preservation could not be verified.');
      for(const value of result.inserted){const request=requests.find(item=>item.crmUserId===value.crmUserId);manifest.entries[value.crmUserId]={...value,sourceFingerprint:request.sourceFingerprint,status:'pending-link',createdAt:new Date().toISOString()};}
      const createdIds=new Set(result.inserted.map(value=>value.crmUserId));
      for(let index=0;index<plan.length;index++)if(plan[index].action==='insert'&&!createdIds.has(plan[index].crmUserId)){
        const {passwordHash,fullName,...record}=plan[index];plan[index]={...record,action:'skip',reason:'concurrent-existing-IAM-email'};
      }
      inserted=result.inserted.length;saveManifest(c,manifest);
    }
    await linkPending(c,manifest,source,role);
  }
  const report={version:1,importId:manifest.importId,mode,checkedAt:new Date().toISOString(),sourceAccounts:source.length,inserted,
    existingIAMConflictCount:plan.filter(value=>value.reason==='existing-IAM-email').length,accounts:publicPlan(plan),
    mappedAccounts:Object.values(manifest.entries).filter(value=>value.status==='mapped').length};
  manifest.lastReport=report;saveManifest(c,manifest);
  process.stdout.write(JSON.stringify({mode,sourceAccounts:source.length,inserted,existingIAMConflicts:report.existingIAMConflictCount,
    alreadyImported:plan.filter(value=>value.action==='already-imported').length,mappedAccounts:report.mappedAccounts,
    skipped:plan.filter(value=>value.action==='skip').length})+'\n');
  process.stdout.write('Local migration report: .local/legacy-import/<importId>/password-migration.json. Existing IAM identities and credentials are never replaced.\n');
}
if(require.main===module)main().catch(()=>{process.stderr.write('Local CRM password migration stopped. No credential/hash details are printed. Review local ownership, identity conflicts, audited source and private migration status.\n');process.exitCode=1;});
module.exports={supportedHash,makePlan,publicPlan,buildInsertSql,buildLinkSql,validatePasswordConfig,validateContainers,loadSource,loadIam,loadLinks,roleFromManifest,bindManifestTarget,readManifest,manifestPath,linkPending};
