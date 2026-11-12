"""Web Push notifications from the PC to the phone (no third-party server needed).

The PC signs each notification with its own key (created on first run) and hands it to the
phone's push service (Apple's, for an iPhone), which delivers it even with the app closed.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid, b64urlencode
from pywebpush import WebPushException, webpush

# Push services want a contact for the sender. It's never shown to anyone; override if you like.
CONTACT = os.environ.get("BERRY_PUSH_CONTACT", "mailto:berrygoodtunes@example.com")


class Push:
    def __init__(self, root: Path):
        self.key_path = root / "push_key.pem"
        self.subs_path = root / "push_subscriptions.json"
        self._lock = threading.Lock()
        if not self.key_path.exists():
            vapid = Vapid()
            vapid.generate_keys()
            vapid.save_key(str(self.key_path))
        self._vapid = Vapid.from_file(str(self.key_path))
        self._subs: list[dict] = json.loads(self.subs_path.read_text(encoding="utf-8")) if self.subs_path.exists() else []

    def _save(self):
        tmp = self.subs_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._subs, indent=1), encoding="utf-8")
        tmp.replace(self.subs_path)

    def public_key(self) -> str:
        raw = self._vapid.public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        return b64urlencode(raw)

    def subscribe(self, subscription: dict):
        with self._lock:
            self._subs = [s for s in self._subs if s["endpoint"] != subscription["endpoint"]] + [subscription]
            self._save()

    def unsubscribe(self, endpoint: str):
        with self._lock:
            self._subs = [s for s in self._subs if s["endpoint"] != endpoint]
            self._save()

    @property
    def device_count(self) -> int:
        return len(self._subs)

    def send(self, title: str, body: str, url: str = "/", tag: str = "berrygoodtunes") -> int:
        """Notify every subscribed device. Returns how many accepted it."""
        payload = json.dumps({"title": title, "body": body, "url": url, "tag": tag})
        sent = 0
        for sub in list(self._subs):
            try:
                webpush(sub, data=payload, vapid_private_key=self._vapid, vapid_claims={"sub": CONTACT},
                        ttl=6 * 3600, timeout=15)
                sent += 1
            except WebPushException as e:
                status = getattr(e.response, "status_code", None)
                if status in (404, 410):  # the device unsubscribed or the app was removed
                    self.unsubscribe(sub["endpoint"])
                print(f"[push] failed ({status}): {e}", file=sys.stderr, flush=True)
            except Exception as e:  # network trouble; try again next time
                print(f"[push] failed: {e}", file=sys.stderr, flush=True)
        return sent
