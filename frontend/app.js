"use strict";
const $ = (id) => document.getElementById(id);
const LANG_LABELS = { de: "Deutsch", fr: "Français", rw: "Kinyarwanda" };
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

function showLogin() { $("login").hidden = false; $("translate").hidden = true; $("currency").hidden = true; }

function showTab(name) {
  $("login").hidden = true;
  $("translate").hidden = name !== "translate";
  $("currency").hidden = name !== "currency";
  $("tab-translate").classList.toggle("active", name === "translate");
  $("tab-currency").classList.toggle("active", name === "currency");
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
    showTab("translate");
    updateSpeakState();
  } catch (e) { setStatus(e.message); }
}

$("login-btn").onclick = () => {
  password = $("password").value;
  store.set("pw", password);
  init();
};
$("tab-translate").onclick = () => showTab("translate");
$("tab-currency").onclick = () => showTab("currency");

$("go").onclick = async () => {
  setStatus("Übersetze …");
  try {
    const r = await api("/api/translate", {
      text: $("input").value, source: $("source").value,
      target: $("target").value, provider: $("provider").value || null,
    });
    $("output").value = r.translation;
    addHistory({ source: $("source").value, target: $("target").value, input: $("input").value, output: r.translation });
    updateSpeakState();
    setStatus("");
  } catch (e) { setStatus(e.message); }
};

$("copy").onclick = () => navigator.clipboard.writeText($("output").value).catch(() => setStatus("Kopieren nicht möglich"));

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

// --- Sprachausgabe (nur de/fr, Kinyarwanda bleibt Text) ---
const SPEECH_LANGS = { de: "de", fr: "fr" };
const synth = "speechSynthesis" in window ? window.speechSynthesis : null;

function voicesFor(lang) {
  return synth ? synth.getVoices().filter((v) => v.lang.toLowerCase().startsWith(lang)) : [];
}

function updateSpeakState() {
  const lang = SPEECH_LANGS[$("target").value];
  const voices = lang ? voicesFor(lang) : [];
  $("speak").disabled = !synth || !lang || !$("output").value;
  $("voice").hidden = voices.length < 2;
  if (voices.length >= 2) {
    const saved = store.get("voice:" + lang);
    fill($("voice"), voices.map((v) => v.name));
    if (voices.some((v) => v.name === saved)) $("voice").value = saved;
  }
}

$("speak").onclick = () => {
  const lang = SPEECH_LANGS[$("target").value];
  if (!synth || !lang) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance($("output").value);
  u.lang = lang;
  const voices = voicesFor(lang);
  u.voice = voices.find((v) => v.name === $("voice").value) || voices[0] || null;
  synth.speak(u);
};

$("voice").onchange = () => store.set("voice:" + SPEECH_LANGS[$("target").value], $("voice").value);
$("target").onchange = updateSpeakState;
if (synth) synth.onvoiceschanged = updateSpeakState;

// --- Tauschen ---
$("swap").onclick = () => {
  const s = $("source").value;
  $("source").value = $("target").value;
  $("target").value = s;
  const text = $("input").value;
  $("input").value = $("output").value;
  $("output").value = text;
  updateSpeakState();
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
      updateSpeakState();
    };
    return li;
  });
  $("history").replaceChildren(...items);
}

$("history-clear").onclick = () => { store.del("history"); renderHistory(); };

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

renderHistory();
updateSpeakState();

init();
