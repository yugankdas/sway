/**
 * Sway – DJ Booth (Laptop) Script
 *
 * Responsibilities:
 *  - WebSocket to server as role=dashboard (protocol unchanged)
 *  - QR code loading / phone pairing state
 *  - Motion data → smoothing → DJ engine (unchanged pipeline)
 *  - Deck setup (load, play, time, waveform, level)
 *  - Mixer display: the crossfader shows the ENGINE's real audio fader;
 *    a red marker shows the phone's requested position (intent) in Auto DJ.
 *  - Auto DJ / Manual mode toggle and honest transition status
 *  - Diagnostics drawer (collapsible)
 *
 * Visual effects never feed back into audio timing: the engine runs from the
 * render loop exactly as before, and the UI only reads its state.
 */

import { deckA, deckB, formatTime, audioCtx } from './audio.js';
import { djEngine } from './engine.js';
import { generateRoomCode, formatRoomCode } from './room.js';

// ─── Room code (unique per booth, persisted across reloads) ──────────────────

const ROOM_KEY = 'sway-room-code';
let roomCode = sessionStorage.getItem(ROOM_KEY);
if (!roomCode) {
  roomCode = generateRoomCode();
  sessionStorage.setItem(ROOM_KEY, roomCode);
}

// ─── Constants ───────────────────────────────────────────────────────────────

