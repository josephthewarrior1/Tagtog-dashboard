# CRM legacy passwords in TAGTOG — local prototype

The password migration uses a separate local IAM database and a second copy of the restored CRM database. Existing IAM users are never updated, merged, renamed or deleted by the importer. No production connection or deployment is part of these helpers.

## Environments

| Component | Existing local prototype | Legacy-password sandbox |
| --- | --- | --- |
| TAGTOG portal | http://127.0.0.1:4180 | http://localhost:4192 |
| IAM | http://127.0.0.1:8181 | http://localhost:8191 |
| CRM API | http://127.0.0.1:8186 | http://localhost:8196 |
| CRM web | http://127.0.0.1:8188 | http://localhost:8198 |
| IAM database | `tagtog_iam` | `tagtog_iam_passwords` |
| CRM database | `tagtog_crm` | `tagtog_crm_passwords` |

Both databases use the existing labelled loopback PostgreSQL containers, on ports 55431 and 55433. The databases themselves are separate. The sandbox uses a different cookie hostname, signing key, SSO client secrets, process receipts and Next build directory. Its runner stops only its own four recorded processes.

## Migration behavior

For an explicitly audited CRM user with a valid unique email, supported BCrypt hash and recognized CRM role, migration inserts a new IAM user with the exact existing hash. It assigns only the owned CRM role and inserts an explicit CRM identity link. IAM authenticates the original password normally; no CRM password fallback or plaintext password collection is added.

Email checks use trim and lowercase. Any pre-existing IAM account, including an inactive account or one whose hash happens to match, is a conflict and is skipped. Duplicate/invalid source emails, unsupported hashes/roles and conflicting mappings also require review. A matching email never proves identity ownership. Concurrent collision checks and existing-user preservation checks run inside locked transactions. CRM mapping is insert-only and cannot replace an existing link.

Rerunning an owned completed import adds no users. The private manifest binds the database names, issuer, import ID and sandbox ownership. An interrupted insert without its saved ownership record is a conflict requiring review. The old random-password mapper refuses to run after a preserved-password import has created identities.

## Prepare an existing local CRM copy

Prerequisites are the configured original local stack, its restored CRM copy, Docker, Node 20+, Java 21, built IAM/CRM JARs and installed CRM frontend dependencies. These commands do not download or deploy applications:

```powershell
node crm-password-sandbox.cjs prepare
node test/crm-password-prepare-data.cjs
node crm-password-sandbox.cjs start
node crm-password-sandbox.cjs status
# Wait for IAM health 200 and CRM API 401 before seeding the audited role.
node test/crm-password-seed-audit.cjs
node test/crm-legacy-passwords.cjs audit --sandbox
node test/crm-legacy-passwords.cjs import --sandbox
```

Preparation refuses to adopt an unrelated existing database. Newly created databases are tied to the private configuration by an ownership comment. It takes a fresh local CRM dump, restores it only to the new empty database, clears copied sessions/mappings only in that new database, and compares all 17 business tables. Repeated preparation does not reset an existing sandbox.

The normal-profile importer can be inspected with `node test/crm-legacy-passwords.cjs audit`. In this machine's original prototype, all 13 restored CRM emails are already occupied by earlier random-password IAM test accounts, so import skips all 13 there. The separate sandbox permits old-password testing without modifying those existing accounts.

Open **http://localhost:4192** and use the original CRM email and password, then open CRM. The supported original accounts have only CRM access in TAGTOG; their existing CRM roles and allowed event IDs remain in effect. Personal/company isolation, packages and account expiry remain design work.

## Verification and private files

```powershell
node --test test/portal.test.cjs test/crm-legacy-map.test.cjs test/crm-legacy-passwords.test.cjs test/crm-password-sandbox.test.cjs
node test/crm-password-e2e.cjs run
```

The acceptance script creates one disposable synthetic legacy account with a generated known password. It checks wrong-password rejection, unchanged-password login, CRM-only access, PKCE handoff, the original CRM identity/role, restored business counts, logout, idempotence and preservation of all pre-existing business records and IAM users. It removes only its own fixture afterward. For browser verification, `run --keep-fixture` retains it logged out, followed by `cleanup` after inspection. Its Java fixture helper uses the already installed local Spring crypto runtime and never guesses real passwords.

For the 13 actual legacy accounts, exact hash equality and identity/scope preservation are verifiable without knowing plaintext passwords. That is not a claim that all 13 actual password logins were exercised. The account owner must try their original password; passwords are not recovered or displayed.

All generated configuration, signing keys, dumps, source/mapping manifests, migration reports, fixture credentials and real-data screenshots belong under ignored `.local/`. Never commit them. The importer does not write source hashes or plaintext passwords to reports. Source is on the `feature/tagtog-crm-legacy-login` branch in the portal and separate CRM repositories. IAM source remains a separate prerequisite.

```powershell
node crm-password-sandbox.cjs stop
```

Stopping retains both sandbox databases and leaves the existing prototype services and containers alone.
