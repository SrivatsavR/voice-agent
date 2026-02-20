import { WebSocket } from 'ws';
import { Logger } from '../utils/logger.js';

/**
 * Manages the WebSocket connection to Deepgram Live Transcription API.
 * Drop-in replacement for ElevenLabsASR.
 *
 * Feed audio chunks via sendAudio(). Transcripts are delivered via onTranscript callback.
 *
 * KEY DIFFERENCES FROM ELEVENLABS ASR:
 * - Deepgram accepts RAW BINARY audio over WebSocket (not JSON-wrapped base64).
 * - Audio format is specified via query params: encoding=mulaw, sample_rate=8000.
 * - KeepAlive is a JSON message: { "type": "KeepAlive" }
 * - Transcript finality is determined via `is_final` + `speech_final` fields,
 *   and optionally via UtteranceEnd messages.
 * - Uses Nova-3 model for best accuracy and lowest latency.
 */
export class DeepgramASR {
    /**
     * @param {function} onTranscript - Callback for committed transcripts
     * @param {object} [options]
     * @param {Logger} [options.logger] - Call-scoped logger
     */
    constructor(onTranscript, options = {}) {
        this.onTranscript = onTranscript;
        this.onInterim = options.onInterim || null;
        this.ws = null;
        this.isReady = false;
        this._closed = false;
        this._reconnectAttempts = 0;
        this._maxReconnectAttempts = 3;
        this._keepaliveInterval = null;
        this._utteranceBuffer = '';  // Buffer partials within an utterance

        this._log = (options.logger || new Logger('ASR')).withComponent('ASR');

        this._connectPromise = this._connect();
    }