const WS_URL            = (() => {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/?role=dashboard&room=${roomCode}`;
})();
const RECONNECT_DELAY   = 2500;
const PING_INTERVAL     = 3000;
const LERP_RATE         = 0.18; // render loop smoothing
const COMPLETE_HOLD_MS  = 2200; // how long "complete" stays on the announcer
const KEY_STEP          = 0.05;

// ─── State ───────────────────────────────────────────────────────────────────

let ws              = null;
let reconnectTimer  = null;
let pingTimer       = null;
let lastPingTime    = 0;
let messageCount    = 0;
let hzCounter       = 0;
let hzLastReset     = Date.now();
let lastMotionAt    = 0;

// Smoothed values from phone (lerped in render loop)
let targetValue     = 0.5;
let currentValue    = 0.5;
let targetValueY    = 0.5;
let currentValueY   = 0.5;

let phoneConnected  = null;  // null = unknown (first status not yet received)
let phoneCalibrated = false;

// ─── DOM refs ────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const elBody              = document.body;
const elWsStatus          = $('ws-status');
const elWsLabel           = elWsStatus.querySelector('.ws-label');
const elBanner            = $('connection-banner');
const elBannerText        = $('connection-banner-text');
const elQrLoading         = $('qr-loading');
const elQrImg             = $('qr-img');
const elConnectUrl        = $('connect-url');
const elPair              = $('connect-panel');
const elPairTitle         = $('pair-title');
const elPhonePill         = $('phone-status-badge');
const elPhonePillText     = elPhonePill.querySelector('.pill-text');
const elPhoneStateText    = $('phone-state-text');
const elCalibration       = $('calibration-badge');

const elAnnouncer         = $('transition-status');
const elAnnMode           = $('announcer-mode');
const elAnnSync           = $('announcer-sync');
const elTsLabel           = $('ts-label');
const elTsMessage         = $('ts-message');
const elStepBeat          = $('step-beat');
const elStepPhrase        = $('step-phrase');
const elStepBpm           = $('step-bpm');
const elActiveDeckIndicator = $('active-deck-indicator');
const elActiveDeckText    = $('active-deck-text');
const elDeckA             = $('deck-a');
const elDeckB             = $('deck-b');

// Mixer
const elCfTrack       = $('crossfader-track');
const elCfHandle      = $('cf-handle');
const elCfIntent      = $('cf-intent');
const elControlValue  = $('control-value-display');
const elXfHint        = $('xf-hint');
const elXfBurst       = $('xf-burst');
const elXfBurstText   = $('xf-burst-text');

const elEnergyTrack   = $('energy-track');
const elEnergyHandle  = $('energy-handle');
const elEnergyValue   = $('energy-value-display');

// Mode toggle
const elModeManual    = $('mode-manual');
const elModeAuto      = $('mode-auto');

// Diagnostics
const elDebugPanel      = $('debug-panel');
const elDebugToggleBtn  = $('debug-toggle-btn');
const elDebugCloseBtn   = $('debug-close-btn');
const elDebugLatency    = $('debug-latency');
const elDebugHz         = $('debug-hz');
const elDebugTiltX      = $('debug-tiltx');
const elDebugTiltY      = $('debug-tilty');
const elDebugNorm       = $('debug-norm');
const elDebugMsgs       = $('debug-msgs');
const elDebugXfade      = $('debug-xfade');
const elDebugEngine     = $('debug-engine');
const elDebugAnalysisA  = $('debug-analysis-a');
const elDebugAnalysisB  = $('debug-analysis-b');
const elDebugCtx        = $('debug-ctx');
const elDebugRate       = $('debug-rate');
const elEventLog        = $('event-log');
const elLogClearBtn     = $('log-clear-btn');

// Only touch the DOM when something actually changed.
function setText(el, text) { if (el && el.textContent !== text) el.textContent = text; }
function setAttr(el, name, value) { if (el && el.getAttribute(name) !== value) el.setAttribute(name, value); }

// ─── Diagnostics drawer ──────────────────────────────────────────────────────

let debugOpen = false;

function setDebugOpen(open) {
  debugOpen = open;
  elBody.classList.toggle('debug-open', open);
  elDebugPanel.setAttribute('aria-hidden', String(!open));
  elDebugPanel.inert = !open;
  elDebugToggleBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    elDebugMsgs.textContent = messageCount;
    elDebugCloseBtn.focus();
  } else if (document.activeElement && elDebugPanel.contains(document.activeElement)) {
    elDebugToggleBtn.focus();
  }
}

elDebugToggleBtn.addEventListener('click', () => setDebugOpen(!debugOpen));
elDebugCloseBtn.addEventListener('click',  () => setDebugOpen(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && debugOpen) setDebugOpen(false);
});

// ─── Mode toggle ─────────────────────────────────────────────────────────────

function applyModeUI(mode) {
  const auto = mode === 'AUTO';
  elModeManual.classList.toggle('mode-btn--active', !auto);
  elModeAuto.classList.toggle('mode-btn--active', auto);
  elModeManual.setAttribute('aria-pressed', String(!auto));
  elModeAuto.setAttribute('aria-pressed', String(auto));
  elAnnouncer.dataset.mode = mode;
  setText(elAnnMode, auto ? 'Auto DJ' : 'Manual');
  setText(elXfHint, auto
    ? 'Tilt fully toward the other deck to call a transition'
    : 'Tilt left / right · drag · arrow keys');
  holdUntil = 0;
  lastStatusMsg = '';
}

elModeManual.addEventListener('click', () => {
  djEngine.setMode('MANUAL');
  applyModeUI('MANUAL');
  logEvent('Switched to Manual mode');
});

elModeAuto.addEventListener('click', () => {
  djEngine.setMode('AUTO');
  applyModeUI('AUTO');
  logEvent('Switched to Auto DJ mode', 'ok');
});

// ─── Engine status → announcer ────────────────────────────────────────────────
// The engine reports human-readable messages every frame. We classify them
// into the states it actually implements; nothing here alters the engine.

let lastStatusMsg = '';
let holdUntil     = 0;      // keep "complete"/"cancelled" visible briefly
let lastSyncType  = '';

const SYNC_LABELS = {
  'phrase boundary':       'Synced to phrase',
  'downbeat':              'Synced to downbeat',
  'equal-power crossfade': 'Fallback: plain crossfade',
  'immediate cut':         'Outgoing deck stopped — immediate',
};

function classify(msg) {
  if (msg.startsWith('Now playing'))            return 'complete';
  if (msg.startsWith('Transition cancelled'))   return 'cancelled';
  if (msg.startsWith('Transitioning'))          return 'transitioning';
  if (msg.startsWith('Preparing'))              return 'waiting';
  if (msg.startsWith('Waiting for phrase') ||
      msg.startsWith('Waiting for beat'))       return 'waiting';
  if (msg.startsWith('Manual'))                 return 'manual';
  return 'idle'; // "Auto DJ active…", "Playing Deck X · Waiting for intent"
}

function headlineFor(state, msg) {
  switch (state) {
    case 'manual':        return 'Ride it!';
    case 'idle':          return 'Ready!';
    case 'waiting':
      if (msg.startsWith('Waiting for phrase')) return 'Hold it…';
      if (msg.startsWith('Preparing'))          return 'Get set…';
      return 'On the beat…';
    case 'transitioning': return 'Whoosh!';
    case 'complete':      return 'Ka-swap!';
    case 'cancelled':     return 'Called off';
    default:              return '';
  }
}

function friendlyMessage(state, msg) {
  if (state === 'manual') {
    return phoneCalibrated
      ? 'Tilt the phone or drag the fader.'
      : 'Drag the fader, or pair a phone to mix by tilting.';
  }
  if (state === 'idle') {
    const m = msg.match(/Playing Deck ([AB])/);
    if (m) return `Deck ${m[1]} is on air. Tilt hard toward Deck ${m[1] === 'A' ? 'B' : 'A'} to call the swap.`;
    return 'Push the fader to one deck to set who\'s on air, then tilt hard the other way to call a swap.';
  }
  if (state === 'waiting') {
    const m = msg.match(/\(([\d.]+)s\)/);
    if (msg.startsWith('Waiting for phrase')) return `Waiting for the next phrase — ${m ? m[1] : '?'}s.`;
    if (msg.startsWith('Waiting for beat'))   return `Waiting for the next downbeat — ${m ? m[1] : '?'}s.`;
    return 'Cueing the incoming deck.';
  }
  if (state === 'transitioning') {
    const m = msg.match(/(\d+)%/);
    return m ? `Blending, outgoing bass cut — fader at ${m[1]}%.` : 'Blending now.';
  }
  if (state === 'complete') {
    const d = msg.includes('Deck A') ? 'A' : 'B';
    return `Deck ${d} is on air.`;
  }
  if (state === 'cancelled') return 'You tilted back before the drop. Staying put.';
  return msg;
}

function syncLine(state) {
  if (djEngine.mode !== 'AUTO') return 'Direct crossfade';
  if (state === 'transitioning' || state === 'complete') return SYNC_LABELS[lastSyncType] || 'Blending';
  const a = deckA.analysisStatus, b = deckB.analysisStatus;
  if (a === 'loading' || b === 'loading') return 'Analyzing tracks…';
  if (a === 'done' && b === 'done') return 'Phrase + beat aware';
  if (a === 'failed' || b === 'failed') return 'Fallback: plain crossfade';
  return 'Load both decks for beat sync';
}

djEngine.onStatusChange = (msg, steps) => {
  if (steps) {
    applyStepClass(elStepBeat,   steps.beat   || '');
    applyStepClass(elStepPhrase, steps.phrase || '');
    applyStepClass(elStepBpm,    steps.bpm    || '');
  }

  if (msg === lastStatusMsg) return;
  const state = classify(msg);

  // While holding a "complete"/"cancelled" frame, ignore idle chatter
  if (Date.now() < holdUntil && (state === 'idle' || state === 'manual')) return;
  lastStatusMsg = msg;

  if (msg.startsWith('Transitioning at ')) {
    lastSyncType = msg.replace('Transitioning at ', '');
    logEvent(`Transition started (${lastSyncType})`, lastSyncType.includes('crossfade') ? 'warn' : 'ok');
  }

  elAnnouncer.dataset.state = state;
  setText(elTsLabel, headlineFor(state, msg));
  setText(elTsMessage, friendlyMessage(state, msg));
  setText(elAnnSync, syncLine(state));

  if (state === 'complete') {
    holdUntil = Date.now() + COMPLETE_HOLD_MS;
    const deck = msg.includes('Deck A') ? 'A' : 'B';
    fireBurst(`Deck ${deck}!`);
    logEvent(`Transition complete — Deck ${deck} on air`, 'ok');
  } else if (state === 'cancelled') {
    holdUntil = Date.now() + 1200;
    logEvent('Transition cancelled', 'warn');
  } else if (state === 'idle' || state === 'manual') {
    applyStepClass(elStepBeat, ''); applyStepClass(elStepPhrase, ''); applyStepClass(elStepBpm, '');
  }
};

function applyStepClass(el, state) {
  const cls = 'ts-step' + (state ? ` ${state}` : '');
  if (el.className !== cls) el.className = cls;
}

function fireBurst(text) {
  elXfBurstText.textContent = text;
  elXfBurst.classList.remove('is-firing');
  void elXfBurst.offsetWidth; // restart animation
  elXfBurst.classList.add('is-firing');
}
elXfBurst.addEventListener('animationend', () => elXfBurst.classList.remove('is-firing'));

// ─── QR Code ─────────────────────────────────────────────────────────────────

async function loadQRCode() {
  try {
    const res  = await fetch(`/api/qrcode?room=${roomCode}`);
    const data = await res.json();
    elQrImg.onload = () => {
      elQrLoading.hidden = true;
      elQrImg.hidden = false;
    };
    elQrImg.src = data.qr;
    elConnectUrl.textContent = data.url;
    // Show the room code prominently below the URL
    const codeEl = document.getElementById('room-code-display');
    if (codeEl) codeEl.textContent = formatRoomCode(roomCode);
    logEvent(`Room ${roomCode} · QR → ${data.url}`, 'ok');
  } catch (err) {
    elQrLoading.textContent = 'QR unavailable';
    logEvent(`QR code failed: ${err.message}`, 'error');
  }
}

// ─── WebSocket ───────────────────────────────────────────────────────────────

function connect() {
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  setWsState('connecting');

  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    logEvent(`WS init error: ${err.message}`, 'error');
    scheduleReconnect();
    return;
  }

  ws.addEventListener('open',    onOpen);
  ws.addEventListener('message', onMessage);
  ws.addEventListener('close',   onClose);
  ws.addEventListener('error',   onError);
}

function onOpen() {
  setWsState('connected');
  logEvent('Server connected', 'ok');
  startPing();
}

function onMessage(event) {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }

  switch (msg.type) {
    case 'welcome':
      logEvent(`Connected as client #${msg.clientId}`);
      break;
    case 'motion':
      handleMotion(msg);
      break;
    case 'calibrated':
      phoneCalibrated = true;
      renderPhoneState();
      showBanner('Phone calibrated — ready to mix', 'connected', 3500);
      logEvent('Phone calibrated', 'ok');
      break;
    case 'status':
      handleStatus(msg);
      break;
    case 'pong':
      if (msg.echo === lastPingTime) {
        elDebugLatency.textContent = Date.now() - lastPingTime;
      }
      break;
    default:
      break;
  }
}

