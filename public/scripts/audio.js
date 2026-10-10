/**
 * Sway - Audio Engine
 *
 * Deck A and Deck B via Web Audio API.
 * Equal-power crossfade, energy filter.
 *
 * KEY DESIGN DECISIONS:
 *  - playbackRate only changes for Auto DJ BPM matching (setBasePlaybackRate).
 *  - preservesPitch is always false (vinyl mode) — avoids the pitch-stretch decoder
 *    which is the root cause of pausing on rate change.
 *  - audioCtx.resume() is awaited before every play() call.
 *  - AudioContext is unlocked on ANY user interaction.
 */

export const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// ─── Unlock AudioContext on first user interaction ─────────────────────────────
function unlockAudio() {
  if (audioCtx.state !== 'running') {
    audioCtx.resume().catch(() => {});
  }
}
document.addEventListener('click',      unlockAudio, { passive: true });
document.addEventListener('touchstart', unlockAudio, { passive: true });
document.addEventListener('keydown',    unlockAudio, { passive: true });
document.addEventListener('pointerdown',unlockAudio, { passive: true });

// ─── AudioDeck ────────────────────────────────────────────────────────────────

class AudioDeck {
  constructor(id) {
    this.id = id;

    this.audioElement = new Audio();
    this.audioElement.crossOrigin = 'anonymous';
    // Vinyl mode: pitch shifting off prevents browser pitch-stretch decoder from stalling.
    this.audioElement.preservesPitch = false;
    this.audioElement.mozPreservesPitch = false; // Firefox
    this.audioElement.webkitPreservesPitch = false; // Safari legacy

    // --- Audio graph: source → energyFilter → bassEq → gainNode → destination
    this.source      = audioCtx.createMediaElementSource(this.audioElement);
    this.gainNode    = audioCtx.createGain();
    this.energyFilter = audioCtx.createBiquadFilter();
    this.energyFilter.type = 'lowpass';
    this.energyFilter.frequency.value = 22050; // open by default
    this.bassEq = audioCtx.createBiquadFilter();
    this.bassEq.type = 'lowshelf';
    this.bassEq.frequency.value = 200;
    this.bassEq.gain.value = 0;

    this.source.connect(this.energyFilter);
    this.energyFilter.connect(this.bassEq);
    this.bassEq.connect(this.gainNode);
    this.gainNode.connect(audioCtx.destination);

    // --- Volumes
    this.baseVolume  = 1.0;
    this.xfadeVolume = 1.0;

    // --- Playback state
    this.isPlaying       = false;
    this.basePlaybackRate = 1.0;

    // --- Analysis
    this.analysis           = null;
    this.trackName          = null;
    this.analysisStatus     = 'none'; // 'none' | 'loading' | 'done' | 'failed'

    // --- Callbacks (set from dashboard.js)
    this.onTimeUpdate       = null;
    this.onLoaded           = null;
    this.onPlayStateChange  = null;
    this.onAnalysisComplete = null;
    this.onAnalysisStatus   = null;

    // --- Wire events
    this.audioElement.addEventListener('timeupdate', () => {
      if (this.onTimeUpdate) this.onTimeUpdate(this.audioElement.currentTime, this.audioElement.duration);
    });
    this.audioElement.addEventListener('loadedmetadata', () => {
      if (this.onLoaded) this.onLoaded(this.audioElement.duration);
    });
    this.audioElement.addEventListener('play', () => {
      this.isPlaying = true;
      if (this.onPlayStateChange) this.onPlayStateChange(true);
    });
    this.audioElement.addEventListener('pause', () => {
      this.isPlaying = false;
      if (this.onPlayStateChange) this.onPlayStateChange(false);
    });
    this.audioElement.addEventListener('ended', () => {
      this.isPlaying = false;
      if (this.onPlayStateChange) this.onPlayStateChange(false);
    });
    // Detect unexpected stalls and recover
    this.audioElement.addEventListener('stalled', () => {
      if (this.isPlaying) {
        this.audioElement.load();
      }
    });
  }

  // ─── Load ──────────────────────────────────────────────────────────────────

  async loadTrack(file) {
    // Stop current playback
    this.audioElement.pause();
    this.isPlaying = false;
    this.analysis = null;
    this.trackName = file.name;
    this.analysisStatus = 'loading';
    if (this.onAnalysisStatus) this.onAnalysisStatus('loading');

    // Load audio for playback
    const objectUrl = URL.createObjectURL(file);
    this.audioElement.src = objectUrl;
    this.audioElement.load();
    // Reset playback rate
    this.basePlaybackRate = 1.0;
    this.audioElement.playbackRate = 1.0;
    this.audioElement.preservesPitch = false;

    // Analyze in background — never block playback on this
    try {
      const res  = await fetch('/api/analyze', {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': file.type || 'audio/mpeg' },
      });
      const data = await res.json();
      if (data.error) {
        console.warn('[Sway] Analysis error:', data.error);
        this.analysisStatus = 'failed';
        if (this.onAnalysisStatus) this.onAnalysisStatus('failed');
      } else {
        this.analysis = data;
        this.analysisStatus = 'done';
        if (this.onAnalysisStatus) this.onAnalysisStatus('done');
        if (this.onAnalysisComplete) this.onAnalysisComplete(this.analysis);
      }
    } catch (err) {
      console.warn('[Sway] Analysis fetch failed:', err.message);
      this.analysisStatus = 'failed';
      if (this.onAnalysisStatus) this.onAnalysisStatus('failed');
    }
  }

