'use strict';

// CRM-only local fixture. No IAM/portal process is stopped or restarted here.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const net = require('node:net');
const root = __dirname;
const local = path.join(root, '.local');
const configFile = path.join(local, 'local-config.json');
const stateFile = path.join(local, 'crm-processes.json');
const random = () => crypto.randomBytes(32).toString('base64url');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const expectedRepos = {
  backend: path.join(local, 'worktrees', 'crm_be'),
  frontend: path.join(local, 'worktrees', 'crm_fe'),
};

function writePrivate(file, value) {
  fs.writeFileSync(file, value, {mode: 0o600});
}
function config() {
  if (!fs.existsSync(configFile)) throw new Error('Run node local-stack.cjs prepare first.');
  return JSON.parse(fs.readFileSync(configFile, 'utf8'));
}
function run(binary, args, options = {}) {
  const result = cp.spawnSync(binary, args, {windowsHide: true, encoding: 'utf8', ...options});
  if (result.status !== 0) throw new Error(`${path.basename(binary)} failed. Check the local logs.`);
  return result.stdout;
}
function validate(c) {
  const crm = c.crm;
  const db = crm?.database;
  if (crm?.enabled !== true || !/^[A-Za-z0-9_-]{43}$/.test(crm.ssoSecret || '') ||
      db?.container !== 'tagtog-local-crm-db' || db.name !== 'tagtog_crm' ||
      db.user !== 'tagtog_local' || Number(db.port) !== 55433 ||
      !/^[A-Za-z0-9_-]{43}$/.test(db.password || '')) {
    throw new Error('Unexpected CRM fixture configuration. Run node crm-local.cjs prepare.');
  }
  for (const key of Object.keys(expectedRepos)) {
    if (typeof crm.repos?.[key] !== 'string' || path.resolve(crm.repos[key]) !== expectedRepos[key]) {
      throw new Error('CRM must use the isolated local worktrees.');
    }
  }
  if (c.portal?.portalOrigin !== 'http://127.0.0.1:4180' ||
      c.portal?.iamBaseUrl !== 'http://127.0.0.1:8181' ||
      c.portal?.crmBaseUrl !== 'http://127.0.0.1:8186' ||
      c.portal?.crmFrontendUrl !== 'http://127.0.0.1:8188') {
    throw new Error('CRM fixture service addresses must remain on the pinned loopback ports.');
  }
  return crm;
}
function existsContainer(name) {
  return cp.spawnSync('docker', ['container', 'inspect', name], {windowsHide: true, stdio: 'ignore'}).status === 0;
}
function assertContainer(name, hostPort) {
  if (run('docker', ['inspect', '--format', '{{index .Config.Labels "com.tagtog.local"}}', name]).trim() !== 'true') {
    throw new Error('The fixture container name is already in use.');
  }
  const bindings = JSON.parse(run('docker', ['inspect', '--format', '{{json .HostConfig.PortBindings}}', name]));
  const entries = bindings?.['5432/tcp'];
  if (Object.keys(bindings || {}).length !== 1 || !Array.isArray(entries) || entries.length !== 1 ||
      entries[0].HostIp !== '127.0.0.1' || entries[0].HostPort !== String(hostPort)) {
    throw new Error('The fixture database must bind only to its expected loopback port.');
  }
}
function assertIamFixture(c) {
  const db = c.database?.iam;
  if (db?.container !== 'tagtog-local-iam-db' || db.name !== 'tagtog_iam' ||
      db.user !== 'tagtog_local' || Number(db.port) !== 55431) {
    throw new Error('CRM registration requires the existing isolated IAM fixture.');
  }
  assertContainer(db.container, 55431);
  return db;
}
function sqlCrm(c, statement) {
  const db = validate(c).database;
  assertContainer(db.container, 55433);
  return run('docker', ['exec', '-i', db.container, 'psql', '-v', 'ON_ERROR_STOP=1',
    '-U', db.user, '-d', db.name, '-At'], {input: statement});
}
const registrySql = `INSERT INTO ems.systems(code,name,description,base_url,status)
VALUES('CRM','Customer Relationship Management','TAGTOG local CRM prototype','http://127.0.0.1:8188','ENABLED')
ON CONFLICT(code) DO UPDATE SET base_url=EXCLUDED.base_url;
INSERT INTO ems.features(system_id,code,name,route,action_set)
SELECT id,'workspace','CRM workspace','/dashboard','view,create,edit,delete' FROM ems.systems WHERE code='CRM'
ON CONFLICT(system_id,code) DO NOTHING;`;

