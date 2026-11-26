const $ = (s) => document.querySelector(s);

const els = {
  mic: $("#micBtn"), timer: $("#timer"), recState: $("#recState"), wave: $("#wave"),
  transcript: $("#transcript"), placeholder: $("#placeholder"),
  finalText: $("#finalText"), interimText: $("#interimText"), liveMeta: $("#liveMeta"),
  language: $("#language"), engine: $("#engine"), status: $("#engineStatus"),
  save: $("#saveBtn"), copy: $("#copyBtn"), clear: $("#clearBtn"), listen: $("#listenBtn"),
  list: $("#list"), empty: $("#empty"), search: $("#search"), loadMore: $("#loadMore"),
  statTotal: $("#statTotal"), statWords: $("#statWords"), statMinutes: $("#statMinutes"),
  editDialog: $("#editDialog"), editForm: $("#editForm"), editTitle: $("#editTitleInput"),
  editText: $("#editTextInput"), editError: $("#editError"),
  deleteDialog: $("#deleteDialog"), deleteName: $("#deleteName"),
  toasts: $("#toasts"), theme: $("#themeToggle"),
};

const MAX_SESSION_MS = 9.5 * 60 * 1000; // Gemini Live sessions cap at 10 minutes
const PAGE_SIZE = 20;

const state = {
  recording: false, connecting: false, startedAt: 0, elapsedMs: 0, timerId: null,
  ws: null, audioCtx: null, stream: null, worklet: null, analyser: null, rafId: null,
  recognition: null, geminiReady: false,
  items: [], total: 0, query: "", editingId: null, deletingId: null,
};

/* ---------------- Utilities ---------------- */

function toast(msg, type = "") {
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = msg;
  els.toasts.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!res.ok) {
    let detail = res.statusText;
    try { const j = await res.json(); detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch {}
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

const fmtTime = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const wordCount = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);
const fullText = () => (els.finalText.textContent + " " + els.interimText.textContent).replace(/\s+/g, " ").trim();
const langLabel = (code) => ({ auto: "Auto", "hi-IN,en-IN": "Hindi + English", "en-IN": "English", "hi-IN": "Hindi", "ta-IN": "Tamil" }[code] || code);
const relTime = (iso) => {
  const d = new Date(iso), diff = (Date.now() - d) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

/* ---------------- Theme ---------------- */

els.theme.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch {}
});

/* ---------------- Transcript UI ---------------- */

function appendFinal(text) {
  const cur = els.finalText.textContent;
  const sep = cur && !/\s$/.test(cur) && !/^\s/.test(text) ? " " : "";
  els.finalText.textContent = cur + sep + text;
  els.interimText.textContent = "";
  refreshTranscriptUI();
}

function setInterim(text) {
  els.interimText.textContent = (els.finalText.textContent ? " " : "") + text;
  refreshTranscriptUI();
}

