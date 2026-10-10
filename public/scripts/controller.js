/**
 * Sway – Controller (Phone) Script
 *
 * Gesture → WebSocket bridge.
 *
 * Gestures:
 *  - Left/right tilt (gamma) → crossfade intent
 *  - Forward/back tilt (beta) → energy filter
 *
 * Key design decisions (unchanged from the original controller):
 *  - Event type locking: locks onto the first event type that fires to prevent
 *    racing between 'deviceorientation' and 'deviceorientationabsolute'.
 *  - Dead zones prevent neutral-position jitter.
 *  - Exponential Moving Average smoothing on all axes.
 *  - Motion message format and send rate are unchanged.
 *
 * UI: every visual on the motion pad is drawn from the same `normalised` /
 * `normalisedY` values that are sent to the laptop.
 */

// ─── Config ───────────────────────────────────────────────────────────────────────────

const CONFIG = {
  MAX_TILT_DEG:    45,
  MAX_ENERGY_DEG:  40,

  DEAD_ZONE_MIX:    4,   // degrees before mixing starts
  DEAD_ZONE_ENERGY: 6,   // degrees before energy shifts

  SENSITIVITY:      1.0,
  SMOOTHING_ALPHA:  0.15,  // EMA factor (0 = no smoothing, 1 = instant)
  SEND_HZ:          30,
  RECONNECT_DELAY_MS: 2500,
};

const SEND_INTERVAL_MS = 1000 / CONFIG.SEND_HZ;

// ─── State ────────────────────────────────────────────────────────────────────────────

let calibratedGamma = null;
let calibratedBeta  = null;
let isCalibrated    = false;
let smoothedGamma   = 0;
let smoothedBeta    = 0;
let rawGamma        = 0;
let rawBeta         = 0;
let normalised      = 0.5;
let normalisedY     = 0.5;
let ws              = null;
let reconnectTimer  = null;
let lastSendTime    = 0;
let sensorFired     = false;
let sensorStarted   = false;
let eventCount      = 0;
let activeEventType = null;
let debugVisible    = false;

// UI-only state
let wsState         = 'connecting';   // connecting | connected | disconnected
let dashboards      = null;           // from server 'status' broadcasts (null = unknown)
let permissionState = 'unknown';      // unknown | needed | requesting | granted | denied | error
let previewMix      = 0.5;            // raw, pre-calibration preview on the pad
let calibratingUntil = 0;
let renderQueued    = false;
let btnOverride     = null;           // temporary calibrate-button message

// ─── DOM refs ────────────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const elBody           = document.body;
const elStatus         = $('ctrl-status');
const elStatusLabel    = $('ctrl-status-label');
const elCalibrateBtn   = $('calibrate-btn');
const elCalibrateLabel = $('calibrate-label');
const elCalibrateSub   = $('calibrate-sub');
const elCalloutTitle   = $('pad-callout-title');
const elCalibrateHint  = $('calibrate-hint');
const elPad            = $('pad');
const elPuck           = $('puck');
const elPuckBody       = $('puck-body');
const elLines          = $('pad-lines');
const elBurst          = $('pad-burst');
const elMixA           = $('mixbar-a');
const elMixB           = $('mixbar-b');
const elMeterNeedle    = $('ctrl-meter-needle');
const elValueDisplay   = $('ctrl-value-display');
const elEnergyDisplay  = $('energy-display');
const elPermission     = $('sensor-permission');
const elDebugToggle    = $('debug-toggle');
const elDebug          = $('sway-debug');

function setText(el, t) { if (el && el.textContent !== t) el.textContent = t; }

// ─── Debug sheet (sensor readout) ───────────────────────────────────────────────────────────────

let lastDebugMsg = '';
function updateDebug(msg) {
  if (msg) lastDebugMsg = msg;
  if (!elDebug || !debugVisible) return;
  elDebug.innerHTML = `
    <dl class="sheet-grid">
      <div><dt>Mix · γ</dt><dd>${rawGamma.toFixed(1)}° → ${normalised.toFixed(3)}</dd></div>
      <div><dt>Energy · β</dt><dd>${rawBeta.toFixed(1)}° → ${normalisedY.toFixed(3)}</dd></div>
      <div><dt>Events</dt><dd>${eventCount} · ${activeEventType ?? '—'}</dd></div>
    </dl>
    ${lastDebugMsg ? `<p class="sheet-msg">${lastDebugMsg}</p>` : ''}
  `;
}

