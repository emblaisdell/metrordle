"""Transit systems and their station data, loaded from ``data/*.json``.

Each JSON file describes one transit *system* (e.g. WMATA, Philadelphia) with:

    {
      "key": "wmata",
      "name": "Washington Metro (WMATA)",
      "colors": {"Red": "#e51937", ...},   # line name -> hex color
      "stations": [{name, lines, lat, lon, aliases}, ...]
    }

WMATA is the default system. Coordinates only need to be accurate enough to
resolve relative compass directions between stations within a system.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

_DATA_DIR = Path(__file__).with_name("data")

DEFAULT_SYSTEM = "wmata"


@dataclass(frozen=True)
class Station:
    name: str
    lines: tuple[str, ...]
    lat: float
    lon: float
    aliases: tuple[str, ...] = field(default=())


def _normalize(text: str) -> str:
    """Lowercase, drop punctuation, and collapse whitespace for matching."""
    text = text.strip().lower()
    text = text.replace("&", " and ")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


class System:
    """A transit system: its stations, line colors, and name resolution."""

    def __init__(self, key: str, name: str, colors: dict[str, str], stations: list[Station]):
        self.key = key
        self.name = name
        self.colors = colors
        self.stations = stations
        self._lookup: dict[str, Station] = {}
        for station in stations:
            for alias in (station.name, *station.aliases):
                self._lookup[_normalize(alias)] = station

    def find(self, query: str) -> Station | None:
        """Resolve a user-supplied station name (or alias) within this system."""
        if not query:
            return None
        return self._lookup.get(_normalize(query))

    def names(self) -> list[str]:
        return [s.name for s in self.stations]


def _load_system(path: Path) -> System:
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    stations = [
        Station(
            name=entry["name"],
            lines=tuple(entry["lines"]),
            lat=float(entry["lat"]),
            lon=float(entry["lon"]),
            aliases=tuple(entry.get("aliases", ())),
        )
        for entry in data["stations"]
    ]
    return System(
        key=data["key"],
        name=data["name"],
        colors=dict(data.get("colors", {})),
        stations=stations,
    )


SYSTEMS: dict[str, System] = {
    system.key: system
    for system in (_load_system(p) for p in sorted(_DATA_DIR.glob("*.json")))
}

if DEFAULT_SYSTEM not in SYSTEMS:
    raise RuntimeError(f"default system {DEFAULT_SYSTEM!r} missing from {_DATA_DIR}")


def get_system(key: str | None) -> System | None:
    """Return the named system, or the default when ``key`` is None/empty."""
    return SYSTEMS.get(key or DEFAULT_SYSTEM)


def list_systems() -> list[System]:
    return list(SYSTEMS.values())
