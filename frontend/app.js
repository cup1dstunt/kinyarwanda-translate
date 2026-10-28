"use strict";
const $ = (id) => document.getElementById(id);
const LANG_LABELS = { de: "Deutsch", fr: "Français", en: "English", rw: "Kinyarwanda" };
const SPEECH_TAGS = { de: "de-DE", fr: "fr-FR", en: "en-US" }; // Kinyarwanda bleibt Text
const store = {
  get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ohne Speicher: Anmeldung pro Start */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ignorieren */ } },
};
let password = store.get("pw");
let serverTts = false;
let myName = "", myAdmin = false;

function setStatus(msg) { $("status").textContent = msg ? tMsg(msg) : ""; }

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "X-App-Password": password },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { store.del("pw"); showLogin(); throw new Error("Bitte anmelden"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || t("Fehler {0}", res.status));
  return data;
}

function fill(select, values, label = (v) => v) {
  select.replaceChildren(...values.map((v) => {
    const o = document.createElement("option");
    o.value = v; o.textContent = label(v);
    return o;
  }));
}

const TABS = { translate: "translate", chat: "chat", phrases: "phrases", settings: "settings", currency: "currency" };

function showLogin() {
  stopPolling();
  $("login").hidden = false; $("tabbar").hidden = true;
  for (const v of Object.values(TABS)) $(v).hidden = true;
}

function showTab(name) {
  $("login").hidden = true;
  $("tabbar").hidden = false;
  for (const [tab, view] of Object.entries(TABS)) {
    $(view).hidden = tab !== name;
    $("tab-" + tab).classList.toggle("active", tab === name);
  }
  if (name === "settings") $("rate-count").textContent = loadJson("ratings").length;
  if (name === "phrases") loadPhrases();
  startPolling();
  setStatus("");
}

async function init() {
  setStatus("");
  try {
    const info = await api("/api/providers");
    fill($("source"), info.languages, (l) => LANG_LABELS[l]);
    fill($("target"), info.languages, (l) => LANG_LABELS[l]);
    $("source").value = uiLang; $("target").value = uiLang === "rw" ? "de" : "rw";
    fill($("provider"), info.providers);
    if (info.default) $("provider").value = info.default;
    $("provider").hidden = info.providers.length < 2;
    serverTts = !!info.tts;
    $("admin").hidden = !(info.me && info.me.admin);
    $("ocr-btn").hidden = !info.ocr;
    $("price-btn").hidden = !info.ocr;
    fill($("learn-src"), info.languages, (l) => LANG_LABELS[l]);
    fill($("learn-tgt"), info.languages, (l) => LANG_LABELS[l]);
    $("learn-src").value = uiLang; $("learn-tgt").value = uiLang === "rw" ? "de" : "rw";
    myName = info.me ? info.me.name : "";
    myAdmin = !!(info.me && info.me.admin);
    fill($("room-lang"), info.languages, (l) => LANG_LABELS[l]);
    $("room-lang").value = store.get("room-lang") || uiLang;
    if (store.get("chat-mode") === "room") setMode("room");
    startPolling();
    fill($("conv-a"), info.languages, (l) => LANG_LABELS[l]);
    fill($("conv-b"), info.languages, (l) => LANG_LABELS[l]);
    $("conv-a").value = uiLang; $("conv-b").value = uiLang === "rw" ? "de" : "rw";
    updateWho();
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
$("tab-chat").onclick = () => showTab("chat");
$("tab-settings").onclick = () => showTab("settings");
$("tab-phrases").onclick = () => showTab("phrases");

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

// iOS: Mit offener Tastatur springt die Ansicht, wenn die fixierte Tab-Leiste und
// automatisches Scrollen mitspielen. Tab-Leiste daher während der Eingabe ausblenden.
const isField = (el) => el && /^(TEXTAREA|INPUT|SELECT)$/.test(el.tagName);
const typing = () => isField(document.activeElement);
document.addEventListener("focusin", (e) => { if (isField(e.target)) document.body.classList.add("typing"); });
document.addEventListener("focusout", () => {
  setTimeout(() => { if (!typing()) document.body.classList.remove("typing"); }, 50);
});

// iOS verkleinert die Seite für die Tastatur nicht und schiebt die Ansicht beim Fokussieren oft zu weit.
// Darum die sichtbare Fläche über der Tastatur messen (visualViewport), unten so viel Platz wie die Tastatur
// hoch ist anhängen (--kb) und das aktive Feld selbst in den sichtbaren Bereich schieben.
const vv = window.visualViewport;
function keepFieldVisible() {
  if (!vv) return;
  const kb = Math.max(0, Math.round(document.documentElement.clientHeight - vv.height * vv.scale));
  document.documentElement.style.setProperty("--kb", (kb > 80 ? kb : 0) + "px");
  const el = document.activeElement;
  if (kb <= 80 || !isField(el) || el.tagName === "SELECT") return;
  const r = el.getBoundingClientRect();
  const top = vv.offsetTop + 12, bottom = vv.offsetTop + vv.height - 12;
  // Feld passt: ganz zeigen; Feld zu hoch: Anfang zeigen
  const delta = r.height > bottom - top || r.top < top ? r.top - top : Math.max(0, r.bottom - bottom);
  if (Math.abs(delta) > 4) window.scrollBy(0, delta);
}
let kbTimer = null;
const scheduleKeep = () => { clearTimeout(kbTimer); kbTimer = setTimeout(keepFieldVisible, 150); };
if (vv) vv.addEventListener("resize", scheduleKeep);
document.addEventListener("focusin", scheduleKeep);

// --- Sprachausgabe (nur de/fr) ---
const synth = "speechSynthesis" in window ? window.speechSynthesis : null;

function voicesFor(code) {
  if (!synth) return [];
  return synth.getVoices().filter((v) => v.lang.replace("_", "-").toLowerCase().startsWith(code));
}

function updateControls() {
  const src = $("source").value, tgt = $("target").value;
  $("count").textContent = `${$("input").value.length} / 2000`;
  const canSpeak = serverTts || !!synth;
  $("speak-in").disabled = !canSpeak || !SPEECH_TAGS[src] || !$("input").value.trim();
  $("speak").disabled = !canSpeak || !SPEECH_TAGS[tgt] || !$("output").value.trim();
  $("go").disabled = !$("input").value.trim();
  for (const id of ["fav", "show", "rate-up", "rate-down"]) $(id).disabled = !$("output").value.trim();
  $("rate-box").hidden = true;
  const voices = SPEECH_TAGS[tgt] && !serverTts ? voicesFor(tgt) : [];
  $("voice").hidden = voices.length < 1;
  if (voices.length) {
    fill($("voice"), ["", ...voices.map((v) => v.name)], (n) => n || "Standardstimme");
    const saved = store.get("voice:" + tgt);
    $("voice").value = voices.some((v) => v.name === saved) ? saved : "";
  }
}

// Sprachausgabe über Google (Server): funktioniert auch in der installierten iOS-PWA,
// in der die Browser-Sprachausgabe oft stumm bleibt. Browser-Stimmen nur als Rückfall.
const SILENT_AUDIO = "data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA"; // 50 ms Stille
let audio = null;

async function speakServer(text, code) {
  // Element im Klick freischalten, sonst blockiert iOS das spätere play()
  audio = audio || new Audio();
  audio.src = SILENT_AUDIO;
  audio.play().catch(() => {});
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Password": password },
    body: JSON.stringify({ text, lang: code }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || t("Fehler {0}", res.status));
  }
  const url = URL.createObjectURL(await res.blob());
  audio.src = url;
  audio.onended = () => URL.revokeObjectURL(url);
  await audio.play();
}

async function speakAny(text, code, voiceName) {
  if (serverTts) {
    setStatus("Lade Sprachausgabe …");
    try { await speakServer(text, code); setStatus(""); } catch (e) {
      setStatus(t("Sprachausgabe fehlgeschlagen: {0}", e.message));
    }
    return;
  }
  speak(text, code, voiceName);
}

function speak(text, code, voiceName) {
  if (!synth) { setStatus("Sprachausgabe wird hier nicht unterstützt."); return; }
  setStatus("");
  if (synth.speaking || synth.pending) synth.cancel();
  synth.resume(); // iOS bleibt nach längerer Pause manchmal hängen
  const voice = voicesFor(code).find((v) => v.name === voiceName);

  // Ohne gewählte Stimme nimmt iOS die Standardstimme der Sprache. Erweiterte/Premium-Stimmen
  // bleiben in Safari manchmal stumm; startet nichts, gibt es einen Ersatzversuch ohne Stimme.
  const attempt = (useVoice) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = SPEECH_TAGS[code];
    if (useVoice && voice) u.voice = voice;
    let started = false;
    u.onstart = () => { started = true; setStatus(""); };
    u.onerror = (e) => {
      if (e.error !== "canceled" && e.error !== "interrupted") setStatus(t("Sprachausgabe fehlgeschlagen ({0}).", e.error));
    };
    synth.speak(u);
    setTimeout(() => {
      if (started) return;
      if (useVoice && voice) { synth.cancel(); attempt(false); return; }
      setStatus("Die Sprachausgabe startet nicht. Stummschalter und Lautstärke prüfen, ggf. eine andere Stimme wählen.");
    }, 1500);
  };
  attempt(true);
}

