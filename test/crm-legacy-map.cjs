'use strict';

// Maps a restored LOCAL CRM copy. This helper never connects to the old CRM source.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const cp=require('node:child_process');
const {api}=require('./crm-local-fixtures.cjs');
const root=path.resolve(__dirname,'..');
const configPath=path.join(root,'.local','local-config.json');
const IAM='http://127.0.0.1:8181';
const CRM='http://127.0.0.1:8186';
const ROLES=new Set(['ADMIN','MANAGER','USER']);
const random=()=>crypto.randomBytes(32).toString('base64url');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');

function validateConfig(c){
  const imported=c.crm?.legacyImport;
  if(c.crm?.enabled!==true||imported?.active!==true||imported.sourceKind!=='local-crm-copy'||
      typeof imported.importId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(imported.importId))
    throw new Error('An explicitly identified local CRM copy must be active before auditing or mapping.');
  const db=c.crm.database;
  if(db?.container!=='tagtog-local-crm-db'||db.name!=='tagtog_crm'||db.user!=='tagtog_local'||Number(db.port)!==55433||
      c.database?.iam?.container!=='tagtog-local-iam-db'||c.database.iam.name!=='tagtog_iam'||
      c.database.iam.user!=='tagtog_local'||Number(c.database.iam.port)!==55431||
      c.portal?.portalOrigin!=='http://127.0.0.1:4180'||c.portal?.iamBaseUrl!==IAM||c.portal?.crmBaseUrl!==CRM||
      c.portal?.crmFrontendUrl!=='http://127.0.0.1:8188')throw new Error('Only the owned TAGTOG loopback target databases are allowed.');
  return imported;
}
function command(args,input){
  const result=cp.spawnSync('docker',args,{input,encoding:'utf8',windowsHide:true});
  if(result.status!==0)throw new Error('Owned local database inspection failed; no remote source is used by this helper.');
  return result.stdout.trim();
}
function validateContainers(c){
  validateConfig(c);
  for(const [name,port]of [['tagtog-local-crm-db',55433],['tagtog-local-iam-db',55431]]){
    const info=JSON.parse(command(['inspect','--format','{{json .}}',name]));
    const bindings=info.HostConfig?.PortBindings;
    const ports=bindings?.['5432/tcp'];
    if(info.Config?.Labels?.['com.tagtog.local']!=='true'||info.State?.Running!==true||
        Object.keys(bindings||{}).length!==1||!Array.isArray(ports)||ports.length!==1||
        ports[0].HostIp!=='127.0.0.1'||ports[0].HostPort!==String(port))
      throw new Error('Owned local database label, running state, or loopback binding differs.');
  }
}
function pathsFor(c){
  const imported=validateConfig(c);
  const directory=path.join(root,'.local','legacy-import',imported.importId);
  return {directory,manifest:path.join(directory,'mapping.json'),credentials:path.join(directory,'credentials.json')};
}
function writePrivate(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temporary=file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});
  fs.renameSync(temporary,file);
}
function idNumber(value){
  const source=String(value);
  if(!/^[1-9][0-9]*$/.test(source)||!Number.isSafeInteger(Number(source)))throw new Error('Unsupported user ID; explicit review is required.');
  return Number(source);
}
function canonicalUser(value){
  const id=String(value.id);
  if(!/^[1-9][0-9]*$/.test(id)||typeof value.username!=='string'||!value.username.trim())throw new Error('Invalid restored CRM identity record.');
  const roles=Array.isArray(value.roles)?[...new Set(value.roles.map(String))].sort():[];
  const eventIds=Array.isArray(value.allowedEventIds)?[...new Set(value.allowedEventIds.map(String))].sort():[];
  if(eventIds.some(id=>!/^\d+$/.test(id)))throw new Error('Invalid restored CRM event scope.');
  return {id,username:value.username,email:typeof value.email==='string'?value.email:'',
    fullName:typeof value.fullName==='string'?value.fullName:'',roles,allowedEventIds:eventIds};
}
const fingerprint=user=>digest(JSON.stringify(canonicalUser(user)));
function eligibility(user){
  if(!Number.isSafeInteger(Number(user.id)))return 'unsupported-id';
  if(!user.roles.length)return 'roleless';
  if(user.roles.some(role=>!ROLES.has(role)))return 'unsupported-role';
  return 'eligible';
}
function normalizeEmail(value){return typeof value==='string'?value.trim().toLowerCase():'';}
function validEmail(value){
  const local=value.split('@')[0];
  return value.length<=254&&local.length<=64&&!local.startsWith('.')&&!local.endsWith('.')&&!local.includes('..')&&
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(value)&&
    value.split('@')[1].split('.').every(label=>label.length<=63);
}
function chooseEmail(user,duplicates,occupied,importId,reservedOriginalEmails=new Set()){
  const email=normalizeEmail(user.email);
  if(validEmail(email)&&duplicates.get(email)===1&&!occupied.has(email))return {email,reason:'original-unique-email'};
  const base=`crm-legacy-${user.id}@tagtog.local`;
  if(!occupied.has(base)&&!reservedOriginalEmails.has(base))return {email:base,reason:!validEmail(email)?'invalid-original-email':duplicates.get(email)!==1?'duplicate-original-email':'existing-IAM-email'};
  const scoped=`crm-legacy-${user.id}-${digest(importId).slice(0,10)}@tagtog.local`;
  if(!occupied.has(scoped)&&!reservedOriginalEmails.has(scoped))return {email:scoped,reason:'local-alias-conflict'};
  throw new Error('The deterministic legacy alias is already owned by an untracked identity; manual review is required.');
}
function loadUsers(c){
  const sql=`SELECT COALESCE(jsonb_agg(row_data ORDER BY user_id),'[]'::jsonb) FROM (
    SELECT u.id AS user_id,jsonb_build_object('id',u.id::text,'username',u.username,'email',u.email,'fullName',u.full_name,
      'roles',COALESCE((SELECT jsonb_agg(r.role ORDER BY r.role) FROM user_roles r WHERE r.user_id=u.id),'[]'::jsonb),
      'allowedEventIds',COALESCE((SELECT jsonb_agg(a.event_id::text ORDER BY a.event_id) FROM user_allowed_events a WHERE a.user_id=u.id),'[]'::jsonb)) AS row_data
    FROM app_users u
  ) source;`;
  const db=c.crm.database;
  const users=JSON.parse(command(['exec','-i',db.container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',db.user,'-d',db.name],sql)).map(canonicalUser);
  if(new Set(users.map(user=>user.id)).size!==users.length)throw new Error('Duplicate CRM ID in local audit.');
  return users;
}
function readManifest(c){
  const location=pathsFor(c);
  if(!fs.existsSync(location.manifest))return {version:1,sourceKind:'local-crm-copy',importId:c.crm.legacyImport.importId,
    target:{container:'tagtog-local-crm-db',database:'tagtog_crm',port:55433},createdAt:new Date().toISOString(),entries:{}};
  const value=JSON.parse(fs.readFileSync(location.manifest,'utf8'));
  if(value.version!==1||value.sourceKind!=='local-crm-copy'||value.importId!==c.crm.legacyImport.importId||
      value.target?.container!=='tagtog-local-crm-db'||value.target?.database!=='tagtog_crm'||value.target?.port!==55433||
      !value.entries||typeof value.entries!=='object'||Array.isArray(value.entries))throw new Error('Private mapping manifest belongs to a different import.');
  return value;
}
function auditSnapshot(c,users,manifest){
  const current=new Set(users.map(user=>user.id));
  for(const [id,entry]of Object.entries(manifest.entries))if(!current.has(id))throw new Error('A previously audited CRM user disappeared; use a new import identity or review the private manifest.');
  for(const user of users){
    const hash=fingerprint(user);
    const previous=manifest.entries[user.id];
    if(previous&&previous.crmFingerprint!==hash)throw new Error('A restored CRM identity, role, or event scope changed after audit; mapping is stopped for review.');
    if(!previous)manifest.entries[user.id]={crmUserId:user.id,crmFingerprint:hash,crm:user,eligibility:eligibility(user),status:'audited'};
  }
  manifest.auditedAt=new Date().toISOString();
  manifest.crmUserCount=users.length;
  writePrivate(pathsFor(c).manifest,manifest);
  return manifest;
}
function credentialsSnapshot(c,manifest){
  const accounts=Object.values(manifest.entries).filter(entry=>entry.iam?.userId).map(entry=>({
    crmUserId:entry.crmUserId,username:entry.crm.username,roles:entry.crm.roles,allowedEventIds:entry.crm.allowedEventIds,
    iamUserId:entry.iam.userId,email:entry.iam.email,password:entry.iam.password,status:entry.status
  }));
  writePrivate(pathsFor(c).credentials,{sourceKind:'local-crm-copy',importId:manifest.importId,updatedAt:new Date().toISOString(),accounts});
}
function checkpoint(c,manifest){writePrivate(pathsFor(c).manifest,manifest);credentialsSnapshot(c,manifest);}
function assertRandomPasswordMappingAllowed(passwordManifest){
  if(Object.values(passwordManifest?.entries||{}).some(entry=>entry?.iamUserId||['pending-link','mapped'].includes(entry?.status)))
    throw new Error('Preserved CRM passwords have already been imported. Random-password mapping is disabled; use crm-legacy-passwords.cjs. Audit remains available.');
}
async function ensureOwnedRole(c,manifest,token){
  const code='TAGTOG_CRM_LEGACY_'+digest(manifest.importId).slice(0,10).toUpperCase();
  if(!manifest.iamRole){manifest.iamRole={code,intent:random(),status:'planned'};checkpoint(c,manifest);}
  if(manifest.iamRole.code!==code)throw new Error('Owned IAM role identity changed.');
  const description='Owned local CRM copy '+manifest.importId+' '+manifest.iamRole.intent;
  let roles=await api(IAM,'/api/roles',token);
  let role=manifest.iamRole.id?roles.find(role=>String(role.id)===String(manifest.iamRole.id)):roles.find(role=>role.code===code);
  if(role){
    if(role.code!==code||role.description!==description||role.status!=='ACTIVE')throw new Error('Existing IAM role is not the active role recorded for this import.');
  }else{
    if(manifest.iamRole.id)throw new Error('The recorded IAM role is missing.');
    manifest.iamRole.status='create-requested';checkpoint(c,manifest);
    role=await api(IAM,'/api/roles',token,'POST',{code,name:'CRM legacy local access',description});
  }
  manifest.iamRole.id=String(role.id);manifest.iamRole.status='created';checkpoint(c,manifest);
  const roleId=idNumber(role.id);
  const systems=await api(IAM,`/api/roles/${roleId}/systems`,token);
  const crmSystem=systems.find(system=>system.code==='CRM'&&system.status==='ENABLED');
  if(!crmSystem)throw new Error('The local CRM system registry must be enabled first.');
  await api(IAM,`/api/roles/${roleId}/systems`,token,'PUT',{systemIds:[idNumber(crmSystem.systemId)]});
  const permissions=await api(IAM,`/api/roles/${roleId}/permissions`,token);
  if(!permissions.some(permission=>permission.systemCode==='CRM'&&permission.featureCode==='workspace'))throw new Error('CRM workspace feature is missing from the local registry.');
  await api(IAM,`/api/roles/${roleId}/permissions`,token,'PUT',{permissions:permissions.map(permission=>{
    const allowed=permission.systemCode==='CRM'&&permission.featureCode==='workspace';
    return {featureId:idNumber(permission.featureId),canView:allowed,canCreate:allowed,canEdit:allowed,canDelete:allowed};
  })});
  return role;
}
async function verifyPendingCreation(entry,existing){
  if(entry.iam.status!=='create-requested'||!entry.iam.createRequestedAt)throw new Error('The planned IAM email is already occupied; no automatic linking is allowed.');
  let authenticated;
  try{
    authenticated=await api(IAM,'/api/auth/login',null,'POST',{email:entry.iam.email,password:entry.iam.password});
    if(String(authenticated.user?.id)!==String(existing.id)||normalizeEmail(authenticated.user?.email)!==entry.iam.email)
      throw new Error('Pending account ownership differs.');
  }catch{throw new Error('A pending IAM creation could not be verified with its recorded random credentials; manual review is required.');}
  finally{if(authenticated?.refreshToken)await api(IAM,'/api/auth/logout',null,'POST',{refreshToken:authenticated.refreshToken}).catch(()=>{});}
}
async function mapAccounts(c,manifest,users){
  const auth=await api(IAM,'/api/auth/login',null,'POST',{email:c.iamAdmin.email,password:c.iamAdmin.password});
  const token=auth.accessToken;
  try{
    const role=await ensureOwnedRole(c,manifest,token);
    let identities=await api(IAM,'/api/users',token);
    const occupied=new Set(identities.map(identity=>normalizeEmail(identity.email)));
    for(const entry of Object.values(manifest.entries))if(entry.iam?.email)occupied.add(entry.iam.email);
    const duplicates=new Map();for(const user of users){const email=normalizeEmail(user.email);duplicates.set(email,(duplicates.get(email)||0)+1);}
    const reservedOriginalEmails=new Set([...duplicates].filter(([email,count])=>count===1&&validEmail(email)).map(([email])=>email));
    let links=await api(CRM,'/api/tagtog/admin/links',token);
    let mapped=0,skipped=0;
    for(const user of users){
      const entry=manifest.entries[user.id];
      if(entry.crmFingerprint!==fingerprint(user))throw new Error('CRM user changed after audit.');
      if(entry.eligibility!=='eligible'){skipped++;continue;}
      if(!entry.iam){
        const selected=chooseEmail(user,duplicates,occupied,manifest.importId,reservedOriginalEmails);
        const fullName=(user.fullName.trim()||user.username).slice(0,200);
        entry.iam={email:selected.email,emailReason:selected.reason,password:random(),fullName,creationIntent:random(),status:'planned'};
        occupied.add(entry.iam.email);checkpoint(c,manifest);
      }
      if(typeof entry.iam.password!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(entry.iam.password))throw new Error('Recorded local credentials are invalid.');
      let identity=entry.iam.userId?identities.find(identity=>String(identity.id)===entry.iam.userId):identities.find(identity=>normalizeEmail(identity.email)===entry.iam.email);
      if(identity){
        if(normalizeEmail(identity.email)!==entry.iam.email||identity.status!=='ACTIVE')throw new Error('The tracked IAM identity changed or became inactive.');
        if(!entry.iam.userId)await verifyPendingCreation(entry,identity);
        const roleCodes=(identity.roles||[]).map(role=>typeof role==='string'?role:role.code);
        if(roleCodes.length!==1||roleCodes[0]!==role.code)throw new Error('Tracked IAM role assignments changed; review before mapping.');
      }else{
        if(entry.iam.userId)throw new Error('The tracked IAM identity is missing; no replacement was made.');
        entry.iam.status='create-requested';entry.iam.createRequestedAt=new Date().toISOString();checkpoint(c,manifest);
        identity=await api(IAM,'/api/users',token,'POST',{email:entry.iam.email,password:entry.iam.password,fullName:entry.iam.fullName,roleIds:[idNumber(role.id)]});
        identities.push(identity);
      }
      entry.iam.userId=String(identity.id);entry.iam.status='created';checkpoint(c,manifest);
      const subject=idNumber(entry.iam.userId);
      const bySubject=links.find(link=>String(link.subject)===entry.iam.userId);
      const byCrmUser=links.find(link=>String(link.crmUserId)===user.id);
      if(bySubject&&String(bySubject.crmUserId)!==user.id||byCrmUser&&String(byCrmUser.subject)!==entry.iam.userId)
        throw new Error('An existing CRM identity mapping conflicts; nothing was replaced.');
      if(!bySubject){
        await api(CRM,`/api/tagtog/admin/links/${subject}`,token,'PUT',{crmUserId:idNumber(user.id)});
        links.push({subject:entry.iam.userId,crmUserId:user.id});
      }
      entry.status='mapped';entry.mappedAt=new Date().toISOString();checkpoint(c,manifest);mapped++;
    }
    const after=loadUsers(c);
    if(after.length!==users.length||after.some(user=>manifest.entries[user.id]?.crmFingerprint!==fingerprint(user)))throw new Error('CRM identity/roles/event scope changed during mapping.');
    manifest.completedAt=new Date().toISOString();checkpoint(c,manifest);
    process.stdout.write(`Mapped ${mapped} legacy CRM accounts to separate owned CRM-only IAM test identities; skipped ${skipped} accounts requiring role/ID review.\n`);
    process.stdout.write('Passwords and mapping details are only in ignored .local/legacy-import/<importId>/credentials.json and mapping.json.\n');
  }finally{await api(IAM,'/api/auth/logout',null,'POST',{refreshToken:auth.refreshToken}).catch(()=>{});}
}
async function main(){
  const mode=process.argv[2];if(!['audit','map'].includes(mode))throw new Error('Use audit or map against the owned local CRM copy.');
  const c=JSON.parse(fs.readFileSync(configPath,'utf8'));validateContainers(c);
  if(mode==='map'){
    const passwordFile=path.join(pathsFor(c).directory,'password-migration.json');
    if(fs.existsSync(passwordFile))assertRandomPasswordMappingAllowed(JSON.parse(fs.readFileSync(passwordFile,'utf8')));
  }
  const users=loadUsers(c);const manifest=auditSnapshot(c,users,readManifest(c));
  const summary={eligible:0,roleless:0,'unsupported-role':0,'unsupported-id':0};for(const user of users)summary[eligibility(user)]++;
  process.stdout.write(`Audited ${users.length} restored local CRM accounts: eligible=${summary.eligible}, roleless=${summary.roleless}, unsupportedRole=${summary['unsupported-role']}, unsupportedId=${summary['unsupported-id']}.\n`);
  if(mode==='map')await mapAccounts(c,manifest,users);
}
if(require.main===module)main().catch(error=>{process.stderr.write('CRM legacy mapping stopped: '+error.message+'\n');process.exitCode=1;});
module.exports={validateConfig,canonicalUser,fingerprint,eligibility,normalizeEmail,validEmail,chooseEmail,idNumber,pathsFor,assertRandomPasswordMappingAllowed};
