async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return result;
}

function applyWorkspace(data) {
  currentUser = data.user;
  if (Array.isArray(data.rtcIceServers)) rtcIceServers = data.rtcIceServers;
  colleagues = data.people;
  tasks = data.tasks;
  messages = data.messages;
  invitations = data.invitations || [];
  leaveRequests = data.leaveRequests || [];
  expenses = data.expenses || [];
  events = data.events || [];
  attendance = data.attendance || { checkedIn: false };
}

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
}

let colleagues = [];
let currentUser = null;
let tasks = [];
let messages = { general: [], platform: [] };
let invitations = [];
let leaveRequests = [];
let expenses = [];
let events = [];
let attendance = { checkedIn: false };
let activeConversation = "general";
let infrastructure = { source: "unavailable", error: "", updatedAt: null, nodes: [], vms: [] };
let signalingSocket = null;
let signalingRetryTimer = null;
let activeCall = null;
let incomingCall = null;
let groupCallCounts = { audio: 0, video: 0 };
let rtcIceServers = [{ urls: "stun:stun.l.google.com:19302" }];
let callDurationTimer = null;
let callsConnectionState = "connecting";

const pageContent = document.querySelector("#page-content");
const toast = document.querySelector("#toast");
const leaveDialog = document.querySelector("#leave-dialog");
const profileDialog = document.querySelector("#profile-dialog");
const passwordDialog = document.querySelector("#password-dialog");
const invitationDialog = document.querySelector("#invitation-dialog");
const expenseDialog = document.querySelector("#expense-dialog");
const eventDialog = document.querySelector("#event-dialog");
const shareDialog = document.querySelector("#share-dialog");
const itemDialog = document.querySelector("#item-dialog");
const personDialog = document.querySelector("#person-dialog");
const incomingCallDialog = document.querySelector("#incoming-call-dialog");
const callDialog = document.querySelector("#call-dialog");
let currentPage = "home";
let toastTimer;

function taskMarkup(task) {
  const isDone = task.status === "done";
  const statusLabels = { todo: "To do", "in-progress": "In progress", blocked: "Blocked", done: "Done" };
  return `<div class="task-row${isDone ? " done" : ""}" data-searchable>
    <button class="task-check" data-task="${escapeHTML(task.recordId)}" aria-label="${isDone ? "Reopen" : "Complete"} ${escapeHTML(task.title)}" aria-pressed="${isDone}">✓</button>
    <span class="task-info"><span class="task-title">${escapeHTML(task.title)}</span><span class="task-sub">${escapeHTML(task.id)} · ${escapeHTML(task.assignee)} · ${escapeHTML(task.due || "No due date")}</span></span>
    <span class="task-priority${task.priority === "Low" ? " low" : ""}">${escapeHTML(task.priority)}</span>
  </div>`;
}

function taskPanel(limit = tasks.length) {
  const visibleTasks = tasks.filter((task) => task.type === "task").slice(0, limit);
  return `<section class="panel">
    <div class="panel-header"><div><h3>On your plate</h3><p>${tasks.filter((task) => task.type === "task" && task.status !== "done").length} tasks to keep moving</p></div><button class="text-button" data-page="work">All work <span aria-hidden="true">↗</span></button></div>
    <div class="task-list">${visibleTasks.map(taskMarkup).join("")}</div>
    <p class="empty-search">No matching tasks. Try another search.</p>
  </section>`;
}

function workBoard() {
  const columns = [
    ["todo", "To do"],
    ["in-progress", "In progress"],
    ["blocked", "Blocked"],
    ["done", "Done"],
  ];
  return `<div class="board-toolbar"><label class="filter-label" for="board-filter">Show</label><select id="board-filter" class="board-filter"><option value="all">Tasks & tickets</option><option value="task">Tasks</option><option value="ticket">Infrastructure tickets</option></select></div>
    <div class="kanban-board">${columns.map(([status, label]) => {
      const items = tasks.filter((task) => task.status === status);
      return `<section class="board-column" data-status-column="${status}"><div class="column-heading"><h2>${label}</h2><span>${items.length}</span></div><div class="column-items">${items.length ? items.map((task) => `<article class="work-card" data-searchable data-work-type="${task.type}">
        <div class="work-card-top"><span class="work-type ${task.type}">${task.type === "ticket" ? "Infrastructure" : "Task"}</span><span class="work-priority ${task.priority.toLowerCase()}">${escapeHTML(task.priority)}</span></div>
        <h3>${escapeHTML(task.title)}</h3><p>${escapeHTML(task.description || "")}</p>
        <div class="work-card-footer"><span class="work-id">${escapeHTML(task.id)}</span><label class="sr-only" for="status-${escapeHTML(task.recordId)}">Status for ${escapeHTML(task.title)}</label><select class="status-select" id="status-${escapeHTML(task.recordId)}" data-work-status="${escapeHTML(task.recordId)}" aria-label="Status for ${escapeHTML(task.title)}">${columns.map(([value, name]) => `<option value="${value}"${task.status === value ? " selected" : ""}>${name}</option>`).join("")}</select></div>
        <div class="work-card-assignee"><span class="avatar small-avatar">${escapeHTML(initialsFor(task.assignee))}</span><span>${escapeHTML(task.assignee || "Unassigned")}</span><span class="due-label">${escapeHTML(task.due || "No due date")}</span></div>
      </article>`).join("") : `<p class="column-empty">Nothing here yet</p>`}</div></section>`;
    }).join("")}</div><p class="empty-search board-empty">No work items match your search or filter.</p>`;
}

function feedPanel() {
  const activity = [
    ...leaveRequests.map((request) => ({ label: "Time-off request", detail: `${request.start} – ${request.end}`, status: request.status })),
    ...expenses.map((expense) => ({ label: "Expense report", detail: `${(expense.amountCents / 100).toFixed(2)} ${expense.currency} · ${expense.description}`, status: expense.status })),
  ].slice(0, 4);
  return `<section class="panel">
    <div class="panel-header"><div><h3>My recent requests</h3><p>Shared with your workspace</p></div><button class="text-button" data-page="requests">View requests ↗</button></div>
    <div class="feed-list">${activity.length ? activity.map((item) => `<article class="feed-item" data-searchable><span class="feed-mark">↗</span><div class="feed-copy"><strong>${escapeHTML(item.label)}</strong><p>${escapeHTML(item.detail)}</p><time>Status · ${escapeHTML(item.status)}</time></div></article>`).join("") : `<p class="empty-state">Your submitted time-off and expense requests will appear here.</p>`}</div>
    <p class="empty-search">No matching requests.</p>
  </section>`;
}

function quickLinksPanel() {
  return `<section class="panel">
    <div class="panel-header"><div><h3>Quick links</h3><p>Good things, a click away</p></div></div>
    <div class="quick-links">
      <button class="quick-link" data-action="leave"><span class="quick-link-icon">↗</span><span><strong>Request time off</strong><small>Send for review</small></span></button>
      <button class="quick-link" data-page="people"><span class="quick-link-icon">◉</span><span><strong>Find a teammate</strong><small>Meet your people</small></span></button>
      <button class="quick-link" data-page="resources"><span class="quick-link-icon">▤</span><span><strong>People handbook</strong><small>Policies & how-tos</small></span></button>
      <button class="quick-link" data-action="expense"><span class="quick-link-icon">＋</span><span><strong>Submit an expense</strong><small>Get it sorted</small></span></button>
    </div>
  </section>`;
}

function formatDate(date, options) {
  return new Intl.DateTimeFormat("en", options).format(date);
}

function dashboard() {
  const now = new Date();
  const greeting = now.getHours() < 12 ? "Good morning" : now.getHours() < 18 ? "Good afternoon" : "Good evening";
  const openTasks = tasks.filter((task) => task.type === "task" && task.status !== "done").length;
  const infraStatus = infrastructure.source === "proxmox" ? `${infrastructure.nodes.length} live nodes` : "Connect Proxmox";
  return `<div class="page-heading"><div><span class="eyebrow">${formatDate(now, { weekday: "long", month: "long", day: "numeric" }).toUpperCase()}</span><h1>${greeting}, ${escapeHTML(currentUser.name.split(" ")[0])} <span aria-hidden="true">✳</span></h1><p>Your people, work, and infrastructure at a glance.</p></div></div>
    <section class="welcome-banner">
      <div class="welcome-copy"><span class="eyebrow">A PLACE TO START</span><h2>Make today count.</h2><p>Your work, people, and company updates, all in one place.</p><button class="checkin-button" data-action="checkin"${attendance.checkedOut ? " disabled" : ""}>${attendance.checkedOut ? "Day completed  ✓" : attendance.checkedIn ? "Check out for today  ✓" : "Check in for today  →"}</button></div>
      <div class="welcome-art" aria-hidden="true"><span class="art-sun"></span><span class="art-cloud"></span><span class="art-line"></span><span class="art-spark one">✳</span><span class="art-spark two">✦</span></div>
    </section>
    <section class="metric-grid" aria-label="Your work at a glance">
      <article class="metric-card"><div class="metric-top"><span>My requests</span><span class="metric-icon">◷</span></div><div class="metric-value">${leaveRequests.length} <small>time off</small></div></article>
      <article class="metric-card"><div class="metric-top"><span>Open tasks</span><span class="metric-icon">✓</span></div><div class="metric-value">${openTasks} <small>across your board</small></div></article>
      <article class="metric-card"><div class="metric-top"><span>My expenses</span><span class="metric-icon">☼</span></div><div class="metric-value">${expenses.length} <small>submitted</small></div></article>
    </section>
    <div class="panel-header dashboard-shortcut"><div><h3>Cloud infrastructure</h3><p>${infrastructure.source === "proxmox" ? "Live Proxmox cluster status" : "Proxmox connection not configured"}</p></div><button class="text-button" data-page="infrastructure">${escapeHTML(infraStatus)} ↗</button></div>
    <div class="dashboard-grid"><div>${taskPanel(3)}${messagePreview()}</div><div>${feedPanel()}${quickLinksPanel()}</div></div>`;
}

