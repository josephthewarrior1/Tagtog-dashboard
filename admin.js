(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const state = { session: null, users: [], roles: [], appUsers: [], links: [], tab: 'users', filter: '', mappingApp: 'pms' };
  let mappingVersion = 0;
  const dialog = $('#admin-dialog');
  let dialogVersion = 0;
  let returnFocus = null;
  let fieldSequence = 0;

  // All server-supplied values become text nodes or DOM properties, never HTML.
  function element(tag, attributes = {}, ...children) {
    const result = document.createElement(tag);
    const values = [];
    for (const [key, value] of Object.entries(attributes)) {
      if (value === false || value == null) continue;
      if (['value', 'checked', 'selected'].includes(key)) { values.push([key, value]); continue; }
      if (key === 'class') result.className = value;
      else if (value === true) result.setAttribute(key, '');
      else result.setAttribute(key, String(value));
    }
    for (const child of children.flat(Infinity)) if (child != null && child !== false) result.append(child instanceof Node ? child : document.createTextNode(String(child)));
    for (const [key, value] of values) result[key] = value;
    return result;
  }
  const button = (text, action, className = 'secondary-button') => {
    const result = element('button', { type: 'button', class: className }, text);
    result.addEventListener('click', action);
    return result;
  };
  const numericId = value => {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('This record has an unsupported ID. Reload the page and try again.');
    return id;
  };
  const recordId = value => String(numericId(value));
  const userName = user => user.fullName || user.name || user.email || `Account ${user.id}`;
  const roleName = role => role.name || role.code || `Role ${role.id}`;
  const dateText = value => value && Number.isFinite(new Date(value).getTime()) ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value)) : '—';
  const isOwnUser = user => String(user.id) === String(state.session?.user?.id);

  async function api(path, method = 'GET', body) {
    const mutating = method !== 'GET';
    if (mutating && !state.session?.csrfToken) throw new Error('Your session is unavailable. Reload the portal and sign in again.');
    const response = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20000),
      headers: { Accept: 'application/json', ...(mutating ? { 'Content-Type': 'application/json', 'X-CSRF-Token': state.session.csrfToken } : {}) },
      ...(mutating ? { body: JSON.stringify(body ?? {}) } : {})
    });
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401) throw new Error('Your session has expired. Sign in again, then reload this page.');
      const message = typeof data?.error?.message === 'string' ? data.error.message : typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : `The request could not be completed (HTTP ${response.status}).`;
      throw new Error(message.slice(0, 500));
    }
    return data;
  }
  function notify(message, kind = 'success') {
    const target = $('#page-message');
    target.className = 'message ' + kind;
    target.textContent = message;
    target.hidden = false;
  }
  function failure(error) { notify(error instanceof Error ? error.message : 'The request could not be completed.', 'error'); }
  function empty(message) { return element('div', { class: 'empty' }, message); }
  function badge(text, className = '') { return element('span', { class: 'badge ' + className }, text); }
  function table(headers, rows) {
    return element('table', {}, element('thead', {}, element('tr', {}, headers.map(title => element('th', { scope: 'col' }, title)))), element('tbody', {}, rows));
  }
  function field(title, tag = 'input', attributes = {}, children = []) {
    const id = 'admin-field-' + ++fieldSequence;
    const input = element(tag, { id, ...attributes }, children);
    return { input, view: element('label', { class: 'field', for: id }, element('span', {}, title), input) };
  }
  function check(title, checked = false, detail = '') {
    const input = element('input', { type: 'checkbox', checked });
    return { input, view: element('label', { class: 'checkbox-label' }, input, element('span', {}, title, detail ? element('small', {}, detail) : null)) };
  }
  function closeDialog() { dialog.close(); }
  function openDialog(title, intro, content, wide = false) {
    returnFocus = document.activeElement;
    const version = ++dialogVersion;
    dialog.classList.toggle('wide', wide);
    $('#dialog-content').replaceChildren(element('h2', { id: 'dialog-title' }, title), element('p', { class: 'dialog-intro' }, intro), content);
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('input:not([type=checkbox]), select, button')?.focus();
    return version;
  }
  function wireForm(form, work) {
    const error = element('p', { class: 'form-error', role: 'alert' });
    form.append(error);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (form.getAttribute('aria-busy') === 'true') return;
      error.textContent = '';
      form.setAttribute('aria-busy', 'true');
      const controls = [...form.querySelectorAll('button')];
      const wasDisabled = controls.map(control => control.disabled);
      controls.forEach(control => control.disabled = true);
      try { await work(); }
      catch (problem) { error.textContent = problem instanceof Error ? problem.message : 'The request could not be completed.'; }
      finally { form.removeAttribute('aria-busy'); controls.forEach((control, index) => control.disabled = wasDisabled[index]); }
    });
  }
  function formActions(label = 'Save changes') {
    return element('div', { class: 'form-actions' }, button('Cancel', closeDialog), element('button', { type: 'submit', class: 'primary-button' }, label));
  }

  function renderUsers() {
    const query = state.filter.trim().toLocaleLowerCase();
    const users = state.users.filter(user => `${userName(user)} ${user.email || ''}`.toLocaleLowerCase().includes(query));
    $('#user-count').textContent = `${state.users.length} central account${state.users.length === 1 ? '' : 's'}`;
    const rows = users.map(user => {
      const status = user.status === 'ACTIVE';
      const statusAction = button(status ? 'Deactivate' : 'Activate', () => changeUserStatus(user), 'text-button');
      if (isOwnUser(user) && status) { statusAction.disabled = true; statusAction.title = 'Keep your own administrator account active.'; }
      return element('tr', {},
        element('td', {}, element('strong', {}, userName(user), isOwnUser(user) ? ' (you)' : ''), element('small', {}, user.email || 'No email', ` · ID ${user.id}`)),
        element('td', {}, element('div', { class: 'badges' }, (user.roles || []).length ? user.roles.map(role => badge(role.name || role.code)) : badge('Unassigned'))),
        element('td', {}, badge(user.status || 'UNKNOWN', status ? 'active' : 'inactive')),
        element('td', {}, dateText(user.lastLoginAt)),
        element('td', {}, element('div', { class: 'cell-actions' }, button('Assign roles', () => assignUserRoles(user), 'text-button'), statusAction))
      );
    });
    $('#users-table').replaceChildren(rows.length ? table(['Account', 'Roles', 'Status', 'Last sign-in', 'Actions'], rows) : empty(query ? 'No users match this search.' : 'No central accounts found.'));
  }
  function renderRoles() {
    $('#roles-list').replaceChildren(...(state.roles.length ? state.roles.map(role => element('article', { class: 'role-card' },
      element('div', { class: 'role-card-top' }, element('span', { class: 'role-code' }, role.code), badge(role.status || 'ACTIVE', role.status === 'INACTIVE' ? 'inactive' : 'active')),
      element('h3', {}, roleName(role)), element('p', {}, role.description || 'No description provided.'),
      element('div', { class: 'cell-actions' }, button('Manage access', () => editRoleAccess(role), 'text-button'), button('Edit role', () => editRole(role), 'text-button'))
    )) : [empty('No roles found. Create a role to define application access.')]));
  }
  async function reloadBase() {
    const [users, roles] = await Promise.all([api('/api/admin/users'), api('/api/admin/roles')]);
    if (!Array.isArray(users) || !Array.isArray(roles)) throw new Error('The access service returned an invalid list.');
    state.users = users; state.roles = roles;
    renderUsers(); renderRoles();
  }
  function createUser() {
    const name = field('Full name', 'input', { required: true, maxlength: 160, autocomplete: 'name' });
    const email = field('Email', 'input', { type: 'email', required: true, maxlength: 254, autocomplete: 'off' });
    const password = field('Initial password', 'input', { type: 'password', required: true, minlength: 8, maxlength: 128, autocomplete: 'new-password' });
    const choices = state.roles.filter(role => role.status === 'ACTIVE').map(role => ({ role, ...check(roleName(role), false, role.code) }));
    const form = element('form', {}, name.view, email.view, password.view, element('p', { class: 'form-hint' }, 'Use at least 8 characters. Share the initial password through your approved private channel.'),
      element('fieldset', {}, element('legend', {}, 'Assigned roles'), element('div', { class: 'checkbox-list' }, choices.length ? choices.map(choice => choice.view) : 'No active roles are available.')),
      element('p', { class: 'form-hint' }, 'Accounts without a role have no application access.'), formActions('Create user'));
    wireForm(form, async () => {
      await api('/api/admin/users', 'POST', { fullName: name.input.value.trim(), email: email.input.value.trim(), password: password.input.value, roleIds: choices.filter(choice => choice.input.checked).map(choice => numericId(choice.role.id)) });
      password.input.value = '';
      closeDialog(); notify('Central account created.');
      await reloadBase().catch(failure);
    });
    openDialog('Create central account', 'Create an IAM identity and choose its initial roles.', form);
  }
  function assignUserRoles(user) {
    const codes = new Set((user.roles || []).map(role => role.code));
    const choices = state.roles.map(role => ({ role, ...check(roleName(role), codes.has(role.code), `${role.code} · ${role.status}`) }));
    for (const choice of choices) if (isOwnUser(user) && choice.role.code === 'SUPER_ADMIN' && choice.input.checked) choice.input.disabled = true;
    const form = element('form', {}, element('div', { class: 'checkbox-list' }, choices.map(choice => choice.view)), formActions('Save roles'));
    wireForm(form, async () => {
      await api(`/api/admin/users/${recordId(user.id)}/roles`, 'PUT', { roleIds: choices.filter(choice => choice.input.checked).map(choice => numericId(choice.role.id)) });
      closeDialog(); notify(`Roles updated for ${userName(user)}.`); await reloadBase().catch(failure);
    });
    openDialog('Assign roles', `${userName(user)} · ${user.email || ''}`, form);
  }
  function changeUserStatus(user) {
    const next = user.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    const form = element('form', {}, element('div', { class: 'notice' }, next === 'INACTIVE' ? 'Deactivating the account prevents central sign-in and application access.' : 'The user can sign in again using their assigned roles.'), formActions(next === 'INACTIVE' ? 'Deactivate account' : 'Activate account'));
    wireForm(form, async () => {
      await api(`/api/admin/users/${recordId(user.id)}/status`, 'PATCH', { status: next });
      closeDialog(); notify(`Account ${next === 'ACTIVE' ? 'activated' : 'deactivated'}.`); await reloadBase().catch(failure);
    });
    openDialog(next === 'INACTIVE' ? 'Deactivate this account?' : 'Activate this account?', `${userName(user)} · ${user.email || ''}`, form);
  }

  function createRole() {
    const code = field('Role code', 'input', { required: true, pattern: '[A-Z][A-Z0-9_]{1,49}', maxlength: 50, placeholder: 'PMS_PROJECT_MANAGER', autocomplete: 'off' });
    const name = field('Role name', 'input', { required: true, maxlength: 120 });
    const description = field('Description', 'textarea', { maxlength: 500 });
    const form = element('form', {}, code.view, name.view, description.view, element('p', { class: 'form-hint' }, 'Use an uppercase code with letters, numbers, and underscores. Next, choose application access and CRUD permissions.'), formActions('Create & configure access'));
    wireForm(form, async () => {
      const created = await api('/api/admin/roles', 'POST', { code: code.input.value.trim(), name: name.input.value.trim(), description: description.input.value.trim() });
      closeDialog(); notify('Role created. Choose its application access and permissions next.');
      await reloadBase();
      const role = state.roles.find(item => String(item.id) === String(created?.id)) || state.roles.find(item => item.code === code.input.value.trim());
      if (role) await editRoleAccess(role);
    });
    openDialog('Create role', 'Define a role, then configure which application operations it can use.', form);
  }
  function editRole(role) {
    const name = field('Role name', 'input', { required: true, maxlength: 120, value: role.name || '' });
    const description = field('Description', 'textarea', { maxlength: 500, value: role.description || '' });
    const status = field('Status', 'select', { value: role.status || 'ACTIVE' }, [element('option', { value: 'ACTIVE' }, 'ACTIVE'), element('option', { value: 'INACTIVE' }, 'INACTIVE')]);
    const form = element('form', {}, element('p', { class: 'read-only' }, `Role code: ${role.code}`), name.view, description.view, status.view, formActions());
    wireForm(form, async () => {
      await api(`/api/admin/roles/${recordId(role.id)}`, 'PUT', { name: name.input.value.trim(), description: description.input.value.trim(), status: status.input.value });
      closeDialog(); notify('Role updated.'); await reloadBase().catch(failure);
    });
    openDialog('Edit role', role.code, form);
  }
  async function editRoleAccess(role) {
    const version = openDialog('Application access', `${roleName(role)} · ${role.code}`, element('p', { role: 'status' }, 'Loading systems and permissions…'), true);
    try {
      const [systems, permissions] = await Promise.all([api(`/api/admin/roles/${recordId(role.id)}/systems`), api(`/api/admin/roles/${recordId(role.id)}/permissions`)]);
      if (!dialog.open || version !== dialogVersion) return;
      if (!Array.isArray(systems) || !Array.isArray(permissions)) throw new Error('The access service returned invalid role details.');
      const choices = systems.map(system => ({ system, ...check(system.name || system.code, system.hasAccess === true, `${system.code} · ${system.status}`) }));
      choices.forEach(choice => { if (choice.system.status !== 'ENABLED') choice.input.disabled = true; });
      const fields = permissions.filter(permission => ['PMS','CRM'].includes(permission.systemCode)).map(permission => ({ permission, checks: ['canView', 'canCreate', 'canEdit', 'canDelete'].map(key => ({ key, input: element('input', { type: 'checkbox', checked: permission[key] === true, 'aria-label': `${key.replace('can', '')} ${permission.systemCode} ${permission.featureName || permission.featureCode}` }) })) }));
      const permissionTable = table(['Application feature', 'View', 'Create', 'Edit', 'Delete'], fields.map(row => element('tr', {}, element('td', {}, element('strong', {}, `${row.permission.systemCode} · ${row.permission.featureName || row.permission.featureCode}`), element('small', {}, row.permission.route || row.permission.featureCode)), row.checks.map(check => element('td', {}, check.input)))));
      permissionTable.className = 'permission-table';
      const form = element('form', {},
        element('fieldset', {}, element('legend', {}, 'Application access'), element('div', { class: 'checkbox-list' }, choices.length ? choices.map(choice => choice.view) : 'No systems are configured.')),
        element('fieldset', {}, element('legend', {}, 'PMS & CRM permissions'), element('p', { class: 'form-hint' }, 'Enable application access above, then choose each operation. Other feature permissions are preserved.'), fields.length ? element('div', { class: 'permission-wrap' }, permissionTable) : element('div', { class: 'notice' }, 'No PMS or CRM feature definitions are available yet.')),
        formActions('Save access & permissions'));
      wireForm(form, async () => {
        const updates = new Map(fields.map(row => [String(row.permission.featureId), row]));
        const grants = permissions.map(permission => {
          const update = updates.get(String(permission.featureId));
          return { featureId: numericId(permission.featureId), ...Object.fromEntries(['canView', 'canCreate', 'canEdit', 'canDelete'].map(key => [key, update ? update.checks.find(check => check.key === key).input.checked : permission[key] === true])) };
        });
        await api(`/api/admin/roles/${recordId(role.id)}/systems`, 'PUT', { systemIds: choices.filter(choice => choice.input.checked).map(choice => numericId(choice.system.systemId)) });
        try { await api(`/api/admin/roles/${recordId(role.id)}/permissions`, 'PUT', { permissions: grants }); }
        catch (error) { throw new Error(`Application access was saved, but permissions were not saved. ${error.message} Review the form and retry.`); }
        closeDialog(); notify(`Application access and permissions saved for ${roleName(role)}.`); await reloadBase().catch(failure);
      });
      $('#dialog-content').replaceChildren(element('h2', { id: 'dialog-title' }, 'Application access'), element('p', { class: 'dialog-intro' }, `${roleName(role)} · ${role.code}`), form);
      form.querySelector('input, button')?.focus();
    } catch (error) {
      if (dialog.open && version === dialogVersion) $('#dialog-content').append(element('p', { class: 'form-error', role: 'alert' }, error.message));
    }
  }

  function renderMappings() {
    const app = state.mappingApp;
    const label = app.toUpperCase();
    const userKey = app + 'UserId';
    const identity = field('Central IAM identity', 'select', { required: true, value: '' }, [element('option', { value: '' }, 'Choose central account'), ...state.users.map(user => element('option', { value: recordId(user.id) }, `${userName(user)} · ${user.email || 'No email'} · IAM ID ${user.id}`))]);
    const localAccount = field(`Existing ${label} account`, 'select', { required: true, value: '' }, [element('option', { value: '' }, `Choose ${label} account explicitly`), ...state.appUsers.map(user => element('option', { value: recordId(user.id) }, `${userName(user)} · ${user.email || 'No email'} · ${label} ID ${user.id}${user.active === false || user.approved === false ? ' · inactive/unapproved' : ''}`))]);
    const confirmed = check('I have checked both records and confirm this is the correct account mapping.');
    confirmed.input.required = true;
    confirmed.view.className = 'confirm-label';
    const currentMapping = element('p', { class: 'form-hint', 'aria-live': 'polite' }, `Select a central identity and a ${label} account.`);
    const resetConfirmation = () => {
      confirmed.input.checked = false;
      const existing = state.links.find(link => String(link.subject) === identity.input.value);
      currentMapping.textContent = existing ? `This identity is currently linked to ${label} user ID ${existing[userKey]}. Saving a replacement ends its existing ${label} SSO sessions.` : 'No existing link is selected. Account selection is always manual.';
    };
    identity.input.addEventListener('change', resetConfirmation);
    localAccount.input.addEventListener('change', resetConfirmation);
    const form = element('form', { class: 'mapping-card' }, element('div', { class: 'mapping-grid' }, identity.view, localAccount.view), currentMapping, confirmed.view, element('div', { class: 'form-actions' }, element('button', { type: 'submit', class: 'primary-button' }, 'Save explicit link')));
    wireForm(form, async () => {
      const subject = recordId(identity.input.value);
      await api(`/api/admin/${app}/links/${subject}`, 'PUT', { [userKey]: numericId(localAccount.input.value) });
      notify(`Explicit IAM-to-${label} account link saved.`); await loadMappings();
    });
    $('#mapping-form').replaceChildren(form);
    const rows = state.links.map(link => {
      const central = state.users.find(user => String(user.id) === String(link.subject));
      const target = state.appUsers.find(user => String(user.id) === String(link[userKey]));
      const edit = button('Edit link', () => { identity.input.value = String(link.subject); localAccount.input.value = String(link[userKey]); resetConfirmation(); identity.input.focus(); }, 'text-button');
      return element('tr', {}, element('td', {}, element('strong', {}, central ? userName(central) : `IAM ID ${link.subject}`), element('small', {}, `IAM ID ${link.subject}`, central?.email ? ` · ${central.email}` : '')),
        element('td', {}, element('strong', {}, target ? userName(target) : `${label} ID ${link[userKey]}`), element('small', {}, `${label} ID ${link[userKey]}`, target?.email ? ` · ${target.email}` : '')),
        element('td', {}, dateText(link.updatedAt)), element('td', {}, element('div', { class: 'cell-actions' }, edit, button('Remove link', () => removeMapping(app, link, central), 'text-button'))));
    });
    $('#links-table').replaceChildren(rows.length ? table(['IAM identity', `${label} account`, 'Updated', 'Actions'], rows) : empty('No account links have been created.'));
  }
  function removeMapping(app, link, user) {
    const label = app.toUpperCase();
    const form = element('form', {}, element('div', { class: 'notice' }, `Removing this link ends existing ${label} SSO sessions for this identity. The IAM and ${label} accounts remain available separately.`), formActions('Remove account link'));
    wireForm(form, async () => {
      await api(`/api/admin/${app}/links/${recordId(link.subject)}`, 'DELETE', {});
      closeDialog(); notify('Account link removed.'); await loadMappings();
    });
    openDialog('Remove this account link?', `${user ? userName(user) : 'IAM ID ' + link.subject} → ${label} ID ${link[app+'UserId']}`, form);
  }
  async function loadMappings() {
    const version = ++mappingVersion;
    const app = state.mappingApp;
    const label = app.toUpperCase();
    $('#mapping-form').replaceChildren(element('p', { class: 'loading', role: 'status' }, `Loading ${label} accounts and identity links…`));
    $('#links-table').replaceChildren();
    try {
      const [users, links] = await Promise.all([api(`/api/admin/${app}/users`), api(`/api/admin/${app}/links`)]);
      if(version!==mappingVersion) return;
      if (!Array.isArray(users) || !Array.isArray(links)) throw new Error(`${label} returned an invalid account list.`);
      state.appUsers = users; state.links = links; renderMappings();
    } catch (error) { if(version===mappingVersion) $('#mapping-form').replaceChildren(element('p', { class: 'form-error', role: 'alert' }, error.message)); }
  }

  async function selectTab(name, focus = false) {
    state.tab = name;
    for (const tab of document.querySelectorAll('[data-tab]')) {
      const selected = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      $('#' + tab.dataset.tab + '-panel').hidden = !selected;
      if (selected && focus) tab.focus();
    }
    if (name === 'links') await loadMappings();
  }

  document.addEventListener('click', event => {
    const tab = event.target.closest('[data-tab]');
    if (tab && state.session?.isAdmin) { selectTab(tab.dataset.tab); return; }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'close-dialog') { closeDialog(); return; }
    if (!state.session?.isAdmin) return;
    if (action === 'create-user') createUser();
    if (action === 'create-role') createRole();
    if (action === 'refresh-users') reloadBase().then(() => notify('Accounts refreshed.')).catch(failure);
    if (action === 'refresh-links') loadMappings();
  });
  $('.admin-tabs').addEventListener('keydown', event => {
    const tabs = [...document.querySelectorAll('[data-tab]')];
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = tabs.indexOf(document.activeElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : tabs.length - 1)) % tabs.length;
    if (state.session?.isAdmin) selectTab(tabs[index].dataset.tab, true);
  });
  $('#mapping-system').addEventListener('change', event => { state.mappingApp = event.target.value === 'crm' ? 'crm' : 'pms'; loadMappings(); });
  $('#user-search').addEventListener('input', event => { state.filter = event.target.value; renderUsers(); });
  dialog.addEventListener('close', () => { ++dialogVersion; if (returnFocus?.isConnected) returnFocus.focus(); else document.querySelector(`[data-tab="${state.tab}"]`)?.focus(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDialog();
  });

  (async () => {
    try {
      state.session = await api('/api/session');
      if (!state.session?.isAdmin) throw new Error('Administrator access is required to manage users and permissions.');
      const user = state.session.user;
      $('#admin-profile').replaceChildren(element('div', { class: 'profile-row' }, element('span', { class: 'avatar', 'aria-hidden': 'true' }, userName(user).slice(0, 1).toUpperCase()), element('span', {}, element('strong', {}, userName(user)), element('small', {}, 'Administrator'))));
      await reloadBase();
      $('#loading-state').hidden = true; $('#admin-content').hidden = false;
    } catch (error) {
      $('#loading-state').hidden = true;
      failure(error);
      $('#page-message').append(' ', element('a', { href: '/login?returnTo=%2Fadmin' }, 'Sign in again'), ' or ', element('a', { href: '/' }, 'return to the workspace'), '.');
    }
  })();
})();
