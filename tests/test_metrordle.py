"""Tests for Metrordle game logic and the REST API."""

import pytest

from server import create_app
from server.game import GameStore, bearing_to_direction, compare_lines
from server.stations import find_station


# ---- station lookup ----

def test_find_station_by_name_and_alias():
    assert find_station("Metro Center").name == "Metro Center"
    assert find_station("  metro  center ").name == "Metro Center"
    assert find_station("Chinatown").name == "Gallery Place"
    assert find_station("L'Enfant Plaza").name == "L'Enfant Plaza"
    assert find_station("lenfant").name == "L'Enfant Plaza"
    assert find_station("does not exist") is None


# ---- line comparison ----

def test_compare_lines_all_some_none():
    metro_center = find_station("Metro Center")      # Red, Orange, Silver, Blue
    gallery_place = find_station("Gallery Place")     # Red, Green, Yellow
    farragut_west = find_station("Farragut West")     # Blue, Orange, Silver
    rosslyn = find_station("Rosslyn")                 # Blue, Orange, Silver
    branch_ave = find_station("Branch Avenue")        # Green

    # identical line sets
    match, shared = compare_lines(farragut_west, rosslyn)
    assert match == "all"
    assert set(shared) == {"Blue", "Orange", "Silver"}

    # overlapping but not identical
    match, shared = compare_lines(metro_center, gallery_place)
    assert match == "some"
    assert shared == ["Red"]

    # disjoint
    match, _ = compare_lines(metro_center, branch_ave)
    assert match == "none"


# ---- direction ----

def test_bearing_directions():
    shady_grove = find_station("Shady Grove")     # far NW
    branch_ave = find_station("Branch Avenue")    # far SE
    assert bearing_to_direction(branch_ave, shady_grove) in {"NW", "N", "W"}
    assert bearing_to_direction(shady_grove, branch_ave) in {"SE", "S", "E"}


def test_bearing_same_station_is_none():
    mc = find_station("Metro Center")
    assert bearing_to_direction(mc, mc) is None


# ---- API ----

@pytest.fixture
def client():
    # Seed the store's RNG so games are deterministic across the test.
    import random
    app = create_app(GameStore(rng=random.Random(0)))
    app.config.update(TESTING=True)
    return app.test_client()


def test_index_and_stations(client):
    assert client.get("/").status_code == 200
    resp = client.get("/stations")
    body = resp.get_json()
    assert resp.status_code == 200
    assert body["count"] == len(body["stations"]) > 0


def test_full_game_flow_with_seed(client):
    # Deterministic target via explicit seed.
    create = client.post("/games", json={"seed": 42})
    assert create.status_code == 201
    game_id = create.get_json()["id"]
    assert "answer" not in create.get_json()

    # A guess returns the two required pieces of info.
    resp = client.post(f"/games/{game_id}/guesses", json={"station": "Metro Center"})
    body = resp.get_json()
    assert resp.status_code == 200
    result = body["result"]
    assert result["line_match"] in {"all", "some", "none"}
    assert result["direction"] in {None, "N", "NE", "E", "SE", "S", "SW", "W", "NW"}

    # Find out the answer, then guess it to win.
    answer = client.post(f"/games/{game_id}/give-up").get_json()["answer"]
    # give-up ends the game, so start a fresh seeded game to test the win path.
    game_id = client.post("/games", json={"seed": 42}).get_json()["id"]
    win = client.post(f"/games/{game_id}/guesses", json={"station": answer}).get_json()
    assert win["solved"] is True
    assert win["result"]["correct"] is True
    assert win["result"]["direction"] is None
    assert win["answer"] == answer


def test_unknown_station_returns_422(client):
    gid = client.post("/games").get_json()["id"]
    resp = client.post(f"/games/{gid}/guesses", json={"station": "Hogwarts"})
    assert resp.status_code == 422


def test_guess_after_game_over_returns_409(client):
    gid = client.post("/games").get_json()["id"]
    client.post(f"/games/{gid}/give-up")
    resp = client.post(f"/games/{gid}/guesses", json={"station": "Metro Center"})
    assert resp.status_code == 409


def test_missing_game_returns_404(client):
    assert client.get("/games/nope").status_code == 404
    assert client.post("/games/nope/guesses", json={"station": "x"}).status_code == 404


def test_delete_game(client):
    gid = client.post("/games").get_json()["id"]
    assert client.delete(f"/games/{gid}").status_code == 204
    assert client.get(f"/games/{gid}").status_code == 404