    _connect() {
        return new Promise((resolve) => {
            if (this._closed) return resolve();

            const apiKey = process.env.DEEPGRAM_API_KEY;
            if (!apiKey) {
                this._log.error('DEEPGRAM_API_KEY not set!');
                return resolve();
            }

            // Deepgram Streaming API endpoint with configuration:
            // - model=nova-3: Latest, fastest, most accurate model
            // - encoding=mulaw: Twilio sends μ-law encoded audio
            // - sample_rate=8000: Twilio uses 8kHz sample rate
            // - channels=1: Mono audio from Twilio
            // - punctuate=true: Add punctuation to transcripts
            // - interim_results=true: Get partial results for responsive UX
            // - endpointing=200: Finalize after 200ms of silence (fast for voice agent)
            // - utterance_end_ms=500: Send UtteranceEnd event after 500ms silence
            // - vad_events=true: Get voice activity detection events
            // - smart_format removed: LLM handles normalization, saves ASR processing time
            const params = new URLSearchParams({
                model: 'nova-3',
                encoding: 'mulaw',
                sample_rate: '8000',
                channels: '1',
                punctuate: 'true',
                interim_results: 'true',
                endpointing: '200',
                utterance_end_ms: '500',
                vad_events: 'true',
                language: 'en',
            });

            const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

            this._log.info('Connecting to Deepgram', { attempt: this._reconnectAttempts + 1 });

            this.ws = new WebSocket(url, {
                headers: {
                    'Authorization': `Token ${apiKey}`
                }
            });

            let resolved = false;
            const safeResolve = () => {
                if (!resolved) { resolved = true; resolve(); }
            };

            const timeout = setTimeout(() => {
                if (!resolved) {
                    this._log.warn('Timed out waiting for Deepgram connection (10s)');
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.isReady = true;
                    }
                    safeResolve();
                }
            }, 10000);

            this.ws.on('open', () => {
                this._log.info('Deepgram WebSocket open');
                this.isReady = true;
                this._reconnectAttempts = 0;
                this._startKeepalive();
                clearTimeout(timeout);
                safeResolve();
            });

            this.ws.on('message', (data) => {
                try {
                    const text = Buffer.isBuffer(data) ? data.toString() : data;
                    const response = JSON.parse(text);
                    const msgType = response.type;

                    if (msgType === 'Results') {
                        this._handleTranscriptResult(response);
                    } else if (msgType === 'UtteranceEnd') {
                        // UtteranceEnd fires when Deepgram detects end of an utterance
                        // If we have buffered partials, commit them now
                        if (this._utteranceBuffer.trim() && this.onTranscript) {
                            this._log.info(`Utterance end (committing buffer): ${this._utteranceBuffer.trim()}`);
                            this.onTranscript(this._utteranceBuffer.trim());
                        }
                        this._utteranceBuffer = '';
                    } else if (msgType === 'SpeechStarted') {
                        this._log.debug('Speech started (VAD)');
                    } else if (msgType === 'Metadata') {
                        this._log.info('Metadata received', {
                            request_id: response.request_id,
                            model: response.model_info?.name || 'unknown',
                        });
                    } else if (msgType === 'Error' || response.error) {
                        this._log.error('Deepgram error', { error: response.error || response.message || response });
                    } else {
                        this._log.debug(`Received msg type: ${msgType}`);
                    }
                } catch (err) {
                    // Not JSON, ignore
                }
            });

            this.ws.on('error', (err) => {
                this._log.error('WebSocket error', err);
                this.isReady = false;
                this._stopKeepalive();
                clearTimeout(timeout);
                safeResolve();
            });

            this.ws.on('close', (code, reason) => {
                const reasonStr = reason ? reason.toString() : '';
                this._log.info('Disconnected', { code, reason: reasonStr });
                this.isReady = false;
                this._stopKeepalive();
                clearTimeout(timeout);

                if (!this._closed && this._reconnectAttempts < this._maxReconnectAttempts) {
                    this._reconnectAttempts++;
                    const delay = Math.min(1000 * this._reconnectAttempts, 5000);
                    this._log.warn('Reconnecting', { delay_ms: delay, attempt: this._reconnectAttempts, max: this._maxReconnectAttempts });
                    setTimeout(() => {
                        if (!this._closed) {
                            this._connectPromise = this._connect();
                        }
                    }, delay);
                } else if (!this._closed) {
                    this._log.error('Max reconnect attempts exhausted', { max: this._maxReconnectAttempts });
                }

                safeResolve();
            });
        });
    }

    /**
     * Handle a Deepgram Results message.
     * 
     * Deepgram sends results with:
     * - is_final=true: This channel's result is finalized (won't change)
     * - speech_final=true: End of a speech segment (endpointing triggered)
     * 
     * Strategy:
     * - On is_final=true with speech_final=true → commit immediately (speaker paused)
     * - On is_final=true without speech_final → accumulate (speaker still talking)
     * - Partials (is_final=false) → log only, don't accumulate
     */
    _handleTranscriptResult(response) {
        const channel = response.channel;
        if (!channel?.alternatives?.length) return;

        const alt = channel.alternatives[0];
        const transcript = (alt.transcript || '').trim();
        const isFinal = response.is_final;
        const speechFinal = response.speech_final;

        if (!transcript) return;

        if (!isFinal) {
            // Interim/partial result — just log for debugging
            this._log.debug(`Partial: ${transcript}`);
            if (transcript.length > 0 && this.onInterim) {
                this.onInterim(transcript);
            }
            return;
        }

        // is_final=true: This segment won't change
        if (speechFinal) {
            // speech_final=true: The speaker has paused. Commit the full utterance.
            const fullTranscript = this._utteranceBuffer
                ? (this._utteranceBuffer + ' ' + transcript).trim()
                : transcript;
            this._utteranceBuffer = '';

            if (fullTranscript && this.onTranscript) {
                this._log.info(`Committed transcript (speech_final): ${fullTranscript}`);
                this.onTranscript(fullTranscript);
            }
        } else {
            // speech_final=false: Finalized segment, but speaker is still talking.
            // Accumulate into buffer.
            this._utteranceBuffer = this._utteranceBuffer
                ? (this._utteranceBuffer + ' ' + transcript).trim()
                : transcript;
            this._log.debug(`Buffered segment: ${transcript}`, { buffer: this._utteranceBuffer });
        }
    }

    /**
     * Send KeepAlive messages to prevent idle timeout.
     * Deepgram recommends sending KeepAlive every 3-5 seconds during silence.
     */
    _startKeepalive() {
        this._stopKeepalive();
        this._keepaliveInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN && this.isReady) {
                this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
            }
        }, 5000);
    }

    _stopKeepalive() {
        if (this._keepaliveInterval) {
            clearInterval(this._keepaliveInterval);
            this._keepaliveInterval = null;
        }
    }

    /**
     * Send audio to Deepgram ASR.
     * @param {string} base64Audio - Base64-encoded μ-law 8kHz audio from Twilio
     * 
     * IMPORTANT: Deepgram expects RAW BINARY audio, not JSON-wrapped.
     * We decode the base64 from Twilio and send the raw bytes.
     */
    sendAudio(base64Audio) {
        if (this.ws?.readyState === WebSocket.OPEN && this.isReady) {
            if (!base64Audio) return;

            // Decode base64 to raw binary buffer and send directly
            const audioBuffer = Buffer.from(base64Audio, 'base64');
            this.ws.send(audioBuffer);
        }
    }

    async waitReady() {
        await this._connectPromise;
    }

    close() {
        this._closed = true;
        this.isReady = false;
        this._stopKeepalive();
        this._log.info('Closing Deepgram connection');

        // Flush any remaining buffered transcript
        if (this._utteranceBuffer.trim() && this.onTranscript) {
            this._log.info(`Flushing remaining buffer on close: ${this._utteranceBuffer.trim()}`);
            this.onTranscript(this._utteranceBuffer.trim());
            this._utteranceBuffer = '';
        }

        if (this.ws?.readyState === WebSocket.OPEN) {
            try {
                // Send CloseStream message to gracefully close the Deepgram connection
                // This tells Deepgram to finalize any remaining audio
                this.ws.send(JSON.stringify({ type: 'CloseStream' }));
            } catch { }
            // Give Deepgram a moment to send final results, then close
            setTimeout(() => {
                if (this.ws?.readyState === WebSocket.OPEN) {
                    this.ws.close(1000, 'call_ended');
                }
            }, 1000);
        }
    }
}
