(() => {
  "use strict";

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const search = $("#app-search");
  const results = $("#search-results");
  const dialog = $("#portal-dialog");
  const sidebar = $("#sidebar");
  const menuButton = $("[data-action='menu']");
  const backdrop = $("#sidebar-backdrop");
  const mobileQuery = window.matchMedia("(max-width: 760px)");
  let focusBeforeDialog = null;
  let focusBeforeMenu = null;
  let portalSession = null;

  const applications = [
    {
      id: "ems",
      name: "EMS",
      fullName: "Event Management System",
      icon: "event",
      description: "Plan, organize, and deliver meaningful events.",
      features: ["Events", "Participants", "Reports"]
    },
    {
      id: "pms",
      name: "PMS",
      fullName: "Project Management System",
      icon: "project",
      description: "Turn ideas into real progress with your team.",
      features: ["Tasks", "Timeline", "Collaboration"]
    },
    {
      id: "crm",
      name: "CRM",
      fullName: "Customer Relationship Management",
      icon: "relationship",
      description: "Build stronger relationships and grow together.",
      features: ["Contacts", "Companies", "Activities"]
    }
  ];

  const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));

  const icon = name => `<svg class="icon" aria-hidden="true"><use href="#icon-${name}"/></svg>`;

  // Only HTTP(S) destinations are allowed. Empty or invalid values remain previews.
  function getApplicationUrl(id) {
    const value = portalSession?.apps?.find(app => app.id === id)?.launchUrl;
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value.trim(), document.baseURI);
      if (!["https:", "http:"].includes(url.protocol)) return null;
      if (url.username || url.password) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function cardMarkup(application) {
    const url = getApplicationUrl(application.id);
    const actionContent = `<span>Open ${application.name}</span><span class="action-arrow">${icon("arrow")}</span>`;
    const action = url
      ? `<a class="app-open" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${application.name} in a new tab">${actionContent}</a>`
      : `<button class="app-open" type="button" data-open-app="${application.id}" aria-label="Open ${application.name} preview">${actionContent}</button>`;

    return `
      <article class="app-card ${application.id}" aria-labelledby="${application.id}-title">
        <div class="app-visual" aria-hidden="true">
          <span class="app-icon">${icon(application.icon)}</span>
          <span class="app-category">${{ems:"Events",pms:"Projects",crm:"Relationships"}[application.id]}</span>
          <span class="card-orbit orbit-one"></span><span class="card-orbit orbit-two"></span><span class="card-spark"></span>
        </div>
        <div class="app-card-body">
          <div class="app-heading"><h3 id="${application.id}-title">${application.name}</h3><p class="app-name">${application.fullName}</p></div>
          <p class="app-description">${application.description}</p>
          <ul class="app-features" aria-label="${application.name} features">${application.features.map(feature => `<li>${feature}</li>`).join("")}</ul>
          ${action}
        </div>
      </article>`;
  }

  function matchingApplications() {
    const query = search.value.trim().toLocaleLowerCase();
    return applications.filter(application => portalSession?.apps?.some(app => app.id === application.id)).filter(application => [
      application.name, application.fullName, application.description, ...application.features
    ].join(" ").toLocaleLowerCase().includes(query));
  }

  function hideSearchResults() {
    results.hidden = true;
    search.setAttribute("aria-expanded", "false");
  }

  function renderApplications(showResults = false) {
    const matches = matchingApplications();
    const query = search.value.trim();
    $("#app-grid").innerHTML = matches.map(cardMarkup).join("");
    $("#empty-state").hidden = matches.length > 0;
    $("#result-count").textContent = `${matches.length} application${matches.length === 1 ? "" : "s"}`;

    if (!showResults || !query) {
      hideSearchResults();
      return;
    }

    results.innerHTML = matches.length
      ? `<p class="search-summary">Applications · ${matches.length} found</p>${matches.map(application => `
          <button class="search-result ${application.id}" type="button" data-search-app="${application.id}">
            <span class="app-icon">${icon(application.icon)}</span>
            <span><strong>${application.name}</strong><small>${application.fullName}</small></span>
            ${icon("arrow")}
          </button>`).join("")}`
      : '<p class="search-empty">No applications found. Try EMS, PMS, or CRM.</p>';
    results.hidden = false;
    search.setAttribute("aria-expanded", "true");
  }

  function clearSearch() {
    search.value = "";
    renderApplications();
  }

  function openDialog(markup, focusTarget) {
    closeMenu(false);
    hideSearchResults();
    focusBeforeDialog = focusTarget || document.activeElement;
    $("#dialog-content").innerHTML = markup;
    dialog.showModal();
    dialog.querySelector("[data-autofocus]")?.focus();
  }

  function openApplication(id, trigger) {
    if (!portalSession?.apps?.some(app => app.id === id)) return;
    const application = applications.find(item => item.id === id);
    if (!application) return;
    const url = getApplicationUrl(id);
    // Mobile navigation and dropdown results disappear after activation.
    const returnTarget = trigger && sidebar.contains(trigger) && mobileQuery.matches ? menuButton : trigger;

    if (url) {
      closeMenu(false);
      if (returnTarget?.isConnected) returnTarget.focus();
      hideSearchResults();
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }

    openDialog(`
      <span class="dialog-icon ${application.id}">${icon(application.icon)}</span>
      <p class="dialog-eyebrow">APPLICATION PREVIEW</p>
      <h2 id="dialog-title">${application.name}</h2>
      <p class="dialog-subtitle">${application.fullName}</p>
      <p class="dialog-copy">${application.description}</p>
      <div class="preview-notice"><strong>This workspace is not connected yet.</strong><br>You can explore the portal while the application address is being prepared.</div>
      <div class="dialog-actions"><button class="primary-button" type="button" data-action="close-dialog" data-autofocus>Back to portal</button></div>
    `, returnTarget);
  }

  function openGuide(trigger) {
    openDialog(`
      <span class="dialog-icon">${icon("guide")}</span>
      <p class="dialog-eyebrow">PORTAL GUIDE</p>
      <h2 id="dialog-title">Find your starting point.</h2>
      <p class="dialog-copy">TAGTOG brings your applications together in one place.</p>
      <ul class="guide-steps">
        <li><strong>Choose a workspace</strong><p>Use EMS for events, PMS for projects, or CRM for customer relationships.</p></li>
        <li><strong>Find an application quickly</strong><p>Press Ctrl K, ⌘ K, or / to search. Use the arrow keys to choose a result, then press Enter.</p></li>
        <li><strong>Continue in the application</strong><p>Planning, tasks, and customer tools live in their own workspaces. This portal is your starting point.</p></li>
      </ul>
      <div class="dialog-actions"><button class="primary-button" type="button" data-action="close-dialog" data-autofocus>Got it</button></div>
    `, mobileQuery.matches ? menuButton : trigger);
  }

  function openProfile(trigger) {
    const user = portalSession?.user;
    if (!user) return;
    openDialog(`
      <div class="profile-detail"><span class="avatar" aria-hidden="true">${escapeHtml(user.fullName?.slice(0,1)||'?')}</span><div><h2 id="dialog-title">${escapeHtml(user.fullName)}</h2><p>${escapeHtml(user.email)}</p></div></div>
      <p class="dialog-copy">${portalSession.isAdmin?'Workspace administrator':'KIM Communication account'}</p>
      <div class="preview-notice">Signing out here also ends your connected workspace sessions.</div>
      <p id="logout-error" class="dialog-copy" role="alert" hidden></p>
      <div class="dialog-actions"><button class="primary-button" type="button" data-action="logout" data-autofocus>Sign out all workspaces</button><button class="secondary-button" type="button" data-action="close-dialog">Back</button></div>
    `, trigger);
  }

  function openMenu() {
    if (!mobileQuery.matches) return;
    focusBeforeMenu = document.activeElement;
    sidebar.inert = false;
    sidebar.classList.add("mobile-open");
    backdrop.hidden = false;
    menuButton.setAttribute("aria-expanded", "true");
    menuButton.setAttribute("aria-label", "Close navigation");
    sidebar.setAttribute("role", "dialog");
    sidebar.setAttribute("aria-modal", "true");
    $(".workspace").inert = true;
    sidebar.querySelector("a, button")?.focus();
    document.body.style.overflow = "hidden";
  }

  function closeMenu(restoreFocus = true) {
    if (!sidebar.classList.contains("mobile-open")) return;
    sidebar.classList.remove("mobile-open");
    backdrop.hidden = true;
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.setAttribute("aria-label", "Open navigation");
    sidebar.removeAttribute("role");
    sidebar.removeAttribute("aria-modal");
    sidebar.inert = mobileQuery.matches;
    $(".workspace").inert = false;
    document.body.style.overflow = "";
    if (restoreFocus && focusBeforeMenu?.isConnected) focusBeforeMenu.focus();
  }

  function updateClock() {
    const now = new Date();
    const zone = { timeZone: "Asia/Jakarta" };
    $("#current-date").textContent = new Intl.DateTimeFormat("en-GB", {
      ...zone, weekday: "long", day: "numeric", month: "short", year: "numeric"
    }).format(now);
    $("#current-time").textContent = new Intl.DateTimeFormat("en-GB", {
      ...zone, hour: "2-digit", minute: "2-digit", hour12: false
    }).format(now);
    $("#current-date").dateTime = now.toISOString();
    $("#current-time").dateTime = now.toISOString();
    $("#footer-year").textContent = new Intl.DateTimeFormat("en", {...zone, year:"numeric"}).format(now);
  }

  document.addEventListener("click", event => {
    const trigger = event.target.closest("[data-open-app], [data-search-app], [data-action], [data-nav]");
    if (trigger?.matches("[data-open-app]")) return openApplication(trigger.dataset.openApp, trigger);
    if (trigger?.matches("[data-search-app]")) return openApplication(trigger.dataset.searchApp, search);
    if (trigger?.dataset.nav === "home") {
      closeMenu();
      clearSearch();
      window.scrollTo({ top: 0, behavior: "instant" });
      return;
    }
    switch (trigger?.dataset.action) {
      case "menu": return sidebar.classList.contains("mobile-open") ? closeMenu() : openMenu();
      case "guide": return openGuide(trigger);
      case "profile": return openProfile(trigger);
      case "logout": return logout(trigger);
      case "close-dialog": return dialog.close();
      case "clear-search": clearSearch(); search.focus(); return;
    }
    if (!event.target.closest(".search-wrap")) hideSearchResults();
  });

  search.addEventListener("input", () => renderApplications(true));
  search.addEventListener("focus", () => renderApplications(true));
  search.addEventListener("keydown", event => {
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      if (results.hidden) renderApplications(true);
      const buttons = $$(".search-result");
      if (!buttons.length) return;
      event.preventDefault();
      (event.key === "ArrowDown" ? buttons[0] : buttons.at(-1)).focus();
    }
    if (event.key === "Enter" && search.value.trim()) {
      const application = matchingApplications()[0];
      if (application) {
        event.preventDefault();
        openApplication(application.id, search);
      }
    }
  });

  results.addEventListener("keydown", event => {
    const buttons = $$(".search-result");
    if (!["ArrowDown", "ArrowUp"].includes(event.key) || !buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement);
    const next = (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
    buttons[next].focus();
  });

  document.addEventListener("keydown", event => {
    if (dialog.open) return;
    if (sidebar.classList.contains("mobile-open")) {
      if (event.key === "Escape") { event.preventDefault(); closeMenu(); return; }
      if (event.key === "Tab") {
        const focusable = [...sidebar.querySelectorAll("a[href], button:not([disabled])")];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
      return;
    }

    const typing = event.target.closest("input, textarea, [contenteditable='true']");
    const commandK = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";
    const slash = event.key === "/" && !typing && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (commandK || slash) { event.preventDefault(); search.focus(); search.select(); }
    if (event.key === "Escape") {
      if (!results.hidden) { event.preventDefault(); search.focus(); hideSearchResults(); }
      else if (search.value && document.activeElement === search) { clearSearch(); }
    }
  });

  dialog.addEventListener("close", () => {
    if (focusBeforeDialog?.isConnected) focusBeforeDialog.focus();
    hideSearchResults();
  });
  dialog.addEventListener("click", event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  backdrop.addEventListener("click", () => closeMenu());
  mobileQuery.addEventListener("change", () => {
    if (!mobileQuery.matches) closeMenu(false);
    sidebar.inert = mobileQuery.matches && !sidebar.classList.contains("mobile-open");
  });

  if (/Mac|iPhone|iPad/.test(navigator.platform)) $("#search-shortcut").textContent = "⌘ K";
  sidebar.inert = mobileQuery.matches;
  async function logout(button) {
    button.disabled=true;
    try {
      const response=await fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':portalSession.csrfToken},body:'{}'});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error?.message||'Unable to sign out. Please try again.');
      location.assign('/login');
    }catch(error){const message=$('#logout-error');message.textContent=error.message;message.hidden=false;button.disabled=false;}
  }
  async function loadSession() {
    try {
      const response=await fetch('/api/session',{cache:'no-store'});
      if(response.status===401){location.assign('/login');return;}
      const data=await response.json();
      if(!response.ok)throw new Error(data.error?.message||'Unable to load your workspace.');
      portalSession=data;
      const name=data.user.fullName||data.user.email;
      $('.profile-copy strong').textContent=name;
      $('.profile-copy small').textContent=data.isAdmin?'Administrator':'Workspace member';
      $('.profile-button').setAttribute('aria-label','Open profile for '+name);
      $('.profile-button .avatar').textContent=name.slice(0,1).toUpperCase();
      $('.welcome-copy .eyebrow').lastChild.textContent='WELCOME BACK, '+name.split(' ')[0].toUpperCase();
      $$('nav [data-open-app]').forEach(button=>{button.hidden=!data.apps.some(app=>app.id===button.dataset.openApp);});
      $('#access-nav').hidden=!data.isAdmin;
      $('#workspace-error').hidden=true;
      renderApplications();
      if(!data.apps.length){$('#empty-state h3').textContent='Your workspace is being prepared';$('#empty-state p').textContent='Ask your administrator to give you application access.';}
    }catch(error){portalSession=null;$('#app-grid').replaceChildren();$('#result-count').textContent='';$('#workspace-error').textContent=error.message;$('#workspace-error').hidden=false;$$('nav [data-open-app]').forEach(button=>{button.hidden=true;});$('#access-nav').hidden=true;}
  }
  window.addEventListener('focus',loadSession);
  loadSession();
  updateClock();
  window.setInterval(updateClock, 30000);
})();