function workPage() {
  return `<div class="page-heading"><div><span class="eyebrow">TASKS & INFRASTRUCTURE</span><h1>Work board</h1><p>Track team tasks and infrastructure tickets by status.</p></div><button class="button button-primary" data-action="new-task">＋ Create work item</button></div>
    ${workBoard()}`;
}

function peoplePage() {
  const cards = colleagues.map((person) => `<article class="simple-card person-card" data-searchable><span class="avatar">${escapeHTML(person.initials || initialsFor(person.name))}</span><span class="person-info"><strong>${escapeHTML(person.name)}</strong><small>${escapeHTML(person.role)} · ${escapeHTML(person.department || "No department")}</small><small>${escapeHTML(person.location || "Location not set")} · ${escapeHTML(person.status || "Active")}</small></span><button class="text-button" data-person="${escapeHTML(person.id)}">Details ↗</button>${currentUser.accountRole === "admin" ? `<button class="text-button" data-reset-password="${escapeHTML(person.id)}">Reset password link</button>` : ""}</article>`).join("");
  const pending = currentUser.accountRole === "admin" ? `<section class="panel pending-invitations"><div class="panel-header"><div><h3>Pending invitations</h3><p>Links expire after seven days and can only be used once.</p></div></div>${invitations.length ? invitations.map((invite) => `<div class="directory-toolbar"><span>${escapeHTML(invite.email)} · expires ${formatDate(new Date(invite.expiresAt), { month: "short", day: "numeric" })}</span><button class="text-button" data-revoke-invitation="${escapeHTML(invite.id)}">Revoke</button></div>`).join("") : `<p class="empty-search" style="display:block">No pending invitations.</p>`}</section>` : "";
  return `<div class="page-heading"><div><span class="eyebrow">EMPLOYEE DIRECTORY</span><h1>People</h1><p>Work contact details and reporting lines for your team.</p></div><div class="heading-actions"><button class="button button-outline" data-action="edit-profile">Edit my profile</button>${currentUser.accountRole === "admin" ? `<button class="button button-primary" data-action="invite">＋ Invite employee</button>` : ""}</div></div>
    <div class="directory-toolbar"><span>${colleagues.length} employee profiles</span><span>Company directory</span></div>${colleagues.length ? `<div class="simple-grid directory-grid">${cards}</div>` : `<section class="simple-card"><h3>Your directory is ready</h3><p>Employee profiles appear here when teammates accept an invitation.</p></section>`}<p class="empty-search">No teammates match that search.</p>${pending}`;
}

function initialsFor(name = "") {
  return name.trim().split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase() || "VC";
}

function conversationDetails() {
  return {
    general: { name: "# general", description: "Company-wide conversation", initials: "#" },
    platform: { name: "# platform-ops", description: "Infrastructure & platform team", initials: "⌁" },
  };
}

function messageMarkup(message) {
  const mine = message.sender === currentUser.name;
  const time = new Date(message.time);
  const formattedTime = Number.isNaN(time.getTime()) ? message.time : formatDate(time, { hour: "numeric", minute: "2-digit" });
  return `<article class="chat-message${mine ? " mine" : ""}"><span class="avatar chat-avatar">${escapeHTML(initialsFor(message.sender))}</span><div class="chat-message-content"><div class="chat-message-meta"><strong>${escapeHTML(message.sender)}</strong><time>${escapeHTML(formattedTime)}</time></div><p>${escapeHTML(message.text).replace(/\n/g, "<br>")}</p></div></article>`;
}

function messagePreview() {
  const recent = messages.general?.at(-1);
  return `<section class="panel message-preview"><div class="panel-header"><div><h3>Team conversation</h3><p>Latest in # general</p></div><button class="text-button" data-page="messages">Open chat ↗</button></div>${recent ? `<div class="preview-message"><span class="avatar small-avatar">${escapeHTML(initialsFor(recent.sender))}</span><p><strong>${escapeHTML(recent.sender)}</strong><br>${escapeHTML(recent.text)}</p><time>${escapeHTML(recent.time)}</time></div>` : ""}</section>`;
}

function messagesPage() {
  const conversations = conversationDetails();
  const active = conversations[activeConversation] || conversations.general;
  const conversationList = Object.entries(conversations).map(([id, conversation]) => `<button class="conversation-link${id === activeConversation ? " active" : ""}" data-conversation="${id}"><span class="conversation-icon">${escapeHTML(conversation.initials)}</span><span><strong>${escapeHTML(conversation.name)}</strong><small>${escapeHTML(conversation.description)}</small></span></button>`).join("");
  const thread = messages[activeConversation] || [];
  return `<div class="page-heading"><div><span class="eyebrow">STAFF COMMUNICATIONS</span><h1>Messages</h1><p>Team conversations for VOTION CLOUD.</p></div><span class="local-data-label">Shared workspace</span></div>
    <section class="chat-panel"><aside class="conversation-list"><h2>Conversations</h2>${conversationList}</aside><div class="conversation-thread"><header class="thread-header"><span class="conversation-icon">${escapeHTML(active.initials)}</span><div><strong>${escapeHTML(active.name)}</strong><small>${escapeHTML(active.description)}</small></div><span class="channel-state">Shared chat</span></header><div class="thread-messages" id="thread-messages">${thread.length ? thread.map(messageMarkup).join("") : `<p class="thread-empty">No messages yet. Start the conversation.</p>`}</div><form class="message-composer" id="message-form"><label class="sr-only" for="message-input">Message ${escapeHTML(active.name)}</label><textarea id="message-input" name="message" rows="2" maxlength="2000" placeholder="Write a message..." required></textarea><button class="button button-primary" type="submit">Send <span aria-hidden="true">↗</span></button></form></div></section>`;
}

function callPage() {
  const people = colleagues.filter((person) => person.id !== currentUser.id);
  const groupRoom = (mode, title, description, count) => `<article class="call-room-card"><span class="call-room-icon" aria-hidden="true">${mode === "audio" ? "◖" : "▣"}</span><div class="call-room-copy"><h2>${title}</h2><p>${description}</p></div><span class="call-room-count" id="group-call-${mode}-count">${count} ${count === 1 ? "person" : "people"} joined</span><div class="call-room-actions"><button class="button button-primary" data-action="join-group-${mode}">Join ${mode} group</button></div></article>`;
  const contactRows = people.length
    ? people.map((person) => `<article class="call-contact-card"><span class="avatar">${escapeHTML(person.initials || initialsFor(person.name))}</span><span class="call-contact-copy"><strong>${escapeHTML(person.name)}</strong><small>${escapeHTML(person.role)} · ${escapeHTML(person.department || "No department")}</small></span><div class="call-contact-actions"><button class="button button-outline" data-start-call="audio" data-person-id="${escapeHTML(person.id)}">Audio call</button><button class="button button-outline" data-start-call="video" data-person-id="${escapeHTML(person.id)}">Video call</button></div></article>`).join("")
    : `<p class="empty-state">Invite teammates to start a call.</p>`;
  return `<div class="page-heading"><div><span class="eyebrow">VOTION CLOUD COMMUNICATIONS</span><h1>Calls</h1><p>Make private audio and video calls with your team. No paid calling service needed.</p></div><span class="call-connection-state" id="call-connection-state">${callsConnectionState === "connected" ? "Calling ready" : "Connecting…"}</span></div>
    <div class="call-room-grid">${groupRoom("audio", "Team audio call", "Join the shared audio room and talk with your teammates.", groupCallCounts.audio)}${groupRoom("video", "Team video call", "Start or join the shared video room with your team.", groupCallCounts.video)}</div>
    <section class="panel call-contacts-panel"><div class="panel-header"><div><h3>Call a teammate</h3><p>Choose audio or video to start a private call.</p></div></div><div class="call-contact-list">${contactRows}</div></section>
    <p class="call-help-note">Allow microphone and camera access when prompted. <code>localhost</code> is available on this PC only; to call from other devices, VOTION CLOUD must be published on a network-accessible HTTPS address. Calls connect directly and work without a paid calling service. Some firewalls may need a free, self-hosted TURN relay configured by your admin.</p>`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return "0 GB";
  const gigabytes = Number(bytes) / (1024 ** 3);
  return `${gigabytes >= 100 ? gigabytes.toFixed(0) : gigabytes.toFixed(1)} GB`;
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return `${days}d ${hours}h`;
}

