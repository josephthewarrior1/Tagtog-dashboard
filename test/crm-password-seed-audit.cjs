'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const cp=require('node:child_process');
const root=process.argv[2]||path.resolve(__dirname,'..');
const c=JSON.parse(fs.readFileSync(path.join(root,'.local','password-sandbox','local-config.json'),'utf8'));
const helper=require(path.join(root,'test','crm-legacy-passwords.cjs'));
const {canonicalUser,fingerprint}=require(path.join(root,'test','crm-legacy-map.cjs'));
helper.validateContainers(c);
const imported=c.crm.legacyImport;
if(!imported.importId.endsWith('-passwords'))throw new Error('A distinct sandbox import identity is required.');
const directory=path.join(root,'.local','legacy-import',imported.importId);
fs.mkdirSync(directory,{recursive:true,mode:0o700});
const file=path.join(directory,'mapping.json');
const write=value=>fs.writeFileSync(file,JSON.stringify(value,null,2),{mode:0o600});
const roleCode='TAGTOG_CRM_LEGACY_'+crypto.createHash('sha256').update(imported.importId).digest('hex').slice(0,10).toUpperCase();
const manifest=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{version:1,sourceKind:'local-crm-copy',importId:imported.importId,target:{container:c.crm.database.container,database:c.crm.database.name,port:c.crm.database.port},entries:{},createdAt:new Date().toISOString(),iamRole:{code:roleCode,intent:crypto.randomBytes(32).toString('base64url'),status:'planned'}};
if(manifest.importId!==imported.importId||manifest.iamRole.code!==roleCode)throw new Error('Sandbox audit identity differs.');
write(manifest);
const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
const description='Owned local CRM copy '+imported.importId+' '+manifest.iamRole.intent;
const db=c.database.iam;
function sql(statement){
  const result=cp.spawnSync('docker',['exec','-i',db.container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',db.user,'-d',db.name],{input:statement,encoding:'utf8',windowsHide:true});
  if(result.status!==0)throw new Error('Sandbox role preparation failed; details suppressed.');
  return result.stdout.trim();
}
const roleId=sql(`BEGIN;
LOCK TABLE iam.roles,iam.role_system_access,iam.role_feature_permissions IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM iam.roles WHERE code=${quote(roleCode)} AND (description IS DISTINCT FROM ${quote(description)} OR status<>'ACTIVE')) THEN RAISE EXCEPTION 'Role conflict'; END IF; END $$;
INSERT INTO iam.roles(code,name,description) VALUES(${quote(roleCode)},'CRM legacy password sandbox',${quote(description)}) ON CONFLICT(code) DO NOTHING;
INSERT INTO iam.role_system_access(role_id,system_id) SELECT r.id,s.id FROM iam.roles r CROSS JOIN ems.systems s WHERE r.code=${quote(roleCode)} AND s.code='CRM' ON CONFLICT DO NOTHING;
INSERT INTO iam.role_feature_permissions(role_id,feature_id,can_view,can_create,can_edit,can_delete) SELECT r.id,f.id,true,true,true,true FROM iam.roles r CROSS JOIN ems.features f JOIN ems.systems s ON s.id=f.system_id WHERE r.code=${quote(roleCode)} AND s.code='CRM' AND f.code='workspace' ON CONFLICT DO NOTHING;
SELECT id FROM iam.roles WHERE code=${quote(roleCode)}; COMMIT;`);
if(!/^[1-9][0-9]*$/.test(roleId))throw new Error('Sandbox role ID invalid.');
manifest.iamRole.id=roleId;manifest.iamRole.status='created';
const source=helper.loadSource(c);
for(const value of source){
  const user=canonicalUser(value),digest=fingerprint(user),previous=manifest.entries[user.id];
  if(previous&&previous.crmFingerprint!==digest)throw new Error('Sandbox source user changed after audit.');
  if(!previous)manifest.entries[user.id]={crmUserId:user.id,crmFingerprint:digest,crm:user,eligibility:'eligible',status:'audited'};
}
manifest.crmUserCount=source.length;manifest.auditedAt=new Date().toISOString();write(manifest);
process.stdout.write(`Audited ${source.length} CRM identities in the separate password sandbox; owned role is CRM-only. No existing IAM database was modified.\n`);
