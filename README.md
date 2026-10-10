# Sway · Final

> **Intelligent DJ System** — Mix music using phone motion. No screens needed during the set.

## Features

1. **Local MP3 Playback**: Load any MP3 file on Deck A and Deck B.
2. **Real-time Audio Analysis**: Automatically detects BPM, phrases, and downbeats.
3. **Motion Control**:
   - **Mix** (Tilt left/right): Crossfade between decks.
   - **Energy** (Tilt forward/back): Highpass/Lowpass filters to build tension or muffle.
4. **Intelligent Auto DJ**:
   - Switches automatically when you request a transition via motion.
   - Waits for the perfect musical moment (phrase boundary or downbeat).
   - Syncs BPM temporarily to keep the mix smooth.
5. **Debug / Demo Mode**:
   - Fully polished UI with a collapsible debug panel.
   - Clear visual indicators for all motion states.

## Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the server (HTTPS is required for phone sensors):
   ```bash
   npm run dev
   ```
   *If you need to access it over the internet (e.g. for testing off-network), use a Cloudflare tunnel:*
   ```bash
   cloudflared tunnel --url https://localhost:3443 --no-tls-verify
   ```

3. Open `https://localhost:3443` on your laptop (accept the self-signed certificate warning).
4. Scan the QR code with your phone.
5. Tap **CALIBRATE** on your phone (hold it flat/naturally).
6. Load two MP3 files on the laptop.
7. Play both and start moving!

## Configuration

Sway automatically redirects HTTP `3000` to HTTPS `3443` since mobile browsers require a secure context to expose `DeviceOrientation` events.
If you need to change ports, edit `.env` or set `PORT` and `HTTPS_PORT` environment variables.

To modify sensor sensitivity, edit `CONFIG` in `public/scripts/controller.js`.

## Tech Stack
- **Web Audio API**: Real-time audio routing, crossfading, EQ, and Biquad filters.
- **HTML5 Media**: `<audio>` tag used as source to stream large files without RAM bloat.
- **WebSockets**: Sub-millisecond latency communication between phone and laptop.
- **Vanilla JS & CSS**: No heavy frameworks.