function utilization(value, maximum) {
  return maximum > 0 ? Math.min(100, Math.max(0, (value / maximum) * 100)) : 0;
}

function infrastructurePage() {
  const live = infrastructure.source === "proxmox";
  const nodes = live ? infrastructure.nodes : [];
  const virtualMachines = live ? infrastructure.vms : [];
  const onlineNodes = nodes.filter((node) => node.status === "online").length;
  const stateMessage = live
    ? `Live Proxmox data · updated ${formatDate(new Date(infrastructure.updatedAt), { hour: "numeric", minute: "2-digit" })}`
    : infrastructure.error || "Configure a read-only Proxmox API token to show live metrics.";
  return `<div class="page-heading"><div><span class="eyebrow">PLATFORM OPERATIONS</span><h1>Cloud infrastructure</h1><p>Proxmox nodes, resource usage, uptime, and virtual machines.</p></div><div class="heading-actions"><button class="button button-outline" data-action="new-ticket">＋ New ticket</button><button class="button button-outline" data-action="refresh-infrastructure">Refresh <span aria-hidden="true">↻</span></button></div></div>
    <section class="infra-status-bar"><span class="infra-status-dot ${live ? "live" : "demo"}"></span><span class="infra-status-title">${live ? "Live connection" : "Configuration needed"}</span><span class="infra-status-copy">${escapeHTML(stateMessage)}</span><span class="refresh-indicator" id="infra-refresh-indicator">Auto-refresh · 30 sec</span></section>
    <section class="metric-grid infra-metrics"><article class="metric-card"><div class="metric-top"><span>Online nodes</span><span class="metric-icon">⌁</span></div><div class="metric-value">${onlineNodes}<small>/ ${nodes.length} nodes</small></div></article><article class="metric-card"><div class="metric-top"><span>Virtual machines</span><span class="metric-icon">▦</span></div><div class="metric-value">${virtualMachines.filter((vm) => vm.status === "running").length}<small>running</small></div></article><article class="metric-card"><div class="metric-top"><span>Open infra tickets</span><span class="metric-icon">✓</span></div><div class="metric-value">${tasks.filter((task) => task.type === "ticket" && task.status !== "done").length}<small>need attention</small></div></article></section>
    <section class="panel infra-panel"><div class="panel-header"><div><h3>Cluster nodes</h3><p>CPU, memory, disk, and node uptime</p></div><span class="data-source-badge ${live ? "connected" : "sample"}">${live ? "PROXMOX API" : "NOT CONFIGURED"}</span></div><div class="node-list">${nodes.length ? nodes.map((node) => {
      const cpu = Math.round((node.cpu || 0) * 100);
      const memory = utilization(node.mem, node.maxmem);
      const disk = utilization(node.disk, node.maxdisk);
      return `<article class="node-row"><div class="node-name-cell"><span class="node-state ${node.status === "online" ? "online" : "offline"}"></span><div><strong>${escapeHTML(node.node || node.id)}</strong><small>${escapeHTML(node.status || "unknown")} · uptime ${formatUptime(node.uptime || 0)}</small></div></div><div class="resource-cell"><div><span>CPU</span><strong>${cpu}%</strong></div><div class="resource-track"><span style="width:${cpu}%"></span></div><small>${escapeHTML(String(node.maxcpu || 0))} cores</small></div><div class="resource-cell"><div><span>Memory</span><strong>${Math.round(memory)}%</strong></div><div class="resource-track memory"><span style="width:${memory}%"></span></div><small>${formatBytes(node.mem)} / ${formatBytes(node.maxmem)}</small></div><div class="resource-cell"><div><span>Disk</span><strong>${Math.round(disk)}%</strong></div><div class="resource-track disk"><span style="width:${disk}%"></span></div><small>${formatBytes(node.disk)} / ${formatBytes(node.maxdisk)}</small></div></article>`;
    }).join("") : `<p class="empty-state">Infrastructure data appears here after Proxmox is configured.</p>`}</div></section>
    <section class="panel infra-panel vm-panel"><div class="panel-header"><div><h3>Virtual machines</h3><p>Guest status and host assignment</p></div><span class="vm-count">${virtualMachines.length} guests</span></div><div class="vm-table-wrap"><table class="vm-table"><thead><tr><th>Guest</th><th>ID</th><th>Host</th><th>Status</th><th>CPU</th><th>Memory</th></tr></thead><tbody>${virtualMachines.map((vm) => `<tr><td><strong>${escapeHTML(vm.name || `Guest ${vm.vmid}`)}</strong></td><td>${escapeHTML(vm.vmid)}</td><td>${escapeHTML(vm.node)}</td><td><span class="vm-status ${vm.status === "running" ? "running" : "stopped"}">${escapeHTML(vm.status)}</span></td><td>${Math.round((vm.cpu || 0) * 100)}%</td><td>${formatBytes(vm.mem)} / ${formatBytes(vm.maxmem)}</td></tr>`).join("")}</tbody></table></div>${virtualMachines.length ? "" : `<p class="empty-state">Virtual machines appear here after Proxmox is configured.</p>`}</section>`;
}

async function refreshInfrastructure() {
  if (infrastructure.loading) return;
  infrastructure.loading = true;
  try {
    const [nodeResponse, vmResponse] = await Promise.all([fetch("/api/proxmox/nodes"), fetch("/api/proxmox/vms")]);
    const nodeResult = await nodeResponse.json();
    const vmResult = await vmResponse.json();
    if (!nodeResponse.ok) throw new Error(nodeResult.error || "Proxmox nodes are unavailable.");
    if (!vmResponse.ok) throw new Error(vmResult.error || "Proxmox guests are unavailable.");
    infrastructure = { source: "proxmox", error: "", updatedAt: nodeResult.updatedAt, nodes: nodeResult.resources, vms: vmResult.resources, loading: false };
    if (currentPage === "infrastructure" || currentPage === "home") renderPage();
    return true;
  } catch (error) {
    infrastructure = { ...infrastructure, source: "unavailable", error: error.message, loading: false };
    if (currentPage === "infrastructure" || currentPage === "home") renderPage();
    return false;
  }
}

function updateWorkCount() {
  const count = tasks.filter((task) => task.status !== "done").length;
  document.querySelector("#work-count").textContent = count;
}

function refreshAssigneeOptions() {
  const assigneeSelect = document.querySelector("#item-assignee");
  assigneeSelect.innerHTML = `<option value="">Unassigned</option>${colleagues.map((person) => `<option value="${escapeHTML(person.id)}">${escapeHTML(person.name)}</option>`).join("")}`;
}

function resourcesPage() {
  const resources = [
    ["◈", "Time-off requests", "Submit dates and a note for review.", "Request time off", "leave"],
    ["↗", "IT help desk", "Create an infrastructure support ticket.", "Create ticket", "new-ticket"],
    ["＋", "Expense submissions", "Submit a company expense for review.", "Submit expense", "expense"],
  ];
  return `<div class="page-heading"><div><span class="eyebrow">THE USEFUL STUFF</span><h1>Resources</h1><p>Answers, tools, and help without the scavenger hunt.</p></div></div>
    <div class="simple-grid">${resources.map(([icon, title, description, action, type]) => `<article class="simple-card resource-card" data-searchable><span class="resource-icon">${icon}</span><h3>${title}</h3><p>${description}</p><button class="text-button" data-action="${type}">${action} ↗</button></article>`).join("")}</div><p class="empty-search">No resources match that search.</p>`;
}

function calendarPage() {
  const list = events.map((item) => {
    const date = new Date(item.startsAt);
    return `<article class="event-row" data-searchable><span class="event-date"><strong>${formatDate(date, { day: "numeric" })}</strong><small>${formatDate(date, { month: "short" })}</small></span><span class="event-details"><strong>${escapeHTML(item.title)}</strong><small>${formatDate(date, { weekday: "short", hour: "numeric", minute: "2-digit" })} · ${escapeHTML(item.location || "Location not set")}</small></span><span class="event-tag">${escapeHTML(item.category)}</span>${currentUser.accountRole === "admin" ? `<button class="text-button" data-delete-event="${escapeHTML(item.id)}" aria-label="Delete ${escapeHTML(item.title)}">Delete</button>` : ""}</article>`;
  }).join("");
  return `<div class="page-heading"><div><span class="eyebrow">COMING UP</span><h1>Calendar</h1><p>Upcoming events shared with your workspace.</p></div>${currentUser.accountRole === "admin" ? `<button class="button button-primary" data-action="new-event">＋ Add event</button>` : ""}</div>
    <div class="event-list">${list || `<section class="simple-card"><p>No events have been published yet.</p></section>`}</div>`;
}