$("speak").onclick = () => speakAny($("output").value, $("target").value, $("voice").value);
$("speak-in").onclick = () => speakAny($("input").value, $("source").value, "");
$("voice").onchange = () => store.set("voice:" + $("target").value, $("voice").value);
$("input").oninput = updateControls;
$("source").onchange = $("target").onchange = updateControls;
if (synth) synth.onvoiceschanged = updateControls;

// --- Texterkennung (Foto eines Schilds → Text → Übersetzung) ---
const OCR_MAX_SIDE = 1600; // reicht für Schilder, hält Upload und Kosten klein

function imageToBase64(file, maxSide = OCR_MAX_SIDE) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.8).split(",")[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Bild konnte nicht gelesen werden")); };
    img.src = url;
  });
}

$("ocr-file").onchange = async () => {
  const file = $("ocr-file").files[0];
  $("ocr-file").value = "";
  if (!file) return;
  setStatus("Erkenne Text …");
  try {
    const r = await api("/api/ocr", { image: await imageToBase64(file) });
    if (!r.text) { setStatus("Kein Text im Bild gefunden."); return; }
    $("input").value = r.text;
    $("output").value = "";
    updateControls();
    await translate();
  } catch (e) { setStatus(e.message); }
};

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

// Betrag mit Tausenderpunkt (1.234.567,50). Ein einzelner Punkt mit 1–2 Stellen danach gilt als Dezimalpunkt.
function parseAmount(str) {
  let v = str.replace(/[\s']/g, "");
  if (v.includes(",")) v = v.replace(/\./g, "").replace(",", ".");
  else if (!/^\d*\.\d{1,2}$/.test(v)) v = v.replace(/\./g, "");
  return parseFloat(v);
}

$("amount").oninput = (e) => {
  const el = e.target;
  const raw = el.value;
  const digitsBefore = raw.slice(0, el.selectionStart).replace(/[^\d,]/g, "").length;
  const [intPart, ...rest] = raw.replace(/[^\d,.]/g, "").replace(/\./g, "").split(",");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const out = rest.length ? grouped + "," + rest.join("").slice(0, 2) : grouped;
  if (out === raw) return;
  el.value = out;
  let pos = 0, seen = 0;
  while (pos < out.length && seen < digitsBefore) { if (/[\d,]/.test(out[pos])) seen++; pos++; }
  el.setSelectionRange(pos, pos);
};

$("cur-go").onclick = async () => {
  setStatus("");
  try {
    const r = await api("/api/convert", {
      amount: parseAmount($("amount").value), source: $("cur-from").value, target: $("cur-to").value,
    });
    const fmt = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });
    $("cur-result").textContent = `${fmt.format(r.amount)} ${r.from} = ${fmt.format(r.result)} ${r.to}`;
  } catch (e) { setStatus(e.message); }
};

// --- Großanzeige („Zeigen“) ---
function zoom(text) {
  $("zoom-text").textContent = text;
  $("zoom").hidden = false;
}
$("zoom").onclick = () => { $("zoom").hidden = true; };
$("show").onclick = () => zoom($("output").value);

// --- Favoriten / Phrasebook (lokal, auch offline nutzbar) ---
const CATEGORIES = ["Alltagssprache", "Arzt", "Behörde", "Einkaufen", "Unterwegs", "Sonstiges"]; // gespeichert deutsch, angezeigt übersetzt

function loadJson(key) {
  try { return JSON.parse(store.get(key) || "[]"); } catch { return []; }
}

function favId(f) { return [f.source, f.target, f.input].join("|"); }

function addFav(cat) {
  const fav = { cat, source: $("source").value, target: $("target").value, input: $("input").value, output: $("output").value };
  const list = loadJson("favs").filter((f) => favId(f) !== favId(fav));
  store.set("favs", JSON.stringify([fav, ...list]));
}

$("fav").onclick = () => {
  const cat = window.prompt(t("Kategorie: {0}", CATEGORIES.map((c) => t(c)).join(", ")), t(store.get("last-cat") || CATEGORIES[0]));
  if (cat === null) return;
  const match = CATEGORIES.find((c) => [c, t(c)].some((n) => n.toLowerCase() === cat.trim().toLowerCase()));
  const chosen = match || cat.trim() || "Sonstiges";
  store.set("last-cat", chosen);
  addFav(chosen);
  setStatus("");
  $("fav").classList.add("on");
  setTimeout(() => $("fav").classList.remove("on"), 1500);
};

