'use strict';

// Separate local password-migration sandbox. Existing databases and processes
// are never stopped, reset, or reused as application databases by this runner.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const net = require('node:net');
const root = __dirname;
const directory = path.join(root, '.local', 'password-sandbox');
const configFile = path.join(directory, 'local-config.json');
const stateFile = path.join(directory, 'processes.json');
const runnerFile = path.join(root, 'crm-password-sandbox.cjs');
const bindAddress = '127.0.0.1';
const ports = Object.freeze({iam: 8191, crmBackend: 8196, crmFrontend: 8198, portal: 4192});
const random = () => crypto.randomBytes(32).toString('base64url');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const expectedRepos = Object.freeze({
  portal: root,
  iam: path.join(path.dirname(root), 'ems-v2', 'EMS-IAM'),
  crmBackend: path.join(root, '.local', 'worktrees', 'crm_be'),
  crmFrontend: path.join(root, '.local', 'worktrees', 'crm_fe'),
});

function run(binary, args, input) {
  const result = cp.spawnSync(binary, args, {input, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024});
  if (result.status !== 0) throw new Error('Owned local sandbox operation failed. No command arguments or credentials are printed.');
  return result.stdout.trim();
}
function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), {mode: 0o600, flag: 'wx'});
  fs.renameSync(temporary, file);
}
function validate(c) {
  const sandbox = c.passwordSandbox;
  if (c.localPasswordSandbox !== true || sandbox?.version !== 1 || sandbox.bindAddress !== bindAddress ||
      !/^[A-Za-z0-9_-]{43}$/.test(sandbox.ownershipId || '') ||
      sandbox.signingKeyPath !== path.join(directory, 'iam-signing-key.json')) throw new Error('Unexpected sandbox identity or signing-key path.');
  const dbs = [
    [c.database?.iam, 'tagtog-local-iam-db', 'tagtog_iam_passwords', 55431],
    [c.crm?.database, 'tagtog-local-crm-db', 'tagtog_crm_passwords', 55433],
  ];
  for (const [db, container, name, port] of dbs) {
    if (db?.container !== container || db.name !== name || db.user !== 'tagtog_local' || Number(db.port) !== port ||
        !/^[A-Za-z0-9_-]{43}$/.test(db.password || '')) throw new Error('Only the separate named sandbox databases are permitted.');
  }
  const expectedOrigins = {
    portalOrigin: 'http://localhost:4192', iamBaseUrl: 'http://localhost:8191',
    crmBaseUrl: 'http://localhost:8196', crmFrontendUrl: 'http://localhost:8198',
    pmsBaseUrl: 'http://localhost:8192', pmsFrontendUrl: 'http://localhost:8194',
    pmsCallbackUri: 'http://localhost:8194/api/tagtog/callback',
    crmCallbackUri: 'http://localhost:8198/api/tagtog/callback',
  };
  for (const [key, value] of Object.entries(expectedOrigins)) if (c.portal?.[key] !== value) throw new Error('Sandbox origins must remain on the pinned independent loopback host.');
  if (c.portal.crmEnabled !== true || c.crm?.enabled !== true || c.portal.ssoClientId !== 'pms-local' || c.portal.crmSsoClientId !== 'crm-local' ||
      c.iamAdmin?.email !== 'admin@tagtog.local' || !/^[A-Za-z0-9_-]{43}$/.test(c.iamAdmin.password || '') ||
      !/^[A-Za-z0-9_-]{43}$/.test(c.ssoSecret || '') || !/^[A-Za-z0-9_-]{43}$/.test(c.crm.ssoSecret || '') ||
      c.ssoSecret === c.crm.ssoSecret) throw new Error('Sandbox authentication configuration is invalid.');
  if (c.crm.legacyImport?.active !== true || c.crm.legacyImport.sourceKind !== 'local-crm-copy' ||
      typeof c.crm.legacyImport.importId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,117}-passwords$/.test(c.crm.legacyImport.importId) ||
      c.passwordSandbox.sourceImportId + '-passwords' !== c.crm.legacyImport.importId) throw new Error('Sandbox must use its own distinctly named legacy import.');
  for (const [actual, expected] of [[c.repos?.portal, expectedRepos.portal], [c.repos?.iam, expectedRepos.iam],
    [c.crm?.repos?.backend, expectedRepos.crmBackend], [c.crm?.repos?.frontend, expectedRepos.crmFrontend]]) {
    if (typeof actual !== 'string' || path.resolve(actual) !== expected) throw new Error('Sandbox repositories must use the exact existing local checkouts.');
  }
  return c;
}
function config() {
  if (!fs.existsSync(configFile)) throw new Error('Run node crm-password-sandbox.cjs prepare first.');
  return validate(JSON.parse(fs.readFileSync(configFile, 'utf8')));
}
function assertContainers(c) {
  validate(c);
  for (const db of [c.database.iam, c.crm.database]) {
    const info = JSON.parse(run('docker', ['inspect', '--format', '{{json .}}', db.container]));
    const bindings = info.HostConfig?.PortBindings;
    const entries = bindings?.['5432/tcp'];
    if (info.Config?.Labels?.['com.tagtog.local'] !== 'true' || info.State?.Running !== true ||
        Object.keys(bindings || {}).length !== 1 || !Array.isArray(entries) || entries.length !== 1 ||
        entries[0].HostIp !== '127.0.0.1' || entries[0].HostPort !== String(db.port)) throw new Error('Owned local database container label, running state or loopback binding differs.');
  }
}
function assertDatabases(c) {
  assertContainers(c);
  for (const db of [c.database.iam, c.crm.database]) {
    const expectedComment = 'TAGTOG password sandbox ' + c.passwordSandbox.ownershipId;
    const query = `SELECT COALESCE(shobj_description(oid,'pg_database'),'') FROM pg_database WHERE datname='${db.name}';`;
    const comment = run('docker', ['exec', '-i', db.container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', db.user, '-d', 'postgres'], query);
    if (comment !== expectedComment) throw new Error('Create and label the separate sandbox databases before starting; an existing unowned database is never adopted.');
  }
}
function prepare() {
  if (fs.existsSync(configFile)) {
    const c = config();
    assertContainers(c);
    process.stdout.write('Existing independent sandbox configuration retained. No database, account or process was changed.\n');
    return c;
  }
  const base = JSON.parse(fs.readFileSync(path.join(root, '.local', 'local-config.json'), 'utf8'));
  if (base.database?.iam?.container !== 'tagtog-local-iam-db' || base.database.iam.name !== 'tagtog_iam' ||
      Number(base.database.iam.port) !== 55431 || base.crm?.database?.container !== 'tagtog-local-crm-db' ||
      base.crm.database.name !== 'tagtog_crm' || Number(base.crm.database.port) !== 55433 ||
      base.portal?.portalOrigin !== 'http://127.0.0.1:4180') throw new Error('Expected existing local prototype configuration was not found.');
  const c = structuredClone(base);
  if (base.crm.legacyImport?.active !== true || base.crm.legacyImport.sourceKind !== 'local-crm-copy' ||
      typeof base.crm.legacyImport.importId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,117}$/.test(base.crm.legacyImport.importId)) throw new Error('The existing local CRM copy must have a valid explicit import identity.');
  c.localPasswordSandbox = true;
  c.passwordSandbox = {version: 1, ownershipId: random(), bindAddress, createdAt: new Date().toISOString(),
    sourceImportId: base.crm.legacyImport.importId, signingKeyPath: path.join(directory, 'iam-signing-key.json')};
  c.database = {iam: {...base.database.iam, name: 'tagtog_iam_passwords'}};
  c.crm.database = {...base.crm.database, name: 'tagtog_crm_passwords'};
  c.crm.legacyImport = {...base.crm.legacyImport, importId: base.crm.legacyImport.importId + '-passwords'};
  c.ssoSecret = random();
  c.crm.ssoSecret = random();
  c.iamAdmin = {email: 'admin@tagtog.local', password: random()};
  delete c.fixtures;
  delete c.crm.fixtures;
  delete c.crm.fixtureRoleId;
  c.portal = {...c.portal, portalOrigin: 'http://localhost:4192', iamBaseUrl: 'http://localhost:8191',
    crmEnabled: true, crmBaseUrl: 'http://localhost:8196', crmFrontendUrl: 'http://localhost:8198',
    crmCallbackUri: 'http://localhost:8198/api/tagtog/callback', crmSsoClientId: 'crm-local',
    pmsBaseUrl: 'http://localhost:8192', pmsFrontendUrl: 'http://localhost:8194',
    pmsCallbackUri: 'http://localhost:8194/api/tagtog/callback', ssoClientId: 'pms-local'};
  validate(c);
  assertContainers(c);
  writePrivate(configFile, c);
  process.stdout.write('Separate sandbox configuration created in .local/password-sandbox/local-config.json.\n');
  process.stdout.write('No databases, users, existing configurations or running services were modified.\n');
  return c;
}
function jar(repo, iam = false) {
  const target = path.join(repo, iam ? 'build/libs' : 'target');
  const files = fs.readdirSync(target).filter(name => name.endsWith('.jar') && !name.includes('-plain') && !name.includes('original'));
  if (files.length !== 1) throw new Error('Build exactly one executable application JAR before starting the sandbox.');
  return path.join(target, files[0]);
}
function processInfo(pid) {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const result = cp.spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress`],
  {windowsHide: true, encoding: 'utf8'});
  try { return JSON.parse(result.stdout); } catch { return null; }
}
function hasArgument(command, argument) {
  if (typeof command !== 'string' || typeof argument !== 'string') return false;
  return Array.from(command.matchAll(/(?:^|\s)(?:"([^"]*)"|([^\s"]+))/g), match => match[1] ?? match[2])
    .some(value => value.toLowerCase() === argument.toLowerCase());
}
function markers(c, resolveJars = true) {
  validate(c);
  return {
    iam: {path: resolveJars ? jar(c.repos.iam, true) : null, argument: '--server.port=8191'},
    crmBackend: {path: resolveJars ? jar(c.crm.repos.backend) : null, argument: '--server.port=8196'},
    crmFrontend: {path: path.join(c.crm.repos.frontend, 'node_modules', 'next', 'dist', 'bin', 'next'), argument: '8198'},
    portal: {path: runnerFile, argument: 'serve-portal'},
  };
}
function validStoredMarker(name, entry, c) {
  if (!entry || typeof entry.marker !== 'string') return false;
  if (name === 'iam') return path.dirname(entry.marker) === path.join(c.repos.iam, 'build', 'libs') && /\.jar$/.test(entry.marker);
  if (name === 'crmBackend') return path.dirname(entry.marker) === path.join(c.crm.repos.backend, 'target') && /^crm-kimtele-be-.*\.jar$/.test(path.basename(entry.marker));
  return entry.marker === markers(c, false)[name]?.path;
}
function ownedProcess(name, entry, c) {
  if (!validStoredMarker(name, entry, c) || !Number.isSafeInteger(entry.pid) || !entry.creationDate || !entry.commandHash ||
      entry.sandboxId !== c.passwordSandbox.ownershipId || entry.bindAddress !== bindAddress || entry.port !== ports[name]) return false;
  const info = processInfo(entry.pid), expected = markers(c, false)[name];
  return info?.ProcessId === entry.pid && info.CreationDate === entry.creationDate &&
    hasArgument(info.CommandLine, entry.marker) && hasArgument(info.CommandLine, expected.argument) && hash(info.CommandLine) === entry.commandHash;
}
function portOpen(port) {
  return new Promise(resolve => {
    const socket = net.connect({host: bindAddress, port});
    let settled = false;
    const finish = value => { if (!settled) { settled = true; socket.destroy(); resolve(value); } };
    socket.setTimeout(500); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false));
  });
}
async function launch(name, binary, args, cwd, env, marker, c) {
  if (!fs.existsSync(binary)) throw new Error('Local runtime executable is unavailable.');
  const logfile = path.join(directory, name + '.log'), fd = fs.openSync(logfile, 'a');
  let child;
  try {
    child = cp.spawn(binary, args, {cwd, env: {...process.env, ...env}, windowsHide: true, detached: true, stdio: ['ignore', fd, fd]});
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  } finally { fs.closeSync(fd); }
  child.unref();
  const info = processInfo(child.pid);
  if (!info?.CreationDate || !hasArgument(info.CommandLine, marker.path) || !hasArgument(info.CommandLine, marker.argument)) throw new Error('Could not record exact sandbox process ownership. Inspect its private log before retrying.');
  return {pid: child.pid, marker: marker.path, commandHash: hash(info.CommandLine), creationDate: info.CreationDate,
    sandboxId: c.passwordSandbox.ownershipId, bindAddress, port: ports[name], logfile, startedAt: new Date().toISOString()};
}
async function start() {
  if (process.platform !== 'win32') throw new Error('Sandbox process control requires Windows.');
  const c = config(); assertDatabases(c);
  const expected = markers(c), processes = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  const java = process.env.TAGTOG_JAVA || 'C:\\Program Files\\Android\\Android Studio\\jbr\\bin\\java.exe';
  for (const name of ['iam', 'crmBackend', 'crmFrontend', 'portal']) {
    if (await portOpen(ports[name])) {
      if (!ownedProcess(name, processes[name], c)) throw new Error('A sandbox port is already used by an unowned process; it was left untouched.');
      process.stdout.write(`${name} already listening on ${bindAddress}:${ports[name]}; left running.\n`); continue;
    }
    if (ownedProcess(name, processes[name], c)) throw new Error('An owned sandbox process is still starting. Inspect status and its private log before retrying.');
    const marker = expected[name];
    if (name === 'iam') {
      const db = c.database.iam;
      processes[name] = await launch(name, java, ['-jar', marker.path, '--server.address=' + bindAddress, '--server.port=8191'], c.repos.iam, {
        DATABASE_URL: `jdbc:postgresql://127.0.0.1:55431/${db.name}`, DB_USERNAME: db.user, DB_PASSWORD: db.password,
        IAM_ADMIN_EMAIL: c.iamAdmin.email, IAM_ADMIN_PASSWORD: c.iamAdmin.password,
        IAM_SSO_CLIENT_ID: 'pms-local', IAM_SSO_CLIENT_SECRET: c.ssoSecret, IAM_SSO_REDIRECT_URI: c.portal.pmsCallbackUri, IAM_SSO_SYSTEM_CODE: 'PMS',
        IAM_CRM_SSO_CLIENT_ID: 'crm-local', IAM_CRM_SSO_CLIENT_SECRET: c.crm.ssoSecret, IAM_CRM_SSO_REDIRECT_URI: c.portal.crmCallbackUri, IAM_CRM_SSO_SYSTEM_CODE: 'CRM',
        IAM_RSA_KEY_PATH: c.passwordSandbox.signingKeyPath, JWT_ISSUER: c.portal.iamBaseUrl,
        CORS_ALLOWED_ORIGINS: [c.portal.portalOrigin, c.portal.crmFrontendUrl].join(','),
      }, marker, c);
    } else if (name === 'crmBackend') {
      const db = c.crm.database;
      processes[name] = await launch(name, java, ['-jar', marker.path, '--spring.profiles.active=tagtog-local', '--server.address=' + bindAddress,
        '--server.port=8196', `--spring.datasource.url=jdbc:postgresql://127.0.0.1:55433/${db.name}`,
        '--app.cors.allowed-origins=' + [c.portal.portalOrigin, c.portal.crmFrontendUrl].join(',')], c.crm.repos.backend, {
        SPRING_DATASOURCE_USERNAME: db.user, SPRING_DATASOURCE_PASSWORD: db.password,
        TAGTOG_SSO_ENABLED: 'true', TAGTOG_IAM_BASE_URL: c.portal.iamBaseUrl, TAGTOG_IAM_ISSUER: c.portal.iamBaseUrl,
        TAGTOG_SSO_CLIENT_ID: 'crm-local', TAGTOG_SSO_CLIENT_SECRET: c.crm.ssoSecret, TAGTOG_SSO_REDIRECT_URI: c.portal.crmCallbackUri,
        APP_DATA_SEED: 'false', APP_ADMIN_BOOTSTRAP: 'false', EMS_INTEGRATION_ENABLED: 'false', EMS_API_URL: 'http://localhost:9',
      }, marker, c);
    } else if (name === 'crmFrontend') {
      processes[name] = await launch(name, process.execPath, [marker.path, 'dev', '-H', bindAddress, '-p', '8198'], c.crm.repos.frontend, {
        CRM_DEV_INSTANCE: 'tagtog-crm-passwords', NEXT_PUBLIC_TAGTOG_SSO_ENABLED: 'true', API_BASE_URL: c.portal.crmBaseUrl,
        TAGTOG_PORTAL_URL: c.portal.portalOrigin, CRM_TAGTOG_CALLBACK_URL: c.portal.crmCallbackUri, TAGTOG_CLIENT_ID: 'crm-local', NEXT_PUBLIC_PMS_URL: '',
      }, marker, c);
    } else {
      processes[name] = await launch(name, process.execPath, [runnerFile, 'serve-portal'], root, {}, marker, c);
    }
    writePrivate(stateFile, processes);
    process.stdout.write(`${name} started on ${bindAddress}:${ports[name]}.\n`);
  }
}
async function status() {
  const c = config(), processes = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  const urls = {iam: c.portal.iamBaseUrl + '/actuator/health', crmBackend: c.portal.crmBaseUrl + '/api/auth/me',
    crmFrontend: c.portal.crmFrontendUrl + '/login', portal: c.portal.portalOrigin + '/api/health'};
  for (const [name, url] of Object.entries(urls)) {
    let readiness;
    try { const response = await fetch(url, {signal: AbortSignal.timeout(5000), redirect: 'manual'}); readiness = 'HTTP ' + response.status; }
    catch { readiness = 'not ready'; }
    process.stdout.write(`${name}: ${readiness}; ${ownedProcess(name, processes[name], c) ? 'owned process' : 'no matching owned process'}\n`);
  }
}
function stop() {
  if (process.platform !== 'win32') throw new Error('Sandbox process control requires Windows.');
  const c = config(), processes = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  for (const name of ['portal', 'crmFrontend', 'crmBackend', 'iam']) {
    const entry = processes[name];
    if (!ownedProcess(name, entry, c)) { if (entry) process.stdout.write(`${name}: no matching owned process; left untouched.\n`); continue; }
    run('taskkill.exe', ['/PID', String(entry.pid), '/T', '/F']);
    delete processes[name]; writePrivate(stateFile, processes); process.stdout.write(name + ' stopped.\n');
  }
  process.stdout.write('Shared database containers, all databases and existing prototype services remain running and untouched.\n');
}
function servePortal() {
  const c = config();
  const {createPortalServer} = require(path.join(root, 'server.cjs'));
  const server = createPortalServer({...c.portal, root});
  server.listen(4192, bindAddress, () => process.stdout.write('TAGTOG password sandbox: ' + c.portal.portalOrigin + '\n'));
}
if (require.main === module) {
  const commands = {prepare, start, status, stop, 'serve-portal': servePortal};
  Promise.resolve().then(() => { const operation = commands[process.argv[2]]; if (!operation) throw new Error('Use prepare, start, status or stop.'); return operation(); })
    .catch(() => { process.stderr.write('Sandbox operation stopped. Check the private configuration, exact process ownership, labeled databases and local logs. No credentials are printed.\n'); process.exitCode = 1; });
}
module.exports = {validate, config, prepare, assertContainers, assertDatabases, hasArgument, ownedProcess, markers, portOpen, start, status, stop};
