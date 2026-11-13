# BerryGoodBot: BerryGoodTunes

A personal music app. Paste a video link and your Windows PC pulls out the audio. The song then lands in a music player on your iPhone that works offline.

```
iPhone (home-screen app)  ──Tailscale──▶  Windows PC
  • library + player                        • server/ (FastAPI)
  • songs saved on the phone                 • yt-dlp + ffmpeg download the audio
  • works with the PC off                    • keeps the master copy of your library
```

- **The PC is only needed to add songs.** Everything already on the phone plays with the PC off.
- **Links you add while the PC is off wait on the phone** and are sent automatically when the PC is reachable again.
- **Nothing is exposed to the internet.** Tailscale makes the PC reachable only from your own signed-in devices.
- **Audio is YouTube's native AAC stream (`.m4a`), saved without re-encoding.** Sources that aren't AAC are converted once at 192 kbps.
- **Supported sites:** YouTube and the [~1,800 sites yt-dlp supports](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md), either single videos or whole playlists.

## Setup

### 1. On the Windows PC

1. Download this repo (Code → Download ZIP, then right-click → **Extract All**) and put the folder somewhere permanent. Don't move it after step 3, or auto-start loses track of it.
2. In the `windows` folder, **double-click `setup.cmd`**.
   This installs Python, ffmpeg, Deno (which yt-dlp needs for YouTube) and Tailscale if they're missing, sets up the server and shares it over Tailscale.
   - On first run, Tailscale will ask you to **log in**. If it prints a link about **enabling HTTPS**, open it and click enable. Then run `setup.cmd` again.
   - At the end it prints an address like `https://your-pc.tail1234.ts.net`. **Keep it; that's your app's address.**
3. **Double-click `install-autostart.cmd`.** The server now starts hidden whenever you log in, and starts right away too.
   - To remove auto-start, run `install-autostart.cmd -Remove` from a terminal.
   - **After updating the files**, double-click `restart.cmd` to load the new version. No need to reboot.
   - `start.cmd` runs the server in a visible window instead, which is handy for watching errors. Don't use it while auto-start is running; both use the same port.

   Use the `.cmd` files rather than the `.ps1` ones. Windows blocks `.ps1` scripts by default ("running scripts is disabled on this system"), and the `.cmd` files get around that for these scripts only.
4. Optional: in Windows **Settings → System → Power**, set sleep to "Never" while plugged in, or at least long enough to finish downloads you queue from your phone.

### 2. On the iPhone

1. Install **Tailscale** from the App Store and sign in with the **same account** as on the PC.
2. In **Safari**, open your `https://….ts.net` address.
3. Tap **Share → Add to Home Screen**. From now on, always open BerryGoodTunes from the home-screen icon. Safari and the home-screen app keep separate libraries on the phone.

### 3. "Add to BerryGoodTunes" in the Share sheet (recommended)

iOS doesn't let home-screen web apps appear in the Share sheet, so an iOS Shortcut sends the link to your PC instead:

1. Open **Shortcuts → +**, and name it **Add to BerryGoodTunes**.
2. Tap the **ⓘ** (details) button and turn on **Show in Share Sheet**. Set it to receive **URLs** and **Text**.
3. Add the action **Get Contents of URL**:
   - URL: `https://your-pc.tail1234.ts.net/api/jobs`
   - Method: **POST**
   - Request Body: **JSON**, with one field: key `url`, type Text, value **Shortcut Input**
4. Add the action **Show Notification** with the text `Sent to BerryGoodTunes`.

Now in YouTube (or any app), tap **Share → Add to BerryGoodTunes**. Open BerryGoodTunes a minute later and the song will be there and saved to the phone. The Shortcut needs the PC on. If it's off, paste the link into the app instead, and the app will hold it until the PC is back.

## Using it

- **Add:** paste a link and tap **Add**. Progress shows at the top.
- **Whole playlists:** share or paste a **playlist** link (on YouTube: open the playlist, then Share). Every song in it gets queued. Songs already in your library are skipped, and deleted or private videos show an error you can dismiss. Downloads run one at a time with a short pause between them so YouTube doesn't flag a burst of requests. A 50-song playlist takes a few minutes. **Cancel** on the "songs waiting" row stops the rest.
  - A link to a *video that's playing inside a playlist* (`watch?v=…&list=…`) adds just that one video.
  - The songs go into your library like any others; put them into your own playlists if you want them grouped. Adding the same YouTube playlist again later only fetches songs you don't already have.
