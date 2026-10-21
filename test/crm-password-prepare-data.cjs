'use strict';
// Creates only two explicitly named new local databases. Existing databases are read only.
const fs=require('node:fs');
const path=require('node:path');
const cp=require('node:child_process');
const crypto=require('node:crypto');
const root=process.argv[2]||path.resolve(__dirname,'..');
const local=path.join(root,'.local','password-sandbox');
const c=JSON.parse(fs.readFileSync(path.join(local,'local-config.json'),'utf8'));
const original=JSON.parse(fs.readFileSync(path.join(root,'.local','local-config.json'),'utf8'));
const expectedComment='TAGTOG password sandbox '+c.passwordSandbox?.ownershipId;
if(c.localPasswordSandbox!==true||!/^[A-Za-z0-9_-]{43}$/.test(c.passwordSandbox?.ownershipId||'')||c.database.iam.name!=='tagtog_iam_passwords'||c.crm.database.name!=='tagtog_crm_passwords'||c.portal.portalOrigin!=='http://localhost:4192'||original.database.iam.name!=='tagtog_iam'||original.crm.database.name!=='tagtog_crm')throw new Error('Explicit separate local profile required.');
function command(args,input,encoding='utf8'){
  const result=cp.spawnSync('docker',args,{input,encoding,windowsHide:true,maxBuffer:128*1024*1024});
  if(result.status!==0)throw new Error('Owned local database operation failed; credential details suppressed.');
  return result.stdout;
}
const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
function sql(db,query,database=db.name){return command(['exec','-i',db.container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',db.user,'-d',database],query).trim();}
for(const db of[c.database.iam,c.crm.database]){
  const info=JSON.parse(command(['inspect','--format','{{json .}}',db.container]));
  const bindings=info.HostConfig?.PortBindings,ports=bindings?.['5432/tcp'];
  if(info.Config?.Labels?.['com.tagtog.local']!=='true'||!info.State?.Running||Object.keys(bindings||{}).length!==1||ports?.length!==1||ports[0].HostIp!=='127.0.0.1'||ports[0].HostPort!==String(db.port)||db.user!=='tagtog_local')throw new Error('Owned loopback database differs.');
}
const stateFile=path.join(local,'data-state.json');
const state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{version:1,ownershipId:c.passwordSandbox.ownershipId,createdAt:new Date().toISOString(),databases:{}};
if(state.ownershipId!==c.passwordSandbox.ownershipId)throw new Error('Sandbox ownership changed.');
const checkpoint=()=>fs.writeFileSync(stateFile,JSON.stringify(state,null,2),{mode:0o600});
for(const [component,db]of[['iam',c.database.iam],['crm',c.crm.database]]){
  const exists=sql(db,`SELECT coalesce((SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=${quote(db.name)}),'MISSING');`,'postgres');
  if(exists!=='MISSING'){
    if(exists!==expectedComment||state.databases[component]!==db.name)throw new Error('An existing database is not owned by this new sandbox.');
  }else{
    if(sql(db,`SELECT count(*) FROM pg_database WHERE datname=${quote(db.name)};`,'postgres')!=='0')throw new Error('Unlabelled existing database was not changed.');
    command(['exec',db.container,'createdb','-U',db.user,'-O',db.user,db.name]);
    sql(db,`COMMENT ON DATABASE ${db.name} IS ${quote(expectedComment)};`,'postgres');
    state.databases[component]=db.name;checkpoint();
  }
}
if(!state.crmRestored){
  if(sql(c.crm.database,"SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")!=='0')throw new Error('CRM sandbox is not empty; no restore was attempted.');
  const dumpFile=path.join(local,'crm-source.dump');
  const archive=command(['exec',original.crm.database.container,'pg_dump','-Fc','--no-owner','--no-privileges','-U',original.crm.database.user,'-d',original.crm.database.name],undefined,null);
  fs.writeFileSync(dumpFile,archive,{mode:0o600});
  state.crmDumpSha256=crypto.createHash('sha256').update(archive).digest('hex');checkpoint();
  command(['exec','-i',c.crm.database.container,'pg_restore','--exit-on-error','--no-owner','--no-privileges','-U',c.crm.database.user,'-d',c.crm.database.name],archive);
  state.crmRestored=true;checkpoint();
}
if(!state.cloneSessionsCleared){
  // Only the NEW database: source sessions and mappings are untouched.
  sql(c.crm.database,'TRUNCATE TABLE session_tokens,tagtog_identity_links;');
  state.cloneSessionsCleared=true;checkpoint();
}
if(!state.registryPrepared){
  sql(c.database.iam,`CREATE SCHEMA IF NOT EXISTS ems;
CREATE TABLE IF NOT EXISTS ems.systems(id BIGSERIAL PRIMARY KEY,code VARCHAR(64) NOT NULL UNIQUE,name VARCHAR(160) NOT NULL,description TEXT,base_url VARCHAR(512),icon_url VARCHAR(512),status VARCHAR(16) NOT NULL DEFAULT 'ENABLED',created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS ems.features(id BIGSERIAL PRIMARY KEY,system_id BIGINT NOT NULL,code VARCHAR(64) NOT NULL,name VARCHAR(160) NOT NULL,parent_id BIGINT,route VARCHAR(512),action_set VARCHAR(128) NOT NULL DEFAULT 'view,create,edit,delete',created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ,UNIQUE(system_id,code));
INSERT INTO ems.systems(code,name,description,base_url,status) VALUES('CRM','Customer Relationship Management','Separate local old-password sandbox','http://localhost:8198','ENABLED') ON CONFLICT(code) DO NOTHING;
INSERT INTO ems.features(system_id,code,name,route) SELECT id,'workspace','CRM workspace','/dashboard' FROM ems.systems WHERE code='CRM' ON CONFLICT(system_id,code) DO NOTHING;`);
  state.registryPrepared=true;checkpoint();
}
const tables=JSON.parse(sql(original.crm.database,`SELECT jsonb_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='public' AND tablename NOT IN('databasechangelog','databasechangeloglock','session_tokens','tagtog_identity_links');`));
function fingerprints(db){
  return tables.map(table=>{
    if(!/^[a-z_]+$/.test(table))throw new Error('Unexpected table identifier.');
    return JSON.parse(sql(db,`SELECT jsonb_build_object('table',${quote(table)},'count',count(*),'fingerprint',md5(coalesce(string_agg(row_hash,'' ORDER BY row_hash),''))) FROM (SELECT md5(to_jsonb(t)::text) row_hash FROM public.${table} t) rows;`));
  });
}
const before=fingerprints(original.crm.database),after=fingerprints(c.crm.database);
if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Cloned business data differs.');
state.businessTablesVerified=tables.length;state.verifiedAt=new Date().toISOString();checkpoint();
process.stdout.write(`Separate databases prepared; ${tables.length} CRM business tables exactly match the existing local copy. Existing IAM/CRM databases were only read.\n`);
