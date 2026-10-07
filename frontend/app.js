"use strict";
const $ = (id) => document.getElementById(id);
const LANG_LABELS = { de: "Deutsch", fr: "Français", rw: "Kinyarwanda" };
const SPEECH_TAGS = { de: "de-DE", fr: "fr-FR" }; // Kinyarwanda bleibt Text
const store = {
  get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ohne Speicher: Anmeldung pro Start */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ignorieren */ } },
};
let password = store.get("pw");

function setStatus(msg) { $("status").textContent = msg || ""; }

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "X-App-Password": password },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { store.del("pw"); showLogin(); throw new Error("Bitte anmelden"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || "Fehler " + res.status);
  return data;
}

function fill(select, values, label = (v) => v) {
  select.replaceChildren(...values.map((v) => {
    const o = document.createElement("option");
    o.value = v; o.textContent = label(v);
    return o;
  }));
}

function showLogin() {
  $("login").hidden = false; $("translate").hidden = true; $("currency").hidden = true; $("tabbar").hidden = true;
}

function showTab(name) {
  $("login").hidden = true;
  $("tabbar").hidden = false;
  $("translate").hidden = name !== "translate";
  $("currency").hidden = name !== "currency";
  $("tab-translate").classList.toggle("active", name === "translate");
  $("tab-currency").classList.toggle("active", name === "currency");
  setStatus("");
}

async function init() {
  setStatus("");
  try {
    const info = await api("/api/providers");
    fill($("source"), info.languages, (l) => LANG_LABELS[l]);
    fill($("target"), info.languages, (l) => LANG_LABELS[l]);
    $("source").value = "de"; $("target").value = "rw";
    fill($("provider"), info.providers);
    if (info.default) $("provider").value = info.default;
    $("provider").hidden = info.providers.length < 2;
    showTab("translate");
    updateControls();
  } catch (e) { setStatus(e.message); }
}

$("login-btn").onclick = () => {
  password = $("password").value;
  store.set("pw", password);
  init();
};
$("password").onkeydown = (e) => { if (e.key === "Enter") $("login-btn").click(); };
$("tab-translate").onclick = () => showTab("translate");
$("tab-currency").onclick = () => showTab("currency");

async function translate() {
  if (!$("input").value.trim()) return;
  $("go").disabled = true;
  setStatus("Übersetze …");
  try {
    const r = await api("/api/translate", {
      text: $("input").value, source: $("source").value,
      target: $("target").value, provider: $("provider").value || null,
    });
    $("output").value = r.translation;
    addHistory({ source: $("source").value, target: $("target").value, input: $("input").value, output: r.translation });
    updateControls();
    setStatus("");
  } catch (e) { setStatus(e.message); }
  $("go").disabled = false;
}
$("go").onclick = translate;
$("input").onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) translate(); };

$("copy").onclick = () => navigator.clipboard.writeText($("output").value)
  .then(() => setStatus(""))
  .catch(() => setStatus("Kopieren nicht möglich"));

$("clear").onclick = () => {
  $("input").value = ""; $("output").value = "";
  updateControls();
  $("input").focus();
};

// --- Sprachausgabe (nur de/fr) ---
const synth = "speechSynthesis" in window ? window.speechSynthesis : null;

function voicesFor(code) {
  if (!synth) return [];
  return synth.getVoices().filter((v) => v.lang.replace("_", "-").toLowerCase().startsWith(code));
}

function updateControls() {
  const src = $("source").value, tgt = $("target").value;
  $("count").textContent = `${$("input").value.length} / 2000`;
  $("speak-in").disabled = !synth || !SPEECH_TAGS[src] || !$("input").value.trim();
  $("speak").disabled = !synth || !SPEECH_TAGS[tgt] || !$("output").value.trim();
  $("go").disabled = !$("input").value.trim();
  const voices = SPEECH_TAGS[tgt] ? voicesFor(tgt) : [];
  $("voice").hidden = voices.length < 2;
  if (voices.length >= 2) {
    fill($("voice"), voices.map((v) => v.name));
    const saved = store.get("voice:" + tgt);
    if (voices.some((v) => v.name === saved)) $("voice").value = saved;
  }
}