function refreshTranscriptUI() {
  const text = fullText();
  const has = text.length > 0;
  els.placeholder.hidden = has;
  els.transcript.classList.toggle("has-text", has);
  els.liveMeta.textContent = `${wordCount(text)} words`;
  els.copy.disabled = els.clear.disabled = els.listen.disabled = !has;
  els.save.disabled = !has || state.recording || state.connecting;
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function clearTranscript() {
  els.finalText.textContent = "";
  els.interimText.textContent = "";
  state.elapsedMs = 0;
  els.timer.textContent = "00:00";
  refreshTranscriptUI();
}

function setRecState(text, live = false) {
  els.recState.textContent = text;
  els.recState.classList.toggle("live", live);
}

/* ---------------- Waveform ---------------- */

function drawWave() {
  const c = els.wave, ctx = c.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const color = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  const muted = getComputedStyle(document.documentElement).getPropertyValue("--border").trim();
  const bars = Math.max(16, Math.floor(w / 6));
  let data = null;
  if (state.analyser) {
    data = new Uint8Array(state.analyser.frequencyBinCount);
    state.analyser.getByteFrequencyData(data);
  }
  for (let i = 0; i < bars; i++) {
    let v = 0.06;
    if (data) {
      const idx = Math.floor((i / bars) * data.length * 0.6);
      v = Math.max(0.06, data[idx] / 255);
    }
    const bh = Math.max(3, v * h);
    ctx.fillStyle = data ? color : muted;
    ctx.globalAlpha = data ? 0.35 + v * 0.65 : 1;
    const x = i * 6;
    roundRect(ctx, x, (h - bh) / 2, 3, bh, 1.5);
  }
  ctx.globalAlpha = 1;
  if (state.recording) state.rafId = requestAnimationFrame(drawWave);
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.fill();
}
window.addEventListener("resize", () => !state.recording && drawWave());

/* ---------------- Recording ---------------- */

function startTimer() {
  state.startedAt = Date.now() - state.elapsedMs;
  state.timerId = setInterval(() => {
    state.elapsedMs = Date.now() - state.startedAt;
    els.timer.textContent = fmtTime(state.elapsedMs);
    if (state.elapsedMs >= MAX_SESSION_MS) { toast("Session limit reached — stopping."); stopRecording(); }
  }, 250);
}

async function startAudioGraph(withWorklet) {
  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  state.audioCtx = new AudioContext();
  const src = state.audioCtx.createMediaStreamSource(state.stream);
  state.analyser = state.audioCtx.createAnalyser();
  state.analyser.fftSize = 256;
  src.connect(state.analyser);
  if (withWorklet) {
    await state.audioCtx.audioWorklet.addModule("/static/pcm-worklet.js");
    state.worklet = new AudioWorkletNode(state.audioCtx, "pcm-worklet");
    src.connect(state.worklet);
  }
}

function stopAudioGraph() {
  state.worklet?.port.close();
  state.worklet?.disconnect();
  state.stream?.getTracks().forEach((t) => t.stop());
  state.audioCtx?.close();
  Object.assign(state, { worklet: null, stream: null, audioCtx: null, analyser: null });
}

async function startGemini() {
  await startAudioGraph(true);
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/transcribe?language=${encodeURIComponent(els.language.value)}`);
  ws.binaryType = "arraybuffer";
  state.ws = ws;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out connecting to transcription service")), 15000);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "ready") { clearTimeout(timeout); resolve(); }
      else if (msg.type === "error") { clearTimeout(timeout); reject(new Error(msg.message)); }
    };
    ws.onerror = () => { clearTimeout(timeout); reject(new Error("Could not connect to the server")); };
    ws.onclose = () => { clearTimeout(timeout); reject(new Error("Connection closed")); };
  });

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "interim") setInterim(msg.text);
    else if (msg.type === "final") appendFinal(msg.text);
    else if (msg.type === "error") { toast(msg.message, "error"); stopRecording(); }
  };
  ws.onclose = () => { if (state.recording) { toast("Connection lost", "error"); stopRecording(); } };

  state.worklet.port.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer && ws.readyState === WebSocket.OPEN) ws.send(ev.data);
  };
}

function startBrowser() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) throw new Error("This browser doesn't support speech recognition. Use Chrome or Edge.");
  const rec = new SR();
  const lang = els.language.value;
  rec.lang = lang === "auto" || lang.includes(",") ? "hi-IN" : lang; // hi-IN handles Hinglish well
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) appendFinal(r[0].transcript.trim());
      else interim += r[0].transcript;
    }
    if (interim) setInterim(interim.trim());
  };
  rec.onerror = (e) => { if (e.error !== "no-speech" && e.error !== "aborted") toast(`Speech error: ${e.error}`, "error"); };
  rec.onend = () => { if (state.recording) { try { rec.start(); } catch {} } };
  rec.start();
  state.recognition = rec;
  return startAudioGraph(false); // waveform only
}

async function startRecording() {
  if (state.recording || state.connecting) return;
  state.connecting = true;
  els.mic.classList.add("connecting");
  els.language.disabled = els.engine.disabled = true;
  setRecState("Connecting…");
  refreshTranscriptUI();
  try {
    if (els.engine.value === "gemini-live") await startGemini();
    else await startBrowser();
    state.recording = true;
    els.mic.classList.add("recording");
    els.mic.setAttribute("aria-pressed", "true");
    els.mic.setAttribute("aria-label", "Stop recording");
    setRecState("Listening — speak now", true);
    startTimer();
    drawWave();
  } catch (err) {
    toast(err.message || "Could not start recording", "error");
    cleanupRecording();
    setRecState("Tap the mic to start");
  } finally {
    state.connecting = false;
    els.mic.classList.remove("connecting");
    refreshTranscriptUI();
  }
}

function cleanupRecording() {
  clearInterval(state.timerId);
  cancelAnimationFrame(state.rafId);
  stopAudioGraph();
  if (state.recognition) { state.recognition.onend = null; state.recognition.stop(); state.recognition = null; }
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  state.recording = false;
  els.mic.classList.remove("recording");
  els.mic.setAttribute("aria-pressed", "false");
  els.mic.setAttribute("aria-label", "Start recording");
  els.language.disabled = els.engine.disabled = false;
  drawWave();
}

async function stopRecording() {
  if (!state.recording) return;
  const ws = state.ws;
  state.recording = false;
  clearInterval(state.timerId);
  stopAudioGraph();
  setRecState("Finishing…");
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop" }));
    await new Promise((r) => setTimeout(r, 1200)); // let the last final transcript arrive
  }
  // Promote any leftover interim text so nothing is lost.
  const leftover = els.interimText.textContent.trim();
  if (leftover) appendFinal(leftover);
  cleanupRecording();
  setRecState(fullText() ? "Done — review and save" : "Tap the mic to start");
  refreshTranscriptUI();
}

els.mic.addEventListener("click", () => (state.recording ? stopRecording() : startRecording()));
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && e.target === document.body) { e.preventDefault(); els.mic.click(); }
});

/* ---------------- Studio actions ---------------- */

els.clear.addEventListener("click", clearTranscript);
els.copy.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(fullText()); toast("Copied to clipboard"); }
  catch { toast("Copy failed", "error"); }
});
els.listen.addEventListener("click", () => speak(fullText()));

els.save.addEventListener("click", async () => {
  const text = fullText();
  if (!text) return;
  els.save.disabled = true;
  try {
    await api("/api/transcriptions", {
      method: "POST",
      body: JSON.stringify({
        text, language: els.language.value, engine: els.engine.value,
        duration_seconds: Math.round(state.elapsedMs / 100) / 10,
      }),
    });
    toast("Saved to history");
    clearTranscript();
    setRecState("Tap the mic to start");
    await Promise.all([loadList(), loadStats()]);
  } catch (err) {
    toast(`Save failed: ${err.message}`, "error");
  } finally {
    refreshTranscriptUI();
  }
});

/* ---------------- Text to speech ---------------- */

function speak(text) {
  if (!("speechSynthesis" in window)) return toast("Text-to-speech not supported in this browser", "error");
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const lang = /[ऀ-ॿ]/.test(text) ? "hi-IN" : "en-IN";
  u.lang = lang;
  const voice = speechSynthesis.getVoices().find((v) => v.lang.replace("_", "-").startsWith(lang.slice(0, 2)));
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}

/* ---------------- History (CRUD) ---------------- */

function renderList() {
  els.list.replaceChildren();
  for (const item of state.items) els.list.appendChild(renderItem(item));
  els.empty.hidden = state.items.length > 0;
  if (!state.items.length && state.query) {
    els.empty.querySelector(".empty-title").textContent = "No matches";
    els.empty.querySelector(".sub").textContent = `Nothing found for “${state.query}”.`;
  } else {
    els.empty.querySelector(".empty-title").textContent = "No transcriptions yet";
    els.empty.querySelector(".sub").innerHTML = "Record something and hit <strong>Save</strong> — it’ll show up here.";
  }
  els.loadMore.hidden = state.items.length >= state.total;
}

function iconBtn(icon, label, cls, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.setAttribute("aria-label", label);
  b.title = label;
  b.innerHTML = `<svg class="ic"><use href="#i-${icon}"/></svg>`;
  b.addEventListener("click", onClick);
  return b;
}

function chip(text, cls = "") {
  const c = document.createElement("span");
  c.className = `chip ${cls}`;
  c.textContent = text;
  return c;
}

function renderItem(item) {
  const li = document.createElement("li");
  li.className = "item";

  const top = document.createElement("div");
  top.className = "item-top";
  const title = document.createElement("p");
  title.className = "item-title";
  title.textContent = item.title;
  const actions = document.createElement("div");
  actions.className = "item-actions";
  actions.append(
    iconBtn("volume", "Listen", "", () => speak(item.text)),
    iconBtn("copy", "Copy", "", async () => { await navigator.clipboard.writeText(item.text); toast("Copied"); }),
    iconBtn("edit", "Edit", "", () => openEdit(item)),
    iconBtn("trash", "Delete", "del", () => openDelete(item)),
  );
  top.append(title, actions);

  const text = document.createElement("p");
  text.className = "item-text";
  text.textContent = item.text;

  const meta = document.createElement("div");
  meta.className = "item-meta";
  meta.append(
    chip(langLabel(item.language), "accent"),
    chip(`${item.word_count} words`),
    chip(fmtTime(item.duration_seconds * 1000)),
    chip(relTime(item.created_at)),
  );
  meta.lastChild.title = new Date(item.created_at).toLocaleString();

  li.append(top, text, meta);
  return li;
}

async function loadList(append = false) {
  if (!append) {
    els.list.innerHTML = '<li class="skeleton"></li><li class="skeleton"></li>';
    els.empty.hidden = true;
  }
  try {
    const offset = append ? state.items.length : 0;
    const data = await api(`/api/transcriptions?limit=${PAGE_SIZE}&offset=${offset}&q=${encodeURIComponent(state.query)}`);
    state.items = append ? state.items.concat(data.items) : data.items;
    state.total = data.total;
    renderList();
  } catch (err) {
    els.list.replaceChildren();
    toast(`Couldn't load history: ${err.message}`, "error");
  }
}

