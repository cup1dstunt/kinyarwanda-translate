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

const TABS = { translate: "translate", chat: "chat", phrases: "phrases", favs: "favs", currency: "currency" };

function showLogin() {
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
  if (name === "favs") renderFavs();
  if (name === "phrases") loadPhrases();
  if (name === "chat" && room && !$("chat-room").hidden) startPolling();
  if (name !== "chat") stopPolling();
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
    resumeRoom();
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
$("tab-favs").onclick = () => showTab("favs");
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

function imageToBase64(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, OCR_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
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
const CATEGORIES = ["Arzt", "Behörde", "Einkaufen", "Unterwegs", "Sonstiges"]; // gespeichert deutsch, angezeigt übersetzt

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

function renderFavs() {
  const all = loadJson("favs");
  const cats = [...new Set([...CATEGORIES, ...all.map((f) => f.cat)])];
  const current = $("fav-filter").value || "";
  fill($("fav-filter"), ["", ...cats], (c) => t(c || "Alle Kategorien"));
  $("fav-filter").value = cats.includes(current) ? current : "";
  const shown = all.filter((f) => !$("fav-filter").value || f.cat === $("fav-filter").value);
  $("fav-empty").hidden = shown.length > 0;
  $("fav-list").replaceChildren(...shown.map((f) => {
    const card = document.createElement("div");
    card.className = "card fav";
    const meta = document.createElement("small");
    meta.textContent = `${t(f.cat)} · ${LANG_LABELS[f.source]} → ${LANG_LABELS[f.target]}`;
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
        store.set("favs", JSON.stringify(loadJson("favs").filter((x) => favId(x) !== favId(f))));
        renderFavs();
      }),
    );
    card.append(meta, inp, out, row);
    return card;
  }));
  $("rate-count").textContent = loadJson("ratings").length;
}
$("fav-filter").onchange = renderFavs;

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
  if (window.confirm("Alle Bewertungen löschen?")) { store.del("ratings"); renderFavs(); }
};

// --- Phrasenbuch: fertige Sätze, Kinyarwanda ungeprüft bis zur Bestätigung ---
let phrases = null;
const fold = (x) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const reviews = () => { try { return JSON.parse(store.get("phrase-review") || "{}"); } catch { return {}; } };

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
  const cats = [...new Set([...phrases.map((p) => p.c), ...myPhrases.map((p) => p.c)])];
  const keep = $("ph-cat").value;
  fill($("ph-cat"), cats, (c) => t(c));
  if (cats.includes(keep)) $("ph-cat").value = keep;
  fill($("ph-add-cat"), [...new Set([...cats, "Eigene"])], (c) => t(c));
  renderPhrases();
}

let myPhrases = [];

function renderPhrases() {
  if (!phrases) return;
  const lang = $("ph-lang").value, rev = reviews();
  $("ph-hint").textContent = t("Fertige Sätze, {0} → Zielsprache. Kinyarwanda ist ungeprüft, bis es mit 👍 bestätigt oder mit 👎 korrigiert wurde.", LANG_LABELS[uiLang]);
  const q = fold($("ph-search").value);
  const all = [...phrases, ...myPhrases];
  // Suche: alle Kategorien und alle Sprachen, höchstens 80 Treffer
  const shown = q
    ? all.filter((p) => UI_LANGS.some((l) => fold(p[l]).includes(q))).slice(0, 80)
    : all.filter((p) => p.c === $("ph-cat").value);
  $("ph-cat").hidden = !!q;
  $("ph-list").replaceChildren(...shown.map((p) => {
    const key = p.de + "|" + lang;
    const r = rev[key];
    const text = r && r.text ? r.text : p[lang];
    const verified = lang === "rw" && (p.v || r);
    const card = document.createElement("div");
    card.className = "card fav";
    const meta = document.createElement("small");
    meta.textContent = [q ? t(p.c) : "", lang === "rw" && !p.own ? t(verified ? "✓ geprüft" : "ungeprüft") : ""].filter(Boolean).join(" · ");
    const de = document.createElement("div");
    de.textContent = p[uiLang];
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
    row.append(
      mkBtn("#i-expand", "Groß anzeigen", () => zoom(text)),
      mkBtn("#i-speaker", "Vorlesen", () => speakAny(text, lang, ""), !(serverTts || synth) || !SPEECH_TAGS[lang]),
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
      // Bewertung nur noch für noch ungeprüfte Sätze, klein hinter einem Knopf
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
    card.append(...(meta.textContent ? [meta] : []), de, out, row);
    return card;
  }));
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
    meta.textContent = `${t("Von {0}", l.owner)} · ${t(l.category || "Sonstiges")} · ${LANG_LABELS[l.source]} → ${LANG_LABELS[l.target]} · ${t("{0} Wörter", l.items.length)}`;
    const title = document.createElement("strong");
    title.textContent = l.title;
    const row = document.createElement("div");
    row.className = "fav-actions learn-actions";
    const start = document.createElement("button");
    start.className = "primary"; start.textContent = t("Test starten");
    start.onclick = () => startQuiz(l);
    row.append(start);
    card.append(meta, title, row);
    if (myAdmin || l.owner === myName) {
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
    await api("/api/lists", { title: $("learn-title").value, source: $("learn-src").value, target: $("learn-tgt").value, category: $("learn-cat").value, items });
    $("learn-title").value = ""; $("learn-items").value = "";
    $("learn-new").open = false;
    setStatus("");
    loadLists();
  } catch (e) { setStatus(e.message); }
  $("learn-save").disabled = false;
};

const norm = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
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

// --- Gespräch über zwei Handys (Raum-Code, Abfrage alle 2 s) ---
const cid = store.get("cid") || (() => { const v = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/-/g, ""); store.set("cid", v); return v; })();
let room = null, lastId = 0, pollTimer = null;

