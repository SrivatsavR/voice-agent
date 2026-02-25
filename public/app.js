let currentCallId = localStorage.getItem('lastCallId');
let currentSession = JSON.parse(localStorage.getItem('lastSession') || '{}');
let eventSource = null;
let isVoiceCall = false;

// Initialize Lucide icons
lucide.createIcons();

// --- DOM Elements ---
const chatMessages = document.getElementById('chat-messages');
const chatForm = document.getElementById('chat-form');
const userInput = document.getElementById('user-input');
const sessionVariables = document.getElementById('session-variables');
const callIdDisplay = document.getElementById('call-id-display');
const historyList = document.getElementById('history-list');
const resetBtn = document.getElementById('reset-session');
const triggerCallBtn = document.getElementById('trigger-call');
const outboundPhoneInput = document.getElementById('outbound-phone');
const countryCodeSelect = document.getElementById('country-code');
const extractionFeed = document.getElementById('extraction-feed');

// --- API Functions ---
async function api(path, options = {}) {
    const res = await fetch(path, {
        method: options.method || 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: options.body ? JSON.stringify(options.body) : undefined
    });
    return res.json();
}

function setupRealtimeEvents(callId) {
    if (eventSource) {
        eventSource.close();
    }

    console.log(`[Realtime] Connecting to events for ${callId}`);
    eventSource = new EventSource(`/api/events/${callId}`);

    eventSource.onmessage = (event) => {
        try {
            const entry = JSON.parse(event.data);
            handleLogEntry(entry);
        } catch (e) {
            console.error('Error parsing SSE event', e);
        }
    };

    eventSource.onerror = (err) => {
        console.warn('[Realtime] Connection lost, retrying...', err);
        // EventSource automatically retries
    };
}

function handleLogEntry(entry) {
    if (entry.callId !== currentCallId) {
        // Still refresh history if a background session finished, so the outcome updates
        if (entry.component === 'Call' && entry.message.includes('reached terminal node')) {
            refreshHistory();
        }
        return;
    }

    const msg = stripAnsi(entry.message || '');
    const component = entry.component;
    const lowMsgEarly = msg.toLowerCase();

    // 4. Session updates (Phase 4 Real-time Sync)
    if (entry.message === 'SESSION_UPDATED' && entry.data?.session) {
        currentSession = entry.data.session;
        updateVariables(currentSession);
        // Persist local state
        localStorage.setItem('lastSession', JSON.stringify(currentSession));
        return;
    }

    const role = component === 'Agent' ? 'agent' : (component === 'User' ? 'user' : null);
    if (role) {
        // Check if this is an intelligence event (barge-in, silence filler, etc.)
        // If so, log it to the extraction feed AND display as chat message
        const isBargeIn = lowMsgEarly.includes('barge-in');
        const isSilenceFiller = lowMsgEarly.includes('silence filler') || lowMsgEarly.includes('firing silence');
        const isKB = lowMsgEarly.includes('knowledgebase') || lowMsgEarly.includes('knowledge base');

        if (isBargeIn) {
            logIntelligence('Barge-in detected', 'warn');
        } else if (isSilenceFiller) {
            logIntelligence('Silence filler fired', 'info');
        } else if (isKB) {
            logIntelligence(msg.replace(/\[.*?\]/g, '').trim().substring(0, 57) || 'KB search triggered', 'info');
        }

        let txt = msg;
        if (txt.startsWith('Welcome: ')) txt = txt.replace('Welcome: ', '');

        // Handle raw JSON output from agent logs
        if (txt.startsWith('{') && txt.includes('"say"')) {
            try {
                const parsed = JSON.parse(txt);
                txt = parsed.say || txt;
            } catch (e) { }
        }

        // Don't add barge-in partials as regular chat messages
        if (isBargeIn) return;

        addMessage(role, txt);
    }

    // 2. Intelligent Variable Updates
    else if (component === 'Database' && msg === 'Saving session updates' && (entry.data?.updates || entry.updates)) {
        const updates = entry.data?.updates || entry.updates;
        Object.assign(currentSession, updates);
        updateVariables(currentSession);

        const keys = Object.keys(updates).filter(k => !k.endsWith('_valid') && !k.startsWith('bg_'));
        if (keys.length > 0) {
            logIntelligence(`Captured ${keys.join(', ')}`, 'success');
        }
    }

    // 3. Extractable intelligence (Variable extraction events, Barge-ins, Silence, KB)
    const lowMsg = msg.toLowerCase();
    const isIntelligence = component === 'Validation' || component === 'Database' || component === 'Workflow' ||
        component === 'Interruption' || component === 'SilenceFiller' || component === 'KnowledgeBase' || component === 'VectorSearch' ||
        msg.includes('[Background]') || msg.includes('Saving session updates') || msg.includes('Validated') ||
        msg.includes('[FastMatch]') || msg.includes('[Burst Correction]') || msg.includes('[KnowledgeBase]') || msg.includes('[VectorSearch]') ||
        lowMsg.includes('barge-in') || lowMsg.includes('silence filler') || lowMsg.includes('firing silence') || msg.includes('[Chat-RAG]') ||
        lowMsg.includes('captured') || lowMsg.includes('validated') || lowMsg.includes('searching') || lowMsg.includes('retrieved') ||
        lowMsg.includes('answer found') || lowMsg.includes('kb query') || lowMsg.includes('pitch') || lowMsg.includes('interest');

    if (isIntelligence) {

        let type = 'info';
        if (msg.includes('Valid') || msg.includes('Success') || msg.includes('Found') || msg.toLowerCase().includes('match') || msg.includes('Retrieved') || msg.includes('Validated') || lowMsg.includes('answer found')) type = 'success';
        if (msg.includes('Invalid') || msg.includes('Error') || msg.includes('failed') || msg.includes('Discarding')) type = 'warn';
        if (msg.includes('Searching') || msg.includes('Querying') || msg.includes('Generating embedding') || component === 'SilenceFiller') type = 'info';

        let displayMsg = msg;
        if (msg.includes('processTranscript')) return; // ignore timing logs
        if (msg.includes('Processed result')) return; // ignore raw json
        if (msg.includes('Validation Skipped')) return; // ignore skipped validation messages
        if (msg.includes('Generated embedding vector')) return; // ignore technical vector logs

        displayMsg = displayMsg.replace(/\[.*?\]/g, '').trim();
        if (displayMsg.length > 60) displayMsg = displayMsg.substring(0, 57) + '...';

        logIntelligence(displayMsg, type);
    }
}