function onClose(event) {
  setWsState('disconnected');
  clearInterval(pingTimer);
  logEvent(`Disconnected (${event.code})`, 'warn');
  scheduleReconnect();
}

function onError() {
  // onClose will handle reconnect
  logEvent('WebSocket error', 'error');
}

function scheduleReconnect() {
  reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
}

function startPing() {
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      lastPingTime = Date.now();
      ws.send(JSON.stringify({ type: 'ping', t: lastPingTime }));
    }
  }, PING_INTERVAL);
}

function setWsState(state) {
  const map = {
    connecting:   ['busy',  'Server…'],
    connected:    ['ok',    'Server'],
    disconnected: ['error', 'Server offline'],
  };
  const [pill, label] = map[state] ?? ['', state];
  elWsStatus.dataset.state = pill;
  elWsLabel.textContent = label;
  elWsStatus.title = `Laptop ↔ server: ${state}`;
}

// ─── Phone connection status ─────────────────────────────────────────────────

function handleStatus(msg) {
  const nowConnected = msg.controllers > 0;
  const changed = phoneConnected !== null && nowConnected !== phoneConnected;
  phoneConnected = nowConnected;
  if (!nowConnected) phoneCalibrated = false;
  renderPhoneState();

  // Announce real changes only — not the initial status on page load.
  if (changed && nowConnected) {
    showBanner('Phone connected — tap Calibrate on the phone', 'connected', 5000);
    logEvent('Phone connected', 'ok');
  } else if (changed && !nowConnected) {
    showBanner('Phone disconnected', 'disconnected', 4000);
    logEvent('Phone disconnected', 'warn');
  }
}