function morePage() {
  return `<div class="page-heading"><div><span class="eyebrow">YOUR WORKSPACE</span><h1>More</h1><p>Manage company resources and requests.</p></div></div><div class="simple-grid more-grid"><button class="simple-card more-link" data-page="calendar"><span class="resource-icon">▦</span><h3>Company calendar</h3><p>Workspace events and upcoming dates.</p><span class="text-button">Open calendar ↗</span></button><button class="simple-card more-link" data-page="resources"><span class="resource-icon">▤</span><h3>Company services</h3><p>Time-off, IT support, and expense request forms.</p><span class="text-button">Open services ↗</span></button><button class="simple-card more-link" data-page="people"><span class="resource-icon">◉</span><h3>Employee directory</h3><p>Find employee contact details and reporting lines.</p><span class="text-button">Open directory ↗</span></button><button class="simple-card more-link" data-page="requests"><span class="resource-icon">✓</span><h3>Requests</h3><p>Review submitted requests and their current status.</p><span class="text-button">Open requests ↗</span></button></div>`;
}

function requestsPage() {
  const requestCard = (item, type, title, detail) => `<article class="event-row request-row"><span class="event-details"><strong>${escapeHTML(title)}</strong><small>${escapeHTML(detail)} · ${escapeHTML(item.employee || "You")} · ${escapeHTML(item.status)}</small></span>${currentUser.accountRole === "admin" && item.status === "pending" ? `<button class="text-button" data-request-id="${escapeHTML(item.id)}" data-request-type="${type}" data-request-status="approved">Approve</button><button class="text-button request-reject" data-request-id="${escapeHTML(item.id)}" data-request-type="${type}" data-request-status="rejected">Reject</button>` : ""}</article>`;
  const leave = leaveRequests.map((item) => requestCard(item, "leave-requests", "Time off", `${item.start} – ${item.end}${item.note ? ` · ${item.note}` : ""}`)).join("");
  const costs = expenses.map((item) => requestCard(item, "expenses", "Expense", `${(item.amountCents / 100).toFixed(2)} ${item.currency} · ${item.description}`)).join("");
  return `<div class="page-heading"><div><span class="eyebrow">${currentUser.accountRole === "admin" ? "WORKSPACE ADMIN" : "YOUR SUBMISSIONS"}</span><h1>Requests</h1><p>${currentUser.accountRole === "admin" ? "Review employee time-off and expense requests." : "Track the status of your submitted requests."}</p></div></div><section class="panel"><div class="panel-header"><h3>Time off</h3></div>${leave || `<p class="empty-state">No time-off requests.</p>`}</section><section class="panel requests-panel"><div class="panel-header"><h3>Expenses</h3></div>${costs || `<p class="empty-state">No expense requests.</p>`}</section>`;
}

const pages = { home: dashboard, work: workPage, people: peoplePage, messages: messagesPage, calls: callPage, infrastructure: infrastructurePage, resources: resourcesPage, calendar: calendarPage, more: morePage, requests: requestsPage };

function renderPage(page = currentPage, resetScroll = false) {
  if (!currentUser) return;
  currentPage = pages[page] ? page : "home";
  pageContent.innerHTML = pages[currentPage]();
  document.querySelectorAll("[data-page]").forEach((button) => {
    const active = button.dataset.page === currentPage;
    button.classList.toggle("active", active);
    if (button.matches(".nav-item")) active ? button.setAttribute("aria-current", "page") : button.removeAttribute("aria-current");
  });
  updateWorkCount();
  const searchInput = document.querySelector("#global-search");
  searchInput.value = "";
  searchInput.dispatchEvent(new Event("input", { bubbles: true }));
  if (resetScroll) window.scrollTo(0, 0);
}

function openProfileDialog() {
  for (const [field, value] of Object.entries(currentUser)) {
    const key = field === "jobTitle" ? "role" : field;
    const input = document.querySelector(`#profile-${key}`);
    if (input) input.value = value || "";
  }
  profileDialog.showModal();
}

function showAuthScreen(message = "", invitationToken = new URLSearchParams(location.search).get("token")) {
  if (activeCall) finishActiveCall(null, false);
  if (incomingCall) closeIncomingCall(true);
  disconnectCallSocket();
  currentUser = null;
  document.body.classList.add("auth-mode");
  const notice = message ? `<p class="auth-error" role="alert">${escapeHTML(message)}</p>` : "";
  const isPasswordReset = location.pathname === "/reset-password";
  pageContent.innerHTML = isPasswordReset && !invitationToken
    ? `<section class="auth-card"><a class="brand auth-brand" href="/" aria-label="VOTION CLOUD home"><svg class="brand-mark" viewBox="0 0 48 44" aria-hidden="true"><path d="M2 3h12l11 22L37 3h9L25 41 2 3Z" fill="#c5b0ff"/></svg><span class="brand-name">VOTION<span>CLOUD</span></span></a><span class="eyebrow">ACCOUNT SECURITY</span><h1>Password reset</h1><p class="auth-description">This link is missing a reset token. Ask your workspace administrator for a new one.</p>${notice}<button class="text-button auth-switch" data-action="show-login">Return to sign in</button></section>`
    : invitationToken && isPasswordReset
    ? `<section class="auth-card"><a class="brand auth-brand" href="/" aria-label="VOTION CLOUD home"><svg class="brand-mark" viewBox="0 0 48 44" aria-hidden="true"><path d="M2 3h12l11 22L37 3h9L25 41 2 3Z" fill="#c5b0ff"/></svg><span class="brand-name">VOTION<span>CLOUD</span></span></a><span class="eyebrow">ACCOUNT SECURITY</span><h1>Set a new password</h1><p class="auth-description">This administrator-issued link can only be used once and expires after one hour.</p>${notice}<form id="password-reset-form" class="auth-form"><input name="token" type="hidden" value="${escapeHTML(invitationToken)}"><label class="field-label" for="reset-password">New password<input class="form-input" id="reset-password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="256" required></label><label class="field-label" for="reset-password-confirm">Confirm new password<input class="form-input" id="reset-password-confirm" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="256" required></label><button class="button button-primary" type="submit">Update password</button></form></section>`
    : invitationToken
    ? `<section class="auth-card"><a class="brand auth-brand" href="/" aria-label="VOTION CLOUD home"><svg class="brand-mark" viewBox="0 0 48 44" aria-hidden="true"><path d="M2 3h12l11 22L37 3h9L25 41 2 3Z" fill="#c5b0ff"/></svg><span class="brand-name">VOTION<span>CLOUD</span></span></a><span class="eyebrow">EMPLOYEE INVITATION</span><h1>Join your workspace</h1><p class="auth-description">Create your account to accept this invitation.</p>${notice}<form id="invitation-accept-form" class="auth-form"><input name="token" type="hidden" value="${escapeHTML(invitationToken)}"><label class="field-label" for="accept-name">Full name<input class="form-input" id="accept-name" name="name" autocomplete="name" maxlength="120" required></label><label class="field-label" for="accept-password">Password<input class="form-input" id="accept-password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="256" required><small>Use at least 12 characters.</small></label><button class="button button-primary" type="submit">Accept invitation</button></form><button class="text-button auth-switch" data-action="show-login">Already have an account? Sign in</button></section>`
    : `<section class="auth-card"><a class="brand auth-brand" href="/" aria-label="VOTION CLOUD home"><svg class="brand-mark" viewBox="0 0 48 44" aria-hidden="true"><path d="M2 3h12l11 22L37 3h9L25 41 2 3Z" fill="#c5b0ff"/></svg><span class="brand-name">VOTION<span>CLOUD</span></span></a><span class="eyebrow">EMPLOYEE WORKSPACE</span><h1>Welcome back</h1><p class="auth-description">Sign in with your company account.</p>${notice}<form id="login-form" class="auth-form"><label class="field-label" for="login-email">Work email<input class="form-input" id="login-email" name="email" type="email" autocomplete="username" required></label><label class="field-label" for="login-password">Password<input class="form-input" id="login-password" name="password" type="password" autocomplete="current-password" required></label><button class="button button-primary" type="submit">Sign in</button></form></section>`;
}