// ─── WebSocket ──────────────────────────────────────────────────────────────────────────

// Room code: read from URL path /controller/CODE or query ?room=CODE
const _roomMatch = location.pathname.match(/\/controller\/([^/]+)/i)
                || location.search.match(/[?&]room=([^&]+)/i);
const _roomCode  = _roomMatch ? _roomMatch[1].toUpperCase() : '';

const WS_URL = (() => {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const roomParam = _roomCode ? `&room=${_roomCode}` : '';
  return `${proto}://${location.host}/?role=controller${roomParam}`;
})();

function connectWS() {
  clearTimeout(reconnectTimer);
  setStatus('connecting');
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  ws.addEventListener('open',    () => setStatus('connected'));
  ws.addEventListener('close',   () => { setStatus('disconnected'); scheduleReconnect(); });
  ws.addEventListener('error',   () => setStatus('disconnected'));
  ws.addEventListener('message', (event) => {
    // Read-only: the server's existing status broadcast tells us if a booth is open.
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'status' && typeof msg.dashboards === 'number') {
      dashboards = msg.dashboards;
      refreshUI();
    }
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectWS, CONFIG.RECONNECT_DELAY_MS);
}

function sendMotion() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  if (now - lastSendTime < SEND_INTERVAL_MS) return;
  lastSendTime = now;
  ws.send(JSON.stringify({
    type:      'motion',
    tiltX:     parseFloat(rawGamma.toFixed(2)),
    tiltY:     parseFloat(rawBeta.toFixed(2)),
    value:     parseFloat(normalised.toFixed(4)),
    valueY:    parseFloat(normalisedY.toFixed(4)),
    timestamp: now,
  }));
}

// ─── Status / phase ─────────────────────────────────────────────────────────────────────

function setStatus(state) {
  const was = wsState;
  wsState = state;
  if (state !== 'connected') dashboards = null;
  if (was !== state) refreshUI();
}

/** Single source of truth for what the phone is doing right now. */
function currentPhase() {
  if (wsState === 'disconnected') return 'lost';
  if (wsState === 'connecting')   return 'connecting';
  if (permissionState === 'denied' || permissionState === 'error') return 'blocked';
  if (permissionState === 'needed' || permissionState === 'requesting') return 'permission';
  if (Date.now() < calibratingUntil) return 'calibrating';
  if (!sensorFired) return 'no-sensor';
  if (!isCalibrated) return 'calibrate';
  return 'ready';
}

const PHASE_COPY = {
  connecting:  { pill: ['busy',  'Connecting…'],     title: 'Hang tight',        text: 'Connecting to the booth…' },
  lost:        { pill: ['error', 'Connection lost'],  title: 'Signal lost!',      text: 'Reconnecting automatically. Check the laptop is still running Sway.' },
  permission:  { pill: ['warn',  'Motion access'],    title: 'Let’s get moving', text: 'Tap Allow motion below, then accept the prompt.' },
  blocked:     { pill: ['error', 'Motion blocked'],   title: 'Motion is off',     text: 'Turn on Motion & Orientation Access in Settings → Safari, then reload.' },
  'no-sensor': { pill: ['warn',  'No motion yet'],    title: 'Give it a wiggle',  text: 'No motion data yet. Tilt the phone a little. Desktop browsers have no tilt sensor.' },
  calibrate:   { pill: ['warn',  'Calibrate'],        title: 'Find your centre',  text: 'Hold the phone the way you’ll play, then tap Calibrate.' },
  calibrating: { pill: ['busy',  'Calibrating'],      title: 'Locked!',           text: '' },
  ready:       { pill: ['live',  'Ready to mix'],     title: '',                  text: '' },
};

function refreshUI() {
  const phase = currentPhase();
  const copy = PHASE_COPY[phase];
  elBody.dataset.phase = phase;

  let [pillState, pillText] = copy.pill;
  if (phase === 'ready' && dashboards === 0) { pillState = 'warn'; pillText = 'Booth not open'; }
  elStatus.dataset.state = pillState;
  setText(elStatusLabel, pillText);

  setText(elCalloutTitle, copy.title);
  setText(elCalibrateHint, copy.text);

  // Calibrate button
  let label, sub, state;
  if (btnOverride) {
    ({ label, sub, state } = btnOverride);
  } else if (phase === 'permission') {
    label = permissionState === 'requesting' ? 'Asking…' : 'Allow motion';
    sub = 'Needed to read tilt'; state = 'primary';
  } else if (phase === 'blocked') {
    label = 'Try again'; sub = 'After enabling motion access'; state = 'error';
  } else if (isCalibrated) {
    label = 'Recalibrate'; sub = 'Hold your neutral pose, tap to reset'; state = 'done';
  } else {
    label = 'Calibrate'; sub = 'Hold the phone naturally, then tap'; state = 'primary';
  }
  setText(elCalibrateLabel, label);
  setText(elCalibrateSub, sub);
  elCalibrateBtn.dataset.state = state;

  scheduleRender();
}

