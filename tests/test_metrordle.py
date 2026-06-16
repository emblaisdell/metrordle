"""Tests for Metrordle game logic and the REST API."""

import random

import pytest

from server import create_app
from server.game import GameStore, bearing_to_direction, compare_lines
from server.stations import DEFAULT_SYSTEM, get_system

WMATA = get_system("wmata")
PHILLY = get_system("philly")


# ---- systems & station lookup ----

def test_systems_loaded():
    assert DEFAULT_SYSTEM == "wmata"
    assert WMATA is not None and PHILLY is not None
    assert get_system(None) is WMATA          # default
    assert get_system("nope") is None


def test_find_station_by_name_and_alias():
    assert WMATA.find("Metro Center").name == "Metro Center"
    assert WMATA.find("  metro  center ").name == "Metro Center"
    assert WMATA.find("Chinatown").name == "Gallery Place"
    assert WMATA.find("lenfant").name == "L'Enfant Plaza"
    assert WMATA.find("does not exist") is None
    # 'Chinatown' resolves differently per system (no cross-system leakage).
    assert PHILLY.find("Chinatown").name == "Chinatown"
    assert PHILLY.find("Metro Center") is None


# ---- line comparison ----

def test_compare_lines_all_some_none():
    metro_center = WMATA.find("Metro Center")      # Red, Orange, Silver, Blue
    gallery_place = WMATA.find("Gallery Place")     # Red, Green, Yellow
    farragut_west = WMATA.find("Farragut West")     # Blue, Orange, Silver
    rosslyn = WMATA.find("Rosslyn")                 # Blue, Orange, Silver
    branch_ave = WMATA.find("Branch Avenue")        # Green

    match, shared = compare_lines(farragut_west, rosslyn)
    assert match == "all"
    assert set(shared) == {"Blue", "Orange", "Silver"}

    match, shared = compare_lines(metro_center, gallery_place)
    assert match == "some"
    assert shared == ["Red"]

    match, _ = compare_lines(metro_center, branch_ave)
    assert match == "none"


def test_philly_multiline_hub():
    eighth = PHILLY.find("8th Street")             # MFL + Broad St + PATCO
    assert set(eighth.lines) == {"Market-Frankford", "Broad Street", "PATCO"}


# ---- direction ----

def test_bearing_directions():
    shady_grove = WMATA.find("Shady Grove")     # far NW
    branch_ave = WMATA.find("Branch Avenue")    # far SE
    assert bearing_to_direction(branch_ave, shady_grove) in {"NW", "N", "W"}
    assert bearing_to_direction(shady_grove, branch_ave) in {"SE", "S", "E"}


def test_bearing_same_station_is_none():
    mc = WMATA.find("Metro Center")
    assert bearing_to_direction(mc, mc) is None


# ---- API ----

@pytest.fixture
def client():
    app = create_app(GameStore(rng=random.Random(0)))
    app.config.update(TESTING=True)
    return app.test_client()


def test_index_and_systems(client):
    assert client.get("/").status_code == 200
    body = client.get("/systems").get_json()
    assert body["default"] == "wmata"
    keys = {s["key"] for s in body["systems"]}
    assert {"wmata", "philly"} <= keys


def test_stations_per_system(client):
    wmata = client.get("/stations").get_json()           # default
    assert wmata["system"] == "wmata"
    assert wmata["count"] == len(wmata["stations"]) > 0
    assert "Red" in wmata["colors"]

    philly = client.get("/stations?system=philly").get_json()
    assert philly["system"] == "philly"
    assert "Market-Frankford" in philly["colors"]

    assert client.get("/stations?system=bogus").status_code == 404


def test_full_game_flow_with_seed(client):
    create = client.post("/games", json={"seed": 42})
    assert create.status_code == 201
    assert create.get_json()["system"] == "wmata"   # default system
    game_id = create.get_json()["id"]
    assert "answer" not in create.get_json()

    resp = client.post(f"/games/{game_id}/guesses", json={"station": "Metro Center"})
    result = resp.get_json()["result"]
    assert resp.status_code == 200
    assert result["line_match"] in {"all", "some", "none"}
    assert result["direction"] in {None, "N", "NE", "E", "SE", "S", "SW", "W", "NW"}

    answer = client.post(f"/games/{game_id}/give-up").get_json()["answer"]
    game_id = client.post("/games", json={"seed": 42}).get_json()["id"]
    win = client.post(f"/games/{game_id}/guesses", json={"station": answer}).get_json()
    assert win["solved"] is True
    assert win["result"]["correct"] is True
    assert win["result"]["direction"] is None
    assert win["answer"] == answer


def test_philly_game(client):
    create = client.post("/games", json={"system": "philly", "seed": 1})
    assert create.status_code == 201
    game_id = create.get_json()["id"]
    # A Philly station is valid here; a WMATA-only station is not.
    ok = client.post(f"/games/{game_id}/guesses", json={"station": "8th Street"})
    assert ok.status_code == 200
    bad = client.post(f"/games/{game_id}/guesses", json={"station": "Shady Grove"})
    assert bad.status_code == 422


def test_unknown_system_on_create_returns_400(client):
    assert client.post("/games", json={"system": "bogus"}).status_code == 400


def test_unknown_station_returns_422(client):
    gid = client.post("/games").get_json()["id"]
    assert client.post(f"/games/{gid}/guesses", json={"station": "Hogwarts"}).status_code == 422


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
