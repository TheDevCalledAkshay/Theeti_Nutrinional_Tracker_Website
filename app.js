/* ============================================================
   Theeti — a simple, private calorie & macro tracker.
   All data lives in your browser's localStorage. Nutrition comes
   from the built-in "Theeti Essentials" food list (foods.js) plus
   online searches against USDA FoodData Central.
   ============================================================ */
"use strict";

const DATA_PREFIX = "theeti.data."; // per-user: theeti.data.<email>
const LEGACY_KEYS = ["theeti.v1", "caltrack.v1"]; // pre-accounts data to migrate
const USERS_KEY = "theeti.users"; // account registry {email: {name, salt, hash}}
const SESSION_KEY = "theeti.session"; // logged-in email

let state = { goal: 2000, apiKey: "", entries: [] };
let currentUser = null; // {email, name}

const USDA_API_URL = "https://api.nal.usda.gov/fdc/v1/foods/search";
const USDA_DATA_TYPES = "Foundation,SR Legacy,Survey (FNDDS)";
const USDA_DEMO_KEY = "DEMO_KEY";

/* ---------------- state (per user) ---------------- */
function dataKey(email) {
  return DATA_PREFIX + email.toLowerCase();
}

function loadData() {
  try {
    let raw = localStorage.getItem(dataKey(currentUser.email));
    if (raw === null) {
      // first login with no per-user data: adopt any pre-accounts log
      for (const k of LEGACY_KEYS) {
        const legacy = localStorage.getItem(k);
        if (legacy !== null) { raw = legacy; break; }
      }
    }
    const data = raw ? JSON.parse(raw) : {};
    return {
      goal: Number(data.goal) || 2000,
      apiKey: typeof data.apiKey === "string" ? data.apiKey : "",
      entries: Array.isArray(data.entries) ? data.entries : [],
    };
  } catch (err) {
    console.warn("Could not read saved data, starting fresh.", err);
    return { goal: 2000, apiKey: "", entries: [] };
  }
}

function save() {
  if (!currentUser) return;
  try {
    localStorage.setItem(dataKey(currentUser.email), JSON.stringify(state));
  } catch (err) {
    console.warn("Could not save data.", err);
  }
}

/* ---------------- tiny helpers ---------------- */
const $ = (sel) => document.querySelector(sel);
const pad = (n) => String(n).padStart(2, "0");
const fmt = (n) => Math.round(n).toLocaleString();

function dateToStr(d) {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function todayStr() {
  return dateToStr(new Date());
}

function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return dateToStr(dt);
}