function logIntelligence(text, type = 'info') {
    if (!extractionFeed) return;

    if (extractionFeed.querySelector('p.italic')) extractionFeed.innerHTML = '';

    const pill = document.createElement('div');
    pill.className = `extraction-pill ${type === 'success' ? 'success' : (type === 'warn' ? 'warn' : '')}`;

    const iconMap = {
        'Background': 'zap',
        'Validation': 'check-circle',
        'Database': 'database',
        'Saving': 'database',
        'Workflow': 'git-branch',
        'FastMatch': 'zap',
        'Burst': 'zap',
        'KnowledgeBase': 'search',
        'VectorSearch': 'search',
        'Validated': 'check-circle',
        'Invalid': 'alert-circle',
        'Barge-in': 'mic-off',
        'Silence': 'clock',
        'RAG': 'search'
    };

    let icon = 'info'; // Default icon
    const lowText = text.toLowerCase();

    // Check for specific keywords first
    if (lowText.includes('barge-in')) icon = 'mic-off';
    else if (lowText.includes('silence')) icon = 'clock';
    else if (lowText.includes('burst')) icon = 'zap';
    else if (lowText.includes('fast-match') || lowText.includes('fastmatch')) icon = 'zap';
    else if (lowText.includes('valid') || lowText.includes('validated')) icon = 'shield-check';
    else if (lowText.includes('captured') || lowText.includes('saving')) icon = 'database';
    else if (lowText.includes('search') || lowText.includes('query') || lowText.includes('embedding') || lowText.includes('retrieved') || lowText.includes('rag')) icon = 'search';
    else {
        // Fallback to iconMap
        for (const [key, val] of Object.entries(iconMap)) {
            if (text.includes(key)) {
                icon = val;
                break;
            }
        }
    }

    pill.innerHTML = `<i data-lucide="${icon}" class="w-2.5 h-2.5"></i> <span>${text}</span>`;
    extractionFeed.prepend(pill);

    while (extractionFeed.children.length > 6) {
        extractionFeed.removeChild(extractionFeed.lastChild);
    }
    lucide.createIcons();
}

