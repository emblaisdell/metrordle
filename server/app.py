"""Flask JSON REST API for Metrordle."""

from __future__ import annotations

from flask import Flask, jsonify, request

from .game import GameStore
from .stations import DEFAULT_SYSTEM, get_system, list_systems


def create_app(store: GameStore | None = None) -> Flask:
    app = Flask(__name__)
    app.config["JSON_SORT_KEYS"] = False
    games = store or GameStore()

    @app.after_request
    def add_cors_headers(response):
        # Allow the statically served UI (a different origin) to call the API.
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return response

    @app.route("/", methods=["OPTIONS"])
    @app.route("/<path:_path>", methods=["OPTIONS"])
    def cors_preflight(_path: str = ""):
        return "", 204

    @app.get("/")
    def index():
        """Discoverable API root describing the available endpoints."""
        return jsonify({
            "name": "Metrordle",
            "description": "Guess the secret transit station. Each guess reports "
                           "whether you share all/some/no lines, and which of 8 "
                           "compass directions the answer lies in.",
            "default_system": DEFAULT_SYSTEM,
            "endpoints": {
                "GET /systems": "List available transit systems.",
                "GET /stations?system=<key>": "List guessable stations for a system.",
                "POST /games": "Start a game. Optional JSON {\"system\": key, \"seed\": int}.",
                "GET /games/<id>": "Get current game state.",
                "POST /games/<id>/guesses": "Submit a guess: JSON {\"station\": name}.",
                "POST /games/<id>/give-up": "Reveal the answer and end the game.",
                "DELETE /games/<id>": "Delete a game.",
            },
        })

    @app.get("/systems")
    def list_all_systems():
        return jsonify({
            "default": DEFAULT_SYSTEM,
            "systems": [
                {"key": s.key, "name": s.name, "station_count": len(s.stations)}
                for s in list_systems()
            ],
        })

    @app.get("/stations")
    def list_stations():
        key = request.args.get("system")
        system = get_system(key)
        if system is None:
            return jsonify({"error": f"unknown system: {key!r}"}), 404
        return jsonify({
            "system": system.key,
            "system_name": system.name,
            "shape": system.shape,
            "colors": system.colors,
            "labels": system.labels,
            "count": len(system.stations),
            "stations": [
                {"name": s.name, "lines": list(s.lines)} for s in system.stations
            ],
        })

    @app.post("/games")
    def create_game():
        body = request.get_json(silent=True) or {}
        seed = body.get("seed")
        if seed is not None and not isinstance(seed, int):
            return jsonify({"error": "seed must be an integer"}), 400
        key = body.get("system")
        system = get_system(key)
        if system is None:
            return jsonify({"error": f"unknown system: {key!r}"}), 400

        lines = body.get("lines")
        if lines is not None:
            if not isinstance(lines, list) or not lines:
                return jsonify({"error": "lines must be a non-empty list"}), 400
            unknown = [l for l in lines if l not in system.colors]
            if unknown:
                return jsonify({"error": f"unknown lines: {unknown}"}), 400

        game = games.create(system, seed=seed, lines=lines)
        return jsonify(game.to_dict()), 201

    @app.get("/games/<game_id>")
    def get_game(game_id: str):
        game = games.get(game_id)
        if game is None:
            return jsonify({"error": "game not found"}), 404
        return jsonify(game.to_dict())

    @app.post("/games/<game_id>/guesses")
    def submit_guess(game_id: str):
        game = games.get(game_id)
        if game is None:
            return jsonify({"error": "game not found"}), 404
        if game.solved or game.gave_up:
            return jsonify({"error": "game is already over", **game.to_dict()}), 409

        body = request.get_json(silent=True) or {}
        name = body.get("station")
        if not isinstance(name, str) or not name.strip():
            return jsonify({"error": "request body must include a station name"}), 400

        station = game.system.find(name)
        if station is None:
            return jsonify({
                "error": f"unknown station: {name!r}",
                "hint": f"GET /stations?system={game.system.key} lists valid names.",
            }), 422
        if not game.allows(station):
            return jsonify({
                "error": f"{station.name!r} is not on a selected line for this game",
                "lines": list(game.lines),
            }), 422

        guess = game.make_guess(station)
        return jsonify({
            "result": guess.to_dict(),
            "solved": game.solved,
            "guess_count": len(game.guesses),
            **({"answer": game.target.name} if game.solved else {}),
        })

    @app.post("/games/<game_id>/give-up")
    def give_up(game_id: str):
        game = games.get(game_id)
        if game is None:
            return jsonify({"error": "game not found"}), 404
        games.give_up(game)
        return jsonify(game.to_dict(reveal=True))

    @app.delete("/games/<game_id>")
    def delete_game(game_id: str):
        if not games.delete(game_id):
            return jsonify({"error": "game not found"}), 404
        return "", 204

    @app.errorhandler(404)
    def not_found(_err):
        return jsonify({"error": "not found"}), 404

    @app.errorhandler(405)
    def method_not_allowed(_err):
        return jsonify({"error": "method not allowed"}), 405

    return app
