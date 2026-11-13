"""Background download queue: one job at a time through yt-dlp + ffmpeg."""

import os
import queue
import random
import re
import shutil
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

from yt_dlp import YoutubeDL

from library import Library

MAX_JOBS_KEPT = 30  # finished downloads remembered for the app; queued ones are never dropped
MAX_ERRORS_KEPT = 200  # failed ones are kept longer so they can be retried
# Pause between downloads (randomised) so a long playlist doesn't look like a bot to YouTube.
PAUSE_BETWEEN_DOWNLOADS = (4, 8)
# YouTube sometimes refuses a download with 403 Forbidden; it usually works a few minutes later.
MAX_ATTEMPTS = 3

SECTIONS = ("music", "podcasts")
# Without an explicit section, anything this long that YouTube doesn't label as music is a podcast.
PODCAST_MIN_SECONDS = 20 * 60


def guess_section(info: dict) -> str:
    if "Music" in (info.get("categories") or []):
        return "music"
    return "podcasts" if (info.get("duration") or 0) >= PODCAST_MIN_SECONDS else "music"


class _YtdlpLog:
    """Send yt-dlp's warnings and errors to the server log instead of discarding them."""

    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        print(f"[yt-dlp] {msg}", file=sys.stderr, flush=True)

    def error(self, msg):
        print(f"[yt-dlp] {msg}", file=sys.stderr, flush=True)


class DownloadError(Exception):
    pass