function prettyDate(dateStr) {
  if (dateStr === todayStr()) return "Today";
  if (dateStr === shiftDate(todayStr(), -1)) return "Yesterday";
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* Guess the meal from the current time of day:
   5-11 AM breakfast · 11 AM-4 PM lunch · 4-9 PM dinner · 9 PM-5 AM snack */
function guessMeal(d) {
  const h = (d || new Date()).getHours();
  if (h >= 5 && h < 11) return "breakfast";
  if (h >= 11 && h < 16) return "lunch";
  if (h >= 16 && h < 21) return "dinner";
  return "snack";
}

/* ---------------- derived data ---------------- */
function totalsForDate(dateStr) {
  const t = { cal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const e of state.entries) {
    if (e.date !== dateStr) continue;
    t.cal += e.calories || 0;
    t.protein += e.protein || 0;
    t.carbs += e.carbs || 0;
    t.fat += e.fat || 0;
  }
  return t;
}

function entriesForDate(dateStr) {
  return state.entries
    .filter((e) => e.date === dateStr)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function lastNDays(n) {
  const days = [];
  const today = todayStr();
  for (let i = n - 1; i >= 0; i--) days.push(shiftDate(today, -i));
  return days;
}

/* ---------------- food search (built-in list + USDA) ---------------- */
let suggestTimer = null;
let suggestAbort = null;
let suggestItems = [];
let suggestIndex = -1;
let per100 = null; // nutrition per 100 g of the selected product
let pieceUnit = null; // {grams, name} when the food is counted in pieces

const round1 = (n) => Math.round(n * 10) / 10;

function showSuggestStatus(text) {
  const list = $("#suggestList");
  if (!list) return;
  list.classList.remove("hidden");
  list.innerHTML = '<li class="si-status">' + esc(text) + "</li>";
}

function closeSuggestions() {
  const list = $("#suggestList");
  if (list) list.classList.add("hidden");
  suggestIndex = -1;
}

function clearPer100() {
  per100 = null;
  const note = $("#sourceNote");
  if (note) note.textContent = "";
}

function onNameInput() {
  const q = $("#fName").value.trim();
  clearTimeout(suggestTimer);
  if (q.length < 2) {
    closeSuggestions();
    return;
  }
  suggestTimer = setTimeout(() => fetchSuggestions(q), 400);
}

/* Built-in "Theeti Essentials" — instant results, works offline */
function searchEssentialFoods(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [];
  for (const f of window.THEETI_FOODS || []) {
    const name = f.name.toLowerCase();
    let score = -1;
    if (name.startsWith(words[0])) score = 0;
    else if (name.includes(words[0])) score = 1;
    else if (words.every((w) => name.includes(w))) score = 2;
    if (score >= 0) scored.push({ score: score, f: f });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.f.name.localeCompare(b.f.name))
    .slice(0, 6)
    .map(({ f }) => ({
      name: f.name,
      brand: "",
      kcal: f.kcal,
      protein: f.protein,
      carbs: f.carbs,
      fat: f.fat,
      servingQty: f.serving || 0,
      pieceGrams: f.pieceGrams || 0,
      pieceName: f.pieceName || "piece",
      src: "theeti",
    }));
}

/* USDA FoodData Central — huge English database of generic foods & dishes.
   Nutrient ids: 1008 = Energy (kcal), 1062 = Energy (kJ) [some Foundation
   foods only report kJ], 1003 = Protein, 1005 = Carbs, 1004 = Fat. */
function usdaValue(food, id) {
  const n = (food.foodNutrients || []).find((x) => x.nutrientId === id);
  return n ? Number(n.value) || 0 : 0;
}

async function fetchSuggestions(query) {
  if (suggestAbort) suggestAbort.abort();
  suggestAbort = new AbortController();

  // 1) instant results from the built-in list
  const local = searchEssentialFoods(query);
  suggestItems = local;
  renderSuggestions();
  $("#suggestList").insertAdjacentHTML(
    "beforeend",
    '<li class="si-status">Searching USDA FoodData Central…</li>'
  );

  // 2) then merge in USDA results
  try {
    const url =
      USDA_API_URL +
      "?api_key=" + encodeURIComponent(state.apiKey || USDA_DEMO_KEY) +
      "&query=" + encodeURIComponent(query) +
      "&dataType=" + encodeURIComponent(USDA_DATA_TYPES) +
      "&pageSize=15";
    const res = await fetch(url, { signal: suggestAbort.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();

    const seen = new Set(local.map((p) => p.name.toLowerCase()));
    const online = (data.foods || [])
      .map((f) => ({
        name: (f.description || "").trim(),
        brand: "",
        kcal: Math.round(usdaValue(f, 1008) || usdaValue(f, 1062) / 4.184),
        protein: usdaValue(f, 1003),
        carbs: usdaValue(f, 1005),
        fat: usdaValue(f, 1004),
        servingQty: 0,
        src: "usda",
      }))
      .filter((p) => {
        if (!p.name || p.kcal <= 0) return false;
        const key = p.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 8);

    suggestItems = local.concat(online);
    if (!suggestItems.length) {
      showSuggestStatus("No matches found — you can type the numbers manually.");
      return;
    }
    renderSuggestions();
  } catch (err) {
    if (err && err.name === "AbortError") return;
    if (local.length) {
      renderSuggestions();
      $("#suggestList").insertAdjacentHTML(
        "beforeend",
        '<li class="si-status">Online search unavailable — showing built-in matches only. (Add a free USDA key in Settings for full search.)</li>'
      );
    } else {
      showSuggestStatus("Search unavailable — check your connection, or enter the values manually.");
    }
  }
}

function renderSuggestions() {
  const list = $("#suggestList");
  suggestIndex = -1;
  list.classList.remove("hidden");
  list.innerHTML = suggestItems
    .map((item, i) =>
      '<li class="si-item" data-idx="' + i + '">' +
        '<span class="si-name">' + esc(item.name) + (item.brand ? " · " + esc(item.brand) : "") +
          '<span class="si-src ' + (item.src === "theeti" ? "src-theeti" : "src-usda") + '">' +
            (item.src === "theeti" ? "Theeti" : "USDA") + "</span>" +
        "</span>" +
        '<span class="si-meta">' +
          item.kcal + " kcal / 100 g" +
          " · P " + Math.round(item.protein) + " · C " + Math.round(item.carbs) + " · F " + Math.round(item.fat) +
          (item.pieceGrams ? " · 1 " + item.pieceName + " ≈ " + item.pieceGrams + " g" : "") +
        "</span>" +
      "</li>"
    )
    .join("");
}

function highlightSuggestion() {
  const list = $("#suggestList");
  list.querySelectorAll(".si-item").forEach((li) => {
    li.classList.toggle("active", Number(li.dataset.idx) === suggestIndex);
  });
  const active = list.querySelector(".si-item.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function selectSuggestion(i) {
  const item = suggestItems[i];
  if (!item) return;
  per100 = { kcal: item.kcal, protein: item.protein, carbs: item.carbs, fat: item.fat };
  $("#fName").value = item.brand ? item.name + " — " + item.brand : item.name;

  pieceUnit = null;
  let amountText;
  if (item.pieceGrams) {
    pieceUnit = { grams: item.pieceGrams, name: item.pieceName || "piece" };
    $("#fUnit").value = "pcs";
    $("#fQuantity").value = 1;
    amountText = "1 " + pieceUnit.name + " ≈ " + pieceUnit.grams + " g";
  } else {
    $("#fUnit").value = "g";
    $("#fQuantity").value = item.servingQty > 0 ? Math.round(item.servingQty) : 100;
    amountText = $("#fQuantity").value + " g";
  }
  applyPer100();
  const note = $("#sourceNote");
  note.textContent =
    "✨ Auto-filled from " + (item.src === "usda" ? "USDA FoodData Central" : "Theeti's built-in food list") +
    " (" + amountText + ") — change the amount or edit any number.";
  closeSuggestions();
  $("#fQuantity").focus();
  $("#fQuantity").select();
}

function applyPer100() {
  if (!per100) return; // manual values always win
  const q = Number($("#fQuantity").value);
  const grams = $("#fUnit").value === "pcs" && pieceUnit ? q * pieceUnit.grams : q;
  const factor = isFinite(grams) && grams > 0 ? grams / 100 : 0;
  $("#fCal").value = factor > 0 ? Math.round(per100.kcal * factor) : "";
  $("#fProtein").value = factor > 0 ? round1(per100.protein * factor) : "";
  $("#fCarbs").value = factor > 0 ? round1(per100.carbs * factor) : "";
  $("#fFat").value = factor > 0 ? round1(per100.fat * factor) : "";
}

/* ---------------- summary card ---------------- */
function renderSummary() {
  const dateStr = $("#fDate").value || todayStr();
  const t = totalsForDate(dateStr);
  const goal = state.goal;

  $("#summaryDateLabel").textContent = prettyDate(dateStr);
  $("#summaryCalories").textContent = fmt(t.cal);

  const left = goal - t.cal;
  const remaining = $("#summaryRemaining");
  if (left >= 0) {
    remaining.textContent = fmt(left) + " kcal left";
    remaining.className = "summary-remaining ok";
  } else {
    remaining.textContent = fmt(-left) + " kcal over";
    remaining.className = "summary-remaining over";
  }

  const pct = goal > 0 ? Math.min(100, (t.cal / goal) * 100) : 0;
  const fill = $("#progressFill");
  fill.style.width = pct + "%";
  fill.classList.toggle("over", t.cal > goal);

  $("#sumProtein").textContent = Math.round(t.protein) + "g";
  $("#sumCarbs").textContent = Math.round(t.carbs) + "g";
  $("#sumFat").textContent = Math.round(t.fat) + "g";

  $("#todayListTitle").textContent = prettyDate(dateStr) + "'s food";
}

/* ---------------- entry lists ---------------- */
function entryItemHTML(e) {
  const macros = [];
  if (e.qtyLabel) macros.push(e.qtyLabel);
  else if (e.quantity) macros.push(e.quantity + " g");
  if (e.protein) macros.push("P " + Math.round(e.protein) + "g");
  if (e.carbs) macros.push("C " + Math.round(e.carbs) + "g");
  if (e.fat) macros.push("F " + Math.round(e.fat) + "g");
  return (
    '<li class="entry">' +
      '<div class="entry-main">' +
        '<span class="entry-name">' + esc(e.name) + "</span>" +
        '<span class="entry-meta">' +
          '<span class="badge meal-' + esc(e.meal) + '">' + esc(e.meal) + "</span>" +
          (macros.length ? '<span class="muted">' + macros.join(" · ") + "</span>" : "") +
        "</span>" +
      "</div>" +
      '<div class="entry-right">' +
        "<b>" + fmt(e.calories) + " kcal</b>" +
        '<button class="icon-btn" data-del="' + e.id + '" title="Delete">✕</button>' +
      "</div>" +
    "</li>"
  );
}

function renderTodayList() {
  const dateStr = $("#fDate").value || todayStr();
  const entries = entriesForDate(dateStr);
  const list = $("#todayList");
  if (!entries.length) {
    list.innerHTML = '<li class="empty">Nothing logged for this day yet. Add something above! 🍽️</li>';
  } else {
    list.innerHTML = entries.map(entryItemHTML).join("");
  }
  $("#todayCount").textContent =
    entries.length + (entries.length === 1 ? " item" : " items");
}

/* ---------------- history ---------------- */
function renderHistory() {
  const wrap = $("#historyList");
  const byDate = new Map();
  for (const e of state.entries) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  const dates = [...byDate.keys()].sort().reverse();

  if (!dates.length) {
    wrap.innerHTML = '<p class="empty">Nothing logged yet. Add your first food in the "Add Food" tab!</p>';
    return;
  }

  wrap.innerHTML = dates
    .map((date) => {
      const t = totalsForDate(date);
      const items = entriesForDate(date).map(entryItemHTML).join("");
      let note = "";
      if (t.cal > 0) {
        const diff = t.cal - state.goal;
        note = diff > 0 ? " · " + fmt(diff) + " over goal" : " · " + fmt(-diff) + " under goal";
      }
      return (
        '<details class="history-day"' + (date === todayStr() ? " open" : "") + ">" +
          "<summary>" +
            '<span class="hd-date">' + prettyDate(date) + "</span>" +
            '<span class="hd-total">' + fmt(t.cal) + ' kcal <span class="muted">' + note + "</span></span>" +
          "</summary>" +
          '<ul class="entry-list">' + items + "</ul>" +
        "</details>"
      );
    })
    .join("");
}

/* ---------------- analytics ---------------- */
function statCard(label, value, sub, tone) {
  const cls = tone ? " " + tone : "";
  return (
    '<div class="stat' + cls + '">' +
      '<span class="stat-label">' + label + "</span>" +
      '<span class="stat-value">' + value + "</span>" +
      '<span class="stat-sub">' + sub + "</span>" +
    "</div>"
  );
}

function renderAnalytics() {
  const goal = state.goal;
  const today = totalsForDate(todayStr());
  const days7 = lastNDays(7);
  const days30 = lastNDays(30);
  const avg = (days) => days.reduce((sum, d) => sum + totalsForDate(d).cal, 0) / days.length;
  const daysOnGoal = days30.filter((d) => {
    const c = totalsForDate(d).cal;
    return c > 0 && c <= goal;
  }).length;

  $("#statGrid").innerHTML =
    statCard("Today", fmt(today.cal) + " kcal",
      today.cal === 0 ? "nothing logged" : today.cal <= goal ? "within goal 🎯" : "over goal",
      today.cal === 0 ? "" : today.cal <= goal ? "good" : "bad") +
    statCard("7-day avg", fmt(avg(days7)) + " kcal", "per day") +
    statCard("30-day avg", fmt(avg(days30)) + " kcal", "per day") +
    statCard("Days on goal", daysOnGoal + " / 30", "last 30 days");

  drawBarChart($("#barChart"), lastNDays(14), goal);
  drawDonutChart($("#donutChart"));
  renderTopFoods();
}

function drawBarChart(canvas, days, goal) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || (canvas.parentElement && canvas.parentElement.clientWidth) || 620;
  const cssH = 260;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const values = days.map((d) => totalsForDate(d).cal);
  const maxVal = Math.max(goal * 1.2, ...values, 1);
  const padL = 46, padR = 10, padT = 14, padB = 28;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;

  // gridlines + y-axis labels
  ctx.font = "11px sans-serif";
  ctx.lineWidth = 1;
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const yVal = (maxVal / steps) * i;
    const y = padT + plotH - (yVal / maxVal) * plotH;
    ctx.strokeStyle = "#e3e9ee";
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(cssW - padR, y);
    ctx.stroke();
    ctx.fillStyle = "#6b7a87";
    ctx.textAlign = "right";
    ctx.fillText(Math.round(yVal), padL - 6, y + 4);
  }

  // dashed goal line
  const goalY = padT + plotH - (goal / maxVal) * plotH;
  ctx.save();
  ctx.strokeStyle = "#10b981";
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(padL, goalY);
  ctx.lineTo(cssW - padR, goalY);
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = "#059669";
  ctx.textAlign = "left";
  ctx.fillText("goal", padL + 4, goalY - 5);

  // bars
  const n = days.length;
  const slot = plotW / n;
  const barW = Math.min(34, slot * 0.62);
  values.forEach((v, i) => {
    const x = padL + slot * i + (slot - barW) / 2;
    const h = (v / maxVal) * plotH;
    const y = padT + plotH - h;
    ctx.fillStyle = v === 0 ? "#dfe7ec" : v > goal ? "#f59e0b" : "#10b981";
    const r = Math.min(5, barW / 2, h);
    ctx.beginPath();
    ctx.moveTo(x, padT + plotH);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.lineTo(x + barW - r, y);
    ctx.arcTo(x + barW, y, x + barW, y + r, r);
    ctx.lineTo(x + barW, padT + plotH);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#6b7a87";
    ctx.textAlign = "center";
    ctx.fillText(days[i].slice(8), x + barW / 2, cssH - 8);
  });

  const note = $("#barChartNote");
  if (note) {
    note.textContent = values.every((v) => v === 0)
      ? "No data yet — log some food and your chart will appear here."
      : "Green = under goal · Orange = over goal · Dashed line = daily goal (" + fmt(goal) + " kcal)";
  }
}

/* ---------------- donut chart + top foods ---------------- */
const MACROS = [
  { key: "protein", label: "Protein", color: "#3b82f6" },
  { key: "carbs", label: "Carbs", color: "#f59e0b" },
  { key: "fat", label: "Fat", color: "#a78bfa" },
];

function drawDonutChart(canvas) {
  const days = lastNDays(7);
  const sums = { protein: 0, carbs: 0, fat: 0 };
  for (const d of days) {
    const t = totalsForDate(d);
    sums.protein += t.protein;
    sums.carbs += t.carbs;
    sums.fat += t.fat;
  }
  const total = sums.protein + sums.carbs + sums.fat;

  const dpr = window.devicePixelRatio || 1;
  const size = 220;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const cx = size / 2, cy = size / 2;
  const radius = 88, thickness = 26;
  const legend = $("#donutLegend");

  if (total <= 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = "#e3e9ee";
    ctx.lineWidth = thickness;
    ctx.stroke();
    ctx.fillStyle = "#6b7a87";
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("No macro data yet", cx, cy + 4);
    if (legend) {
      legend.innerHTML = '<li class="muted">Log foods with protein, carbs and fat to see your macro split.</li>';
    }
    return;
  }

  let angle = -Math.PI / 2;
  for (const m of MACROS) {
    const arc = (sums[m.key] / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, angle, angle + arc);
    ctx.strokeStyle = m.color;
    ctx.lineWidth = thickness;
    ctx.lineCap = "butt";
    ctx.stroke();
    angle += arc;
  }

  // estimated kcal from macros (4 / 4 / 9 rule), averaged per day
  const kcal = (sums.protein * 4 + sums.carbs * 4 + sums.fat * 9) / 7;
  ctx.fillStyle = "#17222b";
  ctx.font = "700 18px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(fmt(kcal), cx, cy - 2);
  ctx.fillStyle = "#6b7a87";
  ctx.font = "11px sans-serif";
  ctx.fillText("kcal / day avg", cx, cy + 16);

  if (legend) {
    legend.innerHTML = MACROS
      .map((m) => {
        const g = sums[m.key] / 7;
        const pct = Math.round((sums[m.key] / total) * 100);
        return (
          "<li>" +
            '<span class="swatch" style="background:' + m.color + '"></span>' +
            m.label +
            '<span class="muted">' + pct + "%</span>" +
            "<b>" + Math.round(g) + "g/day</b>" +
          "</li>"
        );
      })
      .join("");
  }
}

function renderTopFoods() {
  const cutoff = shiftDate(todayStr(), -29);
  const foods = new Map();
  for (const e of state.entries) {
    if (e.date < cutoff) continue;
    const key = e.name.trim().toLowerCase();
    if (!foods.has(key)) foods.set(key, { name: e.name, count: 0, cal: 0 });
    const f = foods.get(key);
    f.count += 1;
    f.cal += e.calories || 0;
  }
  const top = [...foods.values()].sort((a, b) => b.cal - a.cal).slice(0, 5);
  const el = $("#topFoods");
  if (!top.length) {
    el.innerHTML = '<li class="muted" style="list-style:none">No foods logged in the last 30 days.</li>';
    return;
  }
  el.innerHTML = top
    .map((f) =>
      "<li><b>" + esc(f.name) + "</b>" +
      '<span class="muted">logged ' + f.count + (f.count === 1 ? " time" : " times") +
      " · " + fmt(f.cal) + " kcal total</span></li>"
    )
    .join("");
}

/* ---------------- master render ---------------- */
function renderSettings() {
  $("#goalInput").value = state.goal;
  $("#apiKeyInput").value = state.apiKey || "";
}

function renderAll() {
  renderSummary();
  renderTodayList();
  renderHistory();
  renderAnalytics();
  renderSettings();
}

/* ---------------- tabs ---------------- */
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === name);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("hidden", panel.id !== "panel-" + name);
  });
  renderAll();
}

