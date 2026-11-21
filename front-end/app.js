const API_URL = (function () {
  const params = new URLSearchParams(location.search);
  const fromQuery = params.get("api");
  if (fromQuery) {
    const clean = fromQuery.replace(/\/$/, "");
    localStorage.setItem("gweldig_api_url", clean);
    return clean;
  }
  const stored = localStorage.getItem("gweldig_api_url");
  if (stored) return stored.replace(/\/$/, "");
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.protocol === "file:") {
    return "http://127.0.0.1:8000";
  }
  return window.GWELDIG_API_URL || "";
})();

const VARIANTS = {
  low: { temperature: 0.3, max_output_tokens: 1024, top_p: 0.8 },
  medium: { temperature: 0.7, max_output_tokens: 2048, top_p: 0.95 },
  high: { temperature: 1.0, max_output_tokens: 4096, top_p: 1.0 },
};

const defaultSettings = {
  model: "gemini-2.0-flash",
  variant: "medium",
  ...VARIANTS.medium,
};

const state = {
  projects: JSON.parse(localStorage.getItem("gweldig_projects") || "[]"),
  activeProjectId: localStorage.getItem("gweldig_active_project") || null,
  attachments: [],
  sending: false,
  settings: loadSettings(),
};

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem("gweldig_ai_settings") || "{}");
    const variant = VARIANTS[raw.variant] ? raw.variant : "medium";
    const model = raw.model || defaultSettings.model;
    return { model, variant, ...VARIANTS[variant] };
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings() {
  localStorage.setItem("gweldig_ai_settings", JSON.stringify(state.settings));
}

const els = {};

document.addEventListener("DOMContentLoaded", () => {
  cacheEls();
  bindEvents();
  initTheme();
  initAISettings();
  initApp();
  loadTasks();
});

function cacheEls() {
  els.sidebar = document.getElementById("sidebar");
  els.scrim = document.getElementById("scrim");
  els.openSidebar = document.getElementById("open-sidebar");
  els.closeSidebar = document.getElementById("close-sidebar");
  els.themeToggle = document.getElementById("theme-toggle");
  els.newChat = document.getElementById("new-chat-btn");
  els.search = document.getElementById("search-input");
  els.history = document.getElementById("project-history");
  els.taskForm = document.getElementById("task-form");
  els.taskInput = document.getElementById("task-input");
  els.taskList = document.getElementById("task-list");
  els.clear = document.getElementById("clear-btn");
  els.workspace = document.getElementById("main-workspace");
  els.messages = document.getElementById("workspace-content");
  els.title = document.getElementById("active-project-title");
  els.form = document.getElementById("composer-form");
  els.input = document.getElementById("user-input");
  els.file = document.getElementById("file-input");
  els.send = document.getElementById("send-btn");
  els.tray = document.getElementById("attachment-tray");
  els.modelSelect = document.getElementById("model-select");
  els.variantGroup = document.getElementById("variant-group");
}

function bindEvents() {
  els.themeToggle.addEventListener("click", toggleTheme);
  els.newChat.addEventListener("click", startNewChat);
  els.search.addEventListener("input", () => renderProjects(filterProjects(els.search.value)));
  els.clear.addEventListener("click", clearHistory);
  els.taskForm.addEventListener("submit", (e) => {
    e.preventDefault();
    addTask();
  });
  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    sendMessage();
  });
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  els.input.addEventListener("input", autoResizeInput);
  els.file.addEventListener("change", handleFilePick);
  els.openSidebar?.addEventListener("click", () => setSidebar(true));
  els.closeSidebar?.addEventListener("click", () => setSidebar(false));
  els.scrim?.addEventListener("click", () => setSidebar(false));
  window.addEventListener("resize", () => {
    if (window.innerWidth > 900) setSidebar(false);
  });
  els.modelSelect?.addEventListener("change", () => {
    state.settings.model = els.modelSelect.value;
    saveSettings();
  });
  els.variantGroup?.addEventListener("click", (e) => {
    const btn = e.target.closest(".variant-pill, .variant-btn");
    if (!btn) return;
    setActiveVariant(btn.dataset.variant);
  });
}

