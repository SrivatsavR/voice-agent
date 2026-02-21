
let currentCallId = null;
let currentSession = {};

// Initialize Lucide icons
lucide.createIcons();

// --- DOM Elements ---
const chatMessages = document.getElementById('chat-messages');
const chatForm = document.getElementById('chat-form');
const userInput = document.getElementById('user-input');
const sessionVariables = document.getElementById('session-variables');
const logContent = document.getElementById('log-content');
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

    callIdDisplay.textContent = `Live Session: ${currentCallId}`;
    addMessage('agent', data.say);
    updateVariables(currentSession);
    refreshHistory();
    pollLogs();
}

async function sendMessage(text) {
    addMessage('user', text);
    const data = await api('/api/chat', {
        method: 'POST',
        body: { text, callId: currentCallId }
    });

    if (data.wasExpired) {
        addMessage('system', 'Previous session expired. Starting new conversation.');
        currentCallId = data.callId;
    }

    if (data.say) {
        addMessage('agent', data.say);
    }

    if (data.session) {
        updateVariables(data.session);
    }
}

async function refreshHistory() {
    const history = await api('/api/history');
    historyList.innerHTML = '<div class="text-xs uppercase tracking-widest text-white/40 font-semibold px-2 mb-2">Last 5 Calls</div>';

    history.slice(0, 5).forEach(call => {
        const div = document.createElement('div');
        div.className = 'p-4 bg-white/5 border border-white/10 rounded-xl hover:bg-white/10 transition-all cursor-pointer group';
        div.innerHTML = `
            <div class="flex justify-between items-start mb-1 text-xs text-white/40">
                <span>${new Date(call.timestamp).toLocaleTimeString()}</span>
                <span class="px-2 py-0.5 rounded bg-white/5 font-mono text-[9px] uppercase">${call.call_outcome || 'incomplete'}</span>
            </div>
            <div class="font-medium text-sm text-white/80">${call.preferred_name || call.name_spoken || 'Anonymous Seller'}</div>
            <div class="text-[10px] text-white/30 truncate">${call.caller_phone || 'External Call'}</div>
        `;
        div.onclick = () => location.reload(); // Quick way to reset and view history
        historyList.appendChild(div);
    });
}

function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = `flex flex-col gap-2 ${role === 'user' ? 'items-end' : 'max-w-[80%]'}`;

    const colors = {
        'user': 'bg-white/10 border-white/10 text-white ml-auto',
        'agent': 'bg-indigo-600/20 border-indigo-500/20 text-indigo-100',
        'system': 'bg-red-500/10 border-red-500/20 text-red-100 italic'
    };

    div.innerHTML = `
        <div class="p-4 rounded-2xl border ${colors[role]} ${role === 'user' ? 'rounded-tr-none' : 'rounded-tl-none'}">
            <p>${text}</p>
        </div>
        <span class="text-[10px] text-white/20 ${role === 'user' ? 'mr-1' : 'ml-1'}">${role.toUpperCase()}</span>
    `;

    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateVariables(session) {
    // Define all target variables to show in the UI
    const targets = [
        { key: 'name_spoken', label: 'Seller Name', icon: 'user' },
        { key: 'interest_in_meesho', label: 'Interest', icon: 'check-circle' },
        { key: 'has_bank_account', label: 'Bank Account', icon: 'credit-card' },
        { key: 'products_sold', label: 'Category', icon: 'package' },
        { key: 'price_min', label: 'Min Price', icon: 'tag' },
        { key: 'price_max', label: 'Max Price', icon: 'tag' },
        { key: 'email', label: 'Email ID', icon: 'mail' },
        { key: 'gstin', label: 'GST Number', icon: 'shield-check' }
    ];

    sessionVariables.innerHTML = '';
    targets.forEach(target => {
        const val = session[target.key];
        const isCaptured = val !== undefined && val !== null && val !== '' && val !== 'unknown' && val !== false && (Array.isArray(val) ? val.length > 0 : true);

        const div = document.createElement('div');
        div.className = `variable-item p-4 border rounded-2xl transition-all duration-500 flex items-center gap-4 ${isCaptured
            ? 'bg-emerald-500/10 border-emerald-500/30'
            : 'bg-white/[0.02] border-white/5 opacity-50'
            }`;

        div.innerHTML = `
            <div class="p-2 rounded-lg ${isCaptured ? 'bg-emerald-500/20 text-emerald-400' : 'bg-white/5 text-white/20'}">
                <i data-lucide="${target.icon}" class="w-4 h-4"></i>
            </div>
            <div class="flex-1">
                <div class="text-[10px] uppercase tracking-wider text-white/30 font-bold">${target.label}</div>
                <div class="text-sm font-medium ${isCaptured ? 'text-emerald-100' : 'text-white/10 italic'}">
                    ${isCaptured ? (Array.isArray(val) ? val.join(', ') : val) : 'Pending...'}
                </div>
            </div>
            ${(target.key === 'gstin' && session.gstin_valid) ? '<div class="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-[9px] font-bold border border-emerald-500/30 uppercase mr-2">Verified</div>' : ''}
            ${isCaptured ? '<div class="w-2 h-2 bg-emerald-500 rounded-full shadow-[0_0_8px_rgba(16,185,129,0.5)]"></div>' : ''}
        `;
        sessionVariables.appendChild(div);
    });

    lucide.createIcons();

    if (sessionVariables.children.length === 0) {
        sessionVariables.innerHTML = '<div class="text-center py-20 opacity-20"><i data-lucide="layers" class="w-12 h-12 mx-auto mb-4"></i><p>Waiting for data...</p></div>';
        lucide.createIcons();
    }
}

