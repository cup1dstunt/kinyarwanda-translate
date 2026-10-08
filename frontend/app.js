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
    serverTts = !!info.tts;
    $("ocr-btn").hidden = !info.ocr;
    $("price-btn").hidden = !info.ocr;
    fill($("conv-a"), info.languages, (l) => LANG_LABELS[l]);
    fill($("conv-b"), info.languages, (l) => LANG_LABELS[l]);
    $("conv-a").value = "de"; $("conv-b").value = "rw";
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
    throw new Error(data.detail || "Fehler " + res.status);
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
      setStatus("Sprachausgabe fehlgeschlagen: " + e.message + "");
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
      if (e.error !== "canceled" && e.error !== "interrupted") setStatus("Sprachausgabe fehlgeschlagen (" + e.error + ").");
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

// --- Großanzeige („Zeigen“) ---
function zoom(text) {
  $("zoom-text").textContent = text;
  $("zoom").hidden = false;
}
$("zoom").onclick = () => { $("zoom").hidden = true; };
$("show").onclick = () => zoom($("output").value);

// --- Favoriten / Phrasebook (lokal, auch offline nutzbar) ---
const CATEGORIES = ["Arzt", "Behörde", "Einkaufen", "Unterwegs", "Sonstiges"];

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
  const cat = window.prompt("Kategorie: " + CATEGORIES.join(", "), store.get("last-cat") || CATEGORIES[0]);
  if (cat === null) return;
  const match = CATEGORIES.find((c) => c.toLowerCase() === cat.trim().toLowerCase());
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
  fill($("fav-filter"), ["", ...cats], (c) => c || "Alle Kategorien");
  $("fav-filter").value = cats.includes(current) ? current : "";
  const shown = all.filter((f) => !$("fav-filter").value || f.cat === $("fav-filter").value);
  $("fav-empty").hidden = shown.length > 0;
  $("fav-list").replaceChildren(...shown.map((f) => {
    const card = document.createElement("div");
    card.className = "card fav";
    const meta = document.createElement("small");
    meta.textContent = `${f.cat} · ${LANG_LABELS[f.source]} → ${LANG_LABELS[f.target]}`;
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

function mkBtn(icon, label, onclick, disabled = false) {
  const b = document.createElement("button");
  b.className = "icon"; b.title = label; b.setAttribute("aria-label", label);
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
    if (e.name !== "AbortError") setStatus("Export nicht möglich: " + e.message);
  }
};
$("rate-clear").onclick = () => {
  if (window.confirm("Alle Bewertungen löschen?")) { store.del("ratings"); renderFavs(); }
};

// --- Phrasenbuch: fertige Sätze, Kinyarwanda ungeprüft bis zur Bestätigung ---
let phrases = null;
const reviews = () => { try { return JSON.parse(store.get("phrase-review") || "{}"); } catch { return {}; } };

async function loadPhrases() {
  if (!phrases) {
    try { phrases = await (await fetch("/phrases.json")).json(); } catch { setStatus("Phrasenbuch konnte nicht geladen werden."); return; }
    const cats = [...new Set(phrases.map((p) => p.c))];
    fill($("ph-cat"), cats);
    fill($("ph-lang"), ["rw", "fr", "en"], (l) => "→ " + LANG_LABELS[l]);
  }
  renderPhrases();
}

function renderPhrases() {
  if (!phrases) return;
  const lang = $("ph-lang").value, rev = reviews();
  $("ph-list").replaceChildren(...phrases.filter((p) => p.c === $("ph-cat").value).map((p) => {
    const key = p.de + "|" + lang;
    const r = rev[key];
    const text = r && r.text ? r.text : p[lang];
    const card = document.createElement("div");
    card.className = "card fav";
    const meta = document.createElement("small");
    meta.textContent = lang === "rw" ? (r ? "✓ geprüft" : "ungeprüft") : "";
    const de = document.createElement("div");
    de.textContent = p.de;
    const out = document.createElement("strong");
    out.textContent = text;
    const row = document.createElement("div");
    row.className = "fav-actions";
    const review = (good, correction) => {
      addRating({ provider: "phrasebook", source: "de", target: lang, input: p.de, output: p[lang], good, correction });
      const all = reviews();
      all[key] = { text: correction || p[lang] };
      store.set("phrase-review", JSON.stringify(all));
      renderPhrases();
    };
    row.append(
      mkBtn("#i-expand", "Groß anzeigen", () => zoom(text)),
      mkBtn("#i-speaker", "Vorlesen", () => speakAny(text, lang, ""), !(serverTts || synth) || !SPEECH_TAGS[lang]),
    );
    if (lang === "rw") {
      const up = document.createElement("button");
      up.className = "icon"; up.textContent = "👍"; up.title = "Stimmt";
      up.onclick = () => review(true, "");
      const down = document.createElement("button");
      down.className = "icon"; down.textContent = "👎"; down.title = "Korrigieren";
      down.onclick = () => {
        const fix = window.prompt("Richtige Übersetzung:", text);
        if (fix !== null && fix.trim()) review(false, fix.trim());
      };
      row.append(up, down);
    }
    card.append(...(meta.textContent ? [meta] : []), de, out, row);
    return card;
  }));
}
$("ph-cat").onchange = $("ph-lang").onchange = renderPhrases;

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
  div.scrollIntoView({ behavior: "smooth", block: "end" });
}
$("chat-clear").onclick = () => $("chat-log").replaceChildren();

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

renderHistory();
updateControls();

fetch("/health").then((r) => r.json()).then((h) => { $("version").textContent = "Version " + h.version; }).catch(() => {});

init();