function setSidebar(open) {
  els.sidebar.classList.toggle("open", open);
  els.scrim.classList.toggle("show", open);
}

function initTheme() {
  const saved = localStorage.getItem("gweldig_theme") || "dark";
  document.documentElement.setAttribute("data-theme", saved);
  updateThemeIcon(saved);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("gweldig_theme", next);
  updateThemeIcon(next);
}

function updateThemeIcon(theme) {
  const isDark = theme === "dark";
  els.themeToggle.innerHTML = isDark
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 14.5A8.5 8.5 0 119.5 3a7 7 0 0011.5 11.5z" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M12 2.5v2.5M12 19v2.5M4.5 12H2M22 12h-2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  els.themeToggle.title = isDark ? "Ganti ke tema terang" : "Ganti ke tema gelap";
}

function initAISettings() {
  setActiveVariant(state.settings.variant || "medium");
  loadModels();
}

function setActiveVariant(variant) {
  if (!VARIANTS[variant]) variant = "medium";
  state.settings.variant = variant;
  Object.assign(state.settings, VARIANTS[variant]);
  if (els.variantGroup) {
    els.variantGroup.querySelectorAll(".variant-pill, .variant-btn").forEach((btn) => {
      const active = btn.dataset.variant === variant;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-checked", active ? "true" : "false");
    });
  }
  saveSettings();
}

async function loadModels() {
  if (!els.modelSelect) return;
  const fallback = [
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
    { id: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash Lite" },
    { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
    { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
  ];
  let models = fallback;
  try {
    const res = await fetch(`${API_URL}/models`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.models) && data.models.length) models = data.models;
    }
  } catch {}
  els.modelSelect.innerHTML = "";
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label || m.id;
    els.modelSelect.appendChild(opt);
  }
  const exists = models.some((m) => m.id === state.settings.model);
  if (!exists && models[0]) state.settings.model = models[0].id;
  els.modelSelect.value = state.settings.model;
  saveSettings();
}

function saveLocal() {
  localStorage.setItem("gweldig_projects", JSON.stringify(state.projects));
  localStorage.setItem("gweldig_active_project", state.activeProjectId ? String(state.activeProjectId) : "");
}

async function initApp() {
  try {
    const res = await fetch(`${API_URL}/projects`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        mergeProjectsFromServer(data);
      }
    }
  } catch {}
  renderProjects(filterProjects(els.search.value));
  await ensureActiveProject();
}

function mergeProjectsFromServer(serverProjects) {
  const localMap = new Map(state.projects.map((p) => [String(p.id), p]));
  const merged = serverProjects.map((p) => {
    const existing = localMap.get(String(p.id)) || {};
    return { ...existing, ...p, id: p.id, name: p.name || "Percakapan", messages: existing.messages || [] };
  });
  for (const [id, p] of localMap.entries()) {
    if (!merged.some((m) => String(m.id) === id) && String(id).startsWith("proj-")) {
      merged.push(p);
    }
  }
  merged.sort((a, b) => {
    const da = a.created_at ? new Date(a.created_at).getTime() : 0;
    const db = b.created_at ? new Date(b.created_at).getTime() : 0;
    if (da !== db) return db - da;
    return String(b.id).localeCompare(String(a.id));
  });
  state.projects = merged;
  saveLocal();
}

function filterProjects(query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return state.projects;
  return state.projects.filter((p) => (p.name || "").toLowerCase().includes(q));
}