function setFavs(list) { store.set("favs", JSON.stringify(list)); }

// Karte für einen eigenen Favoriten (im Phrasen-Tab angezeigt)
function favCard(f) {
  const card = document.createElement("div");
  card.className = "card fav";
  const meta = document.createElement("small");
  meta.textContent = `★ ${t(f.cat)} · ${LANG_LABELS[f.source]} → ${LANG_LABELS[f.target]}`;
  const inp = document.createElement("div");
  inp.textContent = f.input;
  const out = document.createElement("strong");
  out.textContent = f.output;
  const row = document.createElement("div");
  row.className = "fav-actions";
  row.append(
    mkBtn("#i-expand", "Groß anzeigen", () => zoom(f.output)),
    mkBtn("#i-speaker", "Vorlesen", () => speakAny(f.output, f.target, ""), !(serverTts || synth) || !SPEECH_TAGS[f.target]),
    mkBtn("#i-trash", "Löschen", () => {
      setFavs(loadJson("favs").filter((x) => favId(x) !== favId(f)));
      renderPhrases();
    }),
  );
  card.append(meta, inp, out, row);
  return card;
}

// --- Zugänge (nur Admin) ---
async function renderAdmin() {
  if ($("admin").hidden) return;
  try {
    const r = await api("/api/admin/users");
    $("admin-list").replaceChildren(...r.users.map((u) => {
      const li = document.createElement("li");
      const name = document.createElement("strong");
      name.textContent = u.name;
      const code = document.createElement("small");
      code.textContent = u.code;
      const row = document.createElement("div");
      row.className = "fav-actions";
      row.append(
        mkBtn("#i-copy", "Code kopieren", () => navigator.clipboard.writeText(u.code).then(() => setStatus("Code kopiert.")).catch(() => setStatus("Kopieren nicht möglich"))),
        mkBtn("#i-trash", "Zugang sperren", async () => {
          if (!window.confirm(t("Zugang von {0} sperren?", u.name))) return;
          try { await fetch("/api/admin/users/" + u.id, { method: "DELETE", headers: { "X-App-Password": password } }); } catch (e) { setStatus(e.message); }
          renderAdmin();
        }),
      );
      li.append(name, code, row);
      return li;
    }));
  } catch (e) { setStatus(e.message); }
}
$("admin-add").onclick = async () => {
  const name = $("admin-name").value.trim();
  if (!name) return;
  try { await api("/api/admin/users", { name }); $("admin-name").value = ""; renderAdmin(); } catch (e) { setStatus(e.message); }
};
$("admin").addEventListener("toggle", () => { if ($("admin").open) renderAdmin(); });

function mkBtn(icon, label, onclick, disabled = false) {
  const b = document.createElement("button");
  b.className = "icon"; b.title = t(label); b.setAttribute("aria-label", t(label));
  b.innerHTML = `<svg><use href="${icon}"/></svg>`;
  b.onclick = onclick; b.disabled = disabled;
  return b;
}

// --- Bewertung durch Muttersprachler (für den Qualitätstest) ---

function addRating(entry) {
  const list = loadJson("ratings");
  list.push({ time: new Date().toISOString(), ...entry });
  store.set("ratings", JSON.stringify(list));
}

function saveRating(good, correction) {
  addRating({
    provider: $("provider").value || "", source: $("source").value, target: $("target").value,
    input: $("input").value, output: $("output").value, good, correction,
  });
}

$("rate-up").onclick = () => { saveRating(true, ""); $("rate-box").hidden = true; setStatus(""); };
$("rate-down").onclick = () => {
  $("rate-fix").value = "";
  $("rate-box").hidden = false;
  $("rate-fix").focus();
};
$("rate-save").onclick = () => {
  saveRating(false, $("rate-fix").value.trim());
  $("rate-box").hidden = true;
};

function ratingsMarkdown() {
  const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const rows = loadJson("ratings").map((r) =>
    `| ${r.time.slice(0, 10)} | ${r.provider} | ${r.source}→${r.target} | ${esc(r.input)} | ${esc(r.output)} | ${r.good ? "👍" : "👎"} | ${esc(r.correction)} |`);
  return ["| Datum | Anbieter | Richtung | Eingabe | Übersetzung | Urteil | Korrektur |", "|---|---|---|---|---|---|---|", ...rows].join("\n");
}

$("rate-export").onclick = async () => {
  const text = ratingsMarkdown();
  try {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); setStatus("In die Zwischenablage kopiert."); }
  } catch (e) {
    if (e.name !== "AbortError") setStatus(t("Export nicht möglich: {0}", e.message));
  }
};
$("rate-clear").onclick = () => {
  if (window.confirm("Alle Bewertungen löschen?")) { store.del("ratings"); $("rate-count").textContent = "0"; }
};

// --- Phrasenbuch: fertige Sätze, Kinyarwanda ungeprüft bis zur Bestätigung ---
let phrases = null;
const fold = (x) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const reviews = () => { try { return JSON.parse(store.get("phrase-review") || "{}"); } catch { return {}; } };

const FAVS = "__favs", DIALOGS = "Gespräche";
let myPhrases = [];

async function loadPhrases() {
  if (!phrases) {
    try {
      const [base, more] = await Promise.all([fetch("/phrases.json"), fetch("/dictionary.json")]);
      phrases = [...await base.json(), ...await more.json()];
    } catch { setStatus("Phrasenbuch konnte nicht geladen werden."); return; }
    const targets = UI_LANGS.filter((l) => l !== uiLang);
    fill($("ph-lang"), targets, (l) => "→ " + LANG_LABELS[l]);
    $("ph-lang").value = targets.includes("rw") ? "rw" : targets[0];
  }
  try { myPhrases = (await api("/api/my-phrases")).phrases.map((p) => ({ ...p, own: true })); } catch { myPhrases = []; }
  // Kategorien jedes Mal neu, weil eigene Phrasen und Favoriten neue Kategorien mitbringen können
  const cats = [...new Set([...phrases.map((p) => p.c), ...myPhrases.map((p) => p.c), ...loadJson("favs").map((f) => f.cat)])];
  const current = $("ph-cat").value || store.get("ph-cat") || (loadJson("favs").length ? FAVS : DIALOGS);
  fill($("ph-cat"), [FAVS, ...cats], (c) => (c === FAVS ? "★ " + t("Favoriten") : t(c)));
  $("ph-cat").value = [FAVS, ...cats].includes(current) ? current : DIALOGS;
  fill($("ph-add-cat"), [...new Set([...cats.filter((c) => c !== DIALOGS), "Eigene"])], (c) => t(c));
  renderPhrases();
}