async function loadWorkspace() {
  const data = await api("/api/bootstrap");
  applyWorkspace(data);
  document.body.classList.remove("auth-mode");
  document.querySelectorAll(".profile-copy strong").forEach((element) => { element.textContent = currentUser.name; });
  document.querySelectorAll(".profile-copy small").forEach((element) => { element.textContent = currentUser.role; });
  document.querySelectorAll(".avatar-me").forEach((element) => { element.textContent = currentUser.initials; });
  document.querySelector("#today-label").textContent = new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric" }).format(new Date());
  connectCallSocket();
  renderPage(currentPage);
}

async function initialize() {
  if (location.pathname === "/invite" || location.pathname === "/reset-password") {
    showAuthScreen();
    return;
  }
  try {
    await loadWorkspace();
    refreshInfrastructure();
  } catch (error) {
    if (error.status === 401) showAuthScreen();
    else showAuthScreen(`Workspace service unavailable: ${error.message}`, "");
  }
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}

function updateCallConnectionState(state) {
  callsConnectionState = state;
  const indicator = document.querySelector("#call-connection-state");
  if (indicator) indicator.textContent = state === "connected" ? "Calling ready" : state === "connecting" ? "Connecting…" : "Reconnecting…";
}

function updateGroupCallCounts(counts) {
  if (!counts || typeof counts !== "object") return;
  for (const mode of ["audio", "video"]) {
    const count = Number(counts[mode]);
    if (!Number.isInteger(count) || count < 0) continue;
    groupCallCounts[mode] = count;
    const indicator = document.querySelector(`#group-call-${mode}-count`);
    if (indicator) indicator.textContent = `${count} ${count === 1 ? "person" : "people"} joined`;
  }
}

