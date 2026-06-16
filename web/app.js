"use strict";

// Direction -> arrow glyph for the results table.
const ARROWS = {
  N: "↑", NE: "↗", E: "→", SE: "↘",
  S: "↓", SW: "↙", W: "←", NW: "↖",
};


const els = {
  api: document.getElementById("api"),
  system: document.getElementById("system"),
  station: document.getElementById("station"),
  combobox: document.getElementById("combobox"),
  suggestions: document.getElementById("suggestions"),
  guessBtn: document.getElementById("guess-btn"),
  newBtn: document.getElementById("new-btn"),
  message: document.getElementById("message"),
  body: document.getElementById("guess-body"),
  empty: document.getElementById("empty"),
};

let gameId = null;
let gameOver = false;
let allStations = [];     // [{ name, lines }] for the current system
let lineColors = {};      // line name -> hex color for the current system
let lineLabels = {};      // line name -> short letter shown in the marker
let markerShape = "circle"; // "circle" (WMATA) | "square" (SEPTA)
let suggestions = [];     // currently shown stations
let activeIndex = -1;     // highlighted suggestion

const currentSystem = () => els.system.value;

const apiBase = () => els.api.value.replace(/\/$/, "");

async function api(path, options = {}) {
  const resp = await fetch(apiBase() + path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = resp.status === 204 ? null : await resp.json();
  if (!resp.ok) {
    throw new Error((data && (data.error || data.hint)) || `HTTP ${resp.status}`);
  }
  return data;
}

function setMessage(text, kind = "") {
  els.message.textContent = text;
  els.message.className = "message" + (kind ? " " + kind : "");
}

function setGameOver(over) {
  gameOver = over;
  els.guessBtn.disabled = over;
  els.station.disabled = over;
}

// Pick black or white text for legibility against a given hex background.
function textOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "#fff";
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  // Relative luminance (sRGB approximation).
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#111" : "#fff";
}

// A line marker: colored circle/square with the line's letter inside.
function lineDots(lines) {
  return lines
    .map((l) => {
      const bg = lineColors[l] || "#888";
      const letter = lineLabels[l] || l.charAt(0).toUpperCase();
      return `<span class="line-marker shape-${markerShape}"
        style="background:${bg};color:${textOn(bg)}" title="${l}">${letter}</span>`;
    })
    .join("");
}

function renderGuess(result, number) {
  els.empty.hidden = true;
  const tr = document.createElement("tr");
  if (result.correct) tr.className = "correct";
  const dir = result.correct ? "🎯" : (ARROWS[result.direction] || "");
  tr.innerHTML = `
    <td>${number}</td>
    <td>${result.guess}</td>
    <td>
      <span class="badge ${result.line_match}">
        <span class="dots">${lineDots(result.lines)}</span>
        <span class="badge-text">${result.line_match}</span>
      </span>
    </td>
    <td class="dir" title="${result.direction || ""}">${dir} ${result.correct ? "" : (result.direction || "")}</td>
  `;
  // Newest guess on top.
  els.body.prepend(tr);
}

async function loadSystems() {
  try {
    const data = await api("/systems");
    els.system.innerHTML = data.systems
      .map((s) => `<option value="${s.key}">${s.name}</option>`)
      .join("");
    els.system.value = data.default;   // WMATA is the default
  } catch (err) {
    setMessage("Could not reach API at " + apiBase() + ": " + err.message, "bad");
  }
}

async function loadStations() {
  try {
    const data = await api(`/stations?system=${encodeURIComponent(currentSystem())}`);
    allStations = data.stations;
    lineColors = data.colors || {};
    lineLabels = data.labels || {};
    markerShape = data.shape || "circle";
  } catch (err) {
    setMessage("Could not load stations: " + err.message, "bad");
  }
}

// ---- Custom autocomplete combobox ----

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]
  ));
}

// Bold the matched substring within a station name.
function highlight(name, query) {
  if (!query) return escapeHtml(name);
  const i = name.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return escapeHtml(name);
  return escapeHtml(name.slice(0, i)) +
    `<span class="match">${escapeHtml(name.slice(i, i + query.length))}</span>` +
    escapeHtml(name.slice(i + query.length));
}

function closeSuggestions() {
  els.suggestions.hidden = true;
  els.station.setAttribute("aria-expanded", "false");
  activeIndex = -1;
}