async function pollLogs() {
    if (!currentCallId) return;

    try {
        const logs = await api(`/api/logs/${currentCallId}`);
        logContent.innerHTML = '';
        logs.forEach(entry => {
            const div = document.createElement('div');
            div.className = `log-entry log-${entry.level}`;
            const time = entry.timestamp ? entry.timestamp.split('T')[1].split('.')[0] : '--:--:--';

            let extra = '';
            if (entry.message && entry.message.includes('Generated embedding vector')) {
                // Formatting embedding for user
                extra = `<div class="embedding-peek font-mono">Vector: [${entry.data.join(', ')}...]</div>`;
            } else if (entry.message && entry.message.includes('Retrieved') && Array.isArray(entry.data)) {
                // Formatting retrieved chunks
                extra = entry.data.map(snip => `
                    <div class="mt-2 p-2 bg-indigo-500/10 border border-indigo-500/20 rounded-lg text-[10px] text-indigo-200/70 italic">
                        "${snip.substring(0, 200)}${snip.length > 200 ? '...' : ''}"
                    </div>
                `).join('');
            } else if (entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data)) {
                extra = `<div class="text-[9px] text-white/20 font-mono ml-2 mt-0.5">${JSON.stringify(entry.data)}</div>`;
            }

            div.innerHTML = `<span class="opacity-30 mr-2">[${time}]</span><span class="font-bold opacity-60 mr-2">[${entry.component}]</span> ${entry.message}${extra}`;
            logContent.appendChild(div);
        });

        if (logs.length > 0) {
            const logsTab = document.getElementById('logs-tab');
            if (!logsTab.classList.contains('hidden')) {
                logsTab.scrollTop = logsTab.scrollHeight;
            }
        }
    } catch (e) { console.error('Log polling failed', e); }

    setTimeout(pollLogs, 2000);
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
    triggerCallBtn.innerHTML = '<i data-lucide="loader" class="w-4 h-4 animate-spin"></i> Calling...';
    lucide.createIcons();

    try {
        const data = await api('/api/outbound', {
            method: 'POST',
            body: { phoneNumber }
        });

        if (data.success) {
            addMessage('system', `Outbound call triggered! SID: ${data.callSid}`);
            // Wait a bit then refresh history
            setTimeout(refreshHistory, 5000);
        } else {
            addMessage('system', `Error: ${data.error}`);
        }
    } catch (e) {
        addMessage('system', `Failed to trigger call: ${e.message}`);
    } finally {
        triggerCallBtn.disabled = false;
        triggerCallBtn.innerHTML = '<i data-lucide="phone" class="w-4 h-4"></i> Call';
        lucide.createIcons();
    }
};

// --- Tabs ---
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => {
        document.querySelectorAll('.tab-btn').forEach(b => {
            b.classList.remove('active', 'border-indigo-500');
            b.classList.add('text-white/40', 'border-transparent');
        });
        btn.classList.add('active', 'border-indigo-500');
        btn.classList.remove('text-white/40', 'border-transparent');

        const tab = btn.dataset.tab;
        document.getElementById('variables-tab').className = tab === 'variables' ? 'flex-1 overflow-y-auto p-6 space-y-6' : 'hidden';
        document.getElementById('logs-tab').className = tab === 'logs' ? 'flex-1 overflow-y-auto p-0' : 'hidden';
    };
});

// Start
startNewSession();