async function prepare() {
  fs.mkdirSync(local, {recursive: true});
  const c = config();
  if (!c.crm) {
    c.crm = {enabled: true, ssoSecret: random(), database: {
      container: 'tagtog-local-crm-db', name: 'tagtog_crm', user: 'tagtog_local', password: random(), port: 55433,
    }, repos: {...expectedRepos}, fixtures: {}};
  }
  c.portal = {...c.portal, crmEnabled: true, crmBaseUrl: 'http://127.0.0.1:8186', crmFrontendUrl: 'http://127.0.0.1:8188'};
  const crm = validate(c);
  const iam = assertIamFixture(c);
  if (crm.ssoSecret === c.ssoSecret || crm.database.password === c.database.iam.password ||
      crm.database.password === c.database.pms?.password) throw new Error('CRM requires independent generated secrets.');
  for (const repo of Object.values(crm.repos)) {
    if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) throw new Error('Prepare the clean CRM worktrees first.');
  }
  writePrivate(configFile, JSON.stringify(c, null, 2));
  const db = crm.database;
  const envFile = path.join(local, 'crm-postgres.env');
  writePrivate(envFile, `POSTGRES_DB=${db.name}\nPOSTGRES_USER=${db.user}\nPOSTGRES_PASSWORD=${db.password}\n`);
  if (existsContainer(db.container)) {
    assertContainer(db.container, 55433);
    run('docker', ['start', db.container]);
  } else {
    const volume = db.container + '-data';
    const volumeExists = cp.spawnSync('docker', ['volume', 'inspect', volume], {windowsHide: true, stdio: 'ignore'}).status === 0;
    if (volumeExists) {
      const label = run('docker', ['volume', 'inspect', '--format', '{{index .Labels "com.tagtog.local"}}', volume]).trim();
      if (label !== 'true') throw new Error('The CRM fixture volume name is already in use.');
    } else {
      run('docker', ['volume', 'create', '--label', 'com.tagtog.local=true', '--label', 'com.tagtog.component=crm', volume]);
    }
    run('docker', ['run', '-d', '--name', db.container, '--label', 'com.tagtog.local=true',
      '--label', 'com.tagtog.component=crm', '--env-file', envFile, '-p', '127.0.0.1:55433:5432',
      '-v', `${volume}:/var/lib/postgresql/data`, 'postgres:17-alpine']);
    assertContainer(db.container, 55433);
  }
  let ready = false;
  for (let n = 0; n < 30; n++) {
    if (cp.spawnSync('docker', ['exec', db.container, 'pg_isready', '-U', db.user, '-d', db.name],
      {windowsHide: true, stdio: 'ignore'}).status === 0) { ready = true; break; }
    await sleep(1000);
  }
  if (!ready) throw new Error('The local CRM database is not ready.');
  run('docker', ['exec', '-i', iam.container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', iam.user, '-d', iam.name, '-At'], {input: registrySql});
  const modules = path.join(crm.repos.frontend, 'node_modules');
  if (!fs.existsSync(modules)) {
    const originalModules = path.join(path.dirname(root), 'Crm_Kimcommunication_fe', 'node_modules');
    if (!fs.existsSync(originalModules) || !fs.statSync(originalModules).isDirectory()) {
      throw new Error('The existing CRM frontend dependencies are required. No packages were installed.');
    }
    fs.symlinkSync(originalModules, modules, process.platform === 'win32' ? 'junction' : 'dir');
  }
  process.stdout.write('Isolated CRM database and IAM registry entry prepared. No users, grants, or account links were created.\n');
  process.stdout.write('Private CRM settings: .local/local-config.json. Restart the owned IAM and portal processes to load CRM registration.\n');
}

function backendJar(repo) {
  const target = path.join(repo, 'target');
  if (!fs.existsSync(target)) throw new Error('Build the CRM backend executable JAR first.');
  const jars = fs.readdirSync(target).filter(file => /^crm-kimtele-be-.*\.jar$/.test(file) && !file.includes('original'));
  if (jars.length !== 1) throw new Error('Build exactly one CRM backend executable JAR first.');
  return path.join(target, jars[0]);
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
function ownedProcess(entry, expectedMarker) {
  if (!entry || entry.marker !== expectedMarker || !Number.isSafeInteger(entry.pid) ||
      !entry.creationDate || !entry.commandHash) return false;
  const info = processInfo(entry.pid);
  return info?.ProcessId === entry.pid && info.CreationDate === entry.creationDate &&
    hasArgument(info.CommandLine, expectedMarker) &&
    crypto.createHash('sha256').update(info.CommandLine).digest('hex') === entry.commandHash;
}
function portOpen(port) {
  return new Promise(resolve => {
    const socket = net.connect({host: '127.0.0.1', port});
    let done = false;
    const finish = open => { if (!done) { done = true; socket.destroy(); resolve(open); } };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}
async function launch(name, binary, args, cwd, env, marker) {
  if (!fs.existsSync(binary)) throw new Error('The local runtime executable is unavailable.');
  const logfile = path.join(local, name + '.log');
  const fd = fs.openSync(logfile, 'a');
  let child;
  try {
    child = cp.spawn(binary, args, {cwd, env: {...process.env, ...env}, windowsHide: true,
      detached: true, stdio: ['ignore', fd, fd]});
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  } finally { fs.closeSync(fd); }
  child.unref();
  const info = processInfo(child.pid);
  if (!info?.CreationDate || !hasArgument(info.CommandLine, marker)) {
    throw new Error('Could not record ownership of the local CRM process. Check the local log.');
  }
  return {pid: child.pid, startedAt: new Date().toISOString(), binary, marker, logfile,
    creationDate: info.CreationDate, commandHash: crypto.createHash('sha256').update(info.CommandLine).digest('hex')};
}
function markers(c) {
  const crm = validate(c);
  return {crmBackend: backendJar(crm.repos.backend), crmFrontend: path.join(crm.repos.frontend, 'node_modules', 'next', 'dist', 'bin', 'next')};
}
async function start() {
  if (process.platform !== 'win32') throw new Error('This local process runner requires Windows.');
  const c = config();
  const crm = validate(c);
  assertIamFixture(c);
  assertContainer(crm.database.container, 55433);
  const expected = markers(c);
  const processes = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  for (const name of ['crmBackend', 'crmFrontend']) {
    const port = name === 'crmBackend' ? 8186 : 8188;
    if (await portOpen(port)) {
      if (!ownedProcess(processes[name], expected[name])) throw new Error(`Port ${port} is already used by a process outside this CRM runner.`);
      process.stdout.write(`${name} already running on ${port}; left running.\n`);
      continue;
    }
    if (ownedProcess(processes[name], expected[name])) throw new Error(`${name} is still starting. Inspect status and its local log before retrying.`);
    if (name === 'crmBackend') {
      const db = crm.database;
      const java = process.env.TAGTOG_JAVA || 'C:\\Program Files\\Android\\Android Studio\\jbr\\bin\\java.exe';
      processes[name] = await launch(name, java, ['-jar', expected[name], '--spring.profiles.active=tagtog-local'], crm.repos.backend, {
        SPRING_DATASOURCE_URL: 'jdbc:postgresql://127.0.0.1:55433/tagtog_crm',
        SPRING_DATASOURCE_USERNAME: db.user, SPRING_DATASOURCE_PASSWORD: db.password,
        TAGTOG_SSO_ENABLED: 'true', TAGTOG_IAM_BASE_URL: 'http://127.0.0.1:8181', TAGTOG_IAM_ISSUER: 'http://127.0.0.1:8181',
        TAGTOG_SSO_CLIENT_ID: 'crm-local', TAGTOG_SSO_CLIENT_SECRET: crm.ssoSecret,
        TAGTOG_SSO_REDIRECT_URI: 'http://127.0.0.1:8188/api/tagtog/callback',
        APP_DATA_SEED: 'false', APP_ADMIN_BOOTSTRAP: 'false', EMS_INTEGRATION_ENABLED: 'false', EMS_API_URL: 'http://127.0.0.1:9',
      }, expected[name]);
    } else {
      processes[name] = await launch(name, process.execPath, [expected[name], 'dev', '-H', '127.0.0.1', '-p', '8188'], crm.repos.frontend, {
        CRM_DEV_INSTANCE: 'tagtog-crm-local', NEXT_PUBLIC_TAGTOG_SSO_ENABLED: 'true',
        API_BASE_URL: 'http://127.0.0.1:8186', TAGTOG_PORTAL_URL: 'http://127.0.0.1:4180',
        CRM_TAGTOG_CALLBACK_URL: 'http://127.0.0.1:8188/api/tagtog/callback', TAGTOG_CLIENT_ID: 'crm-local', NEXT_PUBLIC_PMS_URL: '',
      }, expected[name]);
    }
    writePrivate(stateFile, JSON.stringify(processes, null, 2));
    process.stdout.write(`${name} started on ${port}.\n`);
  }
}
async function status() {
  for (const [name, url] of Object.entries({crmBackend: 'http://127.0.0.1:8186/api/auth/me', crmFrontend: 'http://127.0.0.1:8188/login'})) {
    try {
      const response = await fetch(url, {signal: AbortSignal.timeout(5000), redirect: 'manual'});
      process.stdout.write(`${name}: HTTP ${response.status}\n`);
    } catch { process.stdout.write(`${name}: not ready\n`); }
  }
}
async function stop() {
  if (process.platform !== 'win32') throw new Error('This local process runner requires Windows.');
  const c = config();
  const crm = validate(c);
  const processes = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  // Use recorded markers, but require each to stay in the exact expected repo before any kill.
  const frontendMarker = path.join(crm.repos.frontend, 'node_modules', 'next', 'dist', 'bin', 'next');
  for (const name of ['crmBackend', 'crmFrontend']) {
    const entry = processes[name];
    const validMarker = name === 'crmFrontend' ? entry?.marker === frontendMarker :
      typeof entry?.marker === 'string' && path.dirname(entry.marker) === path.join(crm.repos.backend, 'target') &&
      /^crm-kimtele-be-.*\.jar$/.test(path.basename(entry.marker));
    if (!validMarker || !ownedProcess(entry, entry.marker)) {
      if (entry) process.stdout.write(`${name}: no matching owned process; left untouched.\n`);
      continue;
    }
    run('taskkill.exe', ['/PID', String(entry.pid), '/T', '/F']);
    delete processes[name];
    writePrivate(stateFile, JSON.stringify(processes, null, 2));
    process.stdout.write(`${name} stopped.\n`);
  }
  if (existsContainer(crm.database.container)) {
    assertContainer(crm.database.container, 55433);
    run('docker', ['stop', crm.database.container]);
    process.stdout.write('CRM fixture database stopped; its volume is retained.\n');
  }
}

if (require.main === module) {
  const operations = {prepare, start, status, stop};
  Promise.resolve().then(() => {
    const operation = operations[process.argv[2]];
    if (!operation) throw new Error('Use prepare, start, status, or stop.');
    return operation();
  }).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
module.exports = {config, validate, hasArgument, sqlCrm, prepare, start, status, stop};
