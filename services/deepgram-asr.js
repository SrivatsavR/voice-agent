import { WebSocket } from 'ws';
import { Logger } from '../utils/logger.js';

export class DeepgramASR {
    constructor(onTranscript, options = {}) {
        this.onTranscript = onTranscript;
        this.ws = null;
        this.isReady = false;
        this._closed = false;
        this._reconnectAttempts = 0;
        this._maxReconnectAttempts = 5;
        this._keepaliveInterval = null;
        this._utteranceBuffer = '';
        this._audioBuffer = []; // To store raw audio for the current utterance
        this._connectTimeout = null;
        this._flushTimeout = null;
        this._safetyFlushTimeout = null;
        this._lastResultTime = 0;
        this._audioSentSinceLastResult = false;
        this.options = options;

        this._log = (options.logger || new Logger('ASR')).withComponent('ASR');
        process.nextTick(() => this._connect());
    }

    setLanguage(lang) {
        if (this.options.language === lang) return;
        this._log.info(`🌐 Switching ASR language to: ${lang}`);
        this.options.language = lang;
        // Reconnect to apply new language
        if (this.ws) {
            this.ws.close(1000, 'language_switch');
        }
        // _connect will be called by close handler if not explicit closed
    }

    _connect() {
        if (this._closed || this._reconnectAttempts >= this._maxReconnectAttempts) {
            return;
        }

        const apiKey = process.env.DEEPGRAM_API_KEY;
        if (!apiKey) {
            this._log.error('🚫 DEEPGRAM_API_KEY missing');
            return;
        }

        const lang = this.options.language || 'multi';

        const params = new URLSearchParams({
            model: 'nova-2',
            encoding: 'mulaw',
            sample_rate: '8000',
            channels: '1',
            punctuate: 'false',
            interim_results: 'true',
            endpointing: '300',
            utterance_end_ms: '1000',
            vad_events: 'true',
            smart_format: 'false',
            language: lang
        });

        const url = `wss://api.deepgram.com/v1/listen?${params}`;
        this._log.info('🔄 Deepgram connect', { attempt: this._reconnectAttempts + 1 });

        this.ws = new WebSocket(url, [], {
            headers: { 'Authorization': `Token ${apiKey}` },
            timeout: 5000,
            perMessageDeflate: false
        });

        this._connectTimeout = setTimeout(() => {
            this._log.warn('⏰ Deepgram timeout');
            this.ws?.close(1000, 'timeout');
        }, 6000);

        this.ws.on('open', () => {
            this._log.info('✅ Deepgram READY');
            this.isReady = true;
            this._reconnectAttempts = 0;
            clearTimeout(this._connectTimeout);
            this._startKeepalive();
        });

        this.ws.on('error', (err) => {
            this._log.error('💥 Deepgram WS error', { message: err.message });
            this.isReady = false;
            clearTimeout(this._connectTimeout);
        });

        this.ws.on('unexpected-response', (req, res) => {
            this._log.error('🚫 Deepgram handshake failed', {
                status: res.statusCode,
                statusText: res.statusText
            });
            this.isReady = false;
            clearTimeout(this._connectTimeout);
        });

        this.ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'Results') {
                    // Reset safety watchdog — Deepgram is alive
                    this._audioSentSinceLastResult = false;
                    if (this._safetyFlushTimeout) {
                        clearTimeout(this._safetyFlushTimeout);
                        this._safetyFlushTimeout = null;
                    }
                    this._handleTranscript(msg);
                } else if (msg.type === 'SpeechStarted') {
                    this.options.onSpeechStarted?.();
                } else if (msg.type === 'UtteranceEnd') {
                    // Deepgram signals end-of-utterance — flush any buffered transcript
                    if (this._utteranceBuffer.trim()) {
                        this._log.info('UtteranceEnd → flushing buffered transcript');
                        this._forceFlush();
                    }
                } else if (msg.type === 'Error' || msg.error) {
                    this._log.error('Deepgram API Error', msg);
                } else if (msg.type !== 'Metadata') {
                    this._log.debug('Deepgram unstructured message', msg);
                }
            } catch (err) {
                this._log.error('Deepgram parse error', { error: err.message, data: data.toString() });
            }
        });

        this.ws.on('close', (code, reason) => {
            this._log.debug('🔌 Deepgram closed', { code, reason: reason?.toString() });
            this.isReady = false;
            clearTimeout(this._connectTimeout);
            this._stopKeepalive();

            if (!this._closed && this._reconnectAttempts < this._maxReconnectAttempts) {
                this._reconnectAttempts++;
                setTimeout(() => this._connect(), 1000 * this._reconnectAttempts);
            }
        });
    }

    _forceFlush() {
        if (this._flushTimeout) {
            clearTimeout(this._flushTimeout);
            this._flushTimeout = null;
        }
        if (this._utteranceBuffer.trim()) {
            const fullAudio = Buffer.concat(this._audioBuffer);
            this.onTranscript?.(this._utteranceBuffer.trim(), fullAudio);
            this._utteranceBuffer = '';
            this._audioBuffer = [];
        } else {
            this._audioBuffer = []; // Just clear if nothing to say
        }
    }

    forceFlush() {
        this._forceFlush();
    }

    _handleTranscript(msg) {
        const transcript = msg.channel?.alternatives?.[0]?.transcript?.trim() || '';
        const isFinal = msg.is_final;
        const speechFinal = msg.speech_final;

        if (!transcript && !speechFinal) return;

        if (!isFinal) {
            if (transcript) this.options.onInterim?.(transcript); // Still immediately calls TTS clearAudio
            return;
        }

        // It is final
        if (transcript) {
            this._utteranceBuffer = this._utteranceBuffer
                ? `${this._utteranceBuffer} ${transcript}`.trim()
                : transcript;
        }

        if (speechFinal) {
            // Immediate flush when Deepgram VAD detects end of phrase
            this._forceFlush();
        } else if (transcript) {
            // Fallback: If no speech_final arrives within 700ms, force flush to prevent hanging
            if (this._flushTimeout) clearTimeout(this._flushTimeout);
            this._flushTimeout = setTimeout(() => this._forceFlush(), 700);
        }
    }

    _startKeepalive() {
        this._stopKeepalive();
        this._keepaliveInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
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

    sendAudio(base64Audio) {
        if (!this.isReady || this.ws?.readyState !== WebSocket.OPEN || !base64Audio) {
            return;
        }
        try {
            const buffer = Buffer.from(base64Audio, 'base64');
            this._audioBuffer.push(buffer); // Save for REST burst
            this.ws.send(buffer);

            // Safety watchdog: if we keep sending audio but Deepgram never replies,
            // force a reconnect after 5s to recover from silent connections.
            if (!this._safetyFlushTimeout) {
                this._audioSentSinceLastResult = true;
                this._safetyFlushTimeout = setTimeout(() => {
                    this._safetyFlushTimeout = null;
                    if (this._audioSentSinceLastResult && !this._closed) {
                        this._log.warn('⚠️ No Deepgram results received for 5s despite audio flowing — reconnecting');
                        this._audioSentSinceLastResult = false;
                        // Force close and reconnect
                        if (this.ws?.readyState === WebSocket.OPEN) {
                            this.ws.close(1000, 'safety_reconnect');
                        }
                    }
                }, 5000);
            }
        } catch { }
    }

    async waitReady() {
        return new Promise(resolve => {
            const check = () => this.isReady ? resolve(true) : setTimeout(check, 50);
            check();
        });
    }

    close() {
        this._closed = true;
        this.isReady = false;
        this._stopKeepalive();
        if (this._safetyFlushTimeout) {
            clearTimeout(this._safetyFlushTimeout);
            this._safetyFlushTimeout = null;
        }

        if (this._utteranceBuffer.trim()) {
            this.onTranscript?.(this._utteranceBuffer.trim());
        }

        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'CloseStream' }));
            setTimeout(() => this.ws.close(), 200);
        }
    }
}
