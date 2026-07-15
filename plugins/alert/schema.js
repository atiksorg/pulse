const schema = `
CREATE TABLE IF NOT EXISTS alert_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dashboard_id TEXT NOT NULL,
    panel_id TEXT NOT NULL,
    title TEXT NOT NULL,
    condition_type TEXT NOT NULL, -- '>', '<', '=', 'no_data'
    threshold REAL,
    check_interval_sec INTEGER DEFAULT 60,
    pending_checks_required INTEGER DEFAULT 1, -- Anti-flapping
    
    -- FSM State
    state TEXT DEFAULT 'OK', -- 'OK', 'PENDING', 'FIRING', 'RESOLVED'
    pending_count INTEGER DEFAULT 0,
    
    -- Scheduling
    next_check_at INTEGER DEFAULT 0,
    
    -- Delivery Config (JSON)
    channels JSON NOT NULL, -- e.g. [{"type": "telegram", "bot_token": "...", "chat_id": "..."}]
    
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS alert_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER NOT NULL,
    state_from TEXT,
    state_to TEXT,
    metric_value REAL,
    phases JSON, -- Audit trail: [{"phase": "eval", "time": 123}, ...]
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY(rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS alert_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER,
    history_id INTEGER,
    is_test BOOLEAN DEFAULT 0,
    
    channel_type TEXT NOT NULL,
    channel_config JSON NOT NULL,
    message_text TEXT NOT NULL,
    
    status TEXT DEFAULT 'pending', -- 'pending', 'processing', 'retry', 'done', 'failed'
    attempts INTEGER DEFAULT 0,
    next_retry_at INTEGER DEFAULT 0,
    error_log TEXT,
    
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_next_check ON alert_rules(next_check_at);
CREATE INDEX IF NOT EXISTS idx_alert_queue_status ON alert_queue(status, next_retry_at);
`;

module.exports = {
    up: (db) => {
        db.exec(schema);
    }
};