// ─── Sensor ───────────────────────────────────────────────────────────────────────────

function onDeviceOrientation(event) {
  // Lock onto first event type to prevent jitter from dual events
  if (!activeEventType) {
    activeEventType = event.type;
  } else if (activeEventType !== event.type) {
    return;
  }

  eventCount++;

  const gamma = event.gamma ?? 0;
  const beta  = event.beta  ?? 0;
  rawGamma = gamma;
  rawBeta  = beta;
  const firstEvent = !sensorFired;
  sensorFired = true;

  // EMA smoothing
  smoothedGamma = CONFIG.SMOOTHING_ALPHA * rawGamma + (1 - CONFIG.SMOOTHING_ALPHA) * smoothedGamma;
  smoothedBeta  = CONFIG.SMOOTHING_ALPHA * rawBeta  + (1 - CONFIG.SMOOTHING_ALPHA) * smoothedBeta;

  if (firstEvent) refreshUI();

  if (!isCalibrated) {
    const rawNorm = (smoothedGamma + CONFIG.MAX_TILT_DEG) / (CONFIG.MAX_TILT_DEG * 2);
    previewMix = Math.max(0, Math.min(1, rawNorm));
    scheduleRender();
    updateDebug('Hold still and tap CALIBRATE');
    return;
  }

  // Relative deltas from calibration point
  const deltaGamma = smoothedGamma - calibratedGamma;
  const deltaBeta  = smoothedBeta  - calibratedBeta;

  // Dead zone + normalize helper
  function processAxis(delta, maxDeg, deadZone) {
    if (Math.abs(delta) < deadZone) return 0.5; // snap to center
    const sign  = delta > 0 ? 1 : -1;
    const trimmed = sign * (Math.abs(delta) - deadZone);
    const scale = maxDeg / (maxDeg - deadZone);
    const scaled = Math.max(-maxDeg, Math.min(maxDeg, trimmed * CONFIG.SENSITIVITY * scale));
    return Math.max(0, Math.min(1, (scaled + maxDeg) / (maxDeg * 2)));
  }

  normalised = processAxis(deltaGamma, CONFIG.MAX_TILT_DEG, CONFIG.DEAD_ZONE_MIX);
  normalisedY = processAxis(deltaBeta, CONFIG.MAX_ENERGY_DEG, CONFIG.DEAD_ZONE_ENERGY);

  scheduleRender();
  updateDebug();
  sendMotion();
}

function startSensor() {
  if (sensorStarted) return;
  sensorStarted = true;
  window.addEventListener('deviceorientation',         onDeviceOrientation, true);
  window.addEventListener('deviceorientationabsolute', onDeviceOrientation, true);
}

// ─── Render (pad + readouts) ────────────────────────────────────────────────────────────────
// Batched to one write per animation frame. Values drawn here are exactly the
// values sendMotion() transmits (or the raw preview before calibration).

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(render);
}