  // ─── Playback control ──────────────────────────────────────────────────────

  async play() {
    // Always ensure AudioContext is running first
    if (audioCtx.state !== 'running') {
      try { await audioCtx.resume(); } catch (e) { /* ignored */ }
    }
    try {
      await this.audioElement.play();
    } catch (e) {
      // NotAllowedError: browser blocked autoplay — user must interact first
      console.warn('[Sway] play() prevented:', e.message);
    }
  }

  pause() {
    this.audioElement.pause();
  }

  togglePlay() {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  // ─── Volume ────────────────────────────────────────────────────────────────

  setBaseVolume(vol) {
    this.baseVolume = Math.max(0, Math.min(1, vol));
    this._updateGain();
  }

  setXfadeVolume(vol) {
    this.xfadeVolume = Math.max(0, Math.min(1, vol));
    this._updateGain();
  }

  _updateGain() {
    this.gainNode.gain.setTargetAtTime(
      this.baseVolume * this.xfadeVolume,
      audioCtx.currentTime,
      0.015 // smooth 15ms ramp to avoid clicks
    );
  }

  // ─── Energy filter (forward/back tilt) ────────────────────────────────────
  // Cutoffs sweep logarithmically (equal octaves per unit of tilt), so the
  // audible change is spread across the whole tilt instead of bunching up at
  // the extremes. Full-tilt endpoints are unchanged: 3 kHz lift, 400 Hz muffle.

  setEnergy(valueY) {
    if (!this.audioElement.src) return;

    const NEUTRAL = 0.05;
    const LIFT_FROM_HZ   = 30;     // highpass just past neutral (inaudible)
    const LIFT_TO_HZ     = 3000;   // highpass at full forward tilt
    const MUFFLE_FROM_HZ = 16000;  // lowpass just past neutral (barely audible)
    const MUFFLE_TO_HZ   = 400;    // lowpass at full back tilt
    const delta   = valueY - 0.5;

    if (Math.abs(delta) < NEUTRAL) {
      this.energyFilter.type = 'lowpass';
      this.energyFilter.frequency.setTargetAtTime(22050, audioCtx.currentTime, 0.05);
      return;
    }

    if (delta > 0) {
      // Forward tilt → highpass (build energy/tension)
      this.energyFilter.type = 'highpass';
      let t = (delta - NEUTRAL) / (0.5 - NEUTRAL);
      t = Math.pow(t, 0.5); // spread the gradient, less concentrated at the end
      const freq = LIFT_FROM_HZ * Math.pow(LIFT_TO_HZ / LIFT_FROM_HZ, t);
      this.energyFilter.frequency.setTargetAtTime(freq, audioCtx.currentTime, 0.05);
    } else {
      // Backward tilt → lowpass (muffle)
      this.energyFilter.type = 'lowpass';
      let t = (-delta - NEUTRAL) / (0.5 - NEUTRAL);
      t = Math.pow(t, 0.5); // spread the gradient, less concentrated at the end
      const freq = MUFFLE_FROM_HZ * Math.pow(MUFFLE_TO_HZ / MUFFLE_FROM_HZ, t);
      this.energyFilter.frequency.setTargetAtTime(freq, audioCtx.currentTime, 0.05);
    }
  }

  setBasePlaybackRate(rate) {
    this.basePlaybackRate = rate;
    this.audioElement.playbackRate = rate;
    this.audioElement.preservesPitch = false;
  }

  // ─── Bass EQ (used during transitions) ───────────────────────────────────

  setBass(gainDb) {
    this.bassEq.gain.setTargetAtTime(gainDb, audioCtx.currentTime, 0.05);
  }
}

// ─── Singleton decks ──────────────────────────────────────────────────────────

export const deckA = new AudioDeck('A');
export const deckB = new AudioDeck('B');

// ─── Crossfader ───────────────────────────────────────────────────────────────

/**
 * Equal-power crossfade.
 * value 0.0 → Deck A full, Deck B silent
 * value 0.5 → both at 0.707
 * value 1.0 → Deck A silent, Deck B full
 */
export function setCrossfader(value) {
  const v = Math.max(0, Math.min(1, value));
  const gainA = Math.cos(v * 0.5 * Math.PI);
  const gainB = Math.cos((1.0 - v) * 0.5 * Math.PI);
  deckA.setXfadeVolume(gainA);
  deckB.setXfadeVolume(gainB);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function formatTime(seconds) {
  if (!seconds || isNaN(seconds) || !isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
