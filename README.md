# Metrordle

A Wordle-style guessing game for WMATA (Washington DC Metro) stations. The
backend in [`server/`](server/) is a **JSON REST API**; a thin, statically
served browser UI lives in [`web/`](web/). The server picks a secret station;
you guess stations and, for each guess, learn just two things:

1. **Line match** — whether you share `all`, `some`, or `none` of the secret
   station's Metro lines.
2. **Direction** — which of the **8 semi-cardinal directions** (`N`, `NE`, `E`,
   `SE`, `S`, `SW`, `W`, `NW`) the secret station lies in, relative to your guess.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Run

**1. Start the API** (port 5000):

```bash
.venv/bin/python app.py            # http://127.0.0.1:5000
# or: .venv/bin/flask --app app run
```

**2. Serve the UI** (any static file server; port 8000 here):

```bash
python3 -m http.server 8000 --directory web
```

Then open <http://127.0.0.1:8000>. The page calls the API at
`http://127.0.0.1:5000` (editable in the footer). The API sends permissive CORS
headers so the two origins can talk; no UI build step is required.

## Test

```bash
.venv/bin/pip install pytest
.venv/bin/python -m pytest
```

## API

| Method & path                 | Description                                            |
|-------------------------------|--------------------------------------------------------|
| `GET /`                       | API description and endpoint index.                    |
| `GET /stations`               | List every guessable station and its lines.            |
| `POST /games`                 | Start a game. Optional body `{"seed": <int>}`.         |
| `GET /games/<id>`             | Current game state (history; answer only once over).   |
| `POST /games/<id>/guesses`    | Submit a guess: body `{"station": "<name>"}`.          |
| `POST /games/<id>/give-up`    | Reveal the answer and end the game.                    |
| `DELETE /games/<id>`          | Delete a game.                                         |

### Example session

```bash
# Start a game
curl -s -X POST localhost:5000/games
# {"id":"3f9c...","solved":false,"gave_up":false,"guess_count":0,"guesses":[]}

# Make a guess
curl -s -X POST localhost:5000/games/3f9c.../guesses \
     -H 'Content-Type: application/json' \
     -d '{"station": "Gallery Place"}'
# {
#   "result": {
#     "guess": "Gallery Place",
#     "lines": ["Red", "Green", "Yellow"],
#     "line_match": "some",
#     "shared_lines": ["Red"],
#     "direction": "NW",
#     "correct": false
#   },
#   "solved": false,
#   "guess_count": 1
# }
```

When you guess correctly, the response includes `"solved": true` and the
`"answer"`. The `direction` is `null` for a correct guess (you're already there).

Station names are matched loosely — case, punctuation, and common aliases
(e.g. `Chinatown` → `Gallery Place`, `White Flint` → `North Bethesda`) all work.

## Layout

```
app.py                    # entry point for the API
server/                   # backend: JSON REST API
  app.py                  # Flask routes
  game.py                 # game store, line comparison, compass bearing
  stations.py             # loads station data, name/alias resolution
  stations.json           # static WMATA station dataset (name, lines, lat/lon)
web/                      # frontend: statically served UI
  index.html
  styles.css
  app.js                  # talks to the API via fetch()
tests/test_metrordle.py
```

### Data

`server/stations.json` holds the 97 stations of the current Metro system with
their serving lines (post-2023 service pattern) and approximate coordinates.
Coordinates only need to be accurate enough to resolve relative compass
directions between stations.
