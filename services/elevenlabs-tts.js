import { WebSocket } from 'ws';
import { Logger } from '../utils/logger.js';

/**
 * ElevenLabs TTS (Rachel / Flash v2.5 / Mulaw 8kHz)
 * 
 * Changes:
 * - Integrated structured Logger (replaces console.log)
 * - Speaking lifecycle hooks: onSpeakingStart / onSpeakingEnd
 *   Used by InterruptionManager to track when the agent is talking
 * - Proper connection lifecycle with explicit state tracking
 * - Better heartbeat that sends proper flush signals
 * - Reconnect support for dropped connections
 * - Proper close sequence (flush → EOS → close)
 */
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'UrB5rVw5j9MDZWDZJtOJ';
const MODEL_ID = 'eleven_flash_v2_5';
const OUTPUT_FORMAT = 'ulaw_8000';

export class ElevenLabsTTS {
    /**
     * @param {WebSocket} twilioWs - The Twilio media-stream WebSocket
     * @param {string} streamSid - Twilio stream SID
     * @param {object} [options]
     * @param {Logger} [options.logger] - Call-scoped logger
     * @param {function} [options.onSpeakingStart] - Called when TTS audio starts
     * @param {function} [options.onSpeakingEnd] - Called when TTS generation is complete
     */
    constructor(twilioWs, streamSid, options = {}) {
        this.twilioWs = twilioWs;
        this.streamSid = streamSid;
        this.ws = null;
        this.isReady = false;
        this._closed = false;
        this._heartbeatInterval = null;
        this._reconnectAttempts = 0;
        this._maxReconnectAttempts = 3;

        // Hooks
        this._onSpeakingStart = options.onSpeakingStart || (() => { });
        this._onSpeakingEnd = options.onSpeakingEnd || (() => { });
        this._isSpeaking = false;
        this._speakingEndTimer = null; // Delayed end for buffer drain
        this._expectedTwilioEndTime = 0;

        // Logger
        this._log = (options.logger || new Logger('TTS')).withComponent('TTS');

        this._connectPromise = this._connect();
    }