async function loadStats() {
  try {
    const s = await api("/api/transcriptions/stats");
    els.statTotal.textContent = s.total.toLocaleString();
    els.statWords.textContent = s.total_words.toLocaleString();
    els.statMinutes.textContent = s.total_minutes.toLocaleString();
  } catch {}
}

let searchTimer;
els.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = els.search.value.trim(); loadList(); }, 250);
});
els.loadMore.addEventListener("click", () => loadList(true));

// Edit
function openEdit(item) {
  state.editingId = item.id;
  els.editTitle.value = item.title;
  els.editText.value = item.text;
  els.editError.textContent = "";
  els.editDialog.showModal();
  els.editTitle.focus();
}
els.editForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = els.editTitle.value.trim(), text = els.editText.value.trim();
  if (!title || !text) { els.editError.textContent = "Title and text are both required."; return; }
  try {
    const updated = await api(`/api/transcriptions/${state.editingId}`, { method: "PUT", body: JSON.stringify({ title, text }) });
    state.items = state.items.map((i) => (i.id === updated.id ? updated : i));
    renderList();
    loadStats();
    els.editDialog.close();
    toast("Changes saved");
  } catch (err) {
    els.editError.textContent = err.message;
  }
});

// Delete
function openDelete(item) {
  state.deletingId = item.id;
  els.deleteName.textContent = `“${item.title}” will be permanently removed.`;
  els.deleteDialog.showModal();
}
els.deleteDialog.addEventListener("close", async () => {
  if (els.deleteDialog.returnValue !== "delete") return;
  els.deleteDialog.returnValue = "";
  try {
    await api(`/api/transcriptions/${state.deletingId}`, { method: "DELETE" });
    state.items = state.items.filter((i) => i.id !== state.deletingId);
    state.total -= 1;
    renderList();
    loadStats();
    toast("Deleted");
  } catch (err) {
    toast(`Delete failed: ${err.message}`, "error");
  }
});

document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", () => b.closest("dialog").close())
);

/* ---------------- Boot ---------------- */

async function checkHealth() {
  try {
    const h = await api("/api/health");
    state.geminiReady = h.gemini_configured;
    els.status.classList.toggle("ok", h.gemini_configured);
    els.status.classList.toggle("warn", !h.gemini_configured);
    els.status.querySelector(".label").textContent = h.gemini_configured ? "Gemini Live ready" : "Browser engine";
    els.status.title = h.gemini_configured ? `Model: ${h.model}` : "GEMINI_API_KEY not set — using browser speech recognition";
    if (!h.gemini_configured) {
      els.engine.value = "browser";
      els.engine.querySelector('[value="gemini-live"]').disabled = true;
    }
  } catch {
    els.status.querySelector(".label").textContent = "Server offline";
  }
}

refreshTranscriptUI();
drawWave();
checkHealth();
loadList();
loadStats();