function renderProjects(list) {
  els.history.innerHTML = "";
  if (!list.length) {
    const li = document.createElement("li");
    li.className = "history-empty";
    li.textContent = state.projects.length ? "Tidak ada hasil." : "Belum ada percakapan.";
    els.history.appendChild(li);
    return;
  }
  for (const proj of list) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "history-item" + (String(proj.id) === String(state.activeProjectId) ? " active" : "");
    btn.textContent = proj.name || "Percakapan";
    btn.title = proj.name || "Percakapan";
    btn.addEventListener("click", () => selectProject(proj.id));
    li.appendChild(btn);
    els.history.appendChild(li);
  }
}

async function ensureActiveProject() {
  if (state.activeProjectId && state.projects.some((p) => String(p.id) === String(state.activeProjectId))) {
    await selectProject(state.activeProjectId, { silent: true });
    return;
  }
  if (state.projects.length) {
    await selectProject(state.projects[0].id, { silent: true });
    return;
  }
  await createProject("Percakapan baru", { silent: true });
}

async function selectProject(id, opts = {}) {
  state.activeProjectId = id;
  saveLocal();
  renderProjects(filterProjects(els.search.value));
  const proj = state.projects.find((p) => String(p.id) === String(id));
  els.title.textContent = proj?.name || "Percakapan";
  els.messages.innerHTML = "";
  let messages = null;
  try {
    const res = await fetch(`${API_URL}/projects/${id}/messages`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) messages = data;
    }
  } catch {}
  if (!messages && proj?.messages) messages = proj.messages;
  if (messages && messages.length) {
    for (const m of messages) appendMessage(m.role, m.content || "", m.attachments || [], { scroll: false });
  } else {
    renderEmptyState();
  }
  if (!opts.silent) setSidebar(false);
  scrollToBottom();
}

function renderEmptyState() {
  els.messages.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "empty-state";
  wrap.innerHTML = `
    <h2>Mulai dari apa yang ada di meja kerjamu.</h2>
    <p>Kirim pertanyaan, tempel teks, atau lampirkan foto dan dokumen. Gweldig akan membantu membaca, meringkas, dan menindaklanjuti.</p>
    <div class="suggestions">
      <button type="button" class="suggestion" data-text="Ringkas poin penting dari gambar atau dokumen yang saya lampirkan.">Ringkas lampiran</button>
      <button type="button" class="suggestion" data-text="Bantu saya menyusun rencana kerja dari percakapan ini.">Susun rencana</button>
      <button type="button" class="suggestion" data-text="Periksa dan jelaskan isi file ini dengan bahasa sederhana.">Jelaskan file</button>
    </div>`;
  wrap.querySelectorAll(".suggestion").forEach((btn) => {
    btn.addEventListener("click", () => {
      els.input.value = btn.dataset.text || "";
      autoResizeInput();
      els.input.focus();
    });
  });
  els.messages.appendChild(wrap);
}

async function startNewChat() {
  const name = window.prompt("Nama percakapan", "Percakapan baru");
  if (!name || !name.trim()) return;
  await createProject(name.trim());
}