    _connect() {
        return new Promise((resolve) => {
            if (this._closed) return resolve();

            const apiKey = process.env.ELEVENLABS_API_KEY;

            // max inactivity_timeout = 180s, optimize_streaming_latency=3 drops lookahead for faster TTFB
            const url = `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input?model_id=${MODEL_ID}&output_format=${OUTPUT_FORMAT}&inactivity_timeout=180&optimize_streaming_latency=3`;

            const currentWs = new WebSocket(url, {
                headers: { 'xi-api-key': apiKey }
            });
            this.ws = currentWs;

            let resolved = false;
            const safeResolve = () => {
                if (!resolved) { resolved = true; resolve(); }
            };

            // Timeout: resolve after 10s even if not connected
            const timeout = setTimeout(() => {
                this._log.warn('Connection timed out after 10s');
                safeResolve();
            }, 10000);

            this.ws.on('open', () => {
                this.isReady = true;
                this._log.info('WebSocket connected');

                // Initialize with BOS (Beginning of Stream) message
                // Lower chunk_length_schedule for faster time-to-first-byte (min ~20, sweet spot 30)
                this.ws.send(JSON.stringify({
                    text: " ",
                    voice_settings: { stability: 0.7, similarity_boost: 0.8 },
                    generation_config: { chunk_length_schedule: [50] }
                }));

                this._reconnectAttempts = 0;
                this._startHeartbeat();
                clearTimeout(timeout);
                safeResolve();
            });

            currentWs.on('message', (data) => {
                if (this.ws !== currentWs) return; // Ignore messages from stale/closed sockets

                try {
                    // ElevenLabs can send audio as raw binary OR as JSON with base64 'audio' field
                    if (Buffer.isBuffer(data)) {
                        // Check if it's JSON hidden in a Buffer
                        const text = data.toString();
                        if (text.startsWith('{')) {
                            const response = JSON.parse(text);
                            if (response.audio) {
                                this._markSpeakingStart();
                                this._sendToTwilio(response.audio);
                            }
                            if (response.error) this._log.error('Server error', { error: response.error });
                            // isFinal might not occur on kept-alive streams, but if it does, it's a hard end
                            if (response.isFinal) {
                                this._log.debug('Generation complete (isFinal) received.');
                            }
                        } else {
                            // Raw binary audio frame
                            this._markSpeakingStart();
                            this._sendToTwilio(data.toString('base64'));
                        }
                    } else if (typeof data === 'string' && data.startsWith('{')) {
                        const response = JSON.parse(data);
                        if (response.audio) {
                            this._markSpeakingStart();
                            this._sendToTwilio(response.audio);
                        }
                        if (response.error) this._log.error('Server error', { error: response.error });
                        if (response.isFinal) {
                            this._log.debug('Generation complete (isFinal) received.');
                        }
                    }
                } catch (err) {
                    // Ignore parse errors
                }
            });

            currentWs.on('error', (err) => {
                if (this.ws === currentWs) {
                    this._log.error('WebSocket error', err);
                    this.isReady = false;
                    this._stopHeartbeat();
                }
                clearTimeout(timeout);
                safeResolve();
            });

            currentWs.on('close', (code, reason) => {
                const isCurrent = (this.ws === currentWs);
                const reasonStr = reason ? reason.toString() : '';
                this._log.info('WebSocket closed', { code, reason: reasonStr, isCurrent });

                if (isCurrent) {
                    this.isReady = false;
                    this.ws = null; // Ensure this.ws is nullified if it was the current active socket
                    this._stopHeartbeat();
                    this._cancelSpeakingEndTimer();
                    this._markSpeakingEnd(); // Ensure speaking state is cleared
                }

                clearTimeout(timeout);

                // Auto-reconnect on unexpected close (only if it was the current socket)
                if (isCurrent && !this._closed && code !== 1000 && this._reconnectAttempts < this._maxReconnectAttempts) {
                    this._reconnectAttempts++;
                    const delay = Math.min(1000 * this._reconnectAttempts, 5000);
                    this._log.warn('Reconnecting', { delay_ms: delay, attempt: this._reconnectAttempts, max: this._maxReconnectAttempts });
                    setTimeout(() => {
                        if (!this._closed) {
                            this._connectPromise = this._connect();
                        }
                    }, delay);
                }

                safeResolve();
            });
        });
    }

    // ── Speaking state hooks ──────────────────────────────────────────────

    get isSpeaking() {
        return this._isSpeaking;
    }

    _markSpeakingStart() {
        if (!this._isSpeaking) {
            this._isSpeaking = true;
            try { this._onSpeakingStart(); } catch { }
        }
    }

    _cancelSpeakingEndTimer() {
        if (this._speakingEndTimer) {
            clearTimeout(this._speakingEndTimer);
            this._speakingEndTimer = null;
        }
    }

    /**
     * Schedule speaking-end after a 1500ms drain window.
     * This allows Twilio's jitter buffer to fully play out the last
     * audio chunk before we flip back to "not speaking" state.
     */
    _scheduleSpeakingEnd(delayMs = 1500) {
        this._cancelSpeakingEndTimer();
        this._speakingEndTimer = setTimeout(() => {
            this._speakingEndTimer = null;
            this._markSpeakingEnd();
        }, delayMs);
    }

    _markSpeakingEnd() {
        this._cancelSpeakingEndTimer();
        if (this._isSpeaking) {
            this._isSpeaking = false;
            try { this._onSpeakingEnd(); } catch { }
        }
    }

    /**
     * Immediately stop TTS playback by sending a Twilio 'clear' event.
     * Also kills the ElevenLabs stream to stop further audio generation.
     */
    clearAudio() {
        this._expectedTwilioEndTime = 0;
        this._cancelSpeakingEndTimer();

        // 1. Clear Twilio buffer
        if (this.twilioWs.readyState === WebSocket.OPEN) {
            this._log.info('Sending clear event to Twilio (barge-in)');
            this.twilioWs.send(JSON.stringify({
                event: 'clear',
                streamSid: this.streamSid,
            }));
        }

        // 2. Kill current ElevenLabs stream to stop generation in flight
        if (this.ws) {
            this._log.info('Killing ElevenLabs stream connection due to barge-in');
            const staleWs = this.ws;
            this.ws = null; // Important: set to null BEFORE closing to avoid handler race
            this.isReady = false;
            try {
                staleWs.close(1000, 'barge_in_interruption');
            } catch (err) {
                this._log.error('Error closing ElevenLabs stream', err);
            }
        }

        // 3. Reset speaking state
        this._markSpeakingEnd();

        // 4. Pre-connect for the next response in background
        this._connectPromise = this._connect();
    }