function render() {
  renderQueued = false;
  const live = isCalibrated;
  const mix = live ? normalised : previewMix;
  const eng = live ? normalisedY : 0.5;

  // Puck: x = mix (A→B), y = energy (Lift at top, Muffle at bottom)
  const dx = mix - 0.5;          // -0.5..0.5
  const dy = eng - 0.5;          // -0.5..0.5, + = lift
  elPad.style.setProperty('--x', `${(mix * 100).toFixed(2)}%`);
  elPad.style.setProperty('--y', `${((1 - eng) * 100).toFixed(2)}%`);
  elPad.style.setProperty('--tilt', `${(dx * 56).toFixed(1)}deg`);
  elPad.style.setProperty('--squash', (1 + Math.abs(dy) * 0.5).toFixed(3));
  elPad.style.setProperty('--stretch', (1 - Math.abs(dy) * 0.25).toFixed(3));
  const mag = Math.min(1, Math.hypot(dx, dy) * 2);
  elPad.style.setProperty('--mag', mag.toFixed(3));
  elPad.style.setProperty('--ang', `${Math.atan2(-dy, dx)}rad`);
  elPad.dataset.side = !live ? 'preview' : dx < -0.02 ? 'a' : dx > 0.02 ? 'b' : 'centre';
  elPad.dataset.energy = !live ? '' : dy > 0.02 ? 'lift' : dy < -0.02 ? 'muffle' : '';
  elPad.classList.toggle('is-moving', live && mag > 0.35);

  // Mix bar: equal-power gains, matching the laptop's crossfader math
  const gA = Math.cos(mix * 0.5 * Math.PI);
  const gB = Math.cos((1 - mix) * 0.5 * Math.PI);
  elMixA.style.transform = `scaleX(${gA.toFixed(3)})`;
  elMixB.style.transform = `scaleX(${gB.toFixed(3)})`;
  elMeterNeedle.style.left = `${(mix * 100).toFixed(2)}%`;

  if (!live) {
    setText(elValueDisplay, '—');
    setText(elEnergyDisplay, '—');
  } else {
    const pa = Math.round(gA * 100), pb = Math.round(gB * 100);
    setText(elValueDisplay, mix < 0.03 ? 'All A' : mix > 0.97 ? 'All B' : `A ${pa} · B ${pb}`);
    // Mirrors audio.js setEnergy(): ±0.05 neutral band
    let e;
    if (Math.abs(dy) < 0.05) e = 'Open';
    else if (dy > 0) e = `Lift ${Math.round((dy - 0.05) / 0.45 * 100)}%`;
    else e = `Muffle ${Math.round((-dy - 0.05) / 0.45 * 100)}%`;
    setText(elEnergyDisplay, e);
  }
}

// ─── Calibrate ─────────────────────────────────────────────────────────────────────────

function calibrate() {
  calibratedGamma = smoothedGamma;
  calibratedBeta  = smoothedBeta;
  isCalibrated    = true;
  normalised    = 0.5;
  normalisedY   = 0.5;

  if (navigator.vibrate) navigator.vibrate([30, 50, 30]);

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'calibrated', timestamp: Date.now() }));
  }

  // Brief confirmation frame; purely visual, motion keeps flowing.
  calibratingUntil = Date.now() + 900;
  elBurst.classList.remove('is-firing');
  void elBurst.offsetWidth;
  elBurst.classList.add('is-firing');
  refreshUI();
  setTimeout(refreshUI, 950);
  updateDebug('Calibrated');
}

function flashButton(label, sub, state, ms) {
  btnOverride = { label, sub, state };
  refreshUI();
  clearTimeout(flashButton._t);
  flashButton._t = setTimeout(() => { btnOverride = null; refreshUI(); }, ms);
}

function onCalibrateClick() {
  // iOS: must request permission synchronously in click handler using .then()
  if (typeof DeviceOrientationEvent?.requestPermission === 'function' && !sensorStarted) {
    permissionState = 'requesting';
    refreshUI();
    DeviceOrientationEvent.requestPermission()
      .then((result) => {
        if (result === 'granted') {
          permissionState = 'granted';
          startSensor();
          updateDebug('iOS permission granted');
        } else {
          permissionState = 'denied';
        }
        refreshUI();
      })
      .catch((err) => {
        permissionState = 'error';
        updateDebug(`Permission failed: ${err.message}`);
        refreshUI();
      });
    return;
  }

  if (!sensorFired) {
    flashButton('Waiting…', `No sensor data yet (${eventCount} events). Move the phone.`, 'busy', 1500);
    return;
  }

  calibrate();
}

// ─── Init ────────────────────────────────────────────────────────────────────────────

function init() {
  connectWS();
  elPermission.hidden = true; // calibrate btn handles everything

  if (typeof DeviceOrientationEvent?.requestPermission !== 'function') {
    // Android / desktop — start listening immediately
    startSensor();
    updateDebug('Sensor started — waiting for first event…');
  } else {
    // iOS 13+ — user must tap first
    permissionState = 'needed';
    updateDebug('iOS — tap Allow motion to enable sensors');
  }

  elCalibrateBtn.addEventListener('click', onCalibrateClick);

  // Sensor readout sheet
  elDebugToggle.addEventListener('click', () => {
    debugVisible = !debugVisible;
    elDebug.hidden = !debugVisible;
    elDebugToggle.setAttribute('aria-expanded', String(debugVisible));
    updateDebug();
  });

  refreshUI();
}

init();
