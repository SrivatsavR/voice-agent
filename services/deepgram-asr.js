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
        this._connectTimeout = null;
        this._flushTimeout = null;
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

        const lang = this.options.language || 'hi';

        const params = new URLSearchParams({
            model: 'nova-2',
            encoding: 'mulaw',
            sample_rate: '8000',
            channels: '1',
            punctuate: 'true',
            interim_results: 'true',
            endpointing: '700',
            utterance_end_ms: '2000',
            vad_events: 'true',
            smart_format: 'true',
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
                    this._handleTranscript(msg);
                } else if (msg.type === 'UtteranceEnd' && this._utteranceBuffer.trim()) {
                    // Ignore Deepgram's native utterance end to strictly enforce 5s voice inactivity flush
                }
            } catch { }
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
            this.onTranscript?.(this._utteranceBuffer.trim());
            this._utteranceBuffer = '';
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
            this.ws.send(buffer);
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

        if (this._utteranceBuffer.trim()) {
            this.onTranscript?.(this._utteranceBuffer.trim());
        }

        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'CloseStream' }));
            setTimeout(() => this.ws.close(), 200);
        }
    }
}