function renderPhoneState() {
  let pill, text, pairState, title, detail;
  if (!phoneConnected) {
    pill = ''; text = 'No phone'; pairState = 'waiting';
    title = 'Pair your phone'; detail = 'Waiting';
  } else if (!phoneCalibrated) {
    pill = 'warn'; text = 'Phone: calibrate'; pairState = 'connected';
    title = 'Phone linked'; detail = 'Connected';
  } else {
    pill = 'live'; text = 'Phone ready'; pairState = 'calibrated';
    title = 'Phone is the fader'; detail = 'Connected';
  }
  elPhonePill.dataset.state = pill;
  setText(elPhonePillText, text);
  elPair.dataset.phone = pairState;
  setText(elPairTitle, title);
  setText(elPhoneStateText, detail);
  setText(elCalibration, phoneCalibrated ? 'Calibrated' : 'Not calibrated');
  elCalibration.className = phoneCalibrated ? 'badge badge--calibrated' : 'badge';
}

function showBanner(text, type, autohideMs) {
  clearTimeout(elBanner._timer);
  elBanner.dataset.type = type;
  elBannerText.textContent = text;
  elBanner.hidden = false;
  elBanner._timer = setTimeout(() => { elBanner.hidden = true; }, autohideMs);
}

// ─── Motion handling ─────────────────────────────────────────────────────────

function handleMotion(msg) {
  messageCount++;
  hzCounter++;
  lastMotionAt = Date.now();

  const alpha = 0.22; // client-side smoothing on top of phone-side smoothing
  targetValue    = alpha * (msg.value    ?? 0.5) + (1 - alpha) * targetValue;
  targetValueY   = alpha * (msg.valueY   ?? 0.5) + (1 - alpha) * targetValueY;

  if (debugOpen) {
    elDebugMsgs.textContent  = messageCount;
    elDebugTiltX.textContent = msg.tiltX?.toFixed(1) ?? '—';
    elDebugTiltY.textContent = msg.tiltY?.toFixed(1) ?? '—';
    elDebugNorm.textContent  = msg.value?.toFixed(3)  ?? '—';
  }

  const now = Date.now();
  if (now - hzLastReset >= 1000) {
    if (debugOpen) elDebugHz.textContent = hzCounter;
    hzCounter   = 0;
    hzLastReset = now;
  }
}