async function startNewSession() {
    const data = await api('/api/chat', { method: 'POST', body: {} });
    currentCallId = data.callId;
    currentSession = data.session || {};
    isVoiceCall = false;

    chatMessages.innerHTML = '';
    if (extractionFeed) extractionFeed.innerHTML = '<p class="text-[10px] text-slate-300 italic">Listening for intents...</p>';
    callIdDisplay.textContent = `ID: ${currentCallId}`;
    addMessage('agent', data.say);
    updateVariables(currentSession);
    refreshHistory();

    // Persist to local storage
    localStorage.setItem('lastCallId', currentCallId);
    localStorage.setItem('lastSession', JSON.stringify(currentSession));

    // Web chat doesn't strictly need SSE for its own responses (handled in sendMessage),
    // but we connect anyway to keep logic consistent.
    setupRealtimeEvents(currentCallId);
}

async function sendMessage(text) {
    if (isVoiceCall) {
        alert('You cannot type text in a live voice call!');
        return;
    }
    addMessage('user', text);
    const data = await api('/api/chat', {
        method: 'POST',
        body: { text, callId: currentCallId }
    });

    if (data.wasExpired) {
        addMessage('system', 'Session resumed after server restart.');
        currentCallId = data.callId;
        localStorage.setItem('lastCallId', currentCallId);
        callIdDisplay.textContent = `ID: ${currentCallId}`;
        setupRealtimeEvents(currentCallId);
        // Show welcome if the server included it alongside the response
        if (data.welcome) addMessage('agent', data.welcome);
    }

    if (data.say) addMessage('agent', data.say);
    if (data.session) {
        currentSession = data.session;
        updateVariables(currentSession);
        localStorage.setItem('lastSession', JSON.stringify(currentSession));
    }
}

