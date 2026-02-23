let currentCallId = null;
let currentSession = {};
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
    const msg = stripAnsi(entry.message || '');
    const component = entry.component;

    // 1. Chat messages
    const role = component === 'Agent' ? 'agent' : (component === 'User' ? 'user' : null);
    if (role) {
        let txt = msg;
        if (txt.startsWith('Welcome: ')) txt = txt.replace('Welcome: ', '');
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

    // 3. Extraction & Validation Feed
    else if (component === 'Validation' || component === 'KnowledgeBase' || component === 'Workflow' || msg.includes('[Fast-Match]') || msg.includes('[Burst Correction]')) {
        let type = 'info';
        if (msg.includes('Valid') || msg.includes('Success') || msg.includes('Found') || msg.includes('match')) type = 'success';
        if (msg.includes('Invalid') || msg.includes('Error') || msg.includes('failed') || msg.includes('Discarding')) type = 'warn';

        let displayMsg = msg;
        if (msg.includes('processTranscript')) return; // ignore timing logs
        if (msg.includes('Processed result')) return; // ignore raw json

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

    let icon = 'info';
    const lowText = text.toLowerCase();
    if (lowText.includes('burst')) icon = 'zap';
    else if (lowText.includes('fast-match')) icon = 'zap';
    else if (lowText.includes('valid')) icon = 'shield-check';
    else if (lowText.includes('found')) icon = 'check-circle';
    else if (lowText.includes('captured')) icon = 'database';

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
    callIdDisplay.textContent = `ID: ${currentCallId}`;
    addMessage('agent', data.say);
    updateVariables(currentSession);
    refreshHistory();

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
        addMessage('system', 'Previous session expired. Starting new conversation.');
        currentCallId = data.callId;
        callIdDisplay.textContent = `ID: ${currentCallId}`;
        setupRealtimeEvents(currentCallId);
    }

    if (data.say) addMessage('agent', data.say);
    if (data.session) updateVariables(data.session);
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
            callIdDisplay.textContent = `ID: ${currentCallId}`;
            updateVariables(currentSession);
            setupRealtimeEvents(currentCallId);

            // Fetch historical logs to backfill chat window
            backfillLogs(currentCallId);
        };
        historyList.appendChild(div);

        // Auto-select if nothing selected OR if there is an active call we aren't currently viewing
        if (!currentCallId || (call.call_outcome === 'in_progress' && !isVoiceCall)) {
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

    div.innerHTML = `
        <div class="px-5 py-3 border backdrop-blur-sm max-w-[85%] ${bubbleClasses[role]} shadow-sm">
            <p class="text-sm leading-relaxed">${text}</p>
        </div>
        <span class="text-[9px] uppercase tracking-widest text-slate-400 font-bold px-1">${role}</span>
    `;

    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateVariables(session) {
    const targets = [
        { key: 'name_spoken', label: 'Name', icon: 'user' },
        { key: 'interest_in_meesho', label: 'Interest', icon: 'check-circle' },
        { key: 'has_bank_account', label: 'Bank Account?', icon: 'credit-card' },
        { key: 'products_sold', label: 'Category', icon: 'package' },
        { key: 'price_min', label: 'Price Range', icon: 'indian-rupee', format: (s) => (s.price_min && s.price_max) ? `₹${s.price_min}-${s.price_max}` : (s.price_min ? `₹${s.price_min}+` : null) },
        { key: 'listing_start', label: 'Ready By', icon: 'calendar' },
        { key: 'email', label: 'Email', icon: 'mail' },
        { key: 'gstin', label: 'GST', icon: 'shield-check' }
    ];

    sessionVariables.innerHTML = '';
    targets.forEach(target => {
        let val = target.format ? target.format(session) : session[target.key];
        const isCaptured = val !== undefined && val !== null && val !== '' && val !== 'unknown' && val !== false && (Array.isArray(val) ? val.length > 0 : true);

        // Determine "Syncing" state
        let isSyncing = false;
        if (target.key === 'email' && session.bg_email_running) isSyncing = true;
        if (target.key === 'gstin' && session.bg_gst_running) isSyncing = true;
        if (target.key === 'listing_start' && session.bg_listing_running) isSyncing = true;
        if (target.key === 'price_min' && session.bg_price_running) isSyncing = true;

        const div = document.createElement('div');
        div.className = `variable-card col-span-1 p-2 rounded-xl flex items-center gap-2 group ${isCaptured ? 'captured' : 'opacity-40'}`;

        let displayVal = isSyncing ? 'Syncing...' : '--';
        if (isCaptured) {
            const rawVal = Array.isArray(val) ? val[0] : val;
            displayVal = rawVal.toString().length > 15 ? rawVal.toString().substring(0, 13) + '..' : rawVal;
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
    startNewSession();
};

triggerCallBtn.onclick = async () => {
    const phoneNumber = outboundPhoneInput.value.trim();
    if (!phoneNumber) {
        alert('Please enter a phone number (+91...)');
        return;
    }

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

// Start
startNewSession();
setInterval(refreshHistory, 5000);
