# TAGTOG central login — local integration prototype

Portal: http://127.0.0.1:4180 · EMS-IAM: 8181 · PMS API: 8182 · PMS web: 8184.

The portal login/logout flow has been checked against an isolated local EMS-IAM. The PMS SSO flow described below is a prototype across separate repositories; complete portal-to-PMS runtime validation is still pending. Account packages and business expiry remain design documents only.

## Related repositories

The PMS prototype source uses clean checkouts of GitHub `main` fetched on 20 October 2026, with TAGTOG SSO changes applied locally:

| App | Clean base | Integration source | Local source |
| --- | --- | --- | --- |
| PMS frontend | `34c57e8` | `local checkout` | `.local/worktrees/pms_fe` |
| PMS backend | `a13d465` | `local checkout` | `.local/worktrees/pms_be` |
| EMS-IAM | `8879a8a` | `local checkout` | `../ems-v2/EMS-IAM` |

IAM and PMS source, JARs, local worktrees, database volumes, and credentials are not included in this repository. The original PMS folders and unrelated changes remain separate from the prototype checkouts. Uploading this portal does not publish changes to those repositories or deploy the stack.

## Run an existing configured local stack

Prerequisites: Docker Desktop running, Node 20+, Java 21, and the related IAM/PMS repositories with their integration changes. Build the executable IAM/PMS JARs first. The helper defaults to the installed Android Studio JBR 21 on Windows; set `TAGTOG_JAVA` for another Java executable.

```powershell
node local-stack.cjs prepare
node local-stack.cjs start
node local-stack.cjs status
```

The helper expects sibling `ems-v2/EMS-IAM`, `pms_be`, and `pms_fe` folders, or existing PMS checkouts under `.local/worktrees`. It does not download or patch these repositories. Generated repository paths can be inspected in `.local/local-config.json` before starting the stack.

Open the portal and sign in with the local IAM account. The private, gitignored **`.local/local-config.json`** contains generated credentials under `iamAdmin` and `fixtures`, plus local database and SSO client secrets. Fixture records must be seeded before fixture-based tests can run; generated credential entries alone do not create users or access grants. Do not share or commit this file. PMS passwords are not used for central login.

```powershell
node local-stack.cjs stop
```

This stops only recorded local app processes and labelled TAGTOG database containers. Volumes are retained. The preview uses loopback databases (`tagtog_iam` on 55431 and `tagtog_pms_latest` on 55432 for clean PMS checkouts), separate from existing PMS databases.

For the portal alone, run `npm start`; IAM must already be available to complete sign-in. See [README.md](README.md) for service URL overrides.

## Prototype access flow

The following describes the intended behavior of the local source changes, not a completed end-to-end acceptance test:

1. **Users & access → Users:** create an IAM account, assign roles, and deactivate an account to stop access.
2. **Roles & permissions:** grant PMS access and `workspace` view/create/edit/delete actions. The portal shows currently allowed applications.
3. **PMS account links:** explicitly link an IAM user ID to the intended existing PMS user ID. Email similarity does not create a link. Existing PMS project membership, ownership, and roles remain relevant.
4. Open PMS through TAGTOG. With the integration changes and SSO enabled, PMS uses central login and requires a bound PMS session.

The PMS prototype checks both central grants and existing project/role restrictions. Revocation, account deactivation, link changes, and global sign-out must be validated against the rebuilt PMS runtime before acceptance. EMS portal integration is not enabled. A separate [local CRM login prototype](CRM-LOCAL.md) uses its own SSO client, clean CRM worktrees, and dedicated database; it does not implement company isolation or account packages.

## Login flow and storage

The Node portal holds IAM access and refresh tokens on the server behind an HttpOnly session cookie. The PMS prototype starts a server-held state/PKCE transaction; IAM returns a 60-second, one-use code bound to the client and callback, then PMS exchanges it through its backend. IAM tokens and passwords are not placed in URLs or browser localStorage by this portal.

PMS retains its own opaque session model. The prototype uses an HttpOnly cookie restricted to `/files` for image/download requests on the same-host local setup and checks permissions in the backend. Public capability links and signed editor callbacks have separate checks in the related PMS source.

Portal and PMS transaction stores are in memory for this single-instance preview; restarting requires signing in again. A deployment would need shared session storage, HTTPS, and domain/cookie configuration. IAM signing keys and code/session records persist locally.

## Validation status

- Portal: `npm test` runs the isolated security suite without a database. Login success, invalid credentials, password visibility, sign-out, signed-out redirects, and desktop/mobile layout have also been checked locally.
- IAM/PMS: targeted source checks are recorded in their separate local SSO documentation. Source checks do not establish that the currently running executable contains every change.
- PMS backend: rebuild the executable after stopping the process holding its JAR before continuing full runtime verification.
- `test/iam-concurrency.cjs` is a manual integration script for the pinned local services and fixture databases. It has not been run as part of end-to-end acceptance. Test outcomes must not print credentials or tokens.
- Full portal → IAM → PMS end-to-end acceptance remains pending. Package/account/expiry tables are not implemented.
