"use strict";

// Direction -> arrow glyph for the results table.
const ARROWS = {
  N: "↑", NE: "↗", E: "→", SE: "↘",
  S: "↓", SW: "↙", W: "←", NW: "↖",
};


const els = {
  api: document.getElementById("api"),
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
let allStations = [];   // [{ name, lines }]
let suggestions = [];   // currently shown stations
let activeIndex = -1;   // highlighted suggestion

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

function lineDots(lines) {
  return lines
    .map((l) => `<span class="line-dot" style="background:var(--${l})" title="${l}"></span>`)
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

async function loadStations() {
  try {
    const data = await api("/stations");
    allStations = data.stations;
  } catch (err) {
    setMessage("Could not reach API at " + apiBase() + ": " + err.message, "bad");
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
    const game = await api("/games", { method: "POST", body: "{}" });
    gameId = game.id;
    setGameOver(false);
    els.body.innerHTML = "";
    els.empty.hidden = false;
    setMessage("New game started. Good luck!", "good");
    els.station.focus();
  } catch (err) {
    setMessage("Failed to start game: " + err.message, "bad");
  }
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
els.api.addEventListener("change", loadStations);

// Boot up.
loadStations().then(newGame);