function connectCallSocket() {
  if (!currentUser || signalingSocket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(signalingSocket.readyState)) return;
  clearTimeout(signalingRetryTimer);
  updateCallConnectionState("connecting");
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/calls`);
  signalingSocket = socket;
  socket.addEventListener("open", () => {
    if (signalingSocket !== socket) return;
    updateCallConnectionState("connected");
    if (currentPage === "calls") renderPage("calls");
  });
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      console.error("The call server sent an invalid message.");
      return;
    }
    handleCallMessage(message).catch((error) => {
      console.error("Could not process a call update:", error);
      showToast(error.message || "A call could not be connected.");
    });
  });
  socket.addEventListener("close", () => {
    if (signalingSocket !== socket) return;
    signalingSocket = null;
    updateCallConnectionState("reconnecting");
    if (activeCall) finishActiveCall("The calling connection was lost.", false);
    if (currentUser) {
      signalingRetryTimer = setTimeout(connectCallSocket, 2000);
      if (currentPage === "calls") renderPage("calls");
    }
  });
  socket.addEventListener("error", () => updateCallConnectionState("reconnecting"));
}

function disconnectCallSocket() {
  clearTimeout(signalingRetryTimer);
  signalingRetryTimer = null;
  const socket = signalingSocket;
  signalingSocket = null;
  updateCallConnectionState("connecting");
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "Signed out");
}

async function ensureCallSocket() {
  if (!currentUser) throw new Error("Sign in before starting a call.");
  if (!signalingSocket || signalingSocket.readyState === WebSocket.CLOSED) connectCallSocket();
  const socket = signalingSocket;
  if (socket?.readyState === WebSocket.OPEN) return;
  if (!socket || socket.readyState !== WebSocket.CONNECTING) throw new Error("The calling connection is unavailable. Please try again.");
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("The calling server is taking too long to respond. Please try again.")), 10000);
    const finish = (error) => {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onOpen = () => finish();
    const onError = () => finish(new Error("Could not connect to the calling server."));
    const onClose = () => finish(new Error("The calling connection closed. Please try again."));
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
    socket.addEventListener("close", onClose, { once: true });
  });
}

function sendCallMessage(message) {
  if (!signalingSocket || signalingSocket.readyState !== WebSocket.OPEN) {
    throw new Error("The calling connection is unavailable. Please wait a moment and try again.");
  }
  signalingSocket.send(JSON.stringify(message));
}

function requireCallMediaSupport(mode) {
  if (!window.isSecureContext) throw new Error("Microphone and camera access requires a secure connection. Open VOTION CLOUD over HTTPS.");
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser does not support microphone and camera access.");
  if (!window.RTCPeerConnection) throw new Error("This browser does not support calls.");
}

async function acquireCallMedia(mode) {
  requireCallMediaSupport(mode);
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: mode === "video" ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });
  } catch (error) {
    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
      throw new Error("Allow VOTION CLOUD to use your microphone and camera, then try again.");
    }
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      throw new Error(mode === "audio" ? "No microphone was found on this device." : "A microphone and camera are required for a video call.");
    }
    throw new Error(`Could not start your ${mode} call: ${error.message}`);
  }
}

function showCallDialog(call, status) {
  activeCall = call;
  document.querySelector("#call-mode-label").textContent = call.mode === "audio" ? "AUDIO CALL" : "VIDEO CALL";
  document.querySelector("#call-title").textContent = call.title;
  document.querySelector("#call-status").textContent = status;
  document.querySelector("#call-duration").textContent = "Connecting…";
  callDialog.showModal();
  updateCallControls();
  renderCallParticipants();
}

function startCallDuration() {
  if (callDurationTimer) return;
  activeCall.startedAt = Date.now();
  const update = () => {
    if (!activeCall?.startedAt) return;
    const elapsed = Math.floor((Date.now() - activeCall.startedAt) / 1000);
    document.querySelector("#call-duration").textContent = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
  };
  update();
  callDurationTimer = setInterval(update, 1000);
}

function appendCallParticipant(container, participant, stream, local = false) {
  const tile = document.createElement("article");
  tile.className = `call-participant${local ? " call-participant-local" : ""}`;
  const showVideo = activeCall.mode === "video" && stream?.getVideoTracks().some((track) => track.enabled);
  if (showVideo) {
    const video = document.createElement("video");
    video.className = "call-video";
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.srcObject = stream;
    tile.append(video);
    video.play().catch(() => {});
  } else {
    const avatar = document.createElement("span");
    avatar.className = "avatar call-participant-avatar";
    avatar.textContent = participant.initials || initialsFor(participant.name);
    tile.append(avatar);
  }
  if (stream && !local) {
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.srcObject = stream;
    tile.append(audio);
    audio.play().catch(() => {
      document.querySelector("#call-status").textContent = "Your browser blocked playback. Allow audio playback to hear the call.";
    });
  }
  const name = document.createElement("strong");
  name.textContent = local ? `${participant.name} (you)` : participant.name;
  const state = document.createElement("small");
  state.textContent = stream ? activeCall.mode === "audio" ? "Microphone connected" : "In call" : "Connecting…";
  tile.append(name, state);
  container.append(tile);
}

function renderCallParticipants() {
  const container = document.querySelector("#call-participants");
  if (!container || !activeCall) return;
  container.replaceChildren();
  appendCallParticipant(container, currentUser, activeCall.localStream, true);
  for (const peer of activeCall.peers.values()) {
    appendCallParticipant(container, peer, peer.stream);
  }
}

function updateCallControls() {
  const microphone = document.querySelector("#call-mic-button");
  const camera = document.querySelector("#call-camera-button");
  const cameraTrack = activeCall?.localStream?.getVideoTracks()[0];
  microphone.disabled = !activeCall?.localStream?.getAudioTracks().length;
  camera.hidden = activeCall?.mode !== "video";
  document.querySelector("#call-title").textContent = activeCall?.title || "Call";
  const micMuted = Boolean(activeCall?.muted);
  microphone.setAttribute("aria-pressed", String(micMuted));
  microphone.querySelector("small").textContent = micMuted ? "Unmute" : "Mute";
  camera.setAttribute("aria-pressed", String(Boolean(cameraTrack && !cameraTrack.enabled)));
  camera.querySelector("small").textContent = cameraTrack?.enabled ? "Camera on" : "Camera off";
}

function finishActiveCall(message, notifyServer = true) {
  const call = activeCall;
  if (!call) return;
  activeCall = null;
  clearInterval(callDurationTimer);
  callDurationTimer = null;
  if (notifyServer && signalingSocket?.readyState === WebSocket.OPEN) {
    try {
      sendCallMessage({ type: "leave-call" });
    } catch (error) {
      console.error("Could not notify the call server:", error.message);
    }
  }
  for (const peer of call.peers.values()) peer.connection?.close();
  for (const track of call.localStream?.getTracks() || []) track.stop();
  if (callDialog.open) callDialog.close();
  if (message) showToast(message);
  if (currentPage === "calls" && currentUser) renderPage("calls");
}

function closeIncomingCall(decline = true) {
  const call = incomingCall;
  incomingCall = null;
  if (incomingCallDialog.open) incomingCallDialog.close();
  if (decline && call && signalingSocket?.readyState === WebSocket.OPEN) {
    sendCallMessage({ type: "decline-call", callId: call.callId });
  }
}

async function startDirectCall(targetId, mode) {
  if (activeCall) throw new Error("End your current call before starting another.");
  const target = colleagues.find((person) => person.id === targetId);
  if (!target) throw new Error("That teammate is no longer available in the directory.");
  requireCallMediaSupport(mode);
  await ensureCallSocket();
  const call = {
    kind: "direct",
    role: "initiator",
    mode,
    targetId,
    title: target.name,
    roomId: null,
    peers: new Map(),
    localStream: null,
    muted: false,
  };
  showCallDialog(call, `Calling ${target.name}…`);
  try {
    sendCallMessage({ type: "start-call", targetId, mode });
  } catch (error) {
    finishActiveCall(null, false);
    throw error;
  }
}

async function joinGroupCall(mode) {
  if (activeCall) throw new Error("End your current call before joining another.");
  requireCallMediaSupport(mode);
  document.querySelector("#call-mode-label").textContent = mode === "audio" ? "AUDIO GROUP" : "VIDEO GROUP";
  document.querySelector("#call-title").textContent = "Team group call";
  document.querySelector("#call-status").textContent = "Allow microphone and camera access to join.";
  document.querySelector("#call-duration").textContent = "Connecting…";
  callDialog.showModal();
  try {
    const localStream = await acquireCallMedia(mode);
    await ensureCallSocket();
    const call = {
      kind: "group",
      role: "joiner",
      mode,
      title: "Team group call",
      roomId: null,
      peers: new Map(),
      localStream,
      muted: false,
    };
    activeCall = call;
    document.querySelector("#call-status").textContent = "Joining the team call…";
    updateCallControls();
    renderCallParticipants();
    sendCallMessage({ type: "join-group-call", mode });
  } catch (error) {
    if (activeCall) finishActiveCall(null, false);
    else if (callDialog.open) callDialog.close();
    showToast(error.message);
  }
}

function declineIncomingCall() {
  closeIncomingCall(true);
}

async function acceptIncomingCall() {
  const pendingCall = incomingCall;
  if (!pendingCall || activeCall) return;
  const acceptButton = document.querySelector("[data-action='accept-incoming-call']");
  acceptButton.disabled = true;
  try {
    const localStream = await acquireCallMedia(pendingCall.mode);
    if (incomingCall !== pendingCall) {
      for (const track of localStream.getTracks()) track.stop();
      return;
    }
    await ensureCallSocket();
    closeIncomingCall(false);
    const call = {
      kind: "direct",
      role: "recipient",
      mode: pendingCall.mode,
      title: pendingCall.caller.name,
      roomId: pendingCall.callId,
      peers: new Map(),
      localStream,
      muted: false,
    };
    showCallDialog(call, "Connecting to your teammate…");
    sendCallMessage({ type: "accept-call", callId: pendingCall.callId });
  } catch (error) {
    closeIncomingCall(true);
    if (activeCall) finishActiveCall(null, false);
    showToast(error.message);
  } finally {
    acceptButton.disabled = false;
  }
}

function getPeerConnection(call, peer) {
  let record = call.peers.get(peer.id);
  if (record?.connection) return record.connection;
  record = { ...peer, connection: null, stream: null, pendingCandidates: [] };
  const connection = new RTCPeerConnection({ iceServers: rtcIceServers });
  record.connection = connection;
  call.peers.set(peer.id, record);
  for (const track of call.localStream.getTracks()) connection.addTrack(track, call.localStream);
  connection.addEventListener("icecandidate", (event) => {
    if (!event.candidate || activeCall !== call) return;
    try {
      sendCallMessage({ type: "peer-signal", peerId: peer.id, signal: { candidate: event.candidate.toJSON() } });
    } catch (error) {
      document.querySelector("#call-status").textContent = error.message;
    }
  });
  connection.addEventListener("track", (event) => {
    record.stream = event.streams[0] || new MediaStream([...(record.stream?.getTracks() || []), event.track]);
    renderCallParticipants();
  });
  connection.addEventListener("connectionstatechange", () => {
    if (activeCall !== call) return;
    if (connection.connectionState === "connected") {
      document.querySelector("#call-status").textContent = "Connected securely peer-to-peer.";
      startCallDuration();
      renderCallParticipants();
    } else if (connection.connectionState === "failed") {
      document.querySelector("#call-status").textContent = "Unable to connect directly. Your network may need a free, self-hosted TURN relay.";
    } else if (connection.connectionState === "disconnected") {
      document.querySelector("#call-status").textContent = "The connection was interrupted. Trying to reconnect…";
    }
  });
  renderCallParticipants();
  return connection;
}

async function sendPeerDescription(call, peerId, description) {
  try {
    sendCallMessage({
      type: "peer-signal",
      peerId,
      signal: { description: { type: description.type, sdp: description.sdp } },
    });
  } catch (error) {
    finishActiveCall(error.message);
  }
}

async function createCallOffer(call, peer) {
  const connection = getPeerConnection(call, peer);
  if (connection.signalingState !== "stable") return;
  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  await sendPeerDescription(call, peer.id, connection.localDescription);
}

async function handlePeerSignal(call, peer, signal) {
  if (activeCall !== call) return;
  const connection = getPeerConnection(call, peer);
  if (signal.description?.type === "offer") {
    await connection.setRemoteDescription(signal.description);
    for (const candidate of call.peers.get(peer.id).pendingCandidates.splice(0)) {
      await connection.addIceCandidate(candidate);
    }
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    await sendPeerDescription(call, peer.id, connection.localDescription);
  } else if (signal.description?.type === "answer") {
    await connection.setRemoteDescription(signal.description);
    for (const candidate of call.peers.get(peer.id).pendingCandidates.splice(0)) {
      await connection.addIceCandidate(candidate);
    }
  } else if (Object.hasOwn(signal, "candidate")) {
    const candidate = signal.candidate;
    if (!connection.remoteDescription) call.peers.get(peer.id).pendingCandidates.push(candidate);
    else await connection.addIceCandidate(candidate);
  }
}

async function handleCallMessage(message) {
  if (!message || typeof message.type !== "string") return;
  if (message.type === "group-call-counts") {
    updateGroupCallCounts(message.counts);
    return;
  }
  if (message.type === "call-server-ready") {
    updateCallConnectionState("connected");
    return;
  }
  if (message.type === "incoming-call") {
    if (activeCall || incomingCall) {
      sendCallMessage({ type: "decline-call", callId: message.callId });
      return;
    }
    incomingCall = message;
    const mode = message.mode === "video" ? "video" : "audio";
    document.querySelector("#incoming-call-title").textContent = `${message.caller.name} is calling`;
    document.querySelector("#incoming-call-copy").textContent = `Incoming ${mode} call from ${message.caller.name}.`;
    document.querySelector("[data-action='accept-incoming-call']").textContent = `Accept ${mode} call`;
    incomingCallDialog.showModal();
    return;
  }
  if (message.type === "call-ringing" && activeCall?.targetId === message.target?.id) {
    activeCall.roomId = message.roomId;
    document.querySelector("#call-status").textContent = `Calling ${message.target.name}…`;
    return;
  }
  if (message.type === "call-unavailable" && activeCall?.targetId === message.targetId) {
    finishActiveCall("Your teammate is not online to take this call.", false);
    return;
  }
  if (message.type === "call-accepted" && activeCall?.role === "initiator") {
    activeCall.roomId = message.roomId;
    document.querySelector("#call-status").textContent = "Connecting to your teammate…";
    try {
      activeCall.localStream = await acquireCallMedia(activeCall.mode);
      updateCallControls();
      renderCallParticipants();
      startCallDuration();
      await createCallOffer(activeCall, message.peer);
    } catch (error) {
      finishActiveCall(error.message);
    }
    return;
  }
  if (message.type === "room-joined" && activeCall &&
    (message.roomId === activeCall.roomId || activeCall.kind === "group")) {
    if (!activeCall.roomId) activeCall.roomId = message.roomId;
    document.querySelector("#call-status").textContent = message.peers.length ? "Connecting to your teammates…" : "You’re the first person here. Invite teammates to join.";
    if (activeCall.kind === "group") {
      startCallDuration();
      for (const peer of message.peers) {
        try {
          await createCallOffer(activeCall, peer);
        } catch (error) {
          finishActiveCall(`Could not connect to ${peer.name}: ${error.message}`);
          return;
        }
      }
    }
    return;
  }
  if (message.type === "room-peer-joined" && activeCall?.kind === "group") {
    if (!activeCall.peers.has(message.peer.id)) {
      activeCall.peers.set(message.peer.id, { ...message.peer, connection: null, stream: null, pendingCandidates: [] });
      document.querySelector("#call-status").textContent = `${message.peer.name} joined the group call.`;
      renderCallParticipants();
    }
    return;
  }
  if (message.type === "peer-signal" && activeCall?.roomId) {
    try {
      await handlePeerSignal(activeCall, message.peer, message.signal);
    } catch (error) {
      document.querySelector("#call-status").textContent = `Could not connect to ${message.peer.name}: ${error.message}`;
    }
    return;
  }
  if (message.type === "room-peer-left" && activeCall?.peers.has(message.peerId)) {
    activeCall.peers.get(message.peerId).connection?.close();
    activeCall.peers.delete(message.peerId);
    renderCallParticipants();
    document.querySelector("#call-status").textContent = "A teammate left the group call.";
    return;
  }
  if (message.type === "call-invitation-closed" && incomingCall?.callId === message.callId) {
    closeIncomingCall(false);
    return;
  }
  if (message.type === "call-declined" && activeCall?.roomId === message.callId) {
    finishActiveCall("Your teammate declined the call.", false);
    return;
  }
  if (message.type === "call-no-answer" && activeCall?.roomId === message.callId) {
    finishActiveCall("Your teammate did not answer.", false);
    return;
  }
  if (message.type === "call-ended" && activeCall) {
    finishActiveCall("Your teammate left the call.", false);
    return;
  }
  if (message.type === "call-error") {
    if (activeCall) finishActiveCall(message.message, Boolean(activeCall.roomId));
    else showToast(message.message);
  }
}

function filterPage(query) {
  const normalizedQuery = query.trim().toLowerCase();
  const selectedType = document.querySelector("#board-filter")?.value || "all";
  const items = [...pageContent.querySelectorAll("[data-searchable]")];
  items.forEach((item) => {
    const typeMatches = selectedType === "all" || item.dataset.workType === selectedType;
    const textMatches = !normalizedQuery || item.textContent.toLowerCase().includes(normalizedQuery);
    const match = typeMatches && textMatches;
    item.hidden = !match;
  });
  pageContent.querySelectorAll(".empty-search").forEach((message) => {
    const parent = message.parentElement;
    const scopedItems = parent.querySelectorAll("[data-searchable]");
    message.style.display = normalizedQuery && scopedItems.length && ![...scopedItems].some((item) => !item.hidden) ? "block" : "none";
  });
  pageContent.querySelectorAll("[data-status-column]").forEach((column) => {
    const visibleItems = column.querySelectorAll("[data-searchable]:not([hidden])").length;
    const count = column.querySelector(".column-heading span");
    if (count) count.textContent = visibleItems;
  });
  const boardEmpty = pageContent.querySelector(".board-empty");
  if (boardEmpty) boardEmpty.style.display = normalizedQuery && !items.some((item) => !item.hidden) ? "block" : "none";
}

document.addEventListener("click", async (event) => {
  const pageButton = event.target.closest("[data-page]");
  if (pageButton && currentUser) {
    renderPage(pageButton.dataset.page, true);
    return;
  }

  if (event.target.closest("[data-action='show-login']")) {
    history.replaceState(null, "", "/");
    showAuthScreen();
    return;
  }

  const personButton = event.target.closest("[data-person]");
  if (personButton) {
    const person = colleagues.find((item) => item.id === personButton.dataset.person);
    if (person) {
      document.querySelector("#person-details").innerHTML = `<div class="person-profile-head"><span class="avatar profile-large">${escapeHTML(person.initials || initialsFor(person.name))}</span><div><h3>${escapeHTML(person.name)}</h3><p>${escapeHTML(person.role)} · ${escapeHTML(person.status || "Active")}</p></div></div><dl class="person-detail-list"><div><dt>Department</dt><dd>${escapeHTML(person.department || "Not provided")}</dd></div><div><dt>Work email</dt><dd><a href="mailto:${escapeHTML(person.email)}">${escapeHTML(person.email)}</a></dd></div><div><dt>Work phone</dt><dd>${escapeHTML(person.phone || "Not provided")}</dd></div><div><dt>Location</dt><dd>${escapeHTML(person.location || "Not provided")}</dd></div><div><dt>Manager</dt><dd>${escapeHTML(person.manager || "Not provided")}</dd></div></dl><div class="person-call-actions"><button class="button button-outline" data-start-call="audio" data-person-id="${escapeHTML(person.id)}">Start audio call</button><button class="button button-primary" data-start-call="video" data-person-id="${escapeHTML(person.id)}">Start video call</button></div>`;
      personDialog.showModal();
    }
    return;
  }

  const startCallButton = event.target.closest("[data-start-call]");
  if (startCallButton) {
    personDialog.close();
    try {
      await startDirectCall(startCallButton.dataset.personId, startCallButton.dataset.startCall);
    } catch (error) {
      showToast(error.message);
    }
    return;
  }

  const revokeButton = event.target.closest("[data-revoke-invitation]");
  if (revokeButton) {
    try {
      await api(`/api/invitations?id=${encodeURIComponent(revokeButton.dataset.revokeInvitation)}`, { method: "DELETE", body: "{}" });
      applyWorkspace(await api("/api/bootstrap"));
      renderPage("people");
      showToast("Invitation revoked.");
    } catch (error) { showToast(error.message); }
    return;
  }

  const resetPasswordButton = event.target.closest("[data-reset-password]");
  if (resetPasswordButton) {
    try {
      const result = await api("/api/password-resets", {
        method: "POST",
        body: JSON.stringify({ userId: resetPasswordButton.dataset.resetPassword }),
      });
      document.querySelector("#share-link").value = result.link;
      shareDialog.showModal();
    } catch (error) { showToast(error.message); }
    return;
  }

  const requestButton = event.target.closest("[data-request-id]");
  if (requestButton) {
    try {
      await api(`/api/${requestButton.dataset.requestType}/${encodeURIComponent(requestButton.dataset.requestId)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: requestButton.dataset.requestStatus }),
      });
      applyWorkspace(await api("/api/bootstrap"));
      renderPage("requests");
      showToast(`Request ${requestButton.dataset.requestStatus}.`);
    } catch (error) { showToast(error.message); }
    return;
  }

  const deleteEventButton = event.target.closest("[data-delete-event]");
  if (deleteEventButton) {
    try {
      await api(`/api/events?id=${encodeURIComponent(deleteEventButton.dataset.deleteEvent)}`, { method: "DELETE", body: "{}" });
      applyWorkspace(await api("/api/bootstrap"));
      renderPage("calendar");
      showToast("Calendar event deleted.");
    } catch (error) { showToast(error.message); }
    return;
  }

  const conversationButton = event.target.closest("[data-conversation]");
  if (conversationButton) {
    activeConversation = conversationButton.dataset.conversation;
    renderPage();
    return;
  }

  const taskButton = event.target.closest("[data-task]");
  if (taskButton) {
    const task = tasks.find((item) => item.recordId === taskButton.dataset.task);
    if (task) {
      try {
        await api(`/api/work/${encodeURIComponent(task.recordId)}`, {
          method: "PATCH",
          body: JSON.stringify({ status: task.status === "done" ? "todo" : "done" }),
        });
        applyWorkspace(await api("/api/bootstrap"));
        renderPage();
      } catch (error) { showToast(error.message); }
    }
    return;
  }

  const closeTarget = event.target.closest("[data-action^='close-']");
  if (closeTarget) {
    const dialogs = {
      "close-dialog": leaveDialog,
      "close-profile": profileDialog,
      "close-password": passwordDialog,
      "close-invitation": invitationDialog,
      "close-expense": expenseDialog,
      "close-event": eventDialog,
      "close-share": shareDialog,
      "close-item": itemDialog,
      "close-person": personDialog,
    };
    dialogs[closeTarget.dataset.action]?.close();
    return;
  }

  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) return;
  try {
    switch (actionButton.dataset.action) {
      case "leave":
        leaveDialog.showModal();
        break;
      case "checkin":
        await api("/api/attendance", { method: "POST", body: "{}" });
        applyWorkspace(await api("/api/bootstrap"));
        renderPage();
        showToast(attendance.checkedIn ? "You’re checked in. Have a good one!" : "You’re checked out for today.");
        break;
      case "expense":
        expenseDialog.showModal();
        break;
      case "new-task":
      case "new-ticket": {
        const isTicket = actionButton.dataset.action === "new-ticket";
        document.querySelector("#item-kind").value = isTicket ? "ticket" : "task";
        document.querySelector("#item-title").textContent = isTicket ? "Create infrastructure ticket" : "Create work item";
        refreshAssigneeOptions();
        itemDialog.showModal();
        break;
      }
      case "new-event":
        if (currentUser.accountRole !== "admin") throw new Error("Workspace administrator access is required.");
        eventDialog.showModal();
        break;
      case "join-group-audio":
        await joinGroupCall("audio");
        break;
      case "join-group-video":
        await joinGroupCall("video");
        break;
      case "accept-incoming-call":
        await acceptIncomingCall();
        break;
      case "decline-incoming-call":
        declineIncomingCall();
        break;
      case "end-call":
        finishActiveCall("You left the call.");
        break;
      case "toggle-microphone":
        if (!activeCall) break;
        activeCall.muted = !activeCall.muted;
        for (const track of activeCall.localStream.getAudioTracks()) track.enabled = !activeCall.muted;
        updateCallControls();
        break;
      case "toggle-camera": {
        const cameraTrack = activeCall?.localStream?.getVideoTracks()[0];
        if (!cameraTrack) break;
        cameraTrack.enabled = !cameraTrack.enabled;
        updateCallControls();
        renderCallParticipants();
        break;
      }
      case "edit-profile":
      case "profile":
        openProfileDialog();
        break;
      case "password-change":
        profileDialog.close();
        document.querySelector("#password-form").reset();
        passwordDialog.showModal();
        break;
      case "invite":
        if (currentUser.accountRole !== "admin") throw new Error("Workspace administrator access is required.");
        document.querySelector("#invitation-form").reset();
        document.querySelector("#invitation-result").hidden = true;
        document.querySelector("#create-invitation").hidden = false;
        invitationDialog.showModal();
        break;
      case "copy-invitation":
        await navigator.clipboard.writeText(document.querySelector("#invitation-link").value);
        showToast("Invitation link copied.");
        break;
      case "copy-share-link":
        await navigator.clipboard.writeText(document.querySelector("#share-link").value);
        showToast("Password reset link copied.");
        break;
      case "logout":
        if (activeCall) finishActiveCall(null);
        if (incomingCall) closeIncomingCall(true);
        await api("/api/auth/logout", { method: "POST", body: "{}" });
        history.replaceState(null, "", "/");
        showAuthScreen("You have signed out.", "");
        break;
      case "notifications":
        showToast(`${leaveRequests.length} time-off request${leaveRequests.length === 1 ? "" : "s"} and ${expenses.length} expense report${expenses.length === 1 ? "" : "s"} submitted.`);
        break;
      case "refresh-infrastructure":
        showToast(await refreshInfrastructure() ? "Proxmox status refreshed." : infrastructure.error);
        break;
      case "calendar":
        showToast("Connect a company calendar to publish events here.");
        break;
      case "resource":
        showToast("Ask your workspace admin to configure this resource link.");
        break;
    }
  } catch (error) { showToast(error.message); }
});

