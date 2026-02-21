import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AsyncLocalStorage } from 'async_hooks';

const logStorage = new AsyncLocalStorage();

// ─── Log Levels ──────────────────────────────────────────────────────────────

const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
    FATAL: 4,
};

const LEVEL_NAMES = Object.fromEntries(
    Object.entries(LOG_LEVELS).map(([k, v]) => [v, k])
);

// ANSI color codes for console output
const COLORS = {
    DEBUG: '\x1b[36m',   // Cyan
    INFO: '\x1b[32m',    // Green
    WARN: '\x1b[33m',    // Yellow
    ERROR: '\x1b[31m',   // Red
    FATAL: '\x1b[35m',   // Magenta
    RESET: '\x1b[0m',
    DIM: '\x1b[2m',
    BOLD: '\x1b[1m',
};

// Component color mapping for easy visual distinction
const COMPONENT_COLORS = {
    'Server': '\x1b[34m',     // Blue
    'WS': '\x1b[36m',         // Cyan
    'ASR': '\x1b[33m',        // Yellow
    'TTS': '\x1b[35m',        // Magenta
    'Workflow': '\x1b[32m',   // Green
    'Agent': '\x1b[32m',      // Green
    'Call': '\x1b[34m',       // Blue
    'Interruption': '\x1b[91m', // Bright Red
};

// ─── Resolve logs directory ──────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_DIR = path.join(__dirname, '..', 'logs');

