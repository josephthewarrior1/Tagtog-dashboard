'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {supportedHash,makePlan,publicPlan,buildInsertSql,buildLinkSql,validatePasswordConfig,roleFromManifest,bindManifestTarget}=require('./crm-legacy-passwords.cjs');
const {fingerprint,assertRandomPasswordMappingAllowed}=require('./crm-legacy-map.cjs');
const hash='$2a$10$'+'a'.repeat(21)+'O'+'a'.repeat(30)+'.';
const user=(changes={})=>({id:'81',username:'legacy',email:'old@example.test',fullName:'Legacy User',roles:['USER'],allowedEventIds:['2'],passwordHash:hash,...changes});
const role={id:'9',code:'TAGTOG_CRM_LEGACY_TEST',description:'Owned local role'};
function fixture(users=[user()]){return {users,legacy:{entries:Object.fromEntries(users.map(value=>[value.id,{crmFingerprint:fingerprint(value)}]))},manifest:{entries:{}}};}
function plan(f,iam=[],links=[]){return makePlan(f.users,iam,links,f.legacy,f.manifest,role);}

test('BCrypt supports Spring formats and rejects malformed or excessive cost hashes',()=>{
  assert.equal(hash.length,60);assert(supportedHash(hash));
  for(const prefix of['2a','2b','2y'])assert(supportedHash(hash.replace('2a',prefix)));
  for(const bad of[null,'password',hash+'x',hash.replace('$10$','$17$'),hash.replace('$10$','$03$'),hash.replace('2a','2x'),hash.slice(0,28)+'a'+hash.slice(29),hash.slice(0,59)+'A'])assert.equal(supportedHash(bad),false);
});
test('normalized existing IAM emails always conflict, even with matching password hash or inactive status',()=>{
  const f=fixture();for(const identity of[{id:'5',email:' OLD@EXAMPLE.TEST ',passwordHash:hash,status:'ACTIVE',roleIds:['9']},{id:'5',email:'old@example.test',status:'INACTIVE',roleIds:[]}]){
    const actual=plan(f,[identity]);assert.equal(actual[0].action,'skip');assert.equal(actual[0].reason,'existing-IAM-email');assert(!Object.hasOwn(actual[0],'passwordHash'));
  }
});
test('new explicit CRM user gets original normalized email, exact hash, and bounded name',()=>{
  const f=fixture([user({email:' Old@Example.Test ',fullName:'x'.repeat(200)})]);const result=plan(f)[0];
  assert.equal(result.action,'insert');assert.equal(result.email,'old@example.test');assert.equal(result.passwordHash,hash);assert.equal(result.fullName.length,160);
  const report=JSON.stringify(publicPlan([result]));assert(!report.includes(hash));assert(!report.includes('passwordHash'));assert(!report.includes('fullName'));
});
test('missing audit, invalid email, duplicate CRM email, unsupported role/hash or existing CRM link never creates IAM identity',()=>{
  const cases=[fixture([user({email:'invalid'})]),fixture([user(),user({id:'82',email:' OLD@example.test '})]),fixture([user({roles:[]})]),fixture([user({roles:['SUPER_ADMIN']})]),fixture([user({passwordHash:'plain'})])];
  for(const f of cases)assert(plan(f).every(value=>value.action==='skip'));
  const missing=fixture();delete missing.legacy.entries['81'];assert.equal(plan(missing)[0].reason,'source-not-explicitly-audited');
  assert.equal(plan(fixture(),[],[{crmUserId:'81',subject:'7',issuer:'http://127.0.0.1:8181'}])[0].reason,'CRM-link-conflict');
});
test('tracked rerun requires exact identity, hash, source fingerprint and sole owned role before pending mapping',()=>{
  const f=fixture();f.manifest.entries['81']={iamUserId:'33',email:'old@example.test',sourceFingerprint:fingerprint(f.users[0]),status:'pending-link'};
  const identity={id:'33',email:'old@example.test',passwordHash:hash,status:'ACTIVE',roleIds:['9']};
  assert.equal(plan(f,[identity])[0].action,'link-pending');
  assert.equal(plan(f,[identity],[{crmUserId:'81',subject:'33',issuer:'http://127.0.0.1:8181'}])[0].action,'already-imported');
  for(const change of[{id:'34'},{passwordHash:hash.replace('2a','2b')},{status:'INACTIVE'},{roleIds:['9','1']},{email:'OLD@example.test'}])assert.equal(plan(f,[{...identity,...change}])[0].reason,'tracked-import-changed-review-required');
  assert.equal(plan(f,[identity],[{crmUserId:'81',subject:'90',issuer:'http://127.0.0.1:8181'}])[0].reason,'CRM-link-conflict');
});
test('insert SQL is locked, rechecks normalized collisions, imports raw hash once, and protects all existing IAM users and role assignments',()=>{
  const entries=plan(fixture()),query=buildInsertSql(entries,role);
  assert.match(query,/pg_advisory_xact_lock/);assert.match(query,/LOCK TABLE iam\.users/);assert.match(query,/lower\(btrim\(u\.email\)\)=r\.email/);assert.match(query,/ON CONFLICT\(email\) DO NOTHING/);
  assert.match(query,/md5\(to_jsonb\(u\)::text\)/);assert.match(query,/Pre-existing IAM users or roles changed; rolling back/);assert.match(query,/INSERT INTO iam\.user_roles/);
  assert(!/UPDATE\s+iam\.users|DELETE\s+FROM\s+iam\.|SET\s+password_hash/i.test(query));
  const encoded=query.match(/decode\('([^']+)','base64'\)/)[1],payload=JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));
  assert.equal(payload[0].password_hash,hash);assert.equal(payload[0].email,'old@example.test');
  assert.throws(()=>buildInsertSql([{...entries[0],passwordHash:'plaintext'}],role));assert.throws(()=>buildInsertSql([...entries,...entries],role));
});
test('role ownership requires source import, deterministic role code, ID and private creation intent',()=>{
  const importId='local-copy-test-20261021',config={crm:{legacyImport:{importId}}};
  const roleCode='TAGTOG_CRM_LEGACY_'+crypto.createHash('sha256').update(importId).digest('hex').slice(0,10).toUpperCase();
  const legacy={importId,entries:{},iamRole:{id:'9',code:roleCode,status:'created',intent:'a'.repeat(43)}};
  assert.equal(roleFromManifest(config,legacy).id,'9');
  for(const change of[{id:'01'},{code:'SUPER_ADMIN'},{status:'planned'},{intent:'bad $$ delimiter'}])assert.throws(()=>roleFromManifest(config,{...legacy,iamRole:{...legacy.iamRole,...change}}));
});
test('CRM mapping transaction is insert-only, locks and preserves existing links, and rechecks source password and scope',()=>{
  const source=[user()],pending=[{crmUserId:'81',iamUserId:'33',sourceFingerprint:fingerprint(source[0])}];
  const query=buildLinkSql(pending,source);
  assert.match(query,/LOCK TABLE app_users,user_roles,user_allowed_events,tagtog_identity_links/);
  assert.match(query,/u\.password IS DISTINCT FROM r\.password_hash/);assert.match(query,/r\.roles/);assert.match(query,/r\.allowed_event_ids/);
  assert.match(query,/CRM mapping collision; existing links were not replaced/);assert.match(query,/ON CONFLICT DO NOTHING/);
  assert.match(query,/md5\(to_jsonb\(l\)::text\)<>b\.fingerprint/);
  assert(!/UPDATE\s+tagtog_identity_links|DELETE\s+FROM/i.test(query));
  assert.throws(()=>buildLinkSql([{...pending[0],sourceFingerprint:'changed'}],source));
  assert.throws(()=>buildLinkSql(pending,source,'https://iam.example.test'));
});
function sandbox(){return {localPasswordSandbox:true,passwordSandbox:{ownershipId:'a'.repeat(43)},crm:{enabled:true,database:{container:'tagtog-local-crm-db',name:'tagtog_crm_passwords',user:'tagtog_local',port:55433},legacyImport:{active:true,sourceKind:'local-crm-copy',importId:'local-password-test-20261021'}},database:{iam:{container:'tagtog-local-iam-db',name:'tagtog_iam_passwords',user:'tagtog_local',port:55431}},portal:{portalOrigin:'http://localhost:4192',iamBaseUrl:'http://localhost:8191',crmBaseUrl:'http://localhost:8196',crmFrontendUrl:'http://localhost:8198'}};}
test('password sandbox permits only its marked separate databases, fixed loopback origins and owned containers',()=>{
  assert.doesNotThrow(()=>validatePasswordConfig(sandbox()));
  for(const mutate of[c=>c.crm.database.name='tagtog_crm',c=>c.database.iam.name='tagtog_iam',c=>c.portal.iamBaseUrl='http://127.0.0.1:8191',c=>c.portal.portalOrigin='https://example.test',c=>c.crm.database.container='another-db',c=>c.database.iam.port=5432,c=>c.passwordSandbox.ownershipId='invalid',c=>c.crm.legacyImport.importId='../escape']){
    const c=sandbox();mutate(c);assert.throws(()=>validatePasswordConfig(c));
  }
});
test('normal profile remains pinned to original database and URLs; sandbox marker cannot silently select it',()=>{
  const c=sandbox();delete c.localPasswordSandbox;assert.throws(()=>validatePasswordConfig(c));
  const normal=sandbox();delete normal.localPasswordSandbox;normal.crm.database.name='tagtog_crm';normal.database.iam.name='tagtog_iam';normal.portal={portalOrigin:'http://127.0.0.1:4180',iamBaseUrl:'http://127.0.0.1:8181',crmBaseUrl:'http://127.0.0.1:8186',crmFrontendUrl:'http://127.0.0.1:8188'};
  assert.doesNotThrow(()=>validatePasswordConfig(normal));normal.localPasswordSandbox=true;assert.throws(()=>validatePasswordConfig(normal));
});
test('sandbox mappings bind the sandbox issuer and treat original IAM issuer as a conflicting CRM mapping',()=>{
  const f=fixture();f.manifest.entries['81']={iamUserId:'33',email:'old@example.test',sourceFingerprint:fingerprint(f.users[0]),status:'pending-link'};
  const identity={id:'33',email:'old@example.test',passwordHash:hash,status:'ACTIVE',roleIds:['9']},sandboxRole={...role,issuer:'http://localhost:8191'};
  assert.equal(makePlan(f.users,[identity],[{crmUserId:'81',subject:'33',issuer:sandboxRole.issuer}],f.legacy,f.manifest,sandboxRole)[0].action,'already-imported');
  assert.equal(makePlan(f.users,[identity],[{crmUserId:'81',subject:'33',issuer:'http://127.0.0.1:8181'}],f.legacy,f.manifest,sandboxRole)[0].reason,'CRM-link-conflict');
  const query=buildLinkSql([{crmUserId:'81',iamUserId:'33',sourceFingerprint:fingerprint(f.users[0])}],f.users,sandboxRole.issuer);
  assert(query.includes(sandboxRole.issuer));assert(!query.includes("'http://127.0.0.1:8181'"));
});
test('password manifests bind exact database, issuer and sandbox ownership; only empty old manifests can be upgraded',()=>{
  const c=sandbox(),value=bindManifestTarget(c,{entries:{}});
  assert.equal(value.target.iamDatabase,'tagtog_iam_passwords');assert.equal(value.target.crmDatabase,'tagtog_crm_passwords');assert.equal(value.target.issuer,'http://localhost:8191');assert(!JSON.stringify(value).includes(c.passwordSandbox.ownershipId));
  assert.doesNotThrow(()=>bindManifestTarget(c,value));
  assert.throws(()=>bindManifestTarget(c,{entries:{81:{iamUserId:'33'}}}));
  for(const changes of[{iamDatabase:'tagtog_iam'},{crmDatabase:'tagtog_crm'},{issuer:'http://127.0.0.1:8181'},{ownershipFingerprint:'different'}])assert.throws(()=>bindManifestTarget(c,{...value,target:{...value.target,...changes}}));
});
test('random-password mapper is blocked after preserved-password import has created or mapped an identity',()=>{
  assert.doesNotThrow(()=>assertRandomPasswordMappingAllowed(null));assert.doesNotThrow(()=>assertRandomPasswordMappingAllowed({entries:{}}));
  for(const entry of[{iamUserId:'33',status:'pending-link'},{status:'mapped'},{iamUserId:'33'}])assert.throws(()=>assertRandomPasswordMappingAllowed({entries:{81:entry}}),/Random-password mapping is disabled/);
});