class Downloader:
    def __init__(self, library: Library, cookies: Path | None = None, ffmpeg: str | None = None):
        self.library = library
        self.cookies = cookies
        self.ffmpeg = ffmpeg
        self.jobs: dict[str, dict] = {}
        self._queue: queue.Queue[str] = queue.Queue()
        self._lock = threading.Lock()
        threading.Thread(target=self._worker, daemon=True).start()

    # ---- public API -------------------------------------------------------

    def submit(self, url: str, title: str | None = None, section: str | None = None, fresh: bool = False) -> dict:
        job = {
            "id": uuid.uuid4().hex[:12],
            "url": url,
            "kind": "video",  # becomes "playlist" once the link turns out to be one
            "status": "queued",  # queued | downloading | processing | done | error
            "progress": 0.0,
            "title": title,
            "track_id": None,
            "error": None,
            "duplicate": False,
            "created_at": time.time(),
            "finished_at": None,
            "playlist": None,  # {"added": n, "already": n} for playlist jobs
            "attempt": 1,
            "section": section,  # music | podcasts; None means sort it automatically
            "fresh": fresh,  # part of a Fresh mix: lands in the Fresh tab until kept
        }
        with self._lock:
            self.jobs[job["id"]] = job
            self._trim()
        self._queue.put(job["id"])
        return job

    def retry(self, job_ids: list[str]) -> int:
        """Queue failed downloads again, each with a fresh set of attempts."""
        count = 0
        with self._lock:
            for job_id in job_ids:
                job = self.jobs.get(job_id)
                if not job or job["status"] != "error" or job["kind"] != "video":
                    continue
                job.update(status="queued", progress=0.0, attempt=1, error=None, finished_at=None)
                self._queue.put(job_id)
                count += 1
        return count

    def cancel_queued(self) -> int:
        """Drop every job that hasn't started yet (e.g. the rest of a big playlist)."""
        with self._lock:
            queued = [j for j in self.jobs if self.jobs[j]["status"] == "queued"]
            for job_id in queued:
                del self.jobs[job_id]
        return len(queued)

    def add_task(self, kind: str, title: str) -> str:
        """A job-list row for work done outside the download queue (e.g. building a Fresh mix)."""
        job_id = uuid.uuid4().hex[:12]
        with self._lock:
            self.jobs[job_id] = {
                "id": job_id, "url": "", "kind": kind, "status": "processing", "progress": 0.0, "title": title,
                "track_id": None, "error": None, "duplicate": False, "created_at": time.time(),
                "finished_at": None, "playlist": None, "attempt": 1, "section": "music", "fresh": False,
            }
        return job_id

    def finish_task(self, job_id: str, error: str | None = None, **fields):
        self._update(job_id, status="error" if error else "done", error=error, progress=1.0,
                     finished_at=time.time(), **fields)

    def list_jobs(self) -> list[dict]:
        with self._lock:
            return sorted((dict(j) for j in self.jobs.values()), key=lambda j: j["created_at"], reverse=True)

    # ---- internals --------------------------------------------------------

    def _trim(self):
        for status, keep in (("done", MAX_JOBS_KEPT), ("error", MAX_ERRORS_KEPT)):
            finished = sorted((j for j in self.jobs.values() if j["status"] == status), key=lambda j: j["created_at"])
            for job in finished[:max(0, len(finished) - keep)]:
                del self.jobs[job["id"]]

    def _update(self, job_id: str, **fields):
        with self._lock:
            if job_id in self.jobs:  # may have been cancelled or trimmed meanwhile
                self.jobs[job_id].update(fields)

    def _worker(self):
        while True:
            job_id = self._queue.get()
            with self._lock:
                job = self.jobs.get(job_id)
                if not job:  # cancelled while queued
                    continue
                # Claim it so a cancel arriving now can't remove it mid-download.
                job["status"] = "downloading"
                url = job["url"]
            downloaded = False
            try:
                result = self._run(job_id, url)
                downloaded = result.pop("downloaded", False)
                self._update(job_id, status="done", progress=1.0, error=None, finished_at=time.time(), **result)
            except Exception as e:  # yt-dlp raises many types; surface them all to the UI
                error = friendly_error(e)
                if "403" in error and job["attempt"] < MAX_ATTEMPTS:
                    # Back of the queue: by the time it comes round again YouTube has usually relented.
                    self._update(job_id, status="queued", progress=0.0, attempt=job["attempt"] + 1,
                                 error=f"YouTube refused the download; retrying (attempt {job['attempt'] + 1} of {MAX_ATTEMPTS})")
                    self._queue.put(job_id)
                    downloaded = True  # pause before the next attempt too
                else:
                    self._update(job_id, status="error", error=error, finished_at=time.time())
            if downloaded and not self._queue.empty():
                time.sleep(random.uniform(*PAUSE_BETWEEN_DOWNLOADS))

    def _expand_playlist(self, job_id: str, raw: dict) -> dict:
        """Queue every video in a playlist as its own job, skipping ones already in the library."""
        title = raw.get("title") or "Playlist"
        self._update(job_id, kind="playlist", title=title, status="processing")
        added = already = 0
        for entry in raw.get("entries") or []:
            # Channel pages list sub-playlists (Videos, Shorts, ...); only take actual videos.
            if not entry or entry.get("_type") == "playlist":
                continue
            url = entry.get("url") or entry.get("webpage_url")
            if not url:
                continue
            ie_key = entry.get("ie_key") or entry.get("extractor_key")
            if ie_key and entry.get("id") and self.library.find_by_source(f"{ie_key}:{entry['id']}"):
                already += 1
                continue
            self.submit(url, title=entry.get("title"), section=self.jobs[job_id]["section"])
            added += 1
        if not added and not already:
            raise DownloadError("Couldn't find any videos in that playlist.")
        return {"title": title, "playlist": {"added": added, "already": already}}

    def _run(self, job_id: str, url: str) -> dict:
        track_id = uuid.uuid4().hex[:12]
        tmp = Path(tempfile.mkdtemp(prefix="berry-"))

        def on_progress(d):
            if d["status"] == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                if total:
                    self._update(job_id, status="downloading", progress=min(d["downloaded_bytes"] / total, 1.0))
            elif d["status"] == "finished":
                self._update(job_id, status="processing", progress=1.0)

        opts = {
            # Prefer the native AAC stream so nothing gets re-encoded; iOS plays it natively.
            "format": "bestaudio[ext=m4a]/bestaudio/best",
            "outtmpl": str(tmp / f"{track_id}.%(ext)s"),
            "noplaylist": True,
            "writethumbnail": True,
            "quiet": True,
            "noprogress": True,
            "logger": _YtdlpLog(),
            "progress_hooks": [on_progress],
            "postprocessors": [
                # Remuxes (no quality loss) when the source is already AAC.
                {"key": "FFmpegExtractAudio", "preferredcodec": "m4a", "preferredquality": "192"},
                {"key": "FFmpegThumbnailsConvertor", "format": "jpg", "when": "before_dl"},
            ],
        }
        if self.cookies and self.cookies.exists():
            opts["cookiefile"] = str(self.cookies)
        if self.ffmpeg:
            opts["ffmpeg_location"] = self.ffmpeg

        try:
            with YoutubeDL(opts) as ydl:
                raw = ydl.extract_info(url, download=False, process=False)
                if raw.get("_type") == "playlist":
                    return self._expand_playlist(job_id, raw)
                if raw.get("id") and raw.get("extractor_key"):
                    existing = self.library.find_by_source(f"{raw['extractor_key']}:{raw['id']}")
                    if existing:
                        return {"track_id": existing["id"], "title": existing["title"], "duplicate": True,
                                "section": existing.get("section", "music")}
                self._update(job_id, title=raw.get("title"), status="downloading")
                info = ydl.process_ie_result(raw, download=True)

            audio = Path(info["requested_downloads"][0]["filepath"])
            covers = list(tmp.glob(f"{track_id}*.jpg"))
            meta = {
                "title": info.get("track") or info.get("title") or "Untitled",
                "artist": info.get("artist") or info.get("uploader") or info.get("channel") or "",
                "duration": info.get("duration"),
                "source_url": info.get("webpage_url") or url,
                "source_id": f"{info.get('extractor_key')}:{info.get('id')}",
                "section": self.jobs.get(job_id, {}).get("section") or guess_section(info),
            }
            if self.jobs.get(job_id, {}).get("fresh"):
                meta["fresh"] = True
            track = self.library.add(track_id, audio, covers[0] if covers else None, meta)
            return {"track_id": track["id"], "title": track["title"], "downloaded": True, "section": track["section"]}
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


def friendly_error(e: Exception) -> str:
    """'ERROR: [youtube] abc123: Private video (caused by ...)' -> 'Private video'."""
    msg = str(e).removeprefix("ERROR: ").strip()
    msg = re.sub(r"^\[[\w:]+\] [^:]+: ", "", msg)
    msg = re.sub(r" \(caused by .*\)$", "", msg, flags=re.S)
    return msg or type(e).__name__


def js_runtime() -> str | None:
    """yt-dlp needs a JavaScript runtime (Deno) to solve YouTube's checks; without one, many downloads fail."""
    for name in ("deno", "node", "bun"):
        if shutil.which(name):
            return name
    return None


def default_ffmpeg() -> str | None:
    """Allow pointing at ffmpeg explicitly (e.g. when it isn't on PATH)."""
    return os.environ.get("BERRY_FFMPEG") or None
