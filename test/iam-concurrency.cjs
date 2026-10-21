'use strict';

// Explicitly local-only integration check. Never prints credentials, codes or tokens.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const iamOrigin = 'http://127.0.0.1:8181';
const clientId = 'pms-local';
const redirectUri = 'http://127.0.0.1:8184/api/tagtog/callback';

async function post(endpoint, body, token) {
  const response = await fetch(iamOrigin + endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token ? {Authorization: 'Bearer ' + token} : {}),
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  const payload = response.status === 204 ? null : await response.json();
  return {status: response.status, payload};
}

async function run(options = {}) {
  const localPath = process.env.TAGTOG_LOCAL_CONFIG || path.resolve(__dirname, '..', '.local', 'local-config.json');
  const config = JSON.parse(await fs.readFile(localPath, 'utf8'));
  assert.equal(typeof config.iamAdmin?.email, 'string');
  assert.equal(typeof config.iamAdmin?.password, 'string');
  assert.equal(typeof config.ssoSecret, 'string');
  assert.ok(config.ssoSecret.length >= 32);

  const login = await post('/api/auth/login', {email: config.iamAdmin.email, password: config.iamAdmin.password});
  assert.equal(login.status, 200);
  const centralToken = login.payload?.data?.accessToken;
  const refreshToken = login.payload?.data?.refreshToken;
  assert.equal(typeof centralToken, 'string');

  try {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
    const authorization = await post('/api/sso/authorize', {
      clientId, redirectUri, codeChallenge, codeChallengeMethod: 'S256',
    }, centralToken);
    assert.equal(authorization.status, 200);
    const code = authorization.payload?.data?.code;
    assert.equal(typeof code, 'string');

    // Both requests start before either response is awaited. PostgreSQL's row lock
    // must let exactly one transaction commit the exchange.
    const body = {clientId, clientSecret: config.ssoSecret, redirectUri, code, codeVerifier};
    const responses = await Promise.all([post('/api/sso/token', body), post('/api/sso/token', body)]);
    assert.deepEqual(responses.map(response => response.status).sort((a, b) => a - b), [200, 400]);
    assert.equal(responses.find(response => response.status === 400).payload?.error?.code, 'INVALID_GRANT');
    assert.equal(typeof responses.find(response => response.status === 200).payload?.data?.ssoSessionId, 'string');

    // The consumed grant must stay unusable after the competing transactions end.
    const replay = await post('/api/sso/token', body);
    assert.equal(replay.status, 400);
    assert.equal(replay.payload?.error?.code, 'INVALID_GRANT');
  } finally {
    // Revoke only this check's central refresh token. Global SSO logout would
    // invalidate unrelated sessions being exercised by another local checker.
    if (typeof refreshToken === 'string') {
      await post('/api/auth/logout', {refreshToken}).catch(() => {});
    }
  }
  if (!options.quiet) process.stdout.write('PASS\n');
}

if (require.main === module) run().catch(() => {
  process.stderr.write('FAIL: local IAM concurrent one-use code check.\n');
  process.exitCode = 1;
});

module.exports = {run};