async function refreshHistory() {
    const history = await api('/api/history');
    historyList.innerHTML = '';

    history.slice(0, 5).forEach(call => {
        const div = document.createElement('div');
        const isActive = call.callId === currentCallId;
        div.className = `history-card p-4 rounded-xl border border-white/5 cursor-pointer group flex flex-col gap-2 ${isActive ? 'active' : 'bg-white/[0.02]'}`;

        const timestamp = new Date(call.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const outcome = call.call_outcome || 'In-Progress';
        const color = outcome === 'complete' || outcome === 'TERM_COMPLETE' ? 'text-emerald-400' : 'text-amber-400';

        div.innerHTML = `
            <div class="flex justify-between items-center">
                <span class="text-[10px] font-bold text-slate-400 truncate">${call.callId}</span>
                <span class="text-[10px] text-slate-400">${timestamp}</span>
            </div>
            <div class="font-semibold text-sm text-slate-800 truncate">${call.preferred_name || call.name_spoken || 'Anonymous'}</div>
            <div class="flex justify-between items-center">
                <span class="text-[10px] text-slate-400 truncate">${call.caller_phone || 'Web Test'}</span>
                <span class="text-[9px] uppercase font-bold tracking-tighter ${color}">${outcome.replace('TERM_', '')}</span>
            </div>
        `;

        div.onclick = () => {
            if (currentCallId === call.callId && isVoiceCall) return; // Already on it

            currentCallId = call.callId;
            currentSession = call;
            isVoiceCall = (call.caller_phone && call.caller_phone !== 'chat-user');

            chatMessages.innerHTML = '';
            if (extractionFeed) extractionFeed.innerHTML = '<p class="text-[10px] text-slate-300 italic">Listening for intents...</p>';
            callIdDisplay.textContent = `ID: ${currentCallId}`;
            updateVariables(currentSession);
            setupRealtimeEvents(currentCallId);

            // Persist selection
            localStorage.setItem('lastCallId', currentCallId);
            localStorage.setItem('lastSession', JSON.stringify(currentSession));

            // Fetch historical logs to backfill chat window
            // If the session object already has a transcript (from history-service), use it immediately
            if (call.transcript && Array.isArray(call.transcript)) {
                call.transcript.forEach(entry => {
                    const role = entry.role === 'assistant' ? 'agent' : (entry.role === 'user' ? 'user' : null);
                    if (role && entry.content) {
                        let txt = typeof entry.content === 'string' ? entry.content : (Array.isArray(entry.content) ? entry.content.map(c => c.text || '').join('') : '');
                        if (txt.startsWith('Welcome: ')) txt = txt.replace('Welcome: ', '');
                        if (txt && !txt.startsWith('{"say"')) { // Filter out raw JSON if any
                            addMessage(role, txt);
                        }
                    }
                });
            } else {
                backfillLogs(currentCallId);
            }
        };
        historyList.appendChild(div);

        // Auto-select ONLY if nothing is selected.
        if (!currentCallId) {
            div.onclick();
        }
    });
}

async function backfillLogs(callId) {
    try {
        const logs = await api(`/api/logs/${callId}`);
        logs.forEach(entry => handleLogEntry(entry));
    } catch (e) { }
}

function stripAnsi(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function addMessage(role, text) {
    if (!text) return;

    // Prevent duplicates (simple check for same role/text in consecutive messages)
    const last = chatMessages.lastElementChild;
    if (last && last.querySelector('p').textContent === text) return;

    const div = document.createElement('div');
    div.className = `flex flex-col gap-1.5 ${role === 'user' ? 'items-end' : 'items-start'}`;

    const bubbleClasses = {
        'user': 'bg-slate-200 border-slate-300 text-slate-800 rounded-2xl rounded-tr-none ml-auto',
        'agent': 'bg-pink-50 border-pink-100 text-slate-800 rounded-2xl rounded-tl-none',
        'system': 'bg-red-50 border-red-100 text-red-600 italic rounded-lg text-[11px]'
    };

    const safeText = escapeHtml(text);
    const safeRole = escapeHtml(role);

    div.innerHTML = `
        <div class="px-5 py-3 border backdrop-blur-sm max-w-[85%] ${bubbleClasses[role]} shadow-sm">
            <p class="text-sm leading-relaxed">${safeText}</p>
        </div>
        <span class="text-[9px] uppercase tracking-widest text-slate-400 font-bold px-1">${safeRole}</span>
    `;

    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateVariables(session) {
    const targets = [
        { key: 'name_spoken', label: 'Seller Name', icon: 'user' },
        { key: 'interest_in_meesho', label: 'Joining Interest', icon: 'thumbs-up' },
        { key: 'has_bank_account', label: 'Active Bank Acc?', icon: 'credit-card' },
        { key: 'products_sold', label: 'Product Items', icon: 'package' },
        {
            key: 'price_min', label: 'Price Range', icon: 'tag', fallback: 'raw_price_min', format: (s) => {
                const min = s.price_min !== undefined && s.price_min !== null ? s.price_min : s.raw_price_min;
                const max = s.price_max !== undefined && s.price_max !== null ? s.price_max : s.raw_price_max;
                if (typeof min === 'number' && typeof max === 'number') return `₹${min}-${max}`;
                if (typeof min === 'number') return `₹${min}+`;
                return min || null;
            }
        },
        { key: 'listing_start', label: 'Ready to List?', icon: 'calendar', fallback: 'raw_listing_start', format: (s) => s.listing_start || s.raw_listing_start },
        { key: 'email', label: 'Email Address', icon: 'mail', fallback: 'raw_email' },
        { key: 'gstin', label: 'GST/UIN', icon: 'shield-check', fallback: 'raw_gstin' }
    ];

    sessionVariables.innerHTML = '';

    // Save state update
    localStorage.setItem('lastSession', JSON.stringify(session));

    targets.forEach(target => {
        let val = target.format ? target.format(session) : (session[target.key] || (target.fallback ? session[target.fallback] : (target.key === 'gstin' ? session.uin : null)));
        // Standardize "yes"/"no" as captured
        const isCaptured = (val !== undefined && val !== null && val !== '' && val !== 'unknown' && val !== false && (Array.isArray(val) ? val.length > 0 : true));

        // Determine "Syncing" state
        let isSyncing = false;
        if (target.key === 'email' && session.bg_email_running === 'yes') isSyncing = true;
        if (target.key === 'gstin' && session.bg_gst_running === 'yes') isSyncing = true;
        if (target.key === 'listing_start' && session.bg_listing_running === 'yes') isSyncing = true;
        if (target.key === 'price_min' && session.bg_price_running === 'yes') isSyncing = true;

        const div = document.createElement('div');
        // Always display prominently if we have ANY data (raw or validated)
        div.className = `variable-card col-span-1 p-2 rounded-xl flex items-center gap-2 group ${isCaptured ? 'captured' : 'opacity-40'}`;

        let displayVal = isSyncing ? 'Syncing...' : '--';
        if (isCaptured) {
            const rawVal = Array.isArray(val) ? val[0] : val;
            displayVal = rawVal && rawVal.toString().length > 20 ? rawVal.toString().substring(0, 18) + '..' : (rawVal || '--');
            if (isSyncing && !val.toString().includes('₹')) { // If syncing and we only have raw text
                // Keep showing the raw text but maybe with a pulse
            }
        }

        div.innerHTML = `
                <div class="p-1.5 rounded-lg ${isCaptured ? 'bg-emerald-500/20 text-emerald-600' : (isSyncing ? 'bg-pink-500/20 text-pink-500' : 'bg-slate-200 text-slate-400')} shrink-0 relative">
                    <i data-lucide="${target.icon}" class="w-3 h-3"></i>
                    ${isSyncing ? '<div class="absolute -top-1 -right-1 syncing-dot"></div>' : ''}
                </div>
                <div class="min-w-0">
                    <div class="text-[8px] uppercase font-bold text-slate-400 truncate">${target.label}</div>
                    <div class="text-[10px] font-bold ${isCaptured ? 'text-slate-800' : (isSyncing ? 'text-pink-500 animate-pulse' : 'text-slate-300')} truncate">${displayVal}</div>
                </div>
            `;
        sessionVariables.appendChild(div);
    });

    lucide.createIcons();
}

// --- Interaction ---
chatForm.onsubmit = (e) => {
    e.preventDefault();
    const text = userInput.value.trim();
    if (!text) return;
    userInput.value = '';
    sendMessage(text);
};

resetBtn.onclick = () => {
    chatMessages.innerHTML = '';
    localStorage.removeItem('lastCallId');
    localStorage.removeItem('lastSession');
    startNewSession();
};

triggerCallBtn.onclick = async () => {
    const rawNumber = outboundPhoneInput.value.trim();
    if (!rawNumber) {
        alert('Please enter a phone number');
        return;
    }

    const countryCode = countryCodeSelect ? countryCodeSelect.value : '+91';
    const phoneNumber = rawNumber.startsWith('+') ? rawNumber : (countryCode + rawNumber);

    triggerCallBtn.disabled = true;
    const originalContent = triggerCallBtn.innerHTML;
    triggerCallBtn.innerHTML = '<i data-lucide="loader" class="w-4 h-4 animate-spin"></i>';
    lucide.createIcons();

    try {
        const data = await api('/api/outbound', {
            method: 'POST',
            body: { phoneNumber }
        });

        if (data.success) {
            addMessage('system', `Call triggered!`);
            // Refresh history immediately to pick up the new call
            refreshHistory();
        } else {
            addMessage('system', `Error: ${data.error}`);
        }
    } catch (e) {
        addMessage('system', `Failed: ${e.message}`);
    } finally {
        triggerCallBtn.disabled = false;
        triggerCallBtn.innerHTML = originalContent;
        lucide.createIcons();
    }
};

// Visibility Handling for Re-sync
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentCallId) {
        console.log('[App] Tab visible, re-syncing events...');
        setupRealtimeEvents(currentCallId);
        refreshHistory();
    }
});

// Start — validate stored session or create fresh one
(async function init() {
    if (currentCallId) {
        // Validate that this session still exists on the server
        try {
            const history = await api('/api/history');
            const found = history.find(h => h.callId === currentCallId);
            if (found) {
                // Session exists on server — resume it
                currentSession = found;
                callIdDisplay.textContent = `ID: ${currentCallId}`;
                updateVariables(currentSession);
                setupRealtimeEvents(currentCallId);
                backfillLogs(currentCallId);
                refreshHistory();
            } else {
                // Session no longer exists on server — start fresh
                localStorage.removeItem('lastCallId');
                localStorage.removeItem('lastSession');
                await startNewSession();
            }
        } catch (e) {
            // API failed — start fresh to be safe
            console.warn('[App] Failed to validate stored session, starting new', e);
            localStorage.removeItem('lastCallId');
            localStorage.removeItem('lastSession');
            await startNewSession();
        }
    } else {
        // No stored session — new device or cleared storage
        await startNewSession();
    }
})();
setInterval(refreshHistory, 5000);
