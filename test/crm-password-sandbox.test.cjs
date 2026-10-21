'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {validate, hasArgument, ownedProcess} = require('../crm-password-sandbox.cjs');
const root = path.resolve(__dirname, '..');
function fixture() {
  return {
    localPasswordSandbox: true,
    passwordSandbox: {version: 1, ownershipId: 'a'.repeat(43), bindAddress: '127.0.0.1',
      signingKeyPath: path.join(root, '.local', 'password-sandbox', 'iam-signing-key.json'), sourceImportId: 'local-crm-20261021-test'},
    repos: {portal: root, iam: path.join(path.dirname(root), 'ems-v2', 'EMS-IAM')},
    database: {iam: {container: 'tagtog-local-iam-db', name: 'tagtog_iam_passwords', user: 'tagtog_local', port: 55431, password: 'b'.repeat(43)}},
    crm: {enabled: true, ssoSecret: 'c'.repeat(43), database: {container: 'tagtog-local-crm-db', name: 'tagtog_crm_passwords', user: 'tagtog_local', port: 55433, password: 'd'.repeat(43)},
      repos: {backend: path.join(root, '.local', 'worktrees', 'crm_be'), frontend: path.join(root, '.local', 'worktrees', 'crm_fe')},
      legacyImport: {active: true, sourceKind: 'local-crm-copy', importId: 'local-crm-20261021-test-passwords'}},
    ssoSecret: 'e'.repeat(43), iamAdmin: {email: 'admin@tagtog.local', password: 'f'.repeat(43)},
    portal: {portalOrigin: 'http://localhost:4192', iamBaseUrl: 'http://localhost:8191', crmBaseUrl: 'http://localhost:8196',
      crmFrontendUrl: 'http://localhost:8198', pmsBaseUrl: 'http://localhost:8192', pmsFrontendUrl: 'http://localhost:8194',
      pmsCallbackUri: 'http://localhost:8194/api/tagtog/callback', crmCallbackUri: 'http://localhost:8198/api/tagtog/callback',
      crmEnabled: true, ssoClientId: 'pms-local', crmSsoClientId: 'crm-local'},
  };
}
test('only the separate fixed local databases and cookie host are accepted', () => {
  const c = fixture(); assert.equal(validate(c), c);
  for (const alter of [value => {value.database.iam.name = 'tagtog_iam';}, value => {value.crm.database.name = 'tagtog_crm';},
    value => {value.database.iam.port = 5432;}, value => {value.crm.database.container = 'crm-kimtele-postgres';},
    value => {value.portal.portalOrigin = 'http://127.0.0.1:4192';}, value => {value.portal.iamBaseUrl = 'https://production.example';},
    value => {value.passwordSandbox.bindAddress = '0.0.0.0';}]) {
    const changed = fixture(); alter(changed); assert.throws(() => validate(changed));
  }
});
test('signing keys, import manifests and source checkouts cannot alias the original prototype', () => {
  for (const alter of [value => {value.passwordSandbox.signingKeyPath = path.join(root, '.local', 'iam-signing-key.json');},
    value => {value.crm.legacyImport.importId = value.passwordSandbox.sourceImportId;},
    value => {value.crm.legacyImport.active = false;}, value => {value.crm.repos.backend = path.join(root, '..', 'Crm_Kimcommunication_be');},
    value => {value.localPasswordSandbox = false;}, value => {value.ssoSecret = value.crm.ssoSecret;}]) {
    const changed = fixture(); alter(changed); assert.throws(() => validate(changed));
  }
});
test('process matching uses whole Windows arguments rather than a path substring', () => {
  const command = '"C:\\Program Files\\Java\\java.exe" -jar "C:\\Folder Kim\\crm.jar" --server.port=8196';
  assert.equal(hasArgument(command, 'C:\\Folder Kim\\crm.jar'), true);
  assert.equal(hasArgument(command, '--server.port=8196'), true);
  assert.equal(hasArgument(command, '--server.port=819'), false);
  assert.equal(hasArgument(command, 'C:\\Folder Kim'), false);
});
test('a stale or foreign sandbox process receipt cannot authorize stopping a process', () => {
  const c = fixture();
  const receipt = {pid: process.pid, marker: path.join(c.repos.iam, 'build', 'libs', 'iam.jar'),
    creationDate: 'unknown', commandHash: 'unknown', sandboxId: 'different-sandbox', bindAddress: '127.0.0.1', port: 8191};
  assert.equal(ownedProcess('iam', receipt, c), false);
  receipt.sandboxId = c.passwordSandbox.ownershipId; receipt.port = 8181;
  assert.equal(ownedProcess('iam', receipt, c), false);
  receipt.port = 8191; receipt.marker = path.join(c.repos.iam, '..', 'foreign.jar');
  assert.equal(ownedProcess('iam', receipt, c), false);
});
