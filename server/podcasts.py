"""Podcast subscriptions: follow shows by their RSS feed and download new episodes.

Episodes come straight from the podcast's own feed (plain audio files), so there's no YouTube
involved. New episodes are checked for when the server starts and every couple of hours while
the PC is on, downloaded into the Podcasts section, and announced with a notification.
"""

from __future__ import annotations

import email.utils
import json
import re
import threading
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from defusedxml import ElementTree as ET  # feeds come from the internet: refuse malicious XML

from downloader import Downloader
from library import Library
from push import Push

USER_AGENT = "BerryGoodTunes/1.0 (personal podcast player)"
CHECK_EVERY = 2 * 60 * 60  # seconds between checks for new episodes
LATEST_ON_SUBSCRIBE = 3    # episodes downloaded when you first subscribe
SEEN_KEPT = 2000           # episode ids remembered per show
FEED_MAX_BYTES = 30 * 1024 * 1024

ITUNES = "{http://www.itunes.com/dtds/podcast-1.0.dtd}"
SEARCH_URL = "https://itunes.apple.com/search"
LOOKUP_URL = "https://itunes.apple.com/lookup"


class PodcastError(Exception):
    pass


def _fetch(url: str, limit: int = FEED_MAX_BYTES) -> tuple[bytes, str]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read(limit + 1)
        if len(data) > limit:
            raise PodcastError("That feed is too large.")
        return data, r.headers.get_content_type()


def _duration(text: str | None) -> int | None:
    """itunes:duration is either seconds or [HH:]MM:SS."""
    if not text:
        return None
    text = text.strip()
    try:
        if ":" in text:
            seconds = 0
            for part in text.split(":"):
                seconds = seconds * 60 + int(float(part))
            return seconds
        return int(float(text))
    except ValueError:
        return None


def _published(text: str | None) -> float | None:
    try:
        return email.utils.parsedate_to_datetime(text).timestamp() if text else None
    except (TypeError, ValueError):
        return None


def parse_feed(data: bytes) -> dict:
    """The parts of an RSS podcast feed we use: show info and its episodes, newest first."""
    try:
        root = ET.fromstring(data)
    except Exception as e:
        raise PodcastError("That link isn't a podcast feed.") from e
    channel = root.find("channel")
    if channel is None:
        raise PodcastError("That link isn't a podcast feed.")
    image = channel.find(f"{ITUNES}image")
    image_url = image.get("href") if image is not None else channel.findtext("image/url")
    episodes = []
    for item in channel.findall("item"):
        enclosure = item.find("enclosure")
        audio_url = enclosure.get("url") if enclosure is not None else None
        if not audio_url:
            continue  # text-only posts
        guid = (item.findtext("guid") or audio_url).strip()
        ep_image = item.find(f"{ITUNES}image")
        episodes.append({
            "guid": guid,
            "title": (item.findtext("title") or "Untitled episode").strip(),
            "audio_url": audio_url.strip(),
            "published_at": _published(item.findtext("pubDate")),
            "duration": _duration(item.findtext(f"{ITUNES}duration")),
            "link": (item.findtext("link") or "").strip() or None,
            "image_url": ep_image.get("href") if ep_image is not None else None,
        })
    episodes.sort(key=lambda e: e["published_at"] or 0, reverse=True)
    return {
        "title": (channel.findtext("title") or "Untitled podcast").strip(),
        "author": (channel.findtext(f"{ITUNES}author") or "").strip(),
        "image_url": image_url,
        "episodes": episodes,
    }


