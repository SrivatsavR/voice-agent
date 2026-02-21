
const history = [];
const MAX_HISTORY = 10;

export function getHistory() {
    return history;
}

export function saveToHistory(session) {
    history.unshift({ ...session, timestamp: new Date().toISOString() });
    if (history.length > MAX_HISTORY) history.pop();
}
