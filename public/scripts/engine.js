/**
 * Sway - Intelligent DJ Engine
 *
 * State machine: IDLE → WAITING_FOR_BEAT → IN_TRANSITION → IDLE
 *
 * Fallback hierarchy:
 *  1. Phrase + beat aware transition (uses analysis sections + downbeats)
 *  2. Beat-aware transition (downbeats only)
 *  3. BPM-aware transition (rate adjustment, no beat sync)
 *  4. Equal-power crossfade (no analysis needed)
 *
 * AUTO mode: transitions are triggered automatically without phone intent.
 * MANUAL mode: transitions follow phone tilt and can be cancelled.
 */

import { deckA, deckB, setCrossfader } from './audio.js';

const TRANSITION_THRESHOLD = 0.15; // how far from edge to trigger intent (manual)
const FADER_LERP_RATE      = 0.08; // how fast virtual fader moves during transition
const COMPLETION_THRESHOLD = 0.04; // how close to edge before transition is "done"

class DJEngine {
  constructor() {
    this.virtualFader     = 0.5;   // actual audio crossfader position
    this.intentFader      = 0.5;   // user's desired crossfader from phone
    this.transitionState  = 'IDLE'; // 'IDLE' | 'WAITING_FOR_BEAT' | 'IN_TRANSITION'
    this.activeDeck       = null;  // 'A' | 'B' | null
    this.transitioningFrom = null; // 'A' | 'B'
    this.mode             = 'MANUAL'; // 'MANUAL' | 'AUTO'
    this.autoNextDeck     = null;  // set when AUTO mode is activated

    this.onStatusChange   = null;  // (message: string, steps: object|null) => void
  }

  // ─── Mode switching ─────────────────────────────────────────────────────────

  setMode(mode) {
    this.mode = mode;
    this.transitionState  = 'IDLE';
    this.activeDeck       = this.virtualFader < 0.5 ? 'A' : 'B';
    this.transitioningFrom = null;

    if (mode === 'AUTO') {
      this.autoNextDeck = null;
      this._notify('Auto DJ active — waiting for intent…', null);
    } else {
      this.autoNextDeck = null;
      this._notify('Manual mode active', null);
    }
  }

  // ─── Main update (called ~60fps from render loop) ───────────────────────────