/* ---------------- events ---------------- */
function wireEvents() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  $("#fDate").value = todayStr();
  $("#fDate").addEventListener("change", () => {
    renderSummary();
    renderTodayList();
  });

  // ---- food search wiring (built-in list + USDA) ----
  $("#fName").addEventListener("input", onNameInput);
  $("#fName").addEventListener("keydown", (ev) => {
    const list = $("#suggestList");
    if (list.classList.contains("hidden") || !suggestItems.length) return;
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      suggestIndex = Math.min(suggestIndex + 1, suggestItems.length - 1);
      highlightSuggestion();
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      suggestIndex = Math.max(suggestIndex - 1, 0);
      highlightSuggestion();
    } else if (ev.key === "Enter" && suggestIndex >= 0) {
      ev.preventDefault(); // pick the highlighted match instead of submitting
      selectSuggestion(suggestIndex);
    } else if (ev.key === "Escape") {
      closeSuggestions();
    }
  });
  $("#suggestList").addEventListener("mousedown", (ev) => {
    const li = ev.target.closest(".si-item");
    if (!li) return;
    ev.preventDefault(); // keep focus in the input
    selectSuggestion(Number(li.dataset.idx));
  });
  $("#fQuantity").addEventListener("input", applyPer100);
  $("#fUnit").addEventListener("change", applyPer100);
  // manual edits to the numbers win over the auto-fill
  ["fCal", "fProtein", "fCarbs", "fFat"].forEach((id) => {
    $("#" + id).addEventListener("input", clearPer100);
  });
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest(".suggest-wrap")) closeSuggestions();
  });

  $("#addForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const name = $("#fName").value.trim();
    const calories = Math.round(Number($("#fCal").value));
    if (!name || !calories || calories <= 0) return;

    const qRaw = Number($("#fQuantity").value) || 0;
    const qtyGrams = $("#fUnit").value === "pcs" && pieceUnit
      ? Math.round(qRaw * pieceUnit.grams)
      : (qRaw || null);

    state.entries.push({
      id: uid(),
      date: $("#fDate").value || todayStr(),
      name: name,
      meal: $("#fMeal").value,
      quantity: qtyGrams,
      qtyLabel: $("#fUnit").value === "pcs" && pieceUnit
        ? $("#fQuantity").value + " " + pieceUnit.name
        : null,
      calories: calories,
      protein: Number($("#fProtein").value) || 0,
      carbs: Number($("#fCarbs").value) || 0,
      fat: Number($("#fFat").value) || 0,
      source: per100 ? "openfoodfacts" : "manual",
      createdAt: Date.now(),
    });
    save();

    per100 = null;
    pieceUnit = null;
    $("#sourceNote").textContent = "";
    $("#fQuantity").value = "";
    $("#fUnit").value = "g";
    closeSuggestions();
    $("#fName").value = "";
    $("#fCal").value = "";
    $("#fProtein").value = "";
    $("#fCarbs").value = "";
    $("#fFat").value = "";
    $("#fMeal").value = guessMeal(); // pre-pick the next meal by time of day
    $("#fName").focus();

    renderAll();
  });

  // delete buttons (delegated, works in Today list and History)
  document.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-del]");
    if (!btn) return;
    const id = btn.dataset.del;
    const entry = state.entries.find((e) => e.id === id);
    if (!entry) return;
    if (!confirm('Delete "' + entry.name + '" (' + entry.date + ")?")) return;
    state.entries = state.entries.filter((e) => e.id !== id);
    save();
    renderAll();
  });

  $("#saveGoal").addEventListener("click", () => {
    const val = Math.round(Number($("#goalInput").value));
    if (!val || val < 500) {
      alert("Please enter a goal of at least 500 kcal.");
      return;
    }
    state.goal = val;
    save();
    renderAll();
  });

  $("#saveApiKey").addEventListener("click", () => {
    state.apiKey = $("#apiKeyInput").value.trim();
    save();
    alert(state.apiKey ? "USDA API key saved ✓" : "API key cleared — using the shared demo key.");
  });

  $("#exportBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "theeti-backup-" + todayStr() + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  $("#sampleBtn").addEventListener("click", () => {
    if (!confirm("Add ~14 days of realistic sample data so you can explore the app?")) return;
    loadSampleData();
    save();
    renderAll();
  });

  $("#clearBtn").addEventListener("click", () => {
    if (!confirm("Erase ALL data? This cannot be undone.")) return;
    if (!confirm("Really sure? Your entire food log will be deleted.")) return;
    state = { goal: 2000, apiKey: state.apiKey, entries: [] };
    save();
    renderAll();
  });

  window.addEventListener("resize", () => {
    if (!$("#panel-analytics").classList.contains("hidden")) {
      renderAnalytics();
    }
  });

  // keep multiple tabs/windows of the same browser in sync
  window.addEventListener("storage", (ev) => {
    if (currentUser && ev.key === dataKey(currentUser.email)) {
      state = loadData();
      renderAll();
    }
  });
}

