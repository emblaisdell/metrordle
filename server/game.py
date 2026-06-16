"""Game logic: line comparison, compass direction, and in-memory game store."""

from __future__ import annotations

import math
import random
import uuid
from dataclasses import dataclass, field

from .stations import STATIONS, Station

# 8 semi-cardinal directions, in clockwise order starting at North.
_COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def compare_lines(guess: Station, target: Station) -> tuple[str, list[str]]:
    """Return (match, shared_lines) where match is 'all' | 'some' | 'none'.

    'all'  -> the two stations are served by exactly the same set of lines.
    'some' -> they share at least one line but not the full set.
    'none' -> they share no lines.
    """
    guess_lines = set(guess.lines)
    target_lines = set(target.lines)
    shared = sorted(guess_lines & target_lines, key=guess.lines.index)

    if guess_lines == target_lines:
        match = "all"
    elif shared:
        match = "some"
    else:
        match = "none"
    return match, shared


def bearing_to_direction(guess: Station, target: Station) -> str | None:
    """Compass direction (one of 8) from ``guess`` toward ``target``.

    Returns None when the two stations are the same location (no direction).
    Uses the great-circle initial bearing, then buckets into 45-degree sectors.
    """
    if guess.lat == target.lat and guess.lon == target.lon:
        return None

    lat1, lat2 = math.radians(guess.lat), math.radians(target.lat)
    d_lon = math.radians(target.lon - guess.lon)

    y = math.sin(d_lon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(d_lon)
    bearing = (math.degrees(math.atan2(y, x)) + 360.0) % 360.0

    # Each sector spans 45 degrees, centered on its compass point.
    index = int((bearing + 22.5) % 360.0 // 45.0)
    return _COMPASS[index]


@dataclass
class Guess:
    station: Station
    line_match: str
    shared_lines: list[str]
    direction: str | None
    correct: bool

    def to_dict(self) -> dict:
        return {
            "guess": self.station.name,
            "lines": list(self.station.lines),
            "line_match": self.line_match,
            "shared_lines": self.shared_lines,
            "direction": self.direction,
            "correct": self.correct,
        }


@dataclass
class Game:
    id: str
    target: Station
    guesses: list[Guess] = field(default_factory=list)

    @property
    def solved(self) -> bool:
        return any(g.correct for g in self.guesses)

    @property
    def gave_up(self) -> bool:
        return getattr(self, "_gave_up", False)

    def make_guess(self, station: Station) -> Guess:
        match, shared = compare_lines(station, self.target)
        direction = bearing_to_direction(station, self.target)
        correct = station.name == self.target.name
        guess = Guess(
            station=station,
            line_match=match,
            shared_lines=shared,
            direction=direction,
            correct=correct,
        )
        self.guesses.append(guess)
        return guess

    def to_dict(self, reveal: bool = False) -> dict:
        data = {
            "id": self.id,
            "solved": self.solved,
            "gave_up": self.gave_up,
            "guess_count": len(self.guesses),
            "guesses": [g.to_dict() for g in self.guesses],
        }
        if reveal or self.solved or self.gave_up:
            data["answer"] = self.target.name
        return data


class GameStore:
    """Thread-unsafe in-memory store of active games. Fine for a single process."""

    def __init__(self, rng: random.Random | None = None):
        self._games: dict[str, Game] = {}
        self._rng = rng or random.Random()

    def create(self, seed: int | None = None) -> Game:
        rng = random.Random(seed) if seed is not None else self._rng
        target = rng.choice(STATIONS)
        game_id = uuid.uuid4().hex
        game = Game(id=game_id, target=target)
        self._games[game_id] = game
        return game

    def get(self, game_id: str) -> Game | None:
        return self._games.get(game_id)

    def delete(self, game_id: str) -> bool:
        return self._games.pop(game_id, None) is not None

    def give_up(self, game: Game) -> None:
        game._gave_up = True