  update(phoneValue, phoneY = 0.5) {
    this.intentFader = phoneValue;

    // Apply energy to both decks regardless of mode
    deckA.setEnergy(phoneY);
    deckB.setEnergy(phoneY);

    const analysisA = deckA.analysis;
    const analysisB = deckB.analysis;
    const bothPlaying = deckA.isPlaying || deckB.isPlaying;

    // ── MANUAL / No analysis / Nothing playing → direct crossfade ──────────
    if (this.mode === 'MANUAL') {
      this.virtualFader   = this.intentFader;
      this.transitionState = 'IDLE';
      setCrossfader(this.virtualFader);
      if (this.activeDeck === 'A') this._notify('Manual · Deck A', null);
      else if (this.activeDeck === 'B') this._notify('Manual · Deck B', null);
      else this._notify('Manual', null);
      return;
    }

    // ── AUTO mode below ─────────────────────────────────────────────────────
    const hasAnalysis = analysisA && analysisB;

    // Update activeDeck if IDLE and fader is at an edge
    if (this.transitionState === 'IDLE') {
      if (this.virtualFader <= 0.05) this.activeDeck = 'A';
      else if (this.virtualFader >= 0.95) this.activeDeck = 'B';
    }

    // Detect intent to transition
    if (this.transitionState === 'IDLE') {
      const triggerToB = this.activeDeck === 'A' &&
        (this.intentFader > 1.0 - TRANSITION_THRESHOLD || this.autoNextDeck === 'B');
      const triggerToA = this.activeDeck === 'B' &&
        (this.intentFader < TRANSITION_THRESHOLD || this.autoNextDeck === 'A');

      if (triggerToB) {
        this.autoNextDeck     = null;
        this.transitionState  = 'WAITING_FOR_BEAT';
        this.transitioningFrom = 'A';
        this.activeDeck       = null;
        this._prepareTransition(deckA, deckB, analysisA, analysisB);
      } else if (triggerToA) {
        this.autoNextDeck     = null;
        this.transitionState  = 'WAITING_FOR_BEAT';
        this.transitioningFrom = 'B';
        this.activeDeck       = null;
        this._prepareTransition(deckB, deckA, analysisB, analysisA);
      } else {
        // Lock fader at edge when idle
        if (this.activeDeck === 'A') {
          this.virtualFader = this.virtualFader * 0.9; // drift to 0
          if (this.virtualFader < 0.01) this.virtualFader = 0;
          this._notify('Playing Deck A · Waiting for intent', null);
        } else if (this.activeDeck === 'B') {
          this.virtualFader = this.virtualFader + (1 - this.virtualFader) * 0.1;
          if (this.virtualFader > 0.99) this.virtualFader = 1;
          this._notify('Playing Deck B · Waiting for intent', null);
        } else {
          this.virtualFader = this.intentFader;
        }
      }
    }

    if (this.transitionState === 'WAITING_FOR_BEAT') {
      const outDeck    = this.transitioningFrom === 'A' ? deckA : deckB;
      const inDeck     = this.transitioningFrom === 'A' ? deckB : deckA;
      const outAnalysis = this.transitioningFrom === 'A' ? analysisA : analysisB;
      const inAnalysis  = this.transitioningFrom === 'A' ? analysisB : analysisA;

      // MANUAL only: allow cancelling by tilting back
      if (this.mode !== 'AUTO') {
        const cancelA = outDeck === deckA && this.intentFader < TRANSITION_THRESHOLD / 2;
        const cancelB = outDeck === deckB && this.intentFader > 1.0 - TRANSITION_THRESHOLD / 2;
        if (cancelA || cancelB) {
          this.transitionState  = 'IDLE';
          this.activeDeck       = this.transitioningFrom;
          this.transitioningFrom = null;
          this._notify('Transition cancelled', null);
          setCrossfader(this.virtualFader);
          return;
        }
      }

      if (!outDeck.isPlaying) {
        // Outgoing deck stopped — just snap the transition immediately
        this._startTransition(inDeck, outAnalysis, inAnalysis, 'immediate');
      } else {
        // Look for a musical moment to jump
        const currentTime  = outDeck.audioElement.currentTime;
        const nextSection  = outAnalysis?.sections?.find(s => s.start > currentTime + 0.5);
        const nextDownbeat = outAnalysis?.downbeats?.find(b => b > currentTime + 0.1);

        if (nextSection && (nextSection.start - currentTime) < 5.0) {
          // Phrase boundary within 5s — wait for it
          const remaining = nextSection.start - currentTime;
          if (remaining < 0.2) {
            this._startTransition(inDeck, outAnalysis, inAnalysis, 'phrase');
          } else {
            this._notify(`Waiting for phrase (${remaining.toFixed(1)}s)…`, { beat: 'active', phrase: 'active', bpm: '' });
          }
        } else if (nextDownbeat) {
          // Wait for next downbeat
          const remaining = nextDownbeat - currentTime;
          if (remaining < 0.2) {
            this._startTransition(inDeck, outAnalysis, inAnalysis, 'beat');
          } else {
            this._notify(`Waiting for beat (${remaining.toFixed(1)}s)…`, { beat: 'active', phrase: '', bpm: '' });
          }
        } else {
          // No analysis or no upcoming beats — transition immediately
          this._startTransition(inDeck, outAnalysis, inAnalysis, 'crossfade');
        }
      }
    }

    if (this.transitionState === 'IN_TRANSITION') {
      const outDeck = this.transitioningFrom === 'A' ? deckA : deckB;
      const inDeck  = this.transitioningFrom === 'A' ? deckB : deckA;

      // Pull fader toward the destination deck
      const targetFader = this.transitioningFrom === 'A' ? 1.0 : 0.0;
      this.virtualFader += (targetFader - this.virtualFader) * FADER_LERP_RATE;

      // EQ separation: cut bass on outgoing deck
      outDeck.setBass(-12);
      inDeck.setBass(0);

      // Check completion
      const done = this.transitioningFrom === 'A'
        ? this.virtualFader >= 1.0 - COMPLETION_THRESHOLD
        : this.virtualFader <= COMPLETION_THRESHOLD;

      if (done) {
        this.virtualFader     = this.transitioningFrom === 'A' ? 1.0 : 0.0;
        this.transitionState  = 'IDLE';
        this.activeDeck       = this.transitioningFrom === 'A' ? 'B' : 'A';
        this.transitioningFrom = null;
        outDeck.setBass(0);
        inDeck.setBass(0);
        this._notify(`Now playing Deck ${this.activeDeck}`, { beat: 'done', phrase: 'done', bpm: 'done' });
      } else {
        this._notify(`Transitioning… ${Math.round(this.virtualFader * 100)}%`, null);
      }
    }

    setCrossfader(this.virtualFader);
  }

  // ─── Internal helpers ────────────────────────────────────────────────────────

  _startTransition(inDeck, outAnalysis, inAnalysis, syncType) {
    this.transitionState = 'IN_TRANSITION';

    // BPM matching removed as per user request

    // Ensure incoming deck is playing
    if (!inDeck.isPlaying) {
      inDeck.play();
    }

    const labels = {
      phrase:    'phrase boundary',
      beat:      'downbeat',
      crossfade: 'equal-power crossfade',
      immediate: 'immediate cut',
    };
    this._notify(`Transitioning at ${labels[syncType] || syncType}`, { beat: 'done', phrase: syncType === 'phrase' ? 'done' : '', bpm: 'done' });
  }

  _prepareTransition(outDeck, inDeck, outAnalysis, inAnalysis) {
    this._notify('Preparing transition…', { beat: 'active', phrase: '', bpm: 'active' });
    // Position incoming deck at first downbeat if not yet started
    if (inDeck.audioElement.currentTime < 1.0 && !inDeck.isPlaying) {
      const firstBeat = inAnalysis?.downbeats?.[0] ?? 0;
      inDeck.audioElement.currentTime = firstBeat;
    }
  }

  _notify(msg, steps) {
    if (this.onStatusChange) this.onStatusChange(msg, steps);
  }
}

export const djEngine = new DJEngine();