// ─── Render loop ───────────────────────────────────────────────────────────────

let lastDebugWrite = 0;

function renderLoop() {
  // Lerp current → target (unchanged)
  currentValue    += (targetValue    - currentValue)    * LERP_RATE;
  currentValueY   += (targetValueY   - currentValueY)   * LERP_RATE;

  currentValue    = clamp(currentValue);
  currentValueY   = clamp(currentValueY);

  // Engine first; the UI then reflects what the engine actually did.
  djEngine.update(currentValue, currentValueY);

  const fader = clamp(djEngine.virtualFader);
  renderCrossfader(fader, currentValue);
  renderEnergy(currentValueY);
  renderOnAir(fader);
  renderLevels();

  if (debugOpen && performance.now() - lastDebugWrite > 100) {
    lastDebugWrite = performance.now();
    elDebugXfade.textContent  = fader.toFixed(3);
    elDebugEngine.textContent = `${djEngine.mode} · ${djEngine.transitionState}`;
    elDebugCtx.textContent    = audioCtx.state;
    elDebugRate.textContent   = `A ${deckA.audioElement.playbackRate.toFixed(3)} · B ${deckB.audioElement.playbackRate.toFixed(3)}`;
  }

  requestAnimationFrame(renderLoop);
}

function renderCrossfader(fader, intent) {
  const p = fader * 100;
  // Inset by half the handle width so the cap never overhangs the track ends
  elCfHandle.style.left = `calc(22px + (100% - 44px) * ${fader.toFixed(4)})`;
  const gA = Math.round(Math.cos(fader * 0.5 * Math.PI) * 100);
  const gB = Math.round(Math.cos((1 - fader) * 0.5 * Math.PI) * 100);
  setText(elControlValue, `A ${gA} · B ${gB}`);
  setAttr(elCfTrack, 'aria-valuenow', String(Math.round(p)));
  setAttr(elCfTrack, 'aria-valuetext',
    fader < 0.03 ? 'Deck A only' : fader > 0.97 ? 'Deck B only' : `Deck A ${gA}%, Deck B ${gB}%`);

  // In Auto DJ the phone's request can differ from the audio fader — show both.
  const showIntent = djEngine.mode === 'AUTO' && Math.abs(intent - fader) > 0.03;
  setAttr(elCfTrack, 'data-intent-visible', String(showIntent));
  if (showIntent) elCfIntent.style.left = `calc(22px + (100% - 44px) * ${intent.toFixed(4)})`;
}

function renderEnergy(v) {
  elEnergyHandle.style.left = `calc(15px + (100% - 30px) * ${v.toFixed(4)})`;
  // Mirrors audio.js setEnergy(): ±0.05 neutral band → filter open
  const d = v - 0.5;
  let label;
  if (Math.abs(d) < 0.05) label = 'Open';
  else if (d > 0) label = `Lift ${Math.round((d - 0.05) / 0.45 * 100)}%`;
  else label = `Muffle ${Math.round((-d - 0.05) / 0.45 * 100)}%`;
  setText(elEnergyValue, label);
  setAttr(elEnergyTrack, 'aria-valuenow', String(Math.round(v * 100)));
  setAttr(elEnergyTrack, 'aria-valuetext', label);
}

function renderOnAir(fader) {
  const gA = Math.cos(fader * 0.5 * Math.PI) * deckA.baseVolume;
  const gB = Math.cos((1 - fader) * 0.5 * Math.PI) * deckB.baseVolume;
  const aOn = deckA.isPlaying && gA > 0.25;
  const bOn = deckB.isPlaying && gB > 0.25;
  setAttr(elDeckA, 'data-active', String(aOn));
  setAttr(elDeckB, 'data-active', String(bOn));
  const on = aOn && bOn ? 'both' : aOn ? 'A' : bOn ? 'B' : '';
  setAttr(elActiveDeckIndicator, 'data-on', on);
  setText(elActiveDeckText,
    on === 'both' ? 'Both decks audible' : on ? `Deck ${on} on air` : 'Nothing on air');
}

function clamp(v) { return Math.max(0, Math.min(1, v)); }

// ─── Manual slider drag + keyboard ──────────────────────────────────────────────

