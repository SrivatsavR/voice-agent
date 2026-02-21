let currentCallId = null;
let currentSession = {};
let lastRenderedLogCount = 0;
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

// --- API Functions ---
async function api(path, options = {}) {
    const res = await fetch(path, {
        method: options.method || 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: options.body ? JSON.stringify(options.body) : undefined
    });
    return res.json();
}

async function startNewSession() {
    const data = await api('/api/chat', { method: 'POST', body: {} });
    currentCallId = data.callId;
    currentSession = data.session || {};
    isVoiceCall = false;
    lastRenderedLogCount = 0;

    chatMessages.innerHTML = '';
    callIdDisplay.textContent = `ID: ${currentCallId}`;
    addMessage('agent', data.say);
    updateVariables(currentSession);
    refreshHistory();
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
                <span class="text-[10px] font-bold text-white/30 truncate">${call.callId}</span>
                <span class="text-[10px] text-white/40">${timestamp}</span>
            </div>
            <div class="font-semibold text-sm text-white/90 truncate">${call.preferred_name || call.name_spoken || 'Anonymous'}</div>
            <div class="flex justify-between items-center">
                <span class="text-[10px] text-white/20 truncate">${call.caller_phone || 'Web Test'}</span>
                <span class="text-[9px] uppercase font-bold tracking-tighter ${color}">${outcome.replace('TERM_', '')}</span>
            </div>
        `;

        div.onclick = () => {
            currentCallId = call.callId;
            currentSession = call;
            isVoiceCall = (call.caller_phone && call.caller_phone !== 'chat-user');
            lastRenderedLogCount = 0;
            chatMessages.innerHTML = '';
            callIdDisplay.textContent = `ID: ${currentCallId}`;
            updateVariables(currentSession);
            div.classList.add('bg-white/10', 'border-indigo-500/50');
        };
        historyList.appendChild(div);

        // Auto-select if nothing selected or if this is an active call and we were idle
        if (!currentCallId || (call.call_outcome === 'in_progress' && !currentCallId.startsWith('c-'))) {
            if (!currentCallId || call.call_outcome === 'in_progress') {
                div.onclick();
            }
        }
    });
}

function stripAnsi(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = `flex flex-col gap-1.5 ${role === 'user' ? 'items-end' : 'items-start'}`;

    const bubbleClasses = {
        'user': 'bg-white/10 border-white/10 text-white rounded-2xl rounded-tr-none ml-auto',
        'agent': 'bg-indigo-600/10 border-indigo-500/20 text-indigo-100 rounded-2xl rounded-tl-none',
        'system': 'bg-red-500/10 border-red-500/20 text-red-100 italic rounded-lg text-[11px]'
    };

    div.innerHTML = `
        <div class="px-5 py-3 border backdrop-blur-sm max-w-[85%] ${bubbleClasses[role]} shadow-sm">
            <p class="text-sm leading-relaxed">${text}</p>
        </div>
        <span class="text-[9px] uppercase tracking-widest text-white/20 font-bold px-1">${role}</span>
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
        { key: 'listing_start', label: 'Ready By', icon: 'calendar' },
        { key: 'email', label: 'Email', icon: 'mail' },
        { key: 'gstin', label: 'GST', icon: 'shield-check' }
    ];

    sessionVariables.innerHTML = '';
    targets.forEach(target => {
        let val = session[target.key];
        const isCaptured = val !== undefined && val !== null && val !== '' && val !== 'unknown' && val !== false && (Array.isArray(val) ? val.length > 0 : true);

        const div = document.createElement('div');
        div.className = `variable-card col-span-1 p-2 rounded-xl flex items-center gap-2 group ${isCaptured ? 'captured' : 'opacity-40'}`;

        if (Array.isArray(val)) val = val[0]; // Compact
        const displayVal = isCaptured ? (val.toString().length > 12 ? val.toString().substring(0, 10) + '..' : val) : '--';

        div.innerHTML = `
            <div class="p-1.5 rounded-lg ${isCaptured ? 'bg-emerald-500/20 text-emerald-400' : 'bg-white/5 text-white/20'} shrink-0">
                <i data-lucide="${target.icon}" class="w-3 h-3"></i>
            </div>
            <div class="min-w-0">
                <div class="text-[8px] uppercase font-bold text-white/30 truncate">${target.label}</div>
                <div class="text-[10px] font-bold ${isCaptured ? 'text-white/90' : 'text-white/10'} truncate">${displayVal}</div>
            </div>
        `;
        sessionVariables.appendChild(div);
    });

    lucide.createIcons();
}

async function pollUpdates() {
    if (!currentCallId) return;

    try {
        const logs = await api(`/api/logs/${currentCallId}`);
        if (logs.length > lastRenderedLogCount) {
            for (let i = lastRenderedLogCount; i < logs.length; i++) {
                const entry = logs[i];
                if (isVoiceCall) {
                    if (entry.component === 'Agent') {
                        let txt = stripAnsi(entry.message || '');
                        if (txt.startsWith('Welcome: ')) txt = txt.replace('Welcome: ', '');
                        addMessage('agent', txt);
                    } else if (entry.component === 'User') {
                        addMessage('user', stripAnsi(entry.message));
                    } else if (entry.component === 'Database' && entry.message === 'Saving session updates' && (entry.data?.updates || entry.updates)) {
                        const updates = entry.data?.updates || entry.updates;
                        Object.assign(currentSession, updates);
                        updateVariables(currentSession);
                    }
                }
            }
            lastRenderedLogCount = logs.length;
        }
    } catch (e) { }

    setTimeout(pollUpdates, 1500);
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
pollUpdates();
setInterval(refreshHistory, 5000);