- **Failed downloads:** when two or more fail, a **Retry all** row appears above them. Each failed song also has its own **Retry**, and retried songs don't create duplicates.
- **✨ Fresh mix (new music every day):** each evening your PC offers about 20 new songs related to the music you already have. It picks a few of your songs and follows YouTube's auto-generated "Mix" for each, skipping anything you already have or were offered before.
  - **The prompt:** around **5:30 PM** (your PC's time), if the PC is on, your phone gets a notification. If the PC is off then, it comes when you switch it on that evening. No need to leave the PC on overnight. Tap the notification to start, or use the **Start / Not today** banner in the app. **Fetch a new mix now** in the Fresh tab works any time the PC is on.
  - **Where songs go:** new songs appear only in the **✨ Fresh** tab, not in All music. To keep one, use **⋯ → Keep in my library**, or add it to a playlist. Songs you don't keep are cleared, from the PC and your phones, when the next mix arrives.
  - **Notifications, one-time setup per phone:** open the app from the Home Screen, go to **Settings → Notifications on this device → Turn on**, and tap **Allow**. That button then becomes **Send test**. Needs iOS 16.4 or newer. If you tapped Don't Allow, turn it back on in iPhone **Settings → Notifications → BerryGoodTunes**.
- **Music and Podcasts:** the switch at the top keeps spoken-word content (podcasts, lectures, audiobooks) out of your music. Each side has its own list, search, playlists, and Play/Shuffle. Music is the default.
  - **Links pasted in the app** go to whichever side you're on.
  - **Links from the Share-sheet Shortcut are sorted automatically:** anything YouTube labels as Music goes to Music, and anything else 20 minutes or longer goes to Podcasts. The download banner says where each one went.
  - **Wrong side?** Use the song's **⋯** menu → **Move to Podcasts** / **Move to Music**. Moving removes it from the old side's playlists.
  - Optional: make a second Shortcut, e.g. **Add to Podcasts**, identical to the first but with a second JSON field: key `section`, value `podcasts`. It always sends to Podcasts. Use `music` for the reverse.
- **Resume where you left off:** podcasts, and anything 20 minutes or longer (like a long mix in Music), remember where you stopped and pick up a few seconds before that spot. Regular songs always start from the beginning.
  - The list shows **"23 min left"** with a progress bar, or **Played** once you've finished (stopping in the last 30 seconds counts).
  - Playing something marked Played starts it from the beginning.
  - The **⋯** menu has **Mark as played / Mark as unplayed**. Unplayed also clears a half-way position.
  - Positions sync through your PC, so you can pause on one device and continue on another.
- **Playlists:** the row of tabs under the search box switches between **All** and that side's playlists. Playlists belong to the side they were created on.
  - **+ New** creates a playlist.
  - A song's **⋯** menu → **Add to playlist…** adds or removes it (tap a playlist to toggle it). When viewing a playlist, the menu also offers **Remove from "…"**.
  - Tap the **selected** tab again to rename or delete the playlist. Deleting a playlist never deletes its songs.
  - Play and Shuffle play the playlist you're viewing.
  - Playlists are stored on your PC, so they sync to every device. Changing them needs the PC online; viewing and playing works offline.
- **Play:** tap a song. It plays through the list, and shuffle and repeat are in the full player (tap the mini player). Lock-screen controls and artwork work.
- **Song status icons:** ✅ saved on this device (plays offline) · ☁️ on your PC only (plays only while the PC is reachable) · ⬇️ saving now.
- **⋯ menu:** save to this device, open the original video, or delete. Delete removes the song from the PC and this phone.
- **Settings (gear):** auto-save new songs to this device (on by default), storage used, the yt-dlp version, and "save all songs now".
- **Several devices:** each device you add the app to downloads the PC's library, so they all stay in sync while the PC is on.

## If YouTube downloads start failing

1. **"HTTP Error 403: Forbidden" on some songs** means YouTube refused that download, usually briefly. Failed songs are retried automatically (up to 3 tries), and any that still fail get a **Retry** button. If most downloads get 403, open **Settings** in the app and check **YouTube helper (Deno)**. If it says **Missing**, re-run `setup.cmd` and then `restart.cmd`.
2. **Restart the server** (`restart.cmd`). Every start updates yt-dlp, which fixes most breakages.
3. **Still failing with "Sign in to confirm you're not a bot"**, or constant 403s? Give it cookies from a logged-in YouTube account:
   - Use a **secondary Google account, not your main one.** Google occasionally flags accounts used this way.
   - Log in to YouTube with it in your browser, export its cookies with the "Get cookies.txt LOCALLY" extension, and save the file as `server\cookies.txt`. Then restart the server.
4. Errors from each download show in the app. The full server log, including yt-dlp's warnings, is at `server\logs\server.log`.

## Where things live

| What | Where |
|---|---|
| Your music (master copy) | `server\library\` on the PC (`tracks.json` + `.m4a`/`.jpg` files) |
| Songs on the phone | Inside the home-screen app's storage |
| Server log | `server\logs\server.log` |

Back up `server\library\` if you care about it. iOS can clear a web app's saved files when the phone is very low on space. If that happens, the songs download again from the PC.

## Known limits

- **Background playback:** iOS has historically been flaky with audio in home-screen web apps (playback stopping when you lock the phone or switch apps). Recent iOS versions are much better, but check this first on your phone.
- **Playlists in the app:** a playlist link adds its songs to your library, but the app doesn't have its own playlists yet. Everything goes in one list.

## Project layout

```
server/    FastAPI app: API + serves the web app (app.py, downloader.py, library.py)
web/       The phone app: plain HTML/CSS/JS, service worker for offline use
windows/   setup, start and install-autostart scripts (.cmd launchers for the .ps1 files)
```

Run the server anywhere for development: `pip install -r server/requirements.txt`, then `cd server && uvicorn app:app --port 8765`, then open http://localhost:8765. Needs `ffmpeg` on PATH (or set `BERRY_FFMPEG` to its folder).