/* ---------------- sample data ---------------- */
const SAMPLE_FOODS = [
  { name: "Oatmeal with banana & honey", meal: "breakfast", cal: 340, protein: 9, carbs: 62, fat: 7 },
  { name: "Scrambled eggs on toast", meal: "breakfast", cal: 380, protein: 20, carbs: 30, fat: 18 },
  { name: "Greek yogurt with berries", meal: "breakfast", cal: 220, protein: 17, carbs: 24, fat: 5 },
  { name: "Grilled chicken & rice", meal: "lunch", cal: 620, protein: 45, carbs: 68, fat: 15 },
  { name: "Turkey sandwich", meal: "lunch", cal: 450, protein: 28, carbs: 42, fat: 16 },
  { name: "Sushi platter", meal: "lunch", cal: 560, protein: 24, carbs: 78, fat: 12 },
  { name: "Salmon, potatoes & greens", meal: "dinner", cal: 680, protein: 42, carbs: 52, fat: 30 },
  { name: "Spaghetti bolognese", meal: "dinner", cal: 720, protein: 32, carbs: 85, fat: 24 },
  { name: "Chicken stir-fry", meal: "dinner", cal: 540, protein: 38, carbs: 45, fat: 20 },
  { name: "Apple", meal: "snack", cal: 95, protein: 0, carbs: 25, fat: 0 },
  { name: "Handful of almonds", meal: "snack", cal: 170, protein: 6, carbs: 6, fat: 15 },
  { name: "Protein shake", meal: "snack", cal: 160, protein: 30, carbs: 5, fat: 2 },
  { name: "Chocolate chip cookie", meal: "snack", cal: 220, protein: 2, carbs: 30, fat: 10 },
];