async function createProject(name, opts = {}) {
  let created = { id: "proj-" + Date.now(), name, messages: [] };
  try {
    const res = await fetch(`${API_URL}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.id != null) created = { ...data, name: data.name || name, messages: [] };
    }
  } catch {}
  state.projects.unshift(created);
  saveLocal();
  renderProjects(filterProjects(els.search.value));
  await selectProject(created.id, opts);
}

function autoResizeInput() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 180) + "px";
}

function handleFilePick(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  for (const file of files) addAttachment(file);
  e.target.value = "";
}

async function addAttachment(file) {
  if (file.size > 8 * 1024 * 1024) {
    window.alert(`File "${file.name}" terlalu besar (maks. 8 MB).`);
    return;
  }
  const dataUrl = await readFileAsDataURL(file);
  const base64 = (dataUrl.split(",")[1] || "");
  state.attachments.push({
    id: "att-" + Date.now() + "-" + Math.random().toString(16).slice(2),
    name: file.name,
    mime_type: file.type || "application/octet-stream",
    size: file.size,
    data: base64,
    previewUrl: dataUrl,
  });
  renderAttachmentTray();
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function renderAttachmentTray() {
  els.tray.innerHTML = "";
  for (const att of state.attachments) {
    const chip = document.createElement("div");
    chip.className = "chip";
    if ((att.mime_type || "").startsWith("image/")) {
      const img = document.createElement("img");
      img.src = att.previewUrl;
      img.alt = "";
      chip.appendChild(img);
    }
    const name = document.createElement("span");
    name.className = "chip-name";
    name.textContent = att.name;
    name.title = att.name;
    chip.appendChild(name);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "chip-remove";
    remove.setAttribute("aria-label", `Hapus ${att.name}`);
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    remove.addEventListener("click", () => {
      chip.style.opacity = "0";
      chip.style.transform = "scale(0.96)";
      setTimeout(() => {
        state.attachments = state.attachments.filter((a) => a.id !== att.id);
        renderAttachmentTray();
      }, 120);
    });
    chip.appendChild(remove);
    els.tray.appendChild(chip);
  }
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    const target = els.messages || els.workspace;
    if (target) target.scrollTop = target.scrollHeight;
  });
}

function appendMessage(role, text, attachments = [], opts = {}) {
  const empty = els.messages.querySelector(".empty-state");
  if (empty) empty.remove();
  const row = document.createElement("div");
  row.className = `chat-row ${role}`;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = role === "user" ? "Anda" : "Gweldig";
  row.appendChild(meta);

  if (role === "user") {
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text || (attachments.length ? "(Lampiran)" : "");
    row.appendChild(bubble);
  } else {
    const box = document.createElement("div");
    box.className = "ai-response";
    const html = (window.marked && window.marked.parse) ? window.marked.parse(text || "") : escapeHtml(text || "");
    box.innerHTML = html;
    row.appendChild(box);
  }

  if (attachments && attachments.length) {
    const wrap = document.createElement("div");
    wrap.className = "msg-attachments";
    for (const att of attachments) {
      if ((att.mime_type || "").startsWith("image/") && (att.previewUrl || att.data)) {
        const img = document.createElement("img");
        img.className = "msg-image";
        img.src = att.previewUrl || `data:${att.mime_type};base64,${att.data}`;
        img.alt = att.name || "Lampiran gambar";
        wrap.appendChild(img);
      } else {
        const file = document.createElement("div");
        file.className = "msg-file";
        file.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v11a2 2 0 01-2 2H7a2 2 0 01-2-2V5a2 2 0 012-2z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
        const span = document.createElement("span");
        span.textContent = att.name || "Lampiran";
        file.appendChild(span);
        wrap.appendChild(file);
      }
    }
    row.appendChild(wrap);
  }

  els.messages.appendChild(row);
  if (opts.scroll !== false) scrollToBottom();
  return row;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]));
}

function saveMessageLocal(role, content, attachments = []) {
  const proj = state.projects.find((p) => String(p.id) === String(state.activeProjectId));
  if (!proj) return;
  if (!proj.messages) proj.messages = [];
  proj.messages.push({ role, content, attachments });
  saveLocal();
}

async function sendMessage() {
  if (state.sending) return;
  const text = els.input.value.trim();
  const attachments = [...state.attachments];
  if (!text && attachments.length === 0) return;
  if (!state.activeProjectId) await ensureActiveProject();

  const displayAttachments = attachments.map((a) => ({
    name: a.name,
    mime_type: a.mime_type,
    previewUrl: a.previewUrl,
  }));

  appendMessage("user", text, displayAttachments);
  saveMessageLocal("user", text, displayAttachments);

  els.input.value = "";
  autoResizeInput();
  state.attachments = [];
  renderAttachmentTray();

  state.sending = true;
  els.send.disabled = true;
  els.input.disabled = true;
  els.file.disabled = true;

  const loadingRow = document.createElement("div");
  loadingRow.className = "chat-row assistant";
  loadingRow.innerHTML = `<div class="meta">Gweldig</div><div class="ai-response loading"><span>Sedang memproses</span><span class="loading-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>`;
  els.messages.appendChild(loadingRow);
  scrollToBottom();

  try {
    const res = await fetch(`${API_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        project_id: String(state.activeProjectId),
        attachments: attachments.map((a) => ({ name: a.name, mime_type: a.mime_type, data: a.data })),
        model: state.settings.model,
        temperature: state.settings.temperature,
        max_output_tokens: state.settings.max_output_tokens,
        top_p: state.settings.top_p,
      }),
    });
    const data = await res.json().catch(() => ({}));
    loadingRow.remove();
    if (res.ok && data.reply) {
      appendMessage("assistant", data.reply);
      saveMessageLocal("assistant", data.reply);
    } else {
      const detail = data.detail || "Gagal memproses pesan.";
      appendMessage("assistant", `Tidak dapat memproses permintaan: ${detail}`);
    }
  } catch {
    loadingRow.remove();
    if (!API_URL) {
      appendMessage("assistant", "Server belum dikonfigurasi untuk perangkat ini. Atur URL backend dengan membuka halaman ini memakai parameter `?api=https://alamat-backend-anda`, lalu coba lagi.");
    } else {
      appendMessage("assistant", `Tidak dapat terhubung ke server (${API_URL}). Pastikan backend aktif dan dapat diakses dari perangkat ini.`);
    }
  } finally {
    state.sending = false;
    els.send.disabled = false;
    els.input.disabled = false;
    els.file.disabled = false;
    els.input.focus();
  }
}

async function clearHistory() {
  if (!state.activeProjectId) return;
  if (!window.confirm("Hapus percakapan ini beserta riwayat pesannya?")) return;
  const id = state.activeProjectId;
  try { await fetch(`${API_URL}/projects/${id}`, { method: "DELETE" }); } catch {}
  state.projects = state.projects.filter((p) => String(p.id) !== String(id));
  state.activeProjectId = null;
  saveLocal();
  renderProjects(filterProjects(els.search.value));
  await ensureActiveProject();
}

async function loadTasks() {
  els.taskList.innerHTML = "";
  try {
    const res = await fetch(`${API_URL}/tasks`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    const tasks = data.tasks || [];
    if (!tasks.length) {
      const li = document.createElement("li");
      li.className = "history-empty";
      li.textContent = "Belum ada tugas.";
      els.taskList.appendChild(li);
      return;
    }
    for (const t of tasks) {
      const li = document.createElement("li");
      li.className = "task-item" + (t.is_completed ? " completed" : "");
      const main = document.createElement("div");
      main.className = "task-main";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!t.is_completed;
      cb.addEventListener("change", () => toggleTask(t.id, cb.checked));
      const span = document.createElement("span");
      span.textContent = t.task || "";
      main.appendChild(cb);
      main.appendChild(span);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "task-del";
      del.setAttribute("aria-label", "Hapus tugas");
      del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
      del.addEventListener("click", () => deleteTask(t.id));
      li.appendChild(main);
      li.appendChild(del);
      els.taskList.appendChild(li);
    }
  } catch {
    const li = document.createElement("li");
    li.className = "history-empty";
    li.textContent = "Tugas tidak tersedia.";
    els.taskList.appendChild(li);
  }
}

async function addTask() {
  const task = els.taskInput.value.trim();
  if (!task) return;
  try {
    const res = await fetch(`${API_URL}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task }),
    });
    if (res.ok) {
      els.taskInput.value = "";
      loadTasks();
    }
  } catch {}
}

async function toggleTask(id, done) {
  try {
    await fetch(`${API_URL}/tasks/${id}?is_completed=${done}`, { method: "PATCH" });
    loadTasks();
  } catch {}
}

async function deleteTask(id) {
  try {
    await fetch(`${API_URL}/tasks/${id}`, { method: "DELETE" });
    loadTasks();
  } catch {}
}