function makeDragger(trackEl, onValue) {
  trackEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    trackEl.focus({ preventScroll: true });
    trackEl.setPointerCapture(e.pointerId);
    onValue(e, trackEl);
    trackEl._dragging = true;
    trackEl.classList.add('is-dragging');
  });
  trackEl.addEventListener('pointermove', (e) => {
    if (!trackEl._dragging) return;
    onValue(e, trackEl);
  });
  const stop = () => { trackEl._dragging = false; trackEl.classList.remove('is-dragging'); };
  trackEl.addEventListener('pointerup',     stop);
  trackEl.addEventListener('pointercancel', stop);
}

function makeKeyboard(trackEl, get, set) {
  trackEl.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    let v = get();
    switch (e.key) {
      case 'ArrowLeft':  case 'ArrowDown': v -= step; break;
      case 'ArrowRight': case 'ArrowUp':   v += step; break;
      case 'Home': v = 0; break;
      case 'End':  v = 1; break;
      case ' ': case 'Enter': v = 0.5; break;
      default: return;
    }
    e.preventDefault();
    set(clamp(v));
  });
}

function pointerValue(e, el, inset) {
  const r = el.getBoundingClientRect();
  return clamp((e.clientX - r.left - inset) / (r.width - inset * 2));
}

makeDragger(elCfTrack,     (e) => { targetValue  = pointerValue(e, elCfTrack, 22); });
makeDragger(elEnergyTrack, (e) => { targetValueY = pointerValue(e, elEnergyTrack, 15); });
makeKeyboard(elCfTrack,     () => targetValue,  (v) => { targetValue  = v; });
makeKeyboard(elEnergyTrack, () => targetValueY, (v) => { targetValueY = v; });

// ─── Deck setup ───────────────────────────────────────────────────────────────

const deckViews = {};

