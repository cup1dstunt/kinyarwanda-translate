"use strict";
const $ = (id) => document.getElementById(id);
const LANG_LABELS = { de: "Deutsch", fr: "Français", rw: "Kinyarwanda" };
let password = sessionStorage.getItem("pw") || "";

function setStatus(msg) { $("status").textContent = msg || ""; }

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "X-App-Password": password },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { showLogin(); throw new Error("Bitte anmelden"); }
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
  } catch (e) { setStatus(e.message); }
}

$("login-btn").onclick = () => {
  password = $("password").value;
  sessionStorage.setItem("pw", password);
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

init();