function speak(text, code, voiceName) {
  if (!synth) { setStatus("Sprachausgabe wird hier nicht unterstützt."); return; }
  setStatus("");
  if (synth.speaking || synth.pending) synth.cancel();
  synth.resume(); // iOS bleibt nach längerer Pause manchmal hängen
  const u = new SpeechSynthesisUtterance(text);
  u.lang = SPEECH_TAGS[code];
  const voices = voicesFor(code);
  const voice = voices.find((v) => v.name === voiceName) || voices.find((v) => v.default) || voices[0];
  if (voice) u.voice = voice;
  else if (synth.getVoices().length) {
    setStatus("Keine Stimme für diese Sprache. iPhone: Einstellungen → Bedienungshilfen → Gesprochene Inhalte → Stimmen.");
  }
  u.onerror = (e) => { if (e.error !== "canceled" && e.error !== "interrupted") setStatus("Sprachausgabe fehlgeschlagen (" + e.error + "). Stummschalter und Lautstärke prüfen."); };
  synth.speak(u);
}

$("speak").onclick = () => speak($("output").value, $("target").value, $("voice").value);
$("speak-in").onclick = () => speak($("input").value, $("source").value, "");
$("voice").onchange = () => store.set("voice:" + $("target").value, $("voice").value);
$("input").oninput = updateControls;
$("source").onchange = $("target").onchange = updateControls;
if (synth) synth.onvoiceschanged = updateControls;

// --- Tauschen ---
$("swap").onclick = () => {
  const s = $("source").value;
  $("source").value = $("target").value;
  $("target").value = s;
  const text = $("input").value;
  $("input").value = $("output").value;
  $("output").value = text;
  updateControls();
};

// --- Verlauf (nur lokal im Gerät) ---
const HISTORY_MAX = 20;

function loadHistory() {
  try { return JSON.parse(store.get("history") || "[]"); } catch { return []; }
}

function addHistory(entry) {
  const list = [entry, ...loadHistory().filter((h) => !(h.input === entry.input && h.source === entry.source && h.target === entry.target))];
  store.set("history", JSON.stringify(list.slice(0, HISTORY_MAX)));
  renderHistory();
}

function renderHistory() {
  const items = loadHistory().map((h) => {
    const li = document.createElement("li");
    const head = document.createElement("small");
    head.textContent = `${LANG_LABELS[h.source]} → ${LANG_LABELS[h.target]}`;
    const body = document.createElement("span");
    body.textContent = `${h.input} → ${h.output}`;
    li.append(head, body);
    li.onclick = () => {
      $("source").value = h.source; $("target").value = h.target;
      $("input").value = h.input; $("output").value = h.output;
      updateControls();
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
    return li;
  });
  $("history").replaceChildren(...items);
  $("history-box").hidden = items.length === 0;
}

$("history-clear").onclick = () => { store.del("history"); renderHistory(); };

// --- Währungsumrechner ---
$("cur-swap").onclick = () => {
  const f = $("cur-from").value;
  $("cur-from").value = $("cur-to").value;
  $("cur-to").value = f;
};

$("cur-go").onclick = async () => {
  setStatus("");
  try {
    const r = await api("/api/convert", {
      amount: parseFloat($("amount").value), source: $("cur-from").value, target: $("cur-to").value,
    });
    const fmt = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });
    $("cur-result").textContent = `${fmt.format(r.amount)} ${r.from} = ${fmt.format(r.result)} ${r.to}`;
  } catch (e) { setStatus(e.message); }
};

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

renderHistory();
updateControls();

fetch("/health").then((r) => r.json()).then((h) => { $("version").textContent = "Version " + h.version; }).catch(() => {});

init();