function setupDeck(deckPrefix, deckObj) {
  const letter     = deckObj.id;
  const elDeck     = $(deckPrefix);
  const elFile     = $(`${deckPrefix}-file`);
  const elUploadTx = $(`${deckPrefix}-upload-label`).querySelector('.file-upload-text');
  const elTrack    = $(`${deckPrefix}-track`);
  const elPlay     = $(`${deckPrefix}-play`);
  const elPlayUse  = elPlay.querySelector('use');
  const elPlayTx   = elPlay.querySelector('.btn-play-label');
  const elTime     = $(`${deckPrefix}-time`);
  const elDuration = $(`${deckPrefix}-duration`);
  const elVol      = $(`${deckPrefix}-vol`);
  const elBpm      = $(`${deckPrefix}-bpm`);
  const elAnalysis = $(`${deckPrefix}-analysis-badge`);
  const elFill     = $(`${deckPrefix}-progress-fill`);
  const elHead     = $(`${deckPrefix}-progress-head`);
  const elCanvas   = $(`${deckPrefix}-wave-canvas`);
  const elLevel    = $(`${deckPrefix}-level`);
  const elDebugAn  = letter === 'A' ? elDebugAnalysisA : elDebugAnalysisB;

  // Level meter: a passive analyser tap after the deck's gain. It has no
  // outputs, so it cannot change what reaches the speakers.
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  deckObj.gainNode.connect(analyser);

  const view = {
    deckObj, elCanvas, elLevel, analyser,
    buf: new Float32Array(analyser.fftSize),
    peaks: null, duration: 0, level: 0, loadToken: 0,
  };
  deckViews[letter] = view;

  // File load
  elFile.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    deckObj.loadTrack(file);
    const name = file.name.replace(/\.[^.]+$/, '');
    elTrack.textContent = name;
    elTrack.title = name;
    elPlay.disabled = false;
    elBpm.textContent = '—';
    elUploadTx.textContent = 'Swap MP3';
    elDeck.dataset.state = 'loaded';
    elFill.style.width = '0%';
    elHead.style.left = '0%';
    elTime.textContent = '0:00';
    view.peaks = null;
    drawWave(view);
    computePeaks(view, file);
    logEvent(`Deck ${letter}: loaded "${name}"`, 'ok');
    e.target.value = ''; // allow re-selecting the same file later
  });

  elPlay.addEventListener('click', () => { deckObj.togglePlay(); });

  const syncVolFill = () => elVol.style.setProperty('--pct', `${parseFloat(elVol.value) * 100}%`);
  elVol.addEventListener('input', (e) => {
    deckObj.setBaseVolume(parseFloat(e.target.value));
    syncVolFill();
  });
  syncVolFill();

  deckObj.onTimeUpdate = (ct, dur) => {
    elTime.textContent = formatTime(ct);
    if (dur && isFinite(dur) && dur > 0) {
      const pctFill = (ct / dur) * 100;
      elFill.style.width = `${pctFill}%`;
      elHead.style.left  = `${pctFill}%`;
    }
  };

  deckObj.onLoaded = (dur) => { elDuration.textContent = formatTime(dur); };

  deckObj.onPlayStateChange = (playing) => {
    elPlayUse.setAttribute('href', playing ? '#i-pause' : '#i-play');
    elPlayTx.textContent = playing ? 'Pause' : 'Play';
    elPlay.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} deck ${letter}`);
    elPlay.classList.toggle('playing', playing);
    elDeck.dataset.state = playing ? 'playing' : (deckObj.audioElement.src ? 'loaded' : 'empty');
    logEvent(`Deck ${letter} ${playing ? 'playing' : 'paused'}`);
  };

  deckObj.onAnalysisStatus = (status) => {
    const labels = { loading: 'Analyzing…', done: 'Analyzed', failed: 'No analysis' };
    elAnalysis.textContent = labels[status] || status;
    elAnalysis.dataset.status = status;
    elAnalysis.title = status === 'failed'
      ? 'Beat analysis unavailable — Auto DJ will use a plain crossfade'
      : '';
    if (status === 'failed') {
      elBpm.textContent = '—';
      elDebugAn.textContent = 'failed';
      logEvent(`Deck ${letter} analysis unavailable — using crossfade fallback`, 'warn');
    } else if (status === 'loading') {
      elDebugAn.textContent = 'loading';
    }
    lastStatusMsg = ''; // refresh announcer sync line next frame
  };

  deckObj.onAnalysisComplete = (analysis) => {
    if (!analysis) return;
    const bpm = Math.round(analysis.bpm);
    elBpm.textContent = bpm > 0 ? String(bpm) : '—';
    const canvas = $(`canvas-${letter.toLowerCase()}`);
    const bpmDebug = $(`analysis-${letter.toLowerCase()}-bpm`);
    if (canvas) drawAnalysis(canvas, analysis);
    if (bpmDebug) bpmDebug.textContent = bpm > 0 ? `· ${bpm} BPM` : '';
    elDebugAn.textContent = `${bpm} BPM · ${analysis.sections?.length ?? 0} sections`;
    drawWave(view);
    logEvent(`Deck ${letter} analyzed — ${bpm} BPM`, 'ok');
  };
}

// ─── Waveform (visual only) ───────────────────────────────────────────────────
// Decodes the file once to compute ~600 loudness bins, then drops the decoded
// buffer. Playback still streams from the <audio> element in audio.js.

const PEAK_BINS = 600;

async function computePeaks(view, file) {
  const token = ++view.loadToken;
  try {
    const decoded = await audioCtx.decodeAudioData(await file.arrayBuffer());
    if (token !== view.loadToken) return; // a newer file was loaded meanwhile
    const ch = decoded.getChannelData(0);
    const step = Math.max(1, Math.floor(ch.length / PEAK_BINS));
    const peaks = new Float32Array(PEAK_BINS);
    let max = 0;
    for (let i = 0; i < PEAK_BINS; i++) {
      let sum = 0, n = 0;
      const start = i * step, end = Math.min(ch.length, start + step);
      for (let j = start; j < end; j += 16) { sum += ch[j] * ch[j]; n++; }
      peaks[i] = n ? Math.sqrt(sum / n) : 0;
      if (peaks[i] > max) max = peaks[i];
    }
    if (max > 0) for (let i = 0; i < PEAK_BINS; i++) peaks[i] /= max;
    view.peaks = peaks;
    view.duration = decoded.duration;
    drawWave(view);
  } catch (err) {
    logEvent(`Deck ${view.deckObj.id}: waveform unavailable (${err.message})`, 'warn');
  }
}

function drawWave(view) {
  const { elCanvas: c, deckObj } = view;
  const rect = c.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = window.devicePixelRatio || 1;
  c.width  = Math.round(rect.width * dpr);
  c.height = Math.round(rect.height * dpr);
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = rect.width, h = rect.height;
  ctx.clearRect(0, 0, w, h);

  const fill = deckObj.id === 'A' ? '#2457D6' : '#F5D84E';
  const ink  = '#242321';
  const analysis = deckObj.analysis;
  const dur = analysis?.duration || view.duration || deckObj.audioElement.duration;

  // Section boundaries from analysis as dashed ink rules
  if (analysis?.sections && dur) {
    ctx.save();
    ctx.strokeStyle = 'rgba(36,35,33,.45)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    analysis.sections.forEach((s) => {
      const x = Math.round((s.start / dur) * w) + .5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    });
    ctx.restore();
  }

  if (view.peaks) {
    const bars = Math.max(20, Math.floor(w / 4));
    const barW = w / bars;
    const mid = h / 2;
    ctx.fillStyle = fill;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1;
    for (let i = 0; i < bars; i++) {
      const p = view.peaks[Math.floor((i / bars) * view.peaks.length)];
      const bh = Math.max(2, p * (h - 14));
      const x = i * barW + 0.5;
      const bw = Math.max(1.5, barW - 1.2);
      ctx.fillRect(x, mid - bh / 2, bw, bh);
      if (bw >= 2.5) ctx.strokeRect(x, mid - bh / 2, bw, bh);
    }
    ctx.fillStyle = ink;
    ctx.fillRect(0, mid - .5, w, 1);
  }

  // Suggested transition points as red pennants along the top edge
  if (analysis?.transition_points && dur) {
    ctx.fillStyle = '#E7473F';
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.5;
    analysis.transition_points.forEach((tp) => {
      const x = (tp / dur) * w;
      ctx.beginPath();
      ctx.moveTo(x - 6, 0); ctx.lineTo(x + 6, 0); ctx.lineTo(x, 9); ctx.closePath();
      ctx.fill(); ctx.stroke();
    });
  }
}

const ro = new ResizeObserver(() => { Object.values(deckViews).forEach(drawWave); });
ro.observe($('deck-a-wave'));
ro.observe($('deck-b-wave'));

function renderLevels() {
  for (const view of Object.values(deckViews)) {
    let lvl = 0;
    if (view.deckObj.isPlaying) {
      view.analyser.getFloatTimeDomainData(view.buf);
      let sum = 0;
      for (let i = 0; i < view.buf.length; i++) sum += view.buf[i] * view.buf[i];
      lvl = Math.min(1, Math.sqrt(sum / view.buf.length) * 3.2);
    }
    view.level = lvl > view.level ? lvl : view.level * 0.9; // fast attack, slow release
    view.elLevel.style.width = `${(view.level * 100).toFixed(1)}%`;
  }
}

// ─── Analysis drawing (diagnostics) ─────────────────────────────────────────────

function drawAnalysis(canvas, analysis) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);

  const dur = analysis.duration;
  if (!dur || dur <= 0) return;

  if (analysis.sections) {
    const maxE = Math.max(...analysis.sections.map(s => s.energy || 0), 0.0001);
    analysis.sections.forEach(sec => {
      const x1 = (sec.start / dur) * w;
      const x2 = (sec.end   / dur) * w;
      const e  = (sec.energy || 0) / maxE;
      ctx.fillStyle = `rgba(36,87,214,${0.15 + e * 0.55})`;
      ctx.fillRect(x1, h - 10, x2 - x1, 10);
      ctx.strokeStyle = '#242321';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, h); ctx.stroke();
    });
  }

  if (analysis.downbeats) {
    ctx.strokeStyle = 'rgba(36,35,33,0.35)';
    ctx.lineWidth   = 1;
    analysis.downbeats.forEach(b => {
      const x = (b / dur) * w;
      ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, h - 12); ctx.stroke();
    });
  }

  if (analysis.transition_points) {
    ctx.fillStyle = '#E7473F';
    analysis.transition_points.forEach(tp => {
      const x = (tp / dur) * w;
      ctx.beginPath();
      ctx.arc(x, h / 2 - 4, 4, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

// ─── Event log ───────────────────────────────────────────────────────────────

function logEvent(msg, type = '') {
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
  const text = document.createElement('span');
  text.className = `log-msg ${type}`;
  text.textContent = msg; // textContent: file names are user-controlled
  entry.append(time, text);
  elEventLog.prepend(entry);
  while (elEventLog.children.length > 100) elEventLog.removeChild(elEventLog.lastChild);
}

elLogClearBtn.addEventListener('click', () => { elEventLog.innerHTML = ''; });

// ─── Read-only hook for automated checks / console debugging ─────────────────────────

window.__sway = {
  deckA, deckB, djEngine, audioCtx,
  get phoneConnected()  { return phoneConnected; },
  get phoneCalibrated() { return phoneCalibrated; },
  get lastMotionAt()    { return lastMotionAt; },
  get messageCount()    { return messageCount; },
  get phoneValue()      { return targetValue; },
};

// ─── Init ────────────────────────────────────────────────────────────────────────

setupDeck('deck-a', deckA);
setupDeck('deck-b', deckB);
applyModeUI(djEngine.mode);
renderPhoneState();

loadQRCode();
connect();
requestAnimationFrame(renderLoop);
