import { Logger } from './logger.js';

/**
 * InterruptionManager
 * 
 * Controls whether a caller can interrupt (barge-in) while the agent is speaking.
 * 
 * When interruptions are ENABLED (default):
 *   - ASR transcripts are processed immediately, even while TTS is playing.
 *   - If the user speaks mid-TTS, the agent stops speaking and processes the new input.
 * 
 * When interruptions are DISABLED:
 *   - ASR transcripts received while the agent is speaking are DROPPED.
 *   - The agent finishes its entire TTS response before listening.
 * 
 * The "speaking" state is managed by the TTS service signaling start/end of audio.
 * 
 * Usage:
 *   const mgr = new InterruptionManager(callLogger);
 *   
 *   // Toggle
 *   mgr.setInterruptionsEnabled(false);
 *   
 *   // Before processing a transcript
 *   if (!mgr.shouldProcessTranscript()) { return; }
 *   
 *   // TTS lifecycle
 *   mgr.onSpeakingStart();
 *   mgr.onSpeakingEnd();
 */
export class InterruptionManager {
    /**
     * @param {Logger} logger - A call-scoped logger instance
     * @param {boolean} [interruptionsEnabled=true] - Initial toggle state
     */
    constructor(logger, interruptionsEnabled = true) {
        this._log = logger?.withComponent('Interruption') ?? new Logger('Interruption');
        this._interruptionsEnabled = interruptionsEnabled;
        this._isSpeaking = false;
        this._droppedCount = 0;         // Count of transcripts dropped in current speaking window
        this._totalDropped = 0;         // Lifetime count
        this._totalInterruptions = 0;   // Lifetime count of successful interruptions
        this._speakingStartTime = null;
    }

    // ── Toggle API ────────────────────────────────────────────────────────

    /**
     * Enable or disable user interruptions (barge-in).
     * @param {boolean} enabled
     */
    setInterruptionsEnabled(enabled) {
        const prev = this._interruptionsEnabled;
        this._interruptionsEnabled = !!enabled;
        if (prev !== this._interruptionsEnabled) {
            this._log.info(`Interruptions toggled: ${prev ? 'ON' : 'OFF'} → ${this._interruptionsEnabled ? 'ON' : 'OFF'}`);
        }
    }

    /**
     * @returns {boolean} Whether interruptions are currently enabled
     */
    isInterruptionsEnabled() {
        return this._interruptionsEnabled;
    }

    // ── Speaking State Management ─────────────────────────────────────────

    /**
     * Called when TTS begins sending audio to the caller.
     */
    onSpeakingStart() {
        this._isSpeaking = true;
        this._droppedCount = 0;
        this._speakingStartTime = Date.now();
        this._log.debug('Agent speaking started');
    }

    /**
     * Called when TTS finishes sending audio (isFinal received or flush complete).
     */
    onSpeakingEnd() {
        const duration = this._speakingStartTime ? Date.now() - this._speakingStartTime : 0;
        this._isSpeaking = false;
        this._log.debug('Agent speaking ended', {
            duration_ms: duration,
            transcripts_dropped: this._droppedCount,
        });
        this._droppedCount = 0;
        this._speakingStartTime = null;
    }

    /**
     * @returns {boolean} Whether the agent is currently speaking
     */
    isSpeaking() {
        return this._isSpeaking;
    }

    // ── Transcript Gate ───────────────────────────────────────────────────

    /**
     * Determines if an incoming ASR transcript should be processed.
     * 
     * Rules:
     *   1. If we're NOT speaking → always process.
     *   2. If we ARE speaking AND interruptions are ENABLED → process (barge-in).
     *   3. If we ARE speaking AND interruptions are DISABLED → DROP.
     * 
     * @param {string} [transcript] - The transcript (for logging only)
     * @returns {boolean} true if the transcript should be processed
     */
    shouldProcessTranscript(transcript = '') {
        // Not speaking: always process
        if (!this._isSpeaking) {
            return true;
        }

        // Speaking + interruptions enabled: allow barge-in
        if (this._interruptionsEnabled) {
            this._totalInterruptions++;
            this._log.info('Barge-in detected — user interrupted agent', {
                transcript: transcript.substring(0, 80),
                total_interruptions: this._totalInterruptions,
            });
            return true;
        }

        // Speaking + interruptions disabled: drop
        this._droppedCount++;
        this._totalDropped++;
        this._log.debug('Transcript dropped (interruptions disabled)', {
            transcript: transcript.substring(0, 80),
            dropped_in_window: this._droppedCount,
            total_dropped: this._totalDropped,
        });
        return false;
    }

    // ── Stats ─────────────────────────────────────────────────────────────

    /**
     * Get statistics about interruption handling.
     */
    getStats() {
        return {
            interruptionsEnabled: this._interruptionsEnabled,
            isSpeaking: this._isSpeaking,
            totalInterruptions: this._totalInterruptions,
            totalDropped: this._totalDropped,
        };
    }
}