// Ein fertiger Satz als Karte oder (im Gespräch) als Sprechblase
function phraseCard(p, lang, className, showCat) {
  const key = p.de + "|" + lang;
  const r = reviews()[key];
  const text = r && r.text ? r.text : p[lang];
  const verified = lang === "rw" && (p.v || r);
  const card = document.createElement("div");
  card.className = className;
  const meta = document.createElement("small");
  meta.textContent = [showCat ? t(p.c) : "", lang === "rw" && !p.own ? t(verified ? "✓ geprüft" : "ungeprüft") : ""].filter(Boolean).join(" · ");
  const src = document.createElement("div");
  src.textContent = p[uiLang];
  const out = document.createElement("strong");
  out.textContent = text;
  const row = document.createElement("div");
  row.className = "fav-actions";
  const review = (good, correction) => {
    addRating({ provider: "phrasebook", source: uiLang, target: lang, input: p[uiLang], output: p[lang], good, correction });
    const all = reviews();
    all[key] = { text: correction || p[lang] };
    store.set("phrase-review", JSON.stringify(all));
    renderPhrases();
  };
  const fav = { cat: p.c, source: uiLang, target: lang, input: p[uiLang], output: text };
  const isFav = loadJson("favs").some((f) => favId(f) === favId(fav));
  const star = mkBtn("#i-star", isFav ? "Aus Favoriten entfernen" : "Als Favorit speichern", () => {
    const rest = loadJson("favs").filter((f) => favId(f) !== favId(fav));
    setFavs(isFav ? rest : [fav, ...rest]);
    renderPhrases();
  });
  star.classList.toggle("on", isFav);
  row.append(
    mkBtn("#i-expand", "Groß anzeigen", () => zoom(text)),
    mkBtn("#i-speaker", "Vorlesen", () => speakAny(text, lang, ""), !(serverTts || synth) || !SPEECH_TAGS[lang]),
    star,
  );
  if (p.own) {
    row.append(mkBtn("#i-trash", "Phrase löschen", async () => {
      if (!window.confirm(t("Phrase „{0}“ löschen?", p[uiLang]))) return;
      try {
        const res = await fetch("/api/my-phrases/" + p.id, { method: "DELETE", headers: { "X-App-Password": password } });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || t("Fehler {0}", res.status));
      } catch (e) { setStatus(e.message); }
      loadPhrases();
    }));
  } else if (lang === "rw" && !verified) {
    // Bewertung nur für noch ungeprüfte Sätze, klein hinter einem Knopf
    const pair = document.createElement("span");
    pair.hidden = true;
    const up = document.createElement("button");
    up.className = "icon"; up.textContent = "👍"; up.title = t("Stimmt");
    up.onclick = () => review(true, "");
    const down = document.createElement("button");
    down.className = "icon"; down.textContent = "👎"; down.title = t("Korrigieren");
    down.onclick = () => {
      const fix = window.prompt(t("Richtige Übersetzung:"), text);
      if (fix !== null && fix.trim()) review(false, fix.trim());
    };
    pair.append(up, down);
    const more = document.createElement("button");
    more.className = "icon"; more.textContent = "⋯"; more.title = t("Prüfen"); more.setAttribute("aria-label", t("Prüfen"));
    more.onclick = () => { pair.hidden = !pair.hidden; };
    row.append(more, pair);
  }
  card.append(...(meta.textContent ? [meta] : []), src, out, row);
  return card;
}

// Kurzes Gespräch: Zeilen mit gleichem Titel ("d"), abwechselnd links (a) und rechts (b)
function dialogCard(title, lines, lang) {
  const box = document.createElement("div");
  box.className = "dialog";
  const head = document.createElement("h3");
  head.textContent = t(title);
  const log = document.createElement("div");
  log.className = "chat-log";
  log.append(...lines.map((p) => phraseCard(p, lang, "bubble fav " + (p.s === "b" ? "b" : "a"))));
  box.append(head, log);
  return box;
}

function renderPhrases() {
  if (!phrases) return;
  const cat = $("ph-cat").value, lang = $("ph-lang").value, favs = loadJson("favs");
  const q = fold($("ph-search").value);
  store.set("ph-cat", cat);
  $("ph-cat").hidden = !!q;
  $("ph-lang").hidden = cat === FAVS && !q;
  $("ph-hint").hidden = cat === FAVS && !q;
  $("fav-empty").hidden = !(cat === FAVS && !q && !favs.length);
  $("ph-hint").textContent = t("Fertige Sätze, {0} → Zielsprache. Kinyarwanda ist ungeprüft, bis es mit 👍 bestätigt oder mit 👎 korrigiert wurde.", LANG_LABELS[uiLang]);
  const all = [...phrases, ...myPhrases];
  if (q) {
    // Suche: alle Kategorien und alle Sprachen, höchstens 80 Treffer
    const hits = all.filter((p) => UI_LANGS.some((l) => fold(p[l]).includes(q))).slice(0, 80);
    $("ph-list").replaceChildren(...hits.map((p) => phraseCard(p, lang, "card fav", true)));
    return;
  }
  if (cat === FAVS) { $("ph-list").replaceChildren(...favs.map(favCard)); return; }
  const list = all.filter((p) => p.c === cat);
  // eigene Favoriten dieser Kategorie oben, außer sie stammen selbst aus dem Phrasenbuch (die haben dort den Stern)
  const own = favs.filter((f) => f.cat === cat && !list.some((p) => p[f.source] === f.input));
  let cards;
  if (cat === DIALOGS) {
    const groups = new Map();
    for (const p of list) groups.set(p.d, [...(groups.get(p.d) || []), p]);
    cards = [...groups].map(([title, lines]) => dialogCard(title, lines, lang));
  } else {
    cards = list.map((p) => phraseCard(p, lang, "card fav"));
  }
  $("ph-list").replaceChildren(...own.map(favCard), ...cards);
}
$("ph-add").onclick = async () => {
  const text = $("ph-add-text").value.trim();
  if (!text) return;
  $("ph-add").disabled = true;
  setStatus("Übersetze …");
  try {
    await api("/api/my-phrases", { text, lang: uiLang, category: $("ph-add-cat").value });
    $("ph-add-text").value = "";
    $("ph-add-box").open = false;
    setStatus("");
    await loadPhrases();
    $("ph-cat").value = $("ph-add-cat").value; renderPhrases();
  } catch (e) { setStatus(e.message); }
  $("ph-add").disabled = false;
};
$("ph-cat").onchange = $("ph-lang").onchange = renderPhrases;
$("ph-search").oninput = renderPhrases;

// --- Gesprächsmodus: zwei Sprachen, abwechselnd ---
let who = "a";

