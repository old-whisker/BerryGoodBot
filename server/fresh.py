"""Fresh mix: a daily batch of new songs related to the music you already have.

Each evening (default 17:30, PC local time), if the PC is on and today's mix hasn't been fetched
or skipped, the phone gets a notification. Tapping it (or Start in the app) builds the mix:
pick a few random songs from the library, read YouTube's auto-generated "Mix" of related songs
for each, and download ones you don't have yet. They stay in the Fresh tab until kept; the ones
you don't keep are cleared when the next mix arrives.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import random
import threading
import time
from pathlib import Path

from yt_dlp import YoutubeDL

from downloader import Downloader, _YtdlpLog, friendly_error
from library import Library
from push import Push

NOTIFY_AT = os.environ.get("BERRY_FRESH_TIME", "17:30")  # 24-hour, the PC's local time
MIX_SIZE = int(os.environ.get("BERRY_FRESH_SIZE", "20"))
SEEDS = 4                        # library songs to branch out from each time
SONG_SECONDS = (60, 10 * 60)     # skip clips and hour-long uploads
HISTORY_KEPT = 3000              # never suggest the same song twice (within this many)


def _today() -> str:
    return dt.date.today().isoformat()


def _notify_time() -> dt.time:
    hours, minutes = (int(x) for x in NOTIFY_AT.split(":"))
    return dt.time(hours, minutes)


class Fresh:
    def __init__(self, library: Library, downloader: Downloader, push: Push, root: Path, cookies: Path | None = None):
        self.library = library
        self.downloader = downloader
        self.push = push
        self.cookies = cookies
        self.path = root / "fresh.json"
        self._lock = threading.Lock()
        self._running = False
        # offered: date the notification went out; decided: date it was started or skipped
        self._state = {"offered": None, "decided": None, "history": []}
        if self.path.exists():
            self._state.update(json.loads(self.path.read_text(encoding="utf-8")))
        threading.Thread(target=self._scheduler, daemon=True).start()

    def _save(self):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._state, indent=1), encoding="utf-8")
        tmp.replace(self.path)

    # ---- what the app sees ----------------------------------------------------

    def _seeds(self) -> list[str]:
        """YouTube ids of kept music in the library."""
        return [t["source_id"].split(":", 1)[1] for t in self.library.list()
                if t.get("section", "music") == "music" and not t.get("fresh")
                and str(t.get("source_id", "")).startswith("Youtube:")]

    def pending(self) -> bool:
        """It's evening and today's mix hasn't been fetched or skipped yet."""
        return (dt.datetime.now().time() >= _notify_time() and self._state["decided"] != _today()
                and not self._running and bool(self._seeds()))

    def status(self) -> dict:
        return {"pending": self.pending(), "running": self._running, "notify_at": NOTIFY_AT, "size": MIX_SIZE,
                "count": len(self.library.fresh_tracks()), "can_build": bool(self._seeds()),
                "devices": self.push.device_count}

    def skip(self):
        with self._lock:
            self._state["decided"] = _today()
            self._save()

    def start(self) -> bool:
        with self._lock:
            if self._running:
                return False
            self._running = True
            self._state["decided"] = _today()
            self._save()
        threading.Thread(target=self._build, daemon=True).start()
        return True

    # ---- the evening notification ---------------------------------------------

    def _scheduler(self):
        while True:
            try:
                if self.pending() and self._state["offered"] != _today():
                    with self._lock:
                        self._state["offered"] = _today()
                        self._save()
                    self.push.send("🍓 Today's Fresh mix", f"{MIX_SIZE} new songs are ready to fetch. Tap to start.",
                                   url="/?fresh=start", tag="fresh-mix")
            except Exception as e:  # never let the scheduler die
                print(f"[fresh] scheduler: {e}", flush=True)
            time.sleep(30)

    # ---- building a mix --------------------------------------------------------

    def _related(self, video_id: str) -> list[dict]:
        """YouTube's auto-generated Mix for a song, without downloading anything."""
        opts = {"extract_flat": "in_playlist", "playlistend": 30, "quiet": True, "noprogress": True,
                "logger": _YtdlpLog()}
        if self.cookies and self.cookies.exists():
            opts["cookiefile"] = str(self.cookies)
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}&list=RD{video_id}", download=False)
        return [e for e in (info or {}).get("entries") or [] if e and e.get("id")]

    def _build(self):
        task = self.downloader.add_task("fresh", "Today's Fresh mix")
        try:
            seeds = self._seeds()
            have = {t.get("source_id") for t in self.library.list()}
            seen = set(self._state["history"]) | {s for s in seeds}
            pools = []
            for seed in random.sample(seeds, min(SEEDS, len(seeds))):
                try:
                    pool = []
                    for e in self._related(seed):
                        d = e.get("duration")
                        if e["id"] in seen or f"Youtube:{e['id']}" in have:
                            continue
                        if d is not None and not (SONG_SECONDS[0] <= d <= SONG_SECONDS[1]):
                            continue
                        seen.add(e["id"])
                        pool.append(e)
                    random.shuffle(pool)
                    pools.append(pool)
                except Exception as e:  # one seed failing shouldn't sink the mix
                    print(f"[fresh] couldn't read the mix for {seed}: {friendly_error(e)}", flush=True)
                time.sleep(random.uniform(2, 4))  # go easy on YouTube

            # Take songs from each seed's pool in turn so one artist doesn't dominate.
            picks = []
            while len(picks) < MIX_SIZE and any(pools):
                for pool in pools:
                    if pool and len(picks) < MIX_SIZE:
                        picks.append(pool.pop())
            if not picks:
                self.downloader.finish_task(task, error="Couldn't find new songs this time. Try again later.")
                return

            # Out with the songs from the last mix you didn't keep, in with the new ones.
            for old in self.library.fresh_tracks():
                self.library.delete(old["id"])
            for e in picks:
                self.downloader.submit(f"https://www.youtube.com/watch?v={e['id']}", title=e.get("title"),
                                       section="music", fresh=True)
            with self._lock:
                self._state["history"] = (self._state["history"] + [e["id"] for e in picks])[-HISTORY_KEPT:]
                self._save()
            self.downloader.finish_task(task, title="Today's Fresh mix", fresh_count=len(picks))
        except Exception as e:
            self.downloader.finish_task(task, error=friendly_error(e))
        finally:
            self._running = False