    // ── Heartbeat ─────────────────────────────────────────────────────────

    _startHeartbeat() {
        this._stopHeartbeat();
        // Send heartbeat every 15s to keep connection alive
        this._heartbeatInterval = setInterval(() => {
            if (this.isReady && this.ws?.readyState === WebSocket.OPEN) {
                try {
                    this.ws.send(JSON.stringify({ text: " " }));
                } catch (err) {
                    this._log.error('Heartbeat send error', err);
                }
            }
        }, 15000);
    }

    _stopHeartbeat() {
        if (this._heartbeatInterval) {
            clearInterval(this._heartbeatInterval);
            this._heartbeatInterval = null;
        }
    }

    async waitReady() {
        await this._connectPromise;
    }

    async sendText(text) {
        if (!text) return;

        // Ensure we have a valid connection
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isReady) {
            this._log.debug('Socket not ready, waiting/reconnecting...');
            if (!this._connectPromise) {
                this._connectPromise = this._connect();
            }
            await this._connectPromise;
        }

        if (this.isReady && text && this.ws?.readyState === WebSocket.OPEN) {
            this._log.debug('Sending text to TTS', { text_length: text.length, preview: text.substring(0, 80) });
            this.ws.send(JSON.stringify({
                text: text,
                voice_settings: { stability: 0.5, similarity_boost: 0.8 },
                try_trigger_generation: true
            }));
        } else {
            this._log.warn('Cannot send text after reconnection attempt', { ready: this.isReady, wsState: this.ws?.readyState });
        }
    }

    /**
     * Trigger generation for the current buffer without closing the connection
     */
    flush() {
        if (this.isReady && this.ws?.readyState === WebSocket.OPEN) {
            // Sending empty text with flush=true tells ElevenLabs to generate now
            this.ws.send(JSON.stringify({
                text: " ",
                try_trigger_generation: true,
                flush: true
            }));
        }
    }

    _sendToTwilio(audioBase64) {
        if (!audioBase64 || audioBase64.length === 0) return;

        // Exact byte calculation for ulaw_8000: 8000 bytes = 1000ms
        const pcmBytes = Buffer.from(audioBase64, 'base64').length;
        const chunkDurationMs = (pcmBytes / 8000) * 1000;

        const now = Date.now();
        if (this._expectedTwilioEndTime < now) {
            this._expectedTwilioEndTime = now + chunkDurationMs;
        } else {
            this._expectedTwilioEndTime += chunkDurationMs;
        }

        // Add 500ms buffer for minor network jitter
        const timeUntilEnd = this._expectedTwilioEndTime - now;
        this._scheduleSpeakingEnd(timeUntilEnd + 500);

        if (this.twilioWs.readyState === WebSocket.OPEN) {
            this.twilioWs.send(JSON.stringify({
                event: 'media',
                streamSid: this.streamSid,
                media: { payload: audioBase64 }
            }));
        }
    }

    close() {
        this._closed = true;
        this.isReady = false;
        this._stopHeartbeat();
        this._cancelSpeakingEndTimer();
        this._markSpeakingEnd();
        this._log.info('Closing TTS connection');

        if (this.ws?.readyState === WebSocket.OPEN) {
            try {
                // Send proper EOS (End of Stream) signal
                this.ws.send(JSON.stringify({ text: "" }));
            } catch { }
            // Give ElevenLabs 2s to flush final audio before hard-close
            setTimeout(() => {
                if (this.ws?.readyState === WebSocket.OPEN) {
                    this.ws.close(1000, 'call_ended');
                }
            }, 2000);
        }
    }
}