document.querySelector("#global-search").addEventListener("input", (event) => filterPage(event.target.value));
document.addEventListener("change", async (event) => {
  if (event.target.matches("[data-work-status]")) {
    try {
      await api(`/api/work/${encodeURIComponent(event.target.dataset.workStatus)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: event.target.value }),
      });
      applyWorkspace(await api("/api/bootstrap"));
      renderPage("work");
    } catch (error) {
      showToast(error.message);
      renderPage("work");
    }
  } else if (event.target.matches("#board-filter")) {
    filterPage(document.querySelector("#global-search").value);
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!form.matches("form")) return;
  const values = Object.fromEntries(new FormData(form));
  try {
    if (form.id === "login-form") {
      event.preventDefault();
      await api("/api/auth/login", { method: "POST", body: JSON.stringify(values) });
      history.replaceState(null, "", location.pathname);
      await loadWorkspace();
      refreshInfrastructure();
      return;
    }
    if (form.id === "invitation-accept-form") {
      event.preventDefault();
      await api("/api/auth/accept-invitation", { method: "POST", body: JSON.stringify(values) });
      history.replaceState(null, "", location.pathname);
      await loadWorkspace();
      showToast("Welcome to VOTION CLOUD.");
      return;
    }
    if (form.id === "password-reset-form") {
      event.preventDefault();
      if (values.password !== values.confirmPassword) throw new Error("The new passwords do not match.");
      await api("/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token: values.token, password: values.password }),
      });
      history.replaceState(null, "", "/");
      await loadWorkspace();
      showToast("Password reset. You’re signed in.");
      return;
    }
    if (form.id === "profile-form") {
      event.preventDefault();
      await api("/api/profile", { method: "PUT", body: JSON.stringify(values) });
      await loadWorkspace();
      profileDialog.close();
      showToast("Profile details saved.");
      return;
    }
    if (form.id === "password-form") {
      event.preventDefault();
      if (values.newPassword !== values.confirmPassword) throw new Error("The new passwords do not match.");
      await api("/api/auth/password", {
        method: "PUT",
        body: JSON.stringify({ currentPassword: values.currentPassword, newPassword: values.newPassword }),
      });
      passwordDialog.close();
      form.reset();
      showToast("Password updated. Other signed-in sessions were ended.");
      return;
    }
    if (form.id === "invitation-form") {
      event.preventDefault();
      const invite = await api("/api/invitations", { method: "POST", body: JSON.stringify(values) });
      document.querySelector("#invitation-link").value = invite.link;
      document.querySelector("#invitation-result").hidden = false;
      document.querySelector("#create-invitation").hidden = true;
      applyWorkspace(await api("/api/bootstrap"));
      renderPage("people");
      document.querySelector("#invitation-link").focus();
      showToast("One-time invitation link created.");
      return;
    }
    if (form.id === "item-form") {
      event.preventDefault();
      await api("/api/work", {
        method: "POST",
        body: JSON.stringify({
          type: values.kind,
          title: values.title,
          description: values.description,
          assigneeId: values.assignee,
          priority: values.priority,
        }),
      });
      itemDialog.close();
      form.reset();
      await loadWorkspace();
      renderPage("work");
      showToast(values.kind === "ticket" ? "Infrastructure ticket added." : "Task added.");
      return;
    }
    if (form.id === "message-form") {
      event.preventDefault();
      const input = form.elements.message;
      if (!input.value.trim()) return;
      await api("/api/messages", { method: "POST", body: JSON.stringify({ channel: activeConversation, text: input.value.trim() }) });
      applyWorkspace(await api("/api/bootstrap"));
      renderPage("messages");
      document.querySelector("#thread-messages").scrollTop = document.querySelector("#thread-messages").scrollHeight;
      return;
    }
    if (form.id === "leave-form") {
      event.preventDefault();
      const start = document.querySelector("#leave-start");
      const end = document.querySelector("#leave-end");
      if (end.value < start.value) {
        end.setCustomValidity("Choose an end date on or after your first day.");
        end.reportValidity();
        return;
      }
      end.setCustomValidity("");
      await api("/api/leave-requests", {
        method: "POST",
        body: JSON.stringify({ start: start.value, end: end.value, note: values.note || "" }),
      });
      leaveDialog.close();
      form.reset();
      await loadWorkspace();
      showToast("Time-off request submitted for review.");
      return;
    }
    if (form.id === "expense-form") {
      event.preventDefault();
      await api("/api/expenses", { method: "POST", body: JSON.stringify(values) });
      expenseDialog.close();
      form.reset();
      await loadWorkspace();
      showToast("Expense submitted for review.");
      return;
    }
    if (form.id === "event-form") {
      event.preventDefault();
      await api("/api/events", {
        method: "POST",
        body: JSON.stringify({ ...values, startsAt: new Date(values.startsAt).toISOString() }),
      });
      eventDialog.close();
      form.reset();
      await loadWorkspace();
      renderPage("calendar");
      showToast("Calendar event published.");
    }
  } catch (error) {
    event.preventDefault();
    if (form.id === "login-form" || form.id === "invitation-accept-form" || form.id === "password-reset-form") {
      const token = form.elements.token?.value || "";
      showAuthScreen(error.message, token);
    } else showToast(error.message);
  }
});

document.addEventListener("keydown", (event) => {
  if (!document.body.classList.contains("auth-mode") && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    document.querySelector("#global-search").focus();
  }
});

document.querySelector("#leave-end").addEventListener("input", (event) => event.currentTarget.setCustomValidity(""));
document.querySelector("#item-kind").addEventListener("change", (event) => {
  document.querySelector("#item-title").textContent = event.target.value === "ticket" ? "Create infrastructure ticket" : "Create work item";
});
document.querySelector("#today-label").textContent = new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric" }).format(new Date());
if (navigator.platform.toLowerCase().includes("mac")) document.querySelector("#search-shortcut").textContent = "⌘ K";
callDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  finishActiveCall("You left the call.");
});
incomingCallDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  declineIncomingCall();
});
window.addEventListener("beforeunload", () => {
  if (activeCall && signalingSocket?.readyState === WebSocket.OPEN) {
    signalingSocket.send(JSON.stringify({ type: "leave-call" }));
  }
  for (const track of activeCall?.localStream?.getTracks() || []) track.stop();
});
initialize();
setInterval(async () => {
  if (document.visibilityState !== "visible" || !currentUser || document.querySelector("dialog[open]") || document.activeElement.matches("input, textarea, select")) return;
  try {
    applyWorkspace(await api("/api/bootstrap"));
    renderPage();
  } catch (error) {
    if (error.status === 401) showAuthScreen("Your session has expired. Please sign in again.", "");
  }
}, 15000);
setInterval(() => {
  if (document.visibilityState === "visible" && currentUser) refreshInfrastructure();
}, 30000);