'use strict';
// Local-only setup. Credentials live exclusively in ignored .local files.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const cp=require('node:child_process');
const net=require('node:net');
const root=__dirname;
const local=path.join(root,'.local');
const configFile=path.join(local,'local-config.json');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const random=()=>crypto.randomBytes(32).toString('base64url');
function writePrivate(file,value){fs.writeFileSync(file,value,{mode:0o600});}
function config(){if(!fs.existsSync(configFile))throw new Error('Run node local-stack.cjs prepare first.');return JSON.parse(fs.readFileSync(configFile,'utf8'));}
function run(binary,args,options={}){
  const result=cp.spawnSync(binary,args,{windowsHide:true,encoding:'utf8',...options});
  if(result.status!==0)throw new Error(`${path.basename(binary)} failed. Check the local logs.`);
  return result.stdout;
}
const registrySql=`CREATE SCHEMA IF NOT EXISTS ems;
CREATE TABLE IF NOT EXISTS ems.systems(id BIGSERIAL PRIMARY KEY,code VARCHAR(64) NOT NULL UNIQUE,name VARCHAR(160) NOT NULL,description TEXT,base_url VARCHAR(512),icon_url VARCHAR(512),status VARCHAR(16) NOT NULL DEFAULT 'ENABLED',created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS ems.features(id BIGSERIAL PRIMARY KEY,system_id BIGINT NOT NULL,code VARCHAR(64) NOT NULL,name VARCHAR(160) NOT NULL,parent_id BIGINT,route VARCHAR(512),action_set VARCHAR(128) NOT NULL DEFAULT 'view,create,edit,delete',created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ,UNIQUE(system_id,code));
INSERT INTO ems.systems(code,name,description,base_url,status) VALUES('PMS','Project Management System','TAGTOG local integration','http://127.0.0.1:8184','ENABLED') ON CONFLICT(code) DO UPDATE SET base_url=EXCLUDED.base_url;
INSERT INTO ems.features(system_id,code,name,route) SELECT id,'workspace','PMS workspace','/' FROM ems.systems WHERE code='PMS' ON CONFLICT(system_id,code) DO NOTHING;`;
function sql(c,which,statement){const db=c.database[which];return run('docker',['exec','-i',db.container,'psql','-v','ON_ERROR_STOP=1','-U',db.user,'-d',db.name,'-At'],{input:statement});}
async function prepare(){
  fs.mkdirSync(local,{recursive:true});
  let c;
  if(fs.existsSync(configFile)){c=config();}else{
    const base=path.dirname(root);
    c={version:1,repos:{portal:root,iam:path.join(base,'ems-v2','EMS-IAM'),pmsBackend:path.join(base,'pms_be'),pmsFrontend:path.join(base,'pms_fe')},portal:{portalOrigin:'http://127.0.0.1:4180',iamBaseUrl:'http://127.0.0.1:8181',pmsBaseUrl:'http://127.0.0.1:8182',pmsFrontendUrl:'http://127.0.0.1:8184'},ssoSecret:random(),database:{iam:{container:'tagtog-local-iam-db',name:'tagtog_iam',user:'tagtog_local',password:random(),port:55431},pms:{container:'tagtog-local-pms-db',name:'tagtog_pms',user:'tagtog_local',password:random(),port:55432}},iamAdmin:{email:'admin@tagtog.local',password:random()},fixtures:{editor:{email:'editor@tagtog.local',fullName:'Local Project Member',password:random()},viewer:{email:'viewer@tagtog.local',fullName:'Local Viewer',password:random()},noaccess:{email:'noaccess@tagtog.local',fullName:'Local No Access',password:random()},inactive:{email:'inactive@tagtog.local',fullName:'Local Inactive',password:random()}}};
    for(const [key,folder]of [['pmsBackend','pms_be'],['pmsFrontend','pms_fe']]){const checkout=path.join(local,'worktrees',folder);if(fs.existsSync(checkout))c.repos[key]=checkout;}
    if(c.repos.pmsBackend.startsWith(local+path.sep))c.database.pms.name='tagtog_pms_latest';
    writePrivate(configFile,JSON.stringify(c,null,2));
  }
  for(const [which,db]of Object.entries(c.database)){
    if(!/^tagtog-local-(iam|pms)-db$/.test(db.container)||!/^tagtog_(iam|pms|pms_latest)$/.test(db.name)||!['55431','55432'].includes(String(db.port)))throw new Error('Unexpected local database configuration.');
    const envFile=path.join(local,which+'-postgres.env');
    writePrivate(envFile,`POSTGRES_DB=${db.name}\nPOSTGRES_USER=${db.user}\nPOSTGRES_PASSWORD=${db.password}\n`);
    const exists=cp.spawnSync('docker',['container','inspect',db.container],{windowsHide:true,stdio:'ignore'}).status===0;
    if(exists){if(run('docker',['inspect','--format','{{index .Config.Labels "com.tagtog.local"}}',db.container]).trim()!=='true')throw new Error('The database container name is already in use.');run('docker',['start',db.container]);}else{run('docker',['run','-d','--name',db.container,'--label','com.tagtog.local=true','--env-file',envFile,'-p',`127.0.0.1:${db.port}:5432`,'-v',`${db.container}-data:/var/lib/postgresql/data`,'postgres:17-alpine']);}
    let ready=false;
    for(let n=0;n<30;n++){if(cp.spawnSync('docker',['exec',db.container,'pg_isready','-U',db.user,'-d',db.name],{windowsHide:true,stdio:'ignore'}).status===0){ready=true;break;}await sleep(1000);}
    if(!ready)throw new Error('Local PostgreSQL is not ready.');
    const found=run('docker',['exec',db.container,'psql','-U',db.user,'-d','postgres','-At','-c',`SELECT 1 FROM pg_database WHERE datname='${db.name}'`]).trim();
    if(found!=='1')run('docker',['exec',db.container,'createdb','-U',db.user,'-O',db.user,db.name]);
  }
  sql(c,'iam',registrySql);
  process.stdout.write('Two isolated local databases prepared. Private credentials: .local/local-config.json\n');
}
function jar(repo){const dir=path.join(repo,repo.endsWith('EMS-IAM')?'build/libs':'target');const files=fs.readdirSync(dir).filter(name=>name.endsWith('.jar')&&!name.includes('-plain')&&!name.includes('original'));if(files.length!==1)throw new Error('Build the application executable jar first: '+repo);return path.join(dir,files[0]);}
function launch(name,binary,args,cwd,env){
  const logfile=path.join(local,name+'.log');const out=fs.openSync(logfile,'a');
  const child=cp.spawn(binary,args,{cwd,env:{...process.env,...env},windowsHide:true,detached:true,stdio:['ignore',out,out]});child.unref();fs.closeSync(out);
  return{pid:child.pid,startedAt:new Date().toISOString(),binary,logfile};
}
function portOpen(port){
  return new Promise(resolve=>{
    const socket=net.connect({host:'127.0.0.1',port});let settled=false;
    const finish=open=>{if(!settled){settled=true;socket.destroy();resolve(open);}};
    socket.setTimeout(500);socket.once('connect',()=>finish(true));
    socket.once('error',()=>finish(false));socket.once('timeout',()=>finish(false));
  });
}
async function start(){
  const c=config();const java=process.env.TAGTOG_JAVA||'C:\\Program Files\\Android\\Android Studio\\jbr\\bin\\java.exe';
  const stateFile=path.join(local,'processes.json');let processes=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile)):{};
  for(const name of ['iam','pmsBackend','pmsFrontend','portal']){
    const port={iam:8181,pmsBackend:8182,pmsFrontend:8184,portal:4180}[name];
    // A listening socket owns the port even while its HTTP app is compiling or warming up.
    if(await portOpen(port)){process.stdout.write(name+' already listening on '+port+'; left running.\n');continue;}
    if(name==='iam'){
      const db=c.database.iam;
      processes[name]=launch(name,java,['-jar',jar(c.repos.iam),'--server.address=127.0.0.1','--server.port=8181'],c.repos.iam,{DATABASE_URL:`jdbc:postgresql://127.0.0.1:${db.port}/${db.name}`,DB_USERNAME:db.user,DB_PASSWORD:db.password,IAM_ADMIN_EMAIL:c.iamAdmin.email,IAM_ADMIN_PASSWORD:c.iamAdmin.password,IAM_SSO_CLIENT_ID:'pms-local',IAM_SSO_CLIENT_SECRET:c.ssoSecret,IAM_SSO_REDIRECT_URI:'http://127.0.0.1:8184/api/tagtog/callback',IAM_SSO_SYSTEM_CODE:'PMS',...(c.crm?.enabled?{IAM_CRM_SSO_CLIENT_ID:'crm-local',IAM_CRM_SSO_CLIENT_SECRET:c.crm.ssoSecret,IAM_CRM_SSO_REDIRECT_URI:'http://127.0.0.1:8188/api/tagtog/callback',IAM_CRM_SSO_SYSTEM_CODE:'CRM'}:{}),IAM_RSA_KEY_PATH:path.join(local,'iam-signing-key.json'),JWT_ISSUER:'http://127.0.0.1:8181',CORS_ALLOWED_ORIGINS:'http://127.0.0.1:4180,http://127.0.0.1:8184'+(c.crm?.enabled?',http://127.0.0.1:8188':'')});
    }else if(name==='pmsBackend'){
      const db=c.database.pms;
      processes[name]=launch(name,java,['-jar',jar(c.repos.pmsBackend),'--spring.profiles.active=tagtog-local'],c.repos.pmsBackend,{SPRING_DATASOURCE_USERNAME:db.user,SPRING_DATASOURCE_PASSWORD:db.password,TAGTOG_SSO_ENABLED:'true',TAGTOG_IAM_BASE_URL:'http://127.0.0.1:8181',TAGTOG_SSO_CLIENT_ID:'pms-local',TAGTOG_SSO_CLIENT_SECRET:c.ssoSecret,TAGTOG_SSO_REDIRECT_URI:'http://127.0.0.1:8184/api/tagtog/callback'});
    }else if(name==='pmsFrontend'){
      processes[name]=launch(name,process.execPath,[path.join(c.repos.pmsFrontend,'node_modules','next','dist','bin','next'),'dev','-H','127.0.0.1','-p','8184'],c.repos.pmsFrontend,{PMS_DEV_INSTANCE:'tagtog-local',NEXT_PUBLIC_TAGTOG_SSO_ENABLED:'true',TAGTOG_PORTAL_URL:'http://127.0.0.1:4180',PMS_TAGTOG_CALLBACK_URL:'http://127.0.0.1:8184/api/tagtog/callback',TAGTOG_CLIENT_ID:'pms-local',API_BASE_URL:'http://127.0.0.1:8182',NEXT_PUBLIC_API_BASE_URL:'http://127.0.0.1:8182'});
    }else{processes[name]=launch(name,process.execPath,[path.join(root,'server.cjs')],root,{TAGTOG_LOCAL_CONFIG:configFile});}
    writePrivate(stateFile,JSON.stringify(processes,null,2));
    process.stdout.write(name+' started on '+port+'.\n');
  }
}
async function status(){for(const [name,url]of Object.entries({portal:'http://127.0.0.1:4180/api/health',iam:'http://127.0.0.1:8181/actuator/health',pmsBackend:'http://127.0.0.1:8182/api/auth/me',pmsFrontend:'http://127.0.0.1:8184/login'})){try{const response=await fetch(url,{signal:AbortSignal.timeout(5000),redirect:'manual'});process.stdout.write(`${name}: HTTP ${response.status}\n`);}catch{process.stdout.write(name+': not ready\n');}}}
async function stop(){
  const c=config();const stateFile=path.join(local,'processes.json');const processes=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{};
  for(const [name,entry]of Object.entries(processes)){
    if(!Number.isSafeInteger(entry.pid)||entry.pid<=0)continue;
    const result=cp.spawnSync('powershell.exe',['-NoProfile','-Command',`Get-CimInstance Win32_Process -Filter 'ProcessId=${entry.pid}' | Select-Object CommandLine | ConvertTo-Json -Compress`],{windowsHide:true,encoding:'utf8'});
    let info;try{info=JSON.parse(result.stdout);}catch{continue;}
    const marker=name==='portal'?path.join(root,'server.cjs'):name==='pmsFrontend'?path.join(c.repos.pmsFrontend,'node_modules','next','dist','bin','next'):name==='iam'?c.repos.iam:name==='pmsBackend'?c.repos.pmsBackend:null;
    if(marker&&typeof info?.CommandLine==='string'&&info.CommandLine.toLowerCase().includes(marker.toLowerCase())){run('taskkill.exe',['/PID',String(entry.pid),'/T','/F']);process.stdout.write(name+' stopped.\n');}
  }
  for(const db of Object.values(c.database)){if(/^tagtog-local-(iam|pms)-db$/.test(db.container)&&run('docker',['inspect','--format','{{index .Config.Labels "com.tagtog.local"}}',db.container]).trim()==='true')run('docker',['stop',db.container]);}
}
if(require.main===module){const command=process.argv[2];Promise.resolve().then(()=>command==='prepare'?prepare():command==='start'?start():command==='status'?status():command==='stop'?stop():Promise.reject(new Error('Use prepare, start, status, or stop.'))).catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});}
module.exports={config,sql,portOpen};