function loadSampleData() {
  let created = Date.now();
  for (let i = 13; i >= 0; i--) {
    const date = shiftDate(todayStr(), -i);
    const count = 3 + Math.floor(Math.random() * 3); // 3-5 items per day
    const picked = [...SAMPLE_FOODS].sort(() => Math.random() - 0.5).slice(0, count);
    for (const f of picked) {
      const variation = 0.85 + Math.random() * 0.3; // ±15% portion sizes
      created += 1;
      state.entries.push({
        id: uid() + created.toString(36),
        date: date,
        name: f.name,
        meal: f.meal,
        calories: Math.round((f.cal * variation) / 5) * 5,
        protein: Math.round(f.protein * variation),
        carbs: Math.round(f.carbs * variation),
        fat: Math.round(f.fat * variation),
        createdAt: created,
      });
    }
  }
}

/* ---------------- auth (local accounts) ---------------- */
function getUsers() {
  try {
    return JSON.parse(localStorage.getItem(USERS_KEY)) || {};
  } catch (err) {
    return {};
  }
}

function saveUsers(users) {
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

async function hashPassword(password, salt) {
  if (window.crypto && crypto.subtle) {
    const bytes = new TextEncoder().encode(salt + ":" + password);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // fallback for contexts without Web Crypto (very rare)
  let h = 5381;
  const s = salt + ":" + password;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return "fb" + h.toString(16);
}

function showAuthError(msg) {
  const el = $("#authError");
  el.textContent = msg;
  el.classList.remove("hidden");
}

function switchAuthTab(name) {
  document.querySelectorAll(".auth-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.auth === name);
  });
  $("#loginForm").classList.toggle("hidden", name !== "login");
  $("#registerForm").classList.toggle("hidden", name !== "register");
  $("#authError").classList.add("hidden");
}

function startApp(user) {
  currentUser = user;
  localStorage.setItem(SESSION_KEY, user.email);
  state = loadData();
  $("#authScreen").classList.add("hidden");
  $("#appShell").classList.remove("hidden");
  $("#userName").textContent = user.name || user.email;
  $("#fDate").value = todayStr();
  $("#fMeal").value = guessMeal();
  renderAll();
}

function logout() {
  localStorage.removeItem(SESSION_KEY);
  location.reload();
}

function wireAuth() {
  document.querySelectorAll(".auth-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchAuthTab(btn.dataset.auth));
  });

  $("#loginForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const email = $("#loginEmail").value.trim().toLowerCase();
    const password = $("#loginPassword").value;
    const user = getUsers()[email];
    if (!user) {
      showAuthError("No account found for that email — switch to Register to create one.");
      return;
    }
    const hash = await hashPassword(password, user.salt);
    if (hash !== user.hash) {
      showAuthError("Wrong password — try again.");
      return;
    }
    startApp({ email: email, name: user.name });
  });

  $("#registerForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const name = $("#regName").value.trim();
    const email = $("#regEmail").value.trim().toLowerCase();
    const password = $("#regPassword").value;
    const confirm = $("#regConfirm").value;
    if (!name) {
      showAuthError("Please enter your name.");
      return;
    }
    if (password !== confirm) {
      showAuthError("Passwords don't match.");
      return;
    }
    const users = getUsers();
    if (users[email]) {
      showAuthError("An account with that email already exists — log in instead.");
      return;
    }
    const salt = uid();
    users[email] = {
      name: name,
      salt: salt,
      hash: await hashPassword(password, salt),
      createdAt: Date.now(),
    };
    saveUsers(users);
    startApp({ email: email, name: name });
  });

  $("#logoutBtn").addEventListener("click", logout);
}

/* ---------------- init ---------------- */
document.addEventListener("DOMContentLoaded", () => {
  wireEvents();
  wireAuth();
  const sessionEmail = localStorage.getItem(SESSION_KEY);
  const users = getUsers();
  if (sessionEmail && users[sessionEmail]) {
    startApp({ email: sessionEmail, name: users[sessionEmail].name });
  } else {
    $("#authScreen").classList.remove("hidden");
  }
});