function updateWho() {
  $("who-a").textContent = LANG_LABELS[$("conv-a").value] || "";
  $("who-b").textContent = LANG_LABELS[$("conv-b").value] || "";
  $("who-a").classList.toggle("active", who === "a");
  $("who-b").classList.toggle("active", who === "b");
}
$("who-a").onclick = () => { who = "a"; updateWho(); };
$("who-b").onclick = () => { who = "b"; updateWho(); };
$("conv-a").onchange = $("conv-b").onchange = updateWho;
$("conv-swap").onclick = () => {
  const a = $("conv-a").value;
  $("conv-a").value = $("conv-b").value;
  $("conv-b").value = a;
  updateWho();
};

$("chat-go").onclick = async () => {
  const text = $("chat-text").value.trim();
  if (!text) return;
  const from = $(who === "a" ? "conv-a" : "conv-b").value;
  const to = $(who === "a" ? "conv-b" : "conv-a").value;
  $("chat-go").disabled = true;
  setStatus("Übersetze …");
  try {
    const r = await api("/api/translate", { text, source: from, target: to, provider: $("provider").value || null });
    addBubble(from, to, text, r.translation, who);
    $("chat-text").value = "";
    who = who === "a" ? "b" : "a"; // nächster Sprecher
    updateWho();
    setStatus("");
  } catch (e) { setStatus(e.message); }
  $("chat-go").disabled = false;
};

function addBubble(from, to, text, translation, side) {
  const div = document.createElement("div");
  div.className = "bubble " + side;
  const orig = document.createElement("small");
  orig.textContent = `${LANG_LABELS[from]}: ${text}`;
  const big = document.createElement("div");
  big.className = "big-text";
  big.textContent = translation;
  const row = document.createElement("div");
  row.className = "fav-actions";
  row.append(
    mkBtn("#i-speaker", "Vorlesen", () => speakAny(translation, to, ""), !(serverTts || synth) || !SPEECH_TAGS[to]),
    mkBtn("#i-expand", "Groß anzeigen", () => zoom(translation)),
  );
  div.append(orig, big, row);
  $("chat-log").append(div);
  if (!typing()) div.scrollIntoView({ block: "nearest" });
}
$("chat-clear").onclick = () => $("chat-log").replaceChildren();

// --- Lernen: Vokabellisten und Mini-Test (ganz ohne KI, nur aus der Liste) ---
function setLearnMode(mode) {
  $("ph-phrases").hidden = mode !== "phrases";
  $("ph-learn").hidden = mode !== "learn";
  $("ph-mode-phrases").classList.toggle("active", mode === "phrases");
  $("ph-mode-learn").classList.toggle("active", mode === "learn");
  if (mode === "learn") loadLists();
}
$("ph-mode-phrases").onclick = () => setLearnMode("phrases");
$("ph-mode-learn").onclick = () => setLearnMode("learn");

let learnData = { lists: [], categories: [] };
let people = [];

function peoplePicker(box, preselected = []) {
  box.replaceChildren(...(people.length ? people.map((n) => {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.value = n; cb.checked = preselected.includes(n);
    label.append(cb, document.createTextNode(n));
    return label;
  }) : [Object.assign(document.createElement("small"), { textContent: t("Noch keine anderen Personen angelegt.") })]));
}
const pickedPeople = (box) => [...box.querySelectorAll("input:checked")].map((c) => c.value);
let learnOwn = "all"; // all | mine | others

for (const [key, id] of [["all", "learn-own-all"], ["mine", "learn-own-mine"], ["others", "learn-own-others"]]) {
  $(id).onclick = () => {
    learnOwn = key;
    for (const [k, i] of [["all", "learn-own-all"], ["mine", "learn-own-mine"], ["others", "learn-own-others"]]) $(i).classList.toggle("active", k === key);
    renderLists();
  };
}
$("learn-cat-filter").onchange = renderLists;

function addWordsForm(l) {
  const box = document.createElement("div");
  box.className = "learn-form";
  box.hidden = true;
  const ta = document.createElement("textarea");
  ta.placeholder = t("Eine Zeile pro Wort, z. B. Wasser = amazi");
  const ok = document.createElement("button");
  ok.className = "primary"; ok.textContent = t("Hinzufügen");
  ok.onclick = async () => {
    const items = parseWordLines(ta.value);
    if (!items.length) { setStatus("Bereits vorhanden oder leer."); return; }
    ok.disabled = true;
    setStatus(items.some((i) => !i.b) ? "Übersetze fehlende Wörter …" : "Speichere …");
    try {
      await api(`/api/lists/${l.id}/items`, { items });
      setStatus("");
      loadLists();
    } catch (e) { setStatus(e.message); }
    ok.disabled = false;
  };
  box.append(ta, ok);
  return box;
}

function renderLists() {
  const cat = $("learn-cat-filter").value;
  const shown = learnData.lists.filter((l) => (learnOwn === "all" || (learnOwn === "mine") === (l.owner === myName))
    && (!cat || (l.category || "Sonstiges") === cat));
  $("learn-empty").textContent = t(learnData.lists.length ? "Keine Listen in dieser Auswahl." : "Noch keine Listen. Lege unten die erste an.");
  $("learn-empty").hidden = shown.length > 0;
  $("learn-lists").replaceChildren(...shown.map((l) => {
    const card = document.createElement("div");
    card.className = "card fav";
    const meta = document.createElement("small");
    const mine = l.owner === myName;
    meta.textContent = `${mine ? (l.to && l.to.length ? t("An: {0}", l.to.join(", ")) : t("Meine")) : t("Von {0}", l.owner)} · ${t(l.category || "Sonstiges")} · ${LANG_LABELS[l.source]} → ${LANG_LABELS[l.target]} · ${t("{0} Wörter", l.items.length)}`;
    const title = document.createElement("strong");
    title.textContent = l.title;
    const row = document.createElement("div");
    row.className = "fav-actions learn-actions";
    const start = document.createElement("button");
    start.className = "primary"; start.textContent = t("Test starten");
    start.onclick = () => startQuiz(l);
    row.append(mkBtn("#i-book", "Lernen mit Karten", () => startCards(l)), start);
    card.append(meta, title, row);
    if (!mine && l.to && l.to.includes(myName)) {
      row.append(mkBtn("#i-trash", "Liste aus meiner Ansicht entfernen", async () => {
        if (!window.confirm(t("Liste „{0}“ entfernen?", l.title))) return;
        try { await api(`/api/lists/${l.id}/leave`, {}); } catch (e) { setStatus(e.message); }
        loadLists();
      }));
    }
    if (myAdmin || mine) {
      const sendBox = document.createElement("div");
      sendBox.className = "learn-form"; sendBox.hidden = true;
      const picker = document.createElement("fieldset");
      picker.className = "people";
      const pk = document.createElement("div");
      picker.append(Object.assign(document.createElement("legend"), { textContent: t("Senden an") }), pk);
      const go = document.createElement("button");
      go.className = "primary"; go.textContent = t("Senden");
      go.onclick = async () => {
        const names = pickedPeople(pk);
        if (!names.length) return;
        go.disabled = true;
        try {
          await api(`/api/lists/${l.id}/share`, { to: names });
          setStatus(t("Gesendet an {0}.", names.join(", ")));
          loadLists();
        } catch (e) { setStatus(e.message); }
        go.disabled = false;
      };
      sendBox.append(picker, go);
      row.append(mkBtn("#i-chat", "Liste senden", () => { peoplePicker(pk, l.to || []); sendBox.hidden = !sendBox.hidden; }));
      card.append(sendBox);
    }
    if (myAdmin || mine) {
      const form = addWordsForm(l);
      row.append(mkBtn("#i-plus", "Wörter hinzufügen", () => { form.hidden = !form.hidden; }));
      row.append(mkBtn("#i-book", "In meine Phrasen übernehmen", async () => {
        setStatus("Übersetze …");
        try {
          const r = await api("/api/my-phrases/from-list", { list_id: l.id });
          setStatus(t("{0} Phrasen übernommen.", r.added));
        } catch (e) { setStatus(e.message); }
      }));
      row.append(mkBtn("#i-trash", "Liste löschen", async () => {
        if (!window.confirm(t("Liste „{0}“ löschen?", l.title))) return;
        try {
          const res = await fetch("/api/lists/" + l.id, { method: "DELETE", headers: { "X-App-Password": password } });
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || t("Fehler {0}", res.status));
        } catch (e) { setStatus(e.message); }
        loadLists();
      }));
      card.append(form);
    }
    return card;
  }));
}

