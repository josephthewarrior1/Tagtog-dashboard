'use strict';
// Explicit disposable fixtures for the isolated loopback prototype only.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const cp=require('node:child_process');
const root=path.resolve(__dirname,'..');
const configPath=path.join(root,'.local','local-config.json');
const random=()=>crypto.randomBytes(32).toString('base64url');
function run(args,input){const r=cp.spawnSync('docker',args,{input,encoding:'utf8',windowsHide:true});if(r.status!==0)throw new Error('Isolated fixture database command failed.');return r.stdout.trim();}
function sqlLiteral(value){return "'"+String(value).replaceAll("'","''")+"'";}
function assertDisposableFixtures(c){
  if(c.crm?.legacyImport?.active===true)throw new Error('Legacy CRM copy is active. Disposable fixture seeding and fixture E2E are disabled; use the legacy mapping workflow.');
}
function assertLocal(c){
  if(!c.crm?.enabled||c.crm.database?.container!=='tagtog-local-crm-db'||c.crm.database?.name!=='tagtog_crm'||Number(c.crm.database?.port)!==55433||c.database.iam?.container!=='tagtog-local-iam-db'||c.database.iam?.name!=='tagtog_iam'||c.portal?.iamBaseUrl!=='http://127.0.0.1:8181')throw new Error('Only the dedicated TAGTOG loopback databases are allowed.');
  for(const container of ['tagtog-local-crm-db','tagtog-local-iam-db'])if(run(['inspect','--format','{{index .Config.Labels "com.tagtog.local"}}',container])!=='true')throw new Error('Fixture container ownership is not valid.');
}
function crmSql(c,query){return run(['exec','-i',c.crm.database.container,'psql','-v','ON_ERROR_STOP=1','-U',c.crm.database.user,'-d',c.crm.database.name,'-At'],query);}
async function api(base,route,token,method='GET',body){
  const response=await fetch(base+route,{method,headers:{Accept:'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000),redirect:'error'});
  if(!response.ok)throw new Error(`Local fixture API ${route} returned HTTP ${response.status}.`);
  if(response.status===204)return null;
  const result=await response.json();return result?.data??result;
}
async function seed(){
  const c=JSON.parse(fs.readFileSync(configPath,'utf8'));assertDisposableFixtures(c);assertLocal(c);
  const checkpoint=()=>fs.writeFileSync(configPath,JSON.stringify(c,null,2),{mode:0o600});
  const iam='http://127.0.0.1:8181';const crm='http://127.0.0.1:8186';
  const auth=await api(iam,'/api/auth/login',null,'POST',c.iamAdmin);
  const token=auth.accessToken;
  try{
    let roles=await api(iam,'/api/roles',token);
    let role=roles.find(item=>item.code==='TAGTOG_CRM_LOCAL_VIEWER');
    if(!role)role=await api(iam,'/api/roles',token,'POST',{code:'TAGTOG_CRM_LOCAL_VIEWER',name:'CRM local prototype viewer',description:'Disposable isolated CRM integration fixture'});
    const systems=await api(iam,`/api/roles/${role.id}/systems`,token);
    const crmSystem=systems.find(item=>item.code==='CRM');if(!crmSystem)throw new Error('Prepare the local CRM registry first.');
    await api(iam,`/api/roles/${role.id}/systems`,token,'PUT',{systemIds:[crmSystem.systemId]});
    const permissions=await api(iam,`/api/roles/${role.id}/permissions`,token);
    await api(iam,`/api/roles/${role.id}/permissions`,token,'PUT',{permissions:permissions.map(p=>({featureId:p.featureId,canView:p.systemCode==='CRM'&&p.featureCode==='workspace',canCreate:false,canEdit:false,canDelete:false}))});
    c.crm.fixtures ||= {};
    const definitions={viewer:{email:'crm-viewer@tagtog.local',fullName:'CRM Local Viewer',roleIds:[role.id]},noaccess:{email:'crm-noaccess@tagtog.local',fullName:'CRM Local No Access',roleIds:[]},unmapped:{email:'crm-unmapped@tagtog.local',fullName:'CRM Local Unmapped',roleIds:[role.id]}};
    let users=await api(iam,'/api/users',token);
    for(const [key,definition]of Object.entries(definitions)){
      let fixture=c.crm.fixtures[key];
      const existing=users.find(user=>user.email===definition.email);
      if(existing&&!fixture?.password)throw new Error('Fixture email already belongs to an unrecorded user. No automatic identity matching is permitted.');
      if(!fixture){fixture={...definition,password:random()};c.crm.fixtures[key]=fixture;checkpoint();}
      let user=existing;
      if(!user){user=await api(iam,'/api/users',token,'POST',{...definition,password:fixture.password});users.push(user);}
      await api(iam,`/api/users/${user.id}/roles`,token,'PUT',{roleIds:definition.roleIds});
      fixture.iamUserId=String(user.id);
      checkpoint();
    }
    c.crm.fixtureRoleId=role.id;
    // Deliberate local fixture records, not identity matching by email.
    for(const [key,username,fullName,localRole]of [['admin','tagtog_local_admin','TAGTOG Local Admin','ADMIN'],['viewer','tagtog_local_viewer','CRM Local Viewer','USER']]){
      const existing=crmSql(c,`SELECT id FROM app_users WHERE username=${sqlLiteral(username)};`);
      if(existing&&!c.crm.fixtures[key]?.crmUserId)throw new Error('Local CRM username already exists without fixture ownership.');
      const id=existing||crmSql(c,`INSERT INTO app_users(username,email,full_name,password,created_at) VALUES(${sqlLiteral(username)},${sqlLiteral(username+'@tagtog.local')},${sqlLiteral(fullName)},${sqlLiteral('SSO_ONLY_'+random())},now()) RETURNING id;`).split(/\r?\n/)[0];
      if(!/^[1-9]\d*$/.test(id))throw new Error('Invalid local fixture user ID.');
      crmSql(c,`INSERT INTO user_roles(user_id,role) SELECT ${id},${sqlLiteral(localRole)} WHERE NOT EXISTS(SELECT 1 FROM user_roles WHERE user_id=${id} AND role=${sqlLiteral(localRole)});`);
      c.crm.fixtures[key] ||= {};
      c.crm.fixtures[key].crmUserId=id;
      checkpoint();
    }
    const me=await api(iam,'/api/me',token);
    c.crm.fixtures.admin.iamUserId=String(me.id);
    for(const key of ['admin','viewer']){
      const fixture=c.crm.fixtures[key];
      await api(crm,`/api/tagtog/admin/links/${fixture.iamUserId}`,token,'PUT',{crmUserId:Number(fixture.crmUserId)});
    }
    fs.writeFileSync(configPath,JSON.stringify(c,null,2),{mode:0o600});
    process.stdout.write('Prepared owned local admin/viewer mappings and no-access/unmapped test identities. Credentials remain in ignored .local/local-config.json.\n');
  }finally{await api(iam,'/api/auth/logout',null,'POST',{refreshToken:auth.refreshToken}).catch(()=>{});}
}
if(require.main===module)Promise.resolve().then(()=>{if(process.argv[2]!=='seed')throw new Error('Use seed only against the isolated local prototype.');return seed();}).catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
module.exports={assertLocal,assertDisposableFixtures,api};
