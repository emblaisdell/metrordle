"use strict";

// Fully client-side Metrordle: the secret station, line comparison, and
// direction are all computed in the browser. Station data is loaded from the
// static JSON files in ./data (same files the server uses).

// Direction -> arrow glyph for the results table.
const ARROWS = {
  N: "↑", NE: "↗", E: "→", SE: "↘",
  S: "↓", SW: "↙", W: "←", NW: "↖",
};
// 8 semi-cardinal directions, clockwise from North.
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
// Data files; the first one is the default system (WMATA).
const DATA_FILES = ["data/wmata.json", "data/philly.json"];

const els = {
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

let systems = {};         // key -> { key, name, shape, colors, labels, stations, lookup }
let systemOrder = [];     // system keys in load order
let game = null;          // { target, lines: Set|null, guesses: number, over: bool }

let allStations = [];     // stations for the current system
let lineColors = {};      // line name -> hex color
let lineLabels = {};      // line name -> short letter shown in the marker
let markerShape = "circle"; // "circle" (WMATA) | "square" (SEPTA)
let allLines = [];        // line names for the current system
let selectedLines = new Set(); // lines currently in play
let suggestions = [];     // currently shown stations
let activeIndex = -1;     // highlighted suggestion
let filterTimer = null;   // debounce for line-filter changes

const currentSystem = () => els.system.value;
const sys = () => systems[currentSystem()];

// ---- Game logic (ported from the server) ----

function normalize(text) {
  return text.trim().toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

function buildLookup(stations) {
  const m = {};
  for (const s of stations) {
    for (const key of [s.name, ...(s.aliases || [])]) m[normalize(key)] = s;
  }
  return m;
}

// Resolve a user-typed name (or alias) to a station within a system.
function findStation(system, query) {
  if (!query) return null;
  return system.lookup[normalize(query)] || null;
}

// "all" = identical line sets, "some" = overlap, "none" = disjoint.
function compareLines(guess, target) {
  const t = new Set(target.lines);
  const shared = guess.lines.filter((l) => t.has(l));
  let match;
  if (guess.lines.length === target.lines.length && shared.length === t.size) {
    match = "all";
  } else {
    match = shared.length ? "some" : "none";
  }
  return { match, shared };
}

// Great-circle initial bearing from guess to target, bucketed into 8 sectors.
function bearingToDirection(guess, target) {
  if (guess.lat === target.lat && guess.lon === target.lon) return null;
  const rad = (d) => (d * Math.PI) / 180;
  const lat1 = rad(guess.lat), lat2 = rad(target.lat), dLon = rad(target.lon - guess.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const bearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return COMPASS[Math.floor(((bearing + 22.5) % 360) / 45)];
}

function stationsForLines(stations, linesSet) {
  if (!linesSet) return stations;
  return stations.filter((s) => s.lines.some((l) => linesSet.has(l)));
}

// ---- UI helpers ----

function setMessage(text, kind = "") {
  els.message.textContent = text;
  els.message.className = "message" + (kind ? " " + kind : "");
}

function setGameOver(over) {
  els.guessBtn.disabled = over;
  els.station.disabled = over;
}

// Pick black or white text for legibility against a given hex background.
function textOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "#fff";
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
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
  els.body.prepend(tr);   // newest guess on top
}

function loadStations() {
  const s = sys();
  allStations = s.stations;
  lineColors = s.colors || {};
  lineLabels = s.labels || {};
  markerShape = s.shape || "circle";
  allLines = Object.keys(lineLabels);
  selectedLines = new Set(allLines);   // everything in play by default
  renderLineFilter();
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

// ---- Game flow ----

function newGame() {
  // Use the line subset only when it's a true subset (all selected => no filter).
  const subset = selectedLines.size < allLines.length ? new Set(selectedLines) : null;
  const pool = stationsForLines(allStations, subset);
  const target = pool[Math.floor(Math.random() * pool.length)];
  game = { target, lines: subset, guesses: 0, over: false };

  setGameOver(false);
  els.body.innerHTML = "";
  els.empty.hidden = false;
  const scope = subset ? `${subset.size} line${subset.size === 1 ? "" : "s"}` : "all lines";
  setMessage(`New ${sys().name} game (${scope}). Good luck!`, "good");
  els.station.value = "";
}

// Switching systems reloads that system's stations, then starts a fresh game.
function changeSystem() {
  loadStations();
  newGame();
}

function submitGuess() {
  const name = els.station.value.trim();
  if (!name) return;
  if (!game) newGame();

  const station = findStation(sys(), name);
  if (station === null) {
    setMessage(`Unknown station: ${name}`, "bad");
    return;
  }
  if (game.lines && !station.lines.some((l) => game.lines.has(l))) {
    setMessage(`${station.name} is not on a selected line for this game.`, "bad");
    return;
  }

  const { match, shared } = compareLines(station, game.target);
  const direction = bearingToDirection(station, game.target);
  const correct = station.name === game.target.name;
  game.guesses += 1;

  renderGuess(
    { guess: station.name, lines: station.lines, line_match: match,
      shared_lines: shared, direction, correct },
    game.guesses,
  );
  els.station.value = "";
  closeSuggestions();

  if (correct) {
    game.over = true;
    setGameOver(true);
    setMessage(`🎉 Solved in ${game.guesses} guess${game.guesses === 1 ? "" : "es"}! It was ${game.target.name}.`, "good");
  } else {
    setMessage(`${match} lines in common · answer is to the ${direction}.`);
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

// ---- Boot: load the static data files, then start a game ----

async function boot() {
  try {
    const loaded = await Promise.all(DATA_FILES.map((f) =>
      fetch(f).then((r) => {
        if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
        return r.json();
      })));
    for (const d of loaded) {
      d.lookup = buildLookup(d.stations);
      systems[d.key] = d;
      systemOrder.push(d.key);
    }
    els.system.innerHTML = systemOrder
      .map((k) => `<option value="${k}">${systems[k].name}</option>`)
      .join("");
    els.system.value = systemOrder[0];   // WMATA is the default
    loadStations();
    newGame();
  } catch (err) {
    setMessage("Could not load station data: " + err.message, "bad");
  }
}

boot();