async function loadLists() {
  try {
    learnData = await api("/api/lists");
    try { people = (await api("/api/people")).people; } catch { people = []; }
    peoplePicker($("learn-to"), pickedPeople($("learn-to")));
    const fill2 = (sel, first) => {
      const keep = sel.value;
      sel.replaceChildren(...[...(first ? [["", t("Alle Kategorien")]] : []), ...learnData.categories.map((c) => [c, t(c)])].map(([v, label]) => {
        const o = document.createElement("option"); o.value = v; o.textContent = label; return o;
      }));
      if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
    };
    fill2($("learn-cat-filter"), true);
    fill2($("learn-cat"), false);
    renderLists();
  } catch (e) { setStatus(e.message); }
}

function parseWordLines(text) {
  return text.split("\n").map((line) => {
    const [a, ...rest] = line.split("=");
    return { a: a.trim(), b: rest.join("=").trim() };
  }).filter((i) => i.a);
}

$("learn-save").onclick = async () => {
  const items = parseWordLines($("learn-items").value);
  if (!$("learn-title").value.trim() || !items.length) { setStatus("Titel und mindestens ein Wort nötig."); return; }
  $("learn-save").disabled = true;
  setStatus(items.some((i) => !i.b) ? "Übersetze fehlende Wörter …" : "Speichere …");
  try {
    await api("/api/lists", { title: $("learn-title").value, source: $("learn-src").value, target: $("learn-tgt").value, category: $("learn-cat").value, to: pickedPeople($("learn-to")), items });
    $("learn-title").value = ""; $("learn-items").value = "";
    $("learn-new").open = false;
    setStatus("");
    loadLists();
  } catch (e) { setStatus(e.message); }
  $("learn-save").disabled = false;
};

const norm = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
// --- Lernkarten: Wort anzeigen, umdrehen, „gewusst“ oder „nochmal“ ---
let deck = null;

function startCards(list) {
  deck = { list, queue: shuffle(list.items.map((it) => ({ front: it.a, back: it.b }))), total: list.items.length, known: 0, flipped: false };
  $("learn-home").hidden = true;
  $("cards").hidden = false;
  showCard();
}

function showCard() {
  if (!deck.queue.length) {
    $("cards-progress").textContent = t("Fertig");
    $("cards-face").textContent = t("Alle Karten gelernt, super!");
    $("cards-face").disabled = true; $("cards-hint").hidden = true; $("cards-answers").hidden = true;
    return;
  }
  const c = deck.queue[0];
  deck.flipped = false;
  $("cards-progress").textContent = `${deck.known} / ${deck.total}`;
  $("cards-face").textContent = c.front;
  $("cards-face").disabled = false; $("cards-hint").hidden = false; $("cards-answers").hidden = true;
}

$("cards-face").onclick = () => {
  const c = deck.queue[0];
  deck.flipped = !deck.flipped;
  $("cards-face").textContent = deck.flipped ? c.back : c.front;
  $("cards-hint").hidden = deck.flipped; $("cards-answers").hidden = !deck.flipped;
};
$("cards-known").onclick = () => { deck.queue.shift(); deck.known++; showCard(); };
$("cards-again").onclick = () => { deck.queue.push(deck.queue.shift()); showCard(); };
$("cards-stop").onclick = () => { $("cards").hidden = true; $("learn-home").hidden = false; };

let quiz = null;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function startQuiz(list, only) {
  const items = only || list.items;
  // Multiple Choice ab 3 Wörtern, sonst Eintippen; abwechselnd beide Richtungen
  const questions = shuffle(items.map((it, i) => (i % 2 ? { q: it.b, a: it.a, ql: list.target, al: list.source } : { q: it.a, a: it.b, ql: list.source, al: list.target })));
  quiz = { list, questions, i: 0, wrong: [], right: 0, typed: false };
  $("learn-home").hidden = true;
  $("quiz").hidden = false;
  showQuestion();
}

function showQuestion() {
  const q = quiz.questions[quiz.i];
  $("quiz-progress").textContent = t("Frage {0} von {1}", quiz.i + 1, quiz.questions.length);
  $("quiz-question").textContent = q.q;
  $("quiz-feedback").textContent = "";
  $("quiz-feedback").className = "quiz-fb";
  $("quiz-next").hidden = true;
  const pool = quiz.list.items.map((it) => (q.al === quiz.list.target ? it.b : it.a)); // Falschantworten nur in der Antwortsprache
  const distractors = shuffle([...new Set(pool.filter((w) => norm(w) !== norm(q.a) && norm(w) !== norm(q.q)))]).slice(0, 3);
  quiz.typed = quiz.questions.length < 3 || distractors.length < 2;
  $("quiz-typed").hidden = !quiz.typed;
  $("quiz-options").hidden = quiz.typed;
  if (quiz.typed) {
    $("quiz-input").value = ""; $("quiz-input").disabled = false; $("quiz-check").disabled = false;
    $("quiz-input").focus();
  } else {
    $("quiz-options").replaceChildren(...shuffle([q.a, ...distractors]).map((w) => {
      const b = document.createElement("button");
      b.className = "quiz-opt"; b.textContent = w;
      b.onclick = () => answer(w);
      return b;
    }));
  }
}

