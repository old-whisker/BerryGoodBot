"""BerryGoodTunes server: serves the web app and downloads audio on request.

Run:  uvicorn app:app --host 127.0.0.1 --port 8765
Then expose it privately with:  tailscale serve --bg 8765
"""

import os
import re
from pathlib import Path

import yt_dlp
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from downloader import SECTIONS, Downloader, default_ffmpeg, js_runtime
from fresh import Fresh
from library import Library
from podcasts import PodcastError, Podcasts
from push import Push

HERE = Path(__file__).resolve().parent
LIBRARY_DIR = Path(os.environ.get("BERRY_LIBRARY", HERE / "library"))
COOKIES = Path(os.environ.get("BERRY_COOKIES", HERE / "cookies.txt"))
WEB_DIR = HERE.parent / "web"

library = Library(LIBRARY_DIR)
downloader = Downloader(library, cookies=COOKIES, ffmpeg=default_ffmpeg())
push = Push(LIBRARY_DIR)
fresh = Fresh(library, downloader, push, LIBRARY_DIR, cookies=COOKIES)
podcasts = Podcasts(library, downloader, push, LIBRARY_DIR)

AUDIO_TYPES = {".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".aac": "audio/aac"}
IMAGE_TYPES = {".jpg": "image/jpeg", ".png": "image/png"}

app = FastAPI(title="BerryGoodTunes")


class JobRequest(BaseModel):
    url: str
    section: str | None = None  # music | podcasts; omitted = sort automatically


class RetryRequest(BaseModel):
    ids: list[str]


class PlaylistRequest(BaseModel):
    name: str
    section: str = "music"


class TrackUpdate(BaseModel):
    section: str | None = None
    keep: bool = False  # move a Fresh song into the library for good


class PodcastRequest(BaseModel):
    link: str  # a feed URL or an Apple Podcasts page link


class EpisodeRequest(BaseModel):
    guid: str


class PushSubscription(BaseModel):
    endpoint: str
    keys: dict[str, str]
    expirationTime: float | None = None


def _section(section: str | None) -> str | None:
    if section is not None and section not in SECTIONS:
        raise HTTPException(400, f"Section must be one of: {', '.join(SECTIONS)}.")
    return section


class PlaylistTrackRequest(BaseModel):
    track_id: str


class ProgressEntry(BaseModel):
    pos: float = Field(ge=0)
    played: bool = False
    at: int  # when the device recorded it, ms since epoch


class ProgressSync(BaseModel):
    entries: dict[str, ProgressEntry] = {}


def public(track: dict) -> dict:
    return {
        k: track.get(k)
        for k in ("id", "title", "artist", "duration", "source_url", "size", "added_at")
    } | {"has_cover": bool(track.get("cover_file")), "section": track.get("section", "music"),
         "fresh": bool(track.get("fresh")), "podcast_id": track.get("podcast_id"),
         "published_at": track.get("published_at")}


@app.get("/api/health")
def health():
    return {"ok": True, "yt_dlp": yt_dlp.version.__version__, "cookies": COOKIES.exists(), "js_runtime": js_runtime()}


@app.get("/api/tracks")
def list_tracks():
    return [public(t) for t in library.list()]


@app.get("/api/tracks/{track_id}/audio")
def track_audio(track_id: str):
    track = library.get(track_id) or _404()
    path = library.audio_path(track)
    return FileResponse(path, media_type=AUDIO_TYPES.get(path.suffix.lower(), "audio/mp4"))


@app.get("/api/tracks/{track_id}/cover")
def track_cover(track_id: str):
    track = library.get(track_id) or _404()
    cover = library.cover_path(track)
    if not cover or not cover.exists():
        _404()
    return FileResponse(cover, media_type=IMAGE_TYPES.get(cover.suffix.lower(), "image/jpeg"))


@app.patch("/api/tracks/{track_id}")
def update_track(track_id: str, req: TrackUpdate):
    track = library.get(track_id) or _404()
    if req.section:
        track = library.set_section(track_id, _section(req.section))
    if req.keep:
        track = library.keep(track_id)
    return public(track)


@app.delete("/api/tracks/{track_id}")
def delete_track(track_id: str):
    # Idempotent so offline deletes can be replayed safely.
    library.delete(track_id)
    return {"ok": True}


@app.get("/api/jobs")
def list_jobs():
    return downloader.list_jobs()


@app.post("/api/jobs", status_code=201)
def create_job(req: JobRequest):
    # Share sheets sometimes send "Check this out https://..." rather than a bare link.
    match = re.search(r"https?://\S+", req.url)
    if not match:
        raise HTTPException(400, "That doesn't look like a link.")
    return downloader.submit(match.group(0), section=_section(req.section))


@app.post("/api/jobs/retry")
def retry_jobs(req: RetryRequest):
    return {"retried": downloader.retry(req.ids)}


@app.delete("/api/jobs/queued")
def cancel_queued():
    return {"cancelled": downloader.cancel_queued()}


@app.post("/api/progress")
def sync_progress(req: ProgressSync):
    """Devices send their listening positions and get back everyone's (newest wins)."""
    return library.merge_progress({k: v.model_dump() for k, v in req.entries.items()})


@app.get("/api/fresh")
def fresh_status():
    return fresh.status()


@app.post("/api/fresh/start")
def fresh_start():
    if not fresh.status()["can_build"]:
        raise HTTPException(400, "Add some music from YouTube first; the Fresh mix branches out from it.")
    return {"started": fresh.start()}


@app.post("/api/fresh/skip")
def fresh_skip():
    fresh.skip()
    return {"ok": True}


@app.get("/api/podcasts")
def list_podcasts():
    return podcasts.list()


@app.get("/api/podcasts/search")
def search_podcasts(q: str):
    try:
        return podcasts.search(q.strip()[:100])
    except Exception:
        raise HTTPException(502, "Couldn't reach the podcast directory. Try again in a moment.")


@app.post("/api/podcasts", status_code=201)
def subscribe_podcast(req: PodcastRequest):
    if not re.match(r"https?://", req.link.strip()):
        raise HTTPException(400, "Paste the show's feed link or its Apple Podcasts link.")
    try:
        return podcasts.subscribe(req.link)
    except PodcastError as e:
        raise HTTPException(400, str(e))
    except Exception:
        raise HTTPException(502, "Couldn't load that podcast. Check the link and try again.")


@app.delete("/api/podcasts/{show_id}")
def unsubscribe_podcast(show_id: str):
    podcasts.unsubscribe(show_id)
    return {"ok": True}


@app.get("/api/podcasts/{show_id}/image")
def podcast_image(show_id: str):
    path = podcasts.image_path(show_id)
    if not path or not path.exists():
        _404()
    return FileResponse(path, media_type=IMAGE_TYPES.get(path.suffix.lower(), "image/jpeg"))


@app.get("/api/podcasts/{show_id}/episodes")
def podcast_episodes(show_id: str):
    try:
        return podcasts.episodes(show_id)
    except Exception:
        raise HTTPException(502, "Couldn't load the episode list. Try again in a moment.")


@app.post("/api/podcasts/{show_id}/episodes")
def download_episode(show_id: str, req: EpisodeRequest):
    return {"queued": podcasts.download(show_id, req.guid)}


@app.post("/api/podcasts/check")
def check_podcasts():
    return {"new": podcasts.check()}


@app.get("/api/push/key")
def push_key():
    return {"key": push.public_key()}


@app.post("/api/push/subscribe")
def push_subscribe(sub: PushSubscription):
    push.subscribe(sub.model_dump(exclude_none=True))
    return {"devices": push.device_count}


@app.post("/api/push/test")
def push_test():
    return {"sent": push.send("🍓 BerryGoodTunes", "Notifications are working.", tag="test")}


@app.get("/api/playlists")
def list_playlists():
    return library.list_playlists()


def _playlist_name(name: str) -> str:
    name = name.strip()[:80]
    if not name:
        raise HTTPException(400, "Give the playlist a name.")
    return name


@app.post("/api/playlists", status_code=201)
def create_playlist(req: PlaylistRequest):
    return library.create_playlist(_playlist_name(req.name), _section(req.section))


@app.patch("/api/playlists/{playlist_id}")
def rename_playlist(playlist_id: str, req: PlaylistRequest):
    return library.rename_playlist(playlist_id, _playlist_name(req.name)) or _404()


@app.delete("/api/playlists/{playlist_id}")
def delete_playlist(playlist_id: str):
    library.delete_playlist(playlist_id)
    return {"ok": True}


@app.post("/api/playlists/{playlist_id}/tracks")
def add_to_playlist(playlist_id: str, req: PlaylistTrackRequest):
    return library.add_to_playlist(playlist_id, req.track_id) or _404()


@app.delete("/api/playlists/{playlist_id}/tracks/{track_id}")
def remove_from_playlist(playlist_id: str, track_id: str):
    return library.remove_from_playlist(playlist_id, track_id) or _404()


def _404():
    raise HTTPException(404, "Not found")


# The service worker must never be served stale, or app updates never land.
@app.get("/sw.js", include_in_schema=False)
def service_worker():
    return FileResponse(WEB_DIR / "sw.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