// Ensure logs directory exists
try {
    if (!fs.existsSync(LOGS_DIR)) {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
} catch {
    // If we can't create logs dir, file logging will be disabled
}

// ─── Minimum log level (configurable via LOG_LEVEL env var) ──────────────────

const MIN_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.DEBUG;
const FILE_LOGGING_ENABLED = process.env.LOG_TO_FILE !== 'false';

// ─── Log File Management ─────────────────────────────────────────────────────

let _currentLogDate = null;
let _logStream = null;

function _getLogStream() {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    if (_currentLogDate !== today) {
        // Close previous stream
        if (_logStream) {
            try { _logStream.end(); } catch { }
        }

        _currentLogDate = today;
        const logFile = path.join(LOGS_DIR, `voice-ai-${today}.log`);
        try {
            _logStream = fs.createWriteStream(logFile, { flags: 'a' });
            _logStream.on('error', () => {
                // Silently disable file logging if write fails
                _logStream = null;
            });
        } catch {
            _logStream = null;
        }
    }

    return _logStream;
}

// ─── Core Logger Class ───────────────────────────────────────────────────────

/**
 * Structured logger with call context, levels, and dual output (console + file).
 * 
 * Usage:
 *   const log = new Logger('ASR');
 *   log.info('Connected');
 *   log.withCall('call-123', 'stream-456').info('Audio received');
 *   
 *   // Scoped logger for a specific call
 *   const callLog = Logger.forCall('call-123', 'stream-456', '(555) 123-4567');
 *   callLog.info('ASR', 'Transcript received', { text: 'hello' });
 */
export class Logger {
    /**
     * @param {string} component - Component name (e.g. 'ASR', 'TTS', 'WS', 'Workflow')
     * @param {object} [context] - Optional persistent context
     * @param {string} [context.callId] - Call identifier
     * @param {string} [context.streamSid] - Twilio stream SID
     * @param {string} [context.callerPhone] - Caller phone number
     */
    constructor(component, context = {}) {
        this.component = component;
        this.context = context;
    }

    /**
     * Run a block of code with a specific call context.
     */
    static runWithContext(context, fn) {
        return logStorage.run(context, fn);
    }

    /**
     * Create a child logger with additional call context.
     */
    withCall(callId, streamSid, callerPhone) {
        return new Logger(this.component, {
            ...this.context,
            callId,
            streamSid,
            callerPhone,
        });
    }

    /**
     * Create a child logger with a different component name, keeping context.
     */
    withComponent(component) {
        return new Logger(component, { ...this.context });
    }

    // ── Level methods ─────────────────────────────────────────────────────

    debug(message, data) { this._log(LOG_LEVELS.DEBUG, message, data); }
    info(message, data) { this._log(LOG_LEVELS.INFO, message, data); }
    warn(message, data) { this._log(LOG_LEVELS.WARN, message, data); }
    error(message, data) { this._log(LOG_LEVELS.ERROR, message, data); }
    fatal(message, data) { this._log(LOG_LEVELS.FATAL, message, data); }

    // ── Performance timing ────────────────────────────────────────────────

    /**
     * Start a timer. Returns title for use with timeEnd().
     * @param {string} label - Timer label
     * @returns {{ label: string, start: number }}
     */
    time(label) {
        return { label, start: performance.now() };
    }

    /**
     * End a timer and log the duration.
     * @param {{ label: string, start: number }} timer
     * @param {object} [extraData] - Additional data to log
     */
    timeEnd(timer, extraData = {}) {
        const elapsed = performance.now() - timer.start;
        this.info(`${timer.label} completed`, {
            ...extraData,
            duration_ms: Math.round(elapsed * 100) / 100,
        });
    }

    // ── Internal logging ──────────────────────────────────────────────────

    _log(level, message, data) {
        if (level < MIN_LEVEL) return;

        const now = new Date();
        const levelName = LEVEL_NAMES[level];

        // Merge with async context if available
        const asyncContext = logStorage.getStore() || {};
        const fullContext = { ...asyncContext, ...this.context };

        // Console output (human-readable, colored)
        this._logToConsole(now, levelName, message, data, fullContext);

        // File output (JSON structured)
        if (FILE_LOGGING_ENABLED) {
            this._logToFile(now, levelName, message, data, fullContext);
        }
    }

    _logToConsole(now, level, message, data, context) {
        const timestamp = now.toISOString().split('T')[1].replace('Z', '');
        const levelColor = COLORS[level] || COLORS.RESET;
        const componentColor = COMPONENT_COLORS[this.component] || COLORS.RESET;

        // Build context string
        let ctx = '';
        if (context.callId) {
            ctx += ` ${COLORS.DIM}call=${context.callId}${COLORS.RESET}`;
        }

        // Format: [HH:MM:SS.mmm] [LEVEL] [Component] message {data}
        let line = `${COLORS.DIM}${timestamp}${COLORS.RESET} ${levelColor}${level.padEnd(5)}${COLORS.RESET} ${componentColor}[${this.component}]${COLORS.RESET}${ctx} ${message}`;

        if (data !== undefined && data !== null) {
            if (typeof data === 'object' && !(data instanceof Error)) {
                const dataStr = JSON.stringify(data);
                if (dataStr.length < 200) {
                    line += ` ${COLORS.DIM}${dataStr}${COLORS.RESET}`;
                } else {
                    line += ` ${COLORS.DIM}${dataStr.substring(0, 200)}…${COLORS.RESET}`;
                }
            } else if (data instanceof Error) {
                line += ` ${COLORS.DIM}${data.message}${COLORS.RESET}`;
                if (level === 'ERROR' || level === 'FATAL') {
                    line += `\n${COLORS.DIM}${data.stack}${COLORS.RESET}`;
                }
            } else {
                line += ` ${COLORS.DIM}${String(data)}${COLORS.RESET}`;
            }
        }

        if (level === 'ERROR' || level === 'FATAL') {
            console.error(line);
        } else if (level === 'WARN') {
            console.warn(line);
        } else {
            console.log(line);
        }
    }

    _logToFile(now, level, message, data, context) {
        const stream = _getLogStream();
        if (!stream) return;

        const entry = {
            timestamp: now.toISOString(),
            level,
            component: this.component,
            message,
            ...(context.callId && { callId: context.callId }),
            ...(context.streamSid && { streamSid: context.streamSid }),
            ...(context.callerPhone && { callerPhone: context.callerPhone }),
        };

        if (data !== undefined && data !== null) {
            if (data instanceof Error) {
                entry.error = { message: data.message, stack: data.stack };
            } else {
                entry.data = data;
            }
        }

        try {
            stream.write(JSON.stringify(entry) + '\n');
        } catch {
            // Silently fail — logging should never crash the app
        }
    }
}

// ─── Call Logger Factory ─────────────────────────────────────────────────────

/**
 * Create a call-scoped logger that includes callId, streamSid, callerPhone
 * in every log line. Use .withComponent('ASR') to create sub-loggers.
 * 
 * @param {string} callId 
 * @param {string} streamSid 
 * @param {string} callerPhone 
 * @returns {Logger}
 */
Logger.forCall = function (callId, streamSid, callerPhone) {
    return new Logger('Call', { callId, streamSid, callerPhone });
};

// ─── Global (component-level) loggers ────────────────────────────────────────

export const serverLog = new Logger('Server');
export const wsLog = new Logger('WS');

// ─── Call ID Generator ───────────────────────────────────────────────────────

let _callCounter = 0;

/**
 * Generate a short unique call ID.
 * Format: c-{timestamp_base36}-{counter}
 */
export function generateCallId() {
    _callCounter++;
    const ts = Date.now().toString(36);
    return `c-${ts}-${_callCounter}`;
}
