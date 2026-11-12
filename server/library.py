"""On-disk music library: audio + cover files, tracks.json, playlists.json and progress.json."""

from __future__ import annotations

import json
import shutil
import threading
import time
import uuid
from pathlib import Path


class Library:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.index_path = root / "tracks.json"
        self.playlists_path = root / "playlists.json"
        self.progress_path = root / "progress.json"
        self._lock = threading.RLock()
        self._tracks: dict[str, dict] = {}
        self._playlists: dict[str, dict] = {}
        # Listening position for podcasts and long items: track_id -> {"pos": seconds, "played": bool, "at": ms}
        self._progress: dict[str, dict] = {}
        if self.progress_path.exists():
            self._progress = json.loads(self.progress_path.read_text(encoding="utf-8"))
        if self.index_path.exists():
            for t in json.loads(self.index_path.read_text(encoding="utf-8")):
                self._tracks[t["id"]] = t
        if self.playlists_path.exists():
            for pl in json.loads(self.playlists_path.read_text(encoding="utf-8")):
                self._playlists[pl["id"]] = pl

    @staticmethod
    def _write(path: Path, data):
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
        tmp.replace(path)

    def _save(self):
        self._write(self.index_path, list(self._tracks.values()))

    def _save_playlists(self):
        self._write(self.playlists_path, list(self._playlists.values()))

    def list(self) -> list[dict]:
        with self._lock:
            return sorted(self._tracks.values(), key=lambda t: t["added_at"], reverse=True)

    def get(self, track_id: str) -> dict | None:
        with self._lock:
            return self._tracks.get(track_id)

    def find_by_source(self, source_id: str) -> dict | None:
        with self._lock:
            return next((t for t in self._tracks.values() if t.get("source_id") == source_id), None)

    def audio_path(self, track: dict) -> Path:
        return self.root / track["audio_file"]

    def cover_path(self, track: dict) -> Path | None:
        return self.root / track["cover_file"] if track.get("cover_file") else None

    def add(self, track_id: str, audio: Path, cover: Path | None, meta: dict) -> dict:
        audio_name = f"{track_id}{audio.suffix}"
        shutil.move(str(audio), self.root / audio_name)
        cover_name = None
        if cover and cover.exists():
            cover_name = f"{track_id}{cover.suffix}"
            shutil.move(str(cover), self.root / cover_name)
        track = {
            "id": track_id,
            **meta,
            "audio_file": audio_name,
            "cover_file": cover_name,
            "size": (self.root / audio_name).stat().st_size,
            "added_at": time.time(),
        }
        with self._lock:
            self._tracks[track_id] = track
            self._save()
        return track

    def delete(self, track_id: str) -> bool:
        with self._lock:
            track = self._tracks.pop(track_id, None)
            if not track:
                return False
            self._save()
            for pl in self._playlists.values():
                if track_id in pl["track_ids"]:
                    pl["track_ids"].remove(track_id)
            self._save_playlists()
            if self._progress.pop(track_id, None):
                self._write(self.progress_path, self._progress)
        for name in (track["audio_file"], track.get("cover_file")):
            if name:
                (self.root / name).unlink(missing_ok=True)
        return True

    # ---- Fresh mix -----------------------------------------------------------

    def fresh_tracks(self) -> list[dict]:
        """Songs from a Fresh mix that haven't been kept yet."""
        with self._lock:
            return [t for t in self._tracks.values() if t.get("fresh")]

    def keep(self, track_id: str) -> dict | None:
        """Move a Fresh song into the library for good."""
        with self._lock:
            track = self._tracks.get(track_id)
            if not track:
                return None
            if track.pop("fresh", None):
                self._save()
            return track

    # ---- listening progress -----------------------------------------------

    def merge_progress(self, entries: dict[str, dict]) -> dict[str, dict]:
        """Merge positions reported by a device (newest "at" wins per track) and return the full set."""
        with self._lock:
            changed = False
            for track_id, entry in entries.items():
                if track_id not in self._tracks:
                    continue
                current = self._progress.get(track_id)
                if current is None or entry["at"] > current["at"]:
                    self._progress[track_id] = {"pos": entry["pos"], "played": entry["played"], "at": entry["at"]}
                    changed = True
            if changed:
                self._write(self.progress_path, self._progress)
            return dict(self._progress)

    # ---- playlists --------------------------------------------------------

    def set_section(self, track_id: str, section: str) -> dict | None:
        """Move a song between Music and Podcasts. Playlists belong to one section, so it leaves
        the other section's playlists."""
        with self._lock:
            track = self._tracks.get(track_id)
            if not track:
                return None
            track["section"] = section
            self._save()
            for pl in self._playlists.values():
                if pl.get("section", "music") != section and track_id in pl["track_ids"]:
                    pl["track_ids"].remove(track_id)
            self._save_playlists()
            return track

    @staticmethod
    def _public_playlist(pl: dict) -> dict:
        return {k: pl[k] for k in ("id", "name", "track_ids", "created_at")} | {"section": pl.get("section", "music")}

    def list_playlists(self) -> list[dict]:
        with self._lock:
            ordered = sorted(self._playlists.values(), key=lambda pl: pl["created_at"])
            return [self._public_playlist(pl) for pl in ordered]

    def create_playlist(self, name: str, section: str = "music") -> dict:
        with self._lock:
            pl = {"id": uuid.uuid4().hex[:12], "name": name, "section": section, "track_ids": [], "created_at": time.time()}
            self._playlists[pl["id"]] = pl
            self._save_playlists()
            return self._public_playlist(pl)

    def rename_playlist(self, playlist_id: str, name: str) -> dict | None:
        with self._lock:
            pl = self._playlists.get(playlist_id)
            if not pl:
                return None
            pl["name"] = name
            self._save_playlists()
            return self._public_playlist(pl)

    def delete_playlist(self, playlist_id: str) -> bool:
        """Removes the playlist only; its songs stay in the library."""
        with self._lock:
            if not self._playlists.pop(playlist_id, None):
                return False
            self._save_playlists()
            return True

    def add_to_playlist(self, playlist_id: str, track_id: str) -> dict | None:
        """Add a song to the end of a playlist (no-op if it's already there)."""
        with self._lock:
            pl = self._playlists.get(playlist_id)
            if not pl or track_id not in self._tracks:
                return None
            if track_id not in pl["track_ids"]:
                pl["track_ids"].append(track_id)
                self._save_playlists()
            self.keep(track_id)  # putting a Fresh song in a playlist means you want it
            return self._public_playlist(pl)

    def remove_from_playlist(self, playlist_id: str, track_id: str) -> dict | None:
        with self._lock:
            pl = self._playlists.get(playlist_id)
            if not pl:
                return None
            if track_id in pl["track_ids"]:
                pl["track_ids"].remove(track_id)
                self._save_playlists()
            return self._public_playlist(pl)