function renderSuggestions(query) {
  const q = query.trim().toLowerCase();
  // Prefix matches first, then any substring match; cap the list.
  suggestions = allStations
    .filter((s) => s.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return ap - bp || a.name.localeCompare(b.name);
    })
    .slice(0, 8);
  activeIndex = -1;

  if (suggestions.length === 0) {
    els.suggestions.innerHTML = `<li class="no-results">No matching station</li>`;
  } else {
    els.suggestions.innerHTML = suggestions
      .map((s, i) => `
        <li role="option" id="opt-${i}" aria-selected="false">
          <span class="dots">${lineDots(s.lines)}</span>
          <span class="name">${highlight(s.name, query)}</span>
        </li>`)
      .join("");
  }
  els.suggestions.hidden = false;
  els.station.setAttribute("aria-expanded", "true");
}

function setActive(index) {
  const items = els.suggestions.querySelectorAll("li[role=option]");
  if (items.length === 0) return;
  activeIndex = (index + items.length) % items.length;
  items.forEach((li, i) => {
    const on = i === activeIndex;
    li.setAttribute("aria-selected", on ? "true" : "false");
    if (on) li.scrollIntoView({ block: "nearest" });
  });
  els.station.setAttribute("aria-activedescendant", `opt-${activeIndex}`);
}

function chooseSuggestion(index) {
  const choice = suggestions[index];
  if (!choice) return;
  els.station.value = choice.name;
  closeSuggestions();
  submitGuess();
}

els.station.addEventListener("input", () => renderSuggestions(els.station.value));
els.station.addEventListener("focus", () => {
  if (els.station.value !== undefined) renderSuggestions(els.station.value);
});

els.suggestions.addEventListener("mousedown", (e) => {
  // mousedown (not click) so we beat the input's blur.
  const li = e.target.closest("li[role=option]");
  if (!li) return;
  e.preventDefault();
  chooseSuggestion(Number(li.id.slice(4)));
});

document.addEventListener("click", (e) => {
  if (!els.combobox.contains(e.target)) closeSuggestions();
});

async function newGame() {
  try {
    const game = await api("/games", {
      method: "POST",
      body: JSON.stringify({ system: currentSystem() }),
    });
    gameId = game.id;
    setGameOver(false);
    els.body.innerHTML = "";
    els.empty.hidden = false;
    setMessage(`New ${game.system_name} game started. Good luck!`, "good");
    els.station.value = "";
    els.station.focus();
  } catch (err) {
    setMessage("Failed to start game: " + err.message, "bad");
  }
}

// Switching systems reloads that system's stations, then starts a fresh game.
async function changeSystem() {
  await loadStations();
  await newGame();
}

async function submitGuess() {
  const station = els.station.value.trim();
  if (!station) return;
  if (!gameId) { await newGame(); }
  try {
    const data = await api(`/games/${gameId}/guesses`, {
      method: "POST",
      body: JSON.stringify({ station }),
    });
    renderGuess(data.result, data.guess_count);
    els.station.value = "";
    closeSuggestions();
    if (data.solved) {
      setGameOver(true);
      setMessage(`🎉 Solved in ${data.guess_count} guess${data.guess_count === 1 ? "" : "es"}! It was ${data.answer}.`, "good");
    } else {
      const r = data.result;
      setMessage(`${r.line_match} lines in common · answer is to the ${r.direction}.`);
    }
  } catch (err) {
    setMessage(err.message, "bad");
  }
}

els.guessBtn.addEventListener("click", submitGuess);
els.station.addEventListener("keydown", (e) => {
  const open = !els.suggestions.hidden;
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      if (!open) renderSuggestions(els.station.value);
      setActive(activeIndex + 1);
      break;
    case "ArrowUp":
      e.preventDefault();
      if (open) setActive(activeIndex - 1);
      break;
    case "Enter":
      e.preventDefault();
      if (open && activeIndex >= 0) chooseSuggestion(activeIndex);
      else submitGuess();
      break;
    case "Escape":
      closeSuggestions();
      break;
  }
});
els.newBtn.addEventListener("click", newGame);
els.system.addEventListener("change", changeSystem);
els.api.addEventListener("change", async () => { await loadSystems(); await changeSystem(); });

// Boot up: discover systems (defaults to WMATA), load its stations, start a game.
loadSystems().then(loadStations).then(newGame);