function answer(given) {
  const q = quiz.questions[quiz.i];
  const ok = norm(given) === norm(q.a);
  if (ok) quiz.right++; else quiz.wrong.push(quiz.list.items.find((it) => it.a === q.q || it.b === q.q));
  $("quiz-feedback").textContent = ok ? t("Richtig!") : t("Falsch. Richtig: {0}", q.a);
  $("quiz-feedback").className = "quiz-fb " + (ok ? "ok" : "bad");
  for (const b of $("quiz-options").children) { b.disabled = true; if (norm(b.textContent) === norm(q.a)) b.classList.add("right"); }
  $("quiz-input").disabled = true; $("quiz-check").disabled = true;
  $("quiz-next").hidden = false;
  $("quiz-next").textContent = t(quiz.i + 1 < quiz.questions.length ? "Weiter" : "Ergebnis");
  $("quiz-next").focus();
}

$("quiz-check").onclick = () => { if ($("quiz-input").value.trim()) answer($("quiz-input").value); };
$("quiz-input").onkeydown = (e) => { if (e.key === "Enter") $("quiz-check").click(); };
$("quiz-next").onclick = () => {
  if (quiz.i + 1 < quiz.questions.length) { quiz.i++; showQuestion(); return; }
  const total = quiz.questions.length;
  $("quiz-progress").textContent = t("Fertig");
  $("quiz-question").textContent = t("{0} von {1} richtig", quiz.right, total);
  $("quiz-options").hidden = true; $("quiz-typed").hidden = true;
  $("quiz-feedback").className = "quiz-fb";
  $("quiz-feedback").textContent = quiz.wrong.length ? t("Noch nicht sicher: {0}", quiz.wrong.map((w) => `${w.a} = ${w.b}`).join(", ")) : t("Alles richtig, super!");
  if (quiz.wrong.length) {
    $("quiz-next").textContent = t("Fehler wiederholen");
    $("quiz-next").onclick = () => { const l = quiz.list, w = quiz.wrong; $("quiz-next").onclick = nextHandler; startQuiz(l, w); };
  } else { $("quiz-next").hidden = true; }
  if (quiz.wrong.length) $("quiz-next").hidden = false;
};
const nextHandler = $("quiz-next").onclick;
$("quiz-stop").onclick = () => { quiz = null; $("quiz").hidden = true; $("learn-home").hidden = false; $("quiz-next").onclick = nextHandler; };

// --- Chats zwischen Personen: dauerhaft auf dem Server, Abfrage per Polling ---
let room = null, lastId = 0, pollTimer = null; // room = geöffneter Chat (Zusammenfassung vom Server)
const CHAT_IMAGE_SIDE = 1280; // Fotos vor dem Senden verkleinern (ca. 200-400 kB)
const imageUrls = new Map(); // Datei -> Blob-URL; Bilder brauchen den Passwort-Header, darum kein <img src> direkt

function setMode(mode) {
  $("chat-local").hidden = mode !== "local";
  $("chat-room").hidden = mode !== "room";
  $("mode-local").classList.toggle("active", mode === "local");
  $("mode-room").classList.toggle("active", mode === "room");
  store.set("chat-mode", mode);
  startPolling();
}
$("mode-local").onclick = () => setMode("local");
$("mode-room").onclick = () => setMode("room");

// Offener Chat: alle 2 s neue Nachrichten; Chatliste: alle 10 s; sonst nur ab und zu für das Abzeichen
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
function startPolling() {
  stopPolling();
  if (document.hidden || !password) return;
  const inChats = !$("chat").hidden && !$("chat-room").hidden;
  const tick = inChats && room ? poll : loadChats;
  tick();
  pollTimer = setInterval(tick, inChats ? (room ? 2000 : 10000) : 60000);
}
document.addEventListener("visibilitychange", startPolling);

const chatLang = () => $("room-lang").value;
const chatName = (c) => c.title || c.members.filter((m) => m.name !== myName).map((m) => m.name).join(", ");
const clock = (sec) => new Date(sec * 1000).toLocaleString(uiLang, { hour: "2-digit", minute: "2-digit", day: "numeric", month: "numeric" });

function showRoom() {
  $("chats-home").hidden = !!room;
  $("room-live").hidden = !room;
  if (!room) return;
  $("room-title").textContent = chatName(room);
  $("room-members").textContent = room.members.map((m) => m.name + (m.lang ? ` (${LANG_LABELS[m.lang]})` : "")).join(", ");
}

async function loadChats() {
  let list;
  try { list = (await api("/api/chats")).chats; } catch { return; }
  const unread = list.reduce((n, c) => n + c.unread, 0);
  $("chat-badge").hidden = !unread;
  $("chat-badge").textContent = unread > 9 ? "9+" : String(unread);
  $("chats-empty").hidden = list.length > 0;
  $("chats-list").replaceChildren(...list.map((c) => {
    const card = document.createElement("button");
    card.className = "card fav chat-item";
    const head = document.createElement("div");
    head.className = "chat-item-head";
    const name = document.createElement("strong");
    name.textContent = chatName(c);
    head.append(name);
    if (c.unread) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = c.unread;
      head.append(badge);
    }
    const last = document.createElement("small");
    last.textContent = c.last ? `${c.last.name === myName ? t("Du") : c.last.name}: ${c.last.image && !c.last.text ? "📷 " + t("Foto") : c.last.text} · ${clock(c.last.time)}` : t("Noch keine Nachrichten");
    card.append(head, last);
    card.onclick = () => openChat(c);
    return card;
  }));
  const wanted = store.get("chat-open");
  if (wanted && !room && !$("chat-room").hidden) {
    const found = list.find((c) => c.id === wanted);
    if (found) openChat(found); else store.del("chat-open");
  }
}

function openChat(c) {
  room = c; lastId = 0;
  store.set("chat-open", c.id);
  $("room-log").replaceChildren();
  showRoom(); startPolling(); setStatus("");
}

function closeChat() {
  room = null; store.del("chat-open");
  showRoom(); startPolling();
}
$("room-back").onclick = closeChat;

$("room-lang").onchange = () => {
  store.set("room-lang", chatLang());
  if (room) openChat(room); // alles neu in der gewählten Sprache laden
};

