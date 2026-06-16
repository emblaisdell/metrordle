"use strict";

// Direction -> arrow glyph for the results table.
const ARROWS = {
  N: "↑", NE: "↗", E: "→", SE: "↘",
  S: "↓", SW: "↙", W: "←", NW: "↖",
};


const els = {
  api: document.getElementById("api"),
  system: document.getElementById("system"),
  lineFilter: document.getElementById("line-filter"),
  lineSummary: document.getElementById("line-summary"),
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
let allLines = [];        // line names for the current system, in API order
let selectedLines = new Set(); // lines currently in play
let suggestions = [];     // currently shown stations
let activeIndex = -1;     // highlighted suggestion
let filterTimer = null;   // debounce for line-filter changes

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
    allLines = Object.keys(lineLabels);
    selectedLines = new Set(allLines);   // everything in play by default
    renderLineFilter();
  } catch (err) {
    setMessage("Could not load stations: " + err.message, "bad");
  }
}

// ---- Line filter ----

const stationInPlay = (s) => s.lines.some((l) => selectedLines.has(l));

function renderLineFilter() {
  els.lineSummary.textContent =
    selectedLines.size === allLines.length
      ? "all"
      : `${selectedLines.size} of ${allLines.length}`;
  els.lineFilter.innerHTML = allLines
    .map((l) => `
      <button type="button" class="line-chip" data-line="${l}"
              aria-pressed="${selectedLines.has(l)}" title="${l}">
        ${lineDots([l])}
        <span>${l}</span>
      </button>`)
    .join("");
}

function toggleLine(line) {
  if (selectedLines.has(line)) {
    if (selectedLines.size === 1) return;   // keep at least one line in play
    selectedLines.delete(line);
  } else {
    selectedLines.add(line);
  }
  renderLineFilter();
  closeSuggestions();
  // Debounce so toggling several chips starts just one new game.
  clearTimeout(filterTimer);
  filterTimer = setTimeout(newGame, 500);
}

els.lineFilter.addEventListener("click", (e) => {
  const chip = e.target.closest(".line-chip");
  if (chip) toggleLine(chip.dataset.line);
});

// ---- Custom autocomplete combobox ----

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]
  ));
}

// Bold every occurrence of each search token within a station name.
function highlight(name, tokens) {
  if (!tokens.length) return escapeHtml(name);
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("(" + tokens.map(escapeRe).join("|") + ")", "ig");
  let out = "", last = 0, m;
  while ((m = re.exec(name)) !== null) {
    if (m.index >= last) {
      out += escapeHtml(name.slice(last, m.index)) +
        `<span class="match">${escapeHtml(m[0])}</span>`;
      last = m.index + m[0].length;
    }
    if (m.index === re.lastIndex) re.lastIndex++;  // avoid zero-length loop
  }
  return out + escapeHtml(name.slice(last));
}

function closeSuggestions() {
  els.suggestions.hidden = true;
  els.station.setAttribute("aria-expanded", "false");
  activeIndex = -1;
}

function renderSuggestions(query) {
  const q = query.trim().toLowerCase();
  // Space-separated tokens may appear anywhere in the name, in any order.
  const tokens = q.split(/\s+/).filter(Boolean);
  const first = tokens[0] || "";
  // Show every match once the query has 4+ letters; otherwise cap the list.
  const cap = q.replace(/\s+/g, "").length >= 4 ? Infinity : 8;

  suggestions = allStations
    .filter((s) => {
      const name = s.name.toLowerCase();
      return stationInPlay(s) && tokens.every((t) => name.includes(t));
    })
    .sort((a, b) => {
      const ap = a.name.toLowerCase().startsWith(first) ? 0 : 1;
      const bp = b.name.toLowerCase().startsWith(first) ? 0 : 1;
      return ap - bp || a.name.localeCompare(b.name);
    })
    .slice(0, cap);
  activeIndex = -1;

  if (suggestions.length === 0) {
    els.suggestions.innerHTML = `<li class="no-results">No matching station</li>`;
  } else {
    els.suggestions.innerHTML = suggestions
      .map((s, i) => `
        <li role="option" id="opt-${i}" aria-selected="false">
          <span class="dots">${lineDots(s.lines)}</span>
          <span class="name">${highlight(s.name, tokens)}</span>
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
    // Send the line subset only when it's a true subset (all selected => omit).
    const lines = selectedLines.size < allLines.length ? [...selectedLines] : undefined;
    const game = await api("/games", {
      method: "POST",
      body: JSON.stringify({ system: currentSystem(), lines }),
    });
    gameId = game.id;
    setGameOver(false);
    els.body.innerHTML = "";
    els.empty.hidden = false;
    const scope = lines ? `${lines.length} line${lines.length === 1 ? "" : "s"}` : "all lines";
    setMessage(`New ${game.system_name} game (${scope}). Good luck!`, "good");
    els.station.value = "";
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