class Podcasts:
    def __init__(self, library: Library, downloader: Downloader, push: Push, root: Path):
        self.library = library
        self.downloader = downloader
        self.push = push
        self.root = root
        self.path = root / "podcasts.json"
        self._lock = threading.RLock()
        self._shows: dict[str, dict] = {}
        if self.path.exists():
            for show in json.loads(self.path.read_text(encoding="utf-8")):
                self._shows[show["id"]] = show
        self._feeds: dict[str, dict] = {}  # last parsed feed per show, for the episode list
        threading.Thread(target=self._checker, daemon=True).start()

    def _save(self):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(list(self._shows.values()), indent=1), encoding="utf-8")
        tmp.replace(self.path)

    @staticmethod
    def public(show: dict) -> dict:
        return {k: show.get(k) for k in ("id", "title", "author", "feed_url", "added_at", "last_checked")} | {
            "has_image": bool(show.get("image_file"))}

    def list(self) -> list[dict]:
        with self._lock:
            return [self.public(s) for s in sorted(self._shows.values(), key=lambda s: s["title"].casefold())]

    def image_path(self, show_id: str) -> Path | None:
        show = self._shows.get(show_id)
        return self.root / show["image_file"] if show and show.get("image_file") else None

    # ---- finding shows ----------------------------------------------------------

    @staticmethod
    def search(term: str) -> list[dict]:
        """Apple's free podcast directory (no account or key needed)."""
        query = urllib.parse.urlencode({"media": "podcast", "entity": "podcast", "limit": 20, "term": term})
        data, _ = _fetch(f"{SEARCH_URL}?{query}", limit=5 * 1024 * 1024)
        return [{"title": r.get("collectionName") or r.get("trackName"), "author": r.get("artistName"),
                 "feed_url": r["feedUrl"], "image_url": r.get("artworkUrl600") or r.get("artworkUrl100")}
                for r in json.loads(data).get("results", []) if r.get("feedUrl")]

    @staticmethod
    def resolve(link: str) -> str:
        """Turn an Apple Podcasts page link into its RSS feed; anything else is taken as a feed."""
        match = re.search(r"podcasts\.apple\.com/.*?/id(\d+)", link)
        if not match:
            return link
        data, _ = _fetch(f"{LOOKUP_URL}?id={match.group(1)}&entity=podcast", limit=1024 * 1024)
        results = [r for r in json.loads(data).get("results", []) if r.get("feedUrl")]
        if not results:
            raise PodcastError("Couldn't find that show's feed.")
        return results[0]["feedUrl"]

    # ---- subscribing --------------------------------------------------------------

    def subscribe(self, link: str) -> dict:
        feed_url = self.resolve(link.strip())
        with self._lock:
            existing = next((s for s in self._shows.values() if s["feed_url"] == feed_url), None)
        if existing:
            return self.public(existing)
        feed = parse_feed(_fetch(feed_url)[0])
        show = {"id": uuid.uuid4().hex[:12], "title": feed["title"], "author": feed["author"], "feed_url": feed_url,
                "added_at": time.time(), "last_checked": time.time(), "image_file": None,
                "seen": [e["guid"] for e in feed["episodes"]][:SEEN_KEPT]}
        show["image_file"] = self._save_image(show["id"], feed["image_url"])
        with self._lock:
            self._shows[show["id"]] = show
            self._feeds[show["id"]] = feed
            self._save()
        for episode in feed["episodes"][:LATEST_ON_SUBSCRIBE]:
            self._queue(show, episode)
        return self.public(show)

    def unsubscribe(self, show_id: str):
        """Stop following a show. Episodes already downloaded stay in the library."""
        with self._lock:
            show = self._shows.pop(show_id, None)
            self._feeds.pop(show_id, None)
            self._save()
        if show and show.get("image_file"):
            (self.root / show["image_file"]).unlink(missing_ok=True)

    def _save_image(self, show_id: str, url: str | None) -> str | None:
        if not url:
            return None
        try:
            data, ctype = _fetch(url, limit=10 * 1024 * 1024)
        except Exception:
            return None
        name = f"show_{show_id}{'.png' if ctype == 'image/png' else '.jpg'}"
        (self.root / name).write_bytes(data)
        return name

    # ---- episodes -----------------------------------------------------------------

    @staticmethod
    def _source_id(show: dict, guid: str) -> str:
        return f"podcast:{show['id']}:{guid}"

    def _queue(self, show: dict, episode: dict):
        self.downloader.submit(episode["audio_url"], title=episode["title"], section="podcasts", episode={
            "source_id": self._source_id(show, episode["guid"]),
            "title": episode["title"],
            "artist": show["title"],
            "duration": episode["duration"],
            "published_at": episode["published_at"],
            "source_url": episode["link"] or episode["audio_url"],
            "podcast_id": show["id"],
            "cover": str(self.root / show["image_file"]) if show.get("image_file") else None,
        })

    def episodes(self, show_id: str) -> list[dict]:
        """Every episode in the feed, marked with whether it's in the library."""
        with self._lock:
            show = self._shows.get(show_id)
        if not show:
            return []
        feed = self._feeds.get(show_id) or self._refresh(show)
        out = []
        for e in feed["episodes"]:
            track = self.library.find_by_source(self._source_id(show, e["guid"]))
            out.append({k: e[k] for k in ("guid", "title", "published_at", "duration")} | {
                "track_id": track["id"] if track else None})
        return out

    def download(self, show_id: str, guid: str) -> bool:
        with self._lock:
            show = self._shows.get(show_id)
        feed = show and (self._feeds.get(show_id) or self._refresh(show))
        episode = feed and next((e for e in feed["episodes"] if e["guid"] == guid), None)
        if not episode:
            return False
        self._queue(show, episode)
        return True

    # ---- checking for new episodes --------------------------------------------------

    def _refresh(self, show: dict) -> dict:
        feed = parse_feed(_fetch(show["feed_url"])[0])
        with self._lock:
            self._feeds[show["id"]] = feed
        return feed

    def check(self) -> int:
        """Look for new episodes on every show, download them, and say so. Returns how many."""
        new = []
        for show in list(self._shows.values()):
            try:
                feed = self._refresh(show)
            except Exception as e:  # one broken feed shouldn't stop the others
                print(f"[podcasts] couldn't check {show['title']}: {e}", flush=True)
                continue
            with self._lock:
                seen = set(show["seen"])
                fresh = [e for e in feed["episodes"] if e["guid"] not in seen]
                show["seen"] = ([e["guid"] for e in fresh] + show["seen"])[:SEEN_KEPT]
                show["last_checked"] = time.time()
                if feed["title"] and feed["title"] != show["title"]:
                    show["title"] = feed["title"]
                self._save()
            for episode in fresh:
                self._queue(show, episode)
                new.append((show, episode))
        if len(new) == 1:
            show, episode = new[0]
            self.push.send(f"🎙 {show['title']}", f"New episode: {episode['title']}", url="/?section=podcasts", tag="podcasts")
        elif new:
            shows = sorted({s["title"] for s, _ in new})
            self.push.send("🎙 New podcast episodes", f"{len(new)} new from {', '.join(shows[:3])}"
                           + (" and more" if len(shows) > 3 else ""), url="/?section=podcasts", tag="podcasts")
        return len(new)

    def _checker(self):
        time.sleep(60)  # let the server settle after starting up
        while True:
            try:
                if self._shows:
                    self.check()
            except Exception as e:
                print(f"[podcasts] check failed: {e}", flush=True)
            time.sleep(CHECK_EVERY)