$("chat-new").addEventListener("toggle", async () => {
  if (!$("chat-new").open) return;
  try { people = (await api("/api/people")).people; } catch { people = []; }
  peoplePicker($("chat-people"), pickedPeople($("chat-people")));
});
$("chat-create").onclick = async () => {
  const members = pickedPeople($("chat-people"));
  if (!members.length) { setStatus("Bitte mindestens eine Person auswählen"); return; }
  try {
    const c = await api("/api/chats", { title: $("chat-title").value.trim(), members });
    $("chat-title").value = ""; $("chat-new").open = false;
    peoplePicker($("chat-people"));
    openChat(c);
  } catch (e) { setStatus(e.message); }
};

async function poll() {
  if (!room) return;
  const id = room.id;
  try {
    const r = await api(`/api/chats/${id}/messages?lang=${chatLang()}&after=${lastId}`);
    if (!room || room.id !== id) return; // inzwischen anderer Chat geöffnet
    room = r.chat; showRoom();
    for (const m of r.messages) { addRoomBubble(m); lastId = Math.max(lastId, m.id); }
    if (r.messages.length) loadChats(); // gelesen: Abzeichen und Liste aktualisieren
  } catch (e) {
    setStatus(e.message);
    if (/Chat nicht gefunden/.test(e.message)) closeChat();
    else { stopPolling(); setTimeout(() => { if (room) startPolling(); }, 10000); } // bei Fehlern nicht im 2-s-Takt wiederholen
  }
}

async function chatImage(file) {
  if (!imageUrls.has(file)) {
    const res = await fetch(`/api/chats/${room.id}/images/${file}`, { headers: { "X-App-Password": password } });
    if (!res.ok) throw new Error(t("Fehler {0}", res.status));
    imageUrls.set(file, URL.createObjectURL(await res.blob()));
  }
  return imageUrls.get(file);
}

function addRoomBubble(m) {
  const div = document.createElement("div");
  div.className = "bubble " + (m.mine ? "b" : "a");
  const who = document.createElement("small");
  who.textContent = `${m.mine ? t("Du") : m.name} · ${clock(m.time)}`;
  div.append(who);
  if (m.image) {
    const img = document.createElement("img");
    img.className = "chat-img"; img.alt = t("Foto");
    chatImage(m.image).then((url) => {
      img.src = url;
      img.onclick = () => { $("img-zoom-pic").src = url; $("img-zoom").hidden = false; };
    }).catch(() => { img.alt = t("Foto konnte nicht geladen werden"); });
    div.append(img);
  }
  if (m.text) {
    const big = document.createElement("div");
    big.className = "big-text";
    big.textContent = m.text;
    div.append(big);
    if (!m.mine && m.original !== m.text) {
      const orig = document.createElement("small");
      orig.textContent = `${LANG_LABELS[m.lang]}: ${m.original}`;
      div.append(orig);
    }
    const row = document.createElement("div");
    row.className = "fav-actions";
    const lang = m.mine ? m.lang : chatLang();
    row.append(
      mkBtn("#i-speaker", "Vorlesen", () => speakAny(m.text, lang, ""), !(serverTts || synth) || !SPEECH_TAGS[lang]),
      mkBtn("#i-expand", "Groß anzeigen", () => zoom(m.text)),
    );
    div.append(row);
  }
  $("room-log").append(div);
  if (!typing()) div.scrollIntoView({ block: "nearest" });
}
$("img-zoom").onclick = () => { $("img-zoom").hidden = true; };

async function sendChat(body) {
  if (!room) return;
  $("room-send").disabled = true;
  try {
    await api(`/api/chats/${room.id}/messages`, { lang: chatLang(), ...body });
    $("room-text").value = "";
    setStatus("");
    await poll();
  } catch (e) { setStatus(e.message); }
  $("room-send").disabled = false;
}
$("room-send").onclick = () => {
  const text = $("room-text").value.trim();
  if (text) sendChat({ text });
};
// Foto mit dem Text im Eingabefeld als Bildunterschrift senden
$("room-file").onchange = async () => {
  const file = $("room-file").files[0];
  $("room-file").value = "";
  if (!file || !room) return;
  setStatus("Foto wird gesendet …");
  try {
    const image = await imageToBase64(file, CHAT_IMAGE_SIDE);
    await sendChat({ image, text: $("room-text").value.trim() });
  } catch (e) { setStatus(e.message); }
};

$("room-leave").onclick = async () => {
  if (!room || !window.confirm(t("Chat „{0}“ verlassen? Er verschwindet dann aus deiner Liste.", chatName(room)))) return;
  try {
    const res = await fetch(`/api/chats/${room.id}`, { method: "DELETE", headers: { "X-App-Password": password } });
    if (!res.ok && res.status !== 404) throw new Error(t("Fehler {0}", res.status));
  } catch (e) { setStatus(e.message); return; }
  closeChat();
};

// --- Preisschild: Foto → Beträge → Euro ---
function parsePrices(text) {
  const out = [];
  for (const line of text.split(/\n/)) {
    for (const m of line.matchAll(/\d{1,3}(?:[.,\s]\d{3})+(?!\d)|\d+/g)) {
      const amount = parseInt(m[0].replace(/[.,\s]/g, ""), 10);
      if (amount >= 50) out.push({ line: line.trim(), amount }); // kleine Zahlen sind meist Mengen/Hausnummern
    }
  }
  return out.slice(0, 30);
}

$("price-file").onchange = async () => {
  const file = $("price-file").files[0];
  $("price-file").value = "";
  if (!file) return;
  setStatus("Erkenne Preise …");
  try {
    const r = await api("/api/ocr", { image: await imageToBase64(file) });
    const prices = parsePrices(r.text || "");
    if (!prices.length) { setStatus("Keine Preise im Bild gefunden."); return; }
    const probe = await api("/api/convert", { amount: 1000, source: "RWF", target: "EUR" });
    const rate = probe.result / 1000;
    const fmt = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });
    $("price-list").replaceChildren(...prices.map((p) => {
      const li = document.createElement("li");
      const l = document.createElement("small");
      l.textContent = p.line;
      const v = document.createElement("strong");
      v.textContent = `${fmt.format(p.amount)} RWF = ${fmt.format(p.amount * rate)} €`;
      li.append(v, l);
      return li;
    }));
    setStatus("");
  } catch (e) { setStatus(e.message); }
};

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

applyUi();
renderHistory();
updateControls();

fetch("/health").then((r) => r.json()).then((h) => { $("version").textContent = t("Version {0}", h.version); }).catch(() => {});

// App-Sprache (gilt pro Gerät): Auswahl speichern und neu laden, damit alle Texte neu aufgebaut werden
fill($("ui-lang"), UI_LANGS, (l) => UI_NAMES[l]);
$("ui-lang").value = uiLang;
$("ui-lang").onchange = () => { store.set("ui-lang", $("ui-lang").value); location.reload(); };

init();
window.appReady = true; // für die Selbstheilung in index.html: Script lief bis zum Ende
try { sessionStorage.removeItem("recovered"); } catch { /* ignorieren */ }
