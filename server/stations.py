"""WMATA Metro station data, loaded from the static ``stations.json`` file.

Each station has a canonical ``name``, the set of ``lines`` that serve it
(current, post-2023 service pattern), and its approximate ``lat``/``lon``.
Coordinates are good enough for relative compass directions between stations.

Line colors: Red, Orange, Silver, Blue, Yellow, Green.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

_DATA_FILE = Path(__file__).with_name("stations.json")


@dataclass(frozen=True)
class Station:
    name: str
    lines: tuple[str, ...]
    lat: float
    lon: float
    aliases: tuple[str, ...] = field(default=())


def _load_stations() -> list[Station]:
    with _DATA_FILE.open(encoding="utf-8") as f:
        raw = json.load(f)
    return [
        Station(
            name=entry["name"],
            lines=tuple(entry["lines"]),
            lat=float(entry["lat"]),
            lon=float(entry["lon"]),
            aliases=tuple(entry.get("aliases", ())),
        )
        for entry in raw
    ]


STATIONS: list[Station] = _load_stations()


def _normalize(text: str) -> str:
    """Lowercase, drop punctuation, and collapse whitespace for matching."""
    text = text.strip().lower()
    text = text.replace("&", " and ")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


# Lookup table from any normalized name/alias to the canonical Station.
_LOOKUP: dict[str, Station] = {}
for _s in STATIONS:
    for _key in (_s.name, *_s.aliases):
        _LOOKUP[_normalize(_key)] = _s


def find_station(query: str) -> Station | None:
    """Resolve a user-supplied station name (or alias) to a Station, or None."""
    if not query:
        return None
    return _LOOKUP.get(_normalize(query))


def all_station_names() -> list[str]:
    return [s.name for s in STATIONS]