function setMode(mode) {
  $("chat-local").hidden = mode !== "local";
  $("chat-room").hidden = mode !== "room";
  $("mode-local").classList.toggle("active", mode === "local");
  $("mode-room").classList.toggle("active", mode === "room");
  if (mode === "room" && room) startPolling(); else stopPolling();
}
$("mode-local").onclick = () => setMode("local");
$("mode-room").onclick = () => setMode("room");

function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
function startPolling() { stopPolling(); if ($("chat").hidden) return; poll(); pollTimer = setInterval(poll, 2000); }
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPolling(); else if (room && !$("chat-room").hidden) startPolling();
});

function showRoom() {
  $("room-join").hidden = !!room;
  $("room-live").hidden = !room;
  if (room) $("room-title").textContent = room;
}

async function enterRoom(code) {
  const lang = $("room-lang").value;
  store.set("room-lang", lang);
  try {
    const r = await api("/api/rooms", { cid, lang, code: code || null });
    room = r.room; lastId = 0;
    store.set("room", JSON.stringify({ room, lang }));
    $("room-log").replaceChildren();
    showRoom(); startPolling(); setStatus("");
  } catch (e) { setStatus(e.message); }
}
$("room-create").onclick = () => enterRoom("");
$("room-enter").onclick = () => { const c = $("room-code").value.trim(); if (c) enterRoom(c); };

function resumeRoom() {
  let saved = null;
  try { saved = JSON.parse(store.get("room") || "null"); } catch { /* ignorieren */ }
  if (!saved || room) return;
  $("room-lang").value = saved.lang;
  api("/api/rooms", { cid, lang: saved.lang, code: saved.room }).then((r) => {
    room = r.room; lastId = 0; showRoom(); setMode("room");
  }).catch(() => store.del("room"));
}

async function poll() {
  if (!room) return;
  try {
    const r = await api(`/api/rooms/${room}/messages?cid=${cid}&after=${lastId}`);
    $("room-members").textContent = r.members.map((m) => `${m.name} (${LANG_LABELS[m.lang]})`).join(", ");
    for (const m of r.messages) { addRoomBubble(m); lastId = Math.max(lastId, m.id); }
  } catch (e) {
    setStatus(e.message);
    if (/Raum|nicht/.test(e.message)) leaveRoom(false);
    else { stopPolling(); setTimeout(() => { if (room) startPolling(); }, 10000); } // bei Fehlern nicht im 2-s-Takt wiederholen
  }
}

function addRoomBubble(m) {
  const div = document.createElement("div");
  div.className = "bubble " + (m.mine ? "b" : "a");
  const who = document.createElement("small");
  who.textContent = m.mine ? t("Du") : m.name;
  const big = document.createElement("div");
  big.className = "big-text";
  big.textContent = m.text;
  div.append(who, big);
  if (!m.mine && m.original !== m.text) {
    const orig = document.createElement("small");
    orig.textContent = `${LANG_LABELS[m.lang]}: ${m.original}`;
    div.append(orig);
  }
  const row = document.createElement("div");
  row.className = "fav-actions";
  const lang = $("room-lang").value;
  row.append(
    mkBtn("#i-speaker", "Vorlesen", () => speakAny(m.text, lang, ""), !(serverTts || synth) || !SPEECH_TAGS[lang]),
    mkBtn("#i-expand", "Groß anzeigen", () => zoom(m.text)),
  );
  div.append(row);
  $("room-log").append(div);
  if (!typing()) div.scrollIntoView({ block: "nearest" });
}

$("room-send").onclick = async () => {
  const text = $("room-text").value.trim();
  if (!text || !room) return;
  $("room-send").disabled = true;
  try {
    await api(`/api/rooms/${room}/messages`, { cid, text });
    $("room-text").value = "";
    await poll();
  } catch (e) { setStatus(e.message); }
  $("room-send").disabled = false;
};

function leaveRoom(notify = true) {
  if (notify && room) fetch(`/api/rooms/${room}?cid=${cid}`, { method: "DELETE", headers: { "X-App-Password": password } }).catch(() => {});
  room = null; stopPolling(); store.del("room"); showRoom();
}
$("room-leave").onclick = () => leaveRoom();

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
$("tab-favs").querySelector("span").textContent = t("Favoriten/Einstellungen").replace("/", "/\u200b"); // darf nach dem Schrägstrich umbrechen
renderHistory();
updateControls();

fetch("/health").then((r) => r.json()).then((h) => { $("version").textContent = t("Version {0}", h.version); }).catch(() => {});

// App-Sprache (gilt pro Gerät): Auswahl speichern und neu laden, damit alle Texte neu aufgebaut werden
fill($("ui-lang"), UI_LANGS, (l) => UI_NAMES[l]);
$("ui-lang").value = uiLang;
$("ui-lang").onchange = () => { store.set("ui-lang", $("ui-lang").value); location.reload(); };

init();
