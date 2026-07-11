/**
 * auth.js — модуль аутентификации, сессий, шейринга и серверных дашбордов
 *
 * Экспортирует функции, которые events_server.js вызывает по ходу обработки
 * HTTP-запросов. Не зависит от внешних пакетов — только node:crypto + better-sqlite3
 * (та же DB, что у основного сервера).
 *
 * Схема:
 *   sources      — PIN, salt, failed_attempts, locked_until
 *   sessions     — хеш токена (raw-токен никогда не пишется), src, expires_at
 *   dashboards   — id, src, name, panels_json, layout_mode
 *   public_shares — share_id, dashboard_id, src, revoked
 */
const crypto = require('node:crypto');

// ── Настройки ──────────────────────────────────────
const PIN_MAX_ATTEMPTS  = 5;                    // после 5 неверных — лок
const PIN_LOCKOUT_MS    = 15 * 60 * 1000;       // 15 минут
const SESSION_TTL_MS    = 30 * 24 * 60 * 60 * 1000; // 30 дней
const SESSION_TOKEN_LEN = 32;                   // 64 hex символа
const IDENT_RE          = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const PIN_RE            = /^\d{4}$/;

// ── IP-based rate limiting для /auth/login ─────────
const LOGIN_RATE_LIMIT    = 10;                  // максимум попыток
const LOGIN_RATE_WINDOW   = 5 * 60 * 1000;       // за 5 минут с одного IP
const LOGIN_RATE_MAP      = new Map();           // ip → number[]

function checkLoginRateLimit(ip) {
  if (!ip) return { ok: true };
  const now = Date.now();
  const cutoff = now - LOGIN_RATE_WINDOW;
  const arr = (LOGIN_RATE_MAP.get(ip) || []).filter(t => t > cutoff);
  if (arr.length >= LOGIN_RATE_LIMIT) {
    const oldest = arr[0];
    const remainSec = Math.ceil((oldest + LOGIN_RATE_WINDOW - now) / 1000);
    LOGIN_RATE_MAP.set(ip, arr);
    return { ok: false, remainSec };
  }
  arr.push(now);
  LOGIN_RATE_MAP.set(ip, arr);
  return { ok: true };
}

// Периодическая очистка устаревших IP-записей (раз в 10 минут)
setInterval(() => {
  const cutoff = Date.now() - LOGIN_RATE_WINDOW;
  for (const [ip, arr] of LOGIN_RATE_MAP.entries()) {
    const filtered = arr.filter(t => t > cutoff);
    if (filtered.length === 0) {
      LOGIN_RATE_MAP.delete(ip);
    } else {
      LOGIN_RATE_MAP.set(ip, filtered);
    }
  }
}, 10 * 60 * 1000);

// ── Хеширование PIN ────────────────────────────────
function hashPin(pin, salt) {
  return crypto.scryptSync(pin, salt, 64).toString('hex');
}
function genSalt() {
  return crypto.randomBytes(16).toString('hex');
}
function genSessionToken() {
  return crypto.randomBytes(SESSION_TOKEN_LEN).toString('hex');
}
function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
function genShareId() {
  // 10 символов base36 = ~52 бита энтропии, человекочитаемо
  return crypto.randomBytes(8).toString('base64')
    .replace(/[+/=]/g, '').slice(0, 10).toLowerCase();
}

// ── Инициализация таблиц ───────────────────────────
function initAuthTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      src              TEXT PRIMARY KEY,
      pin_hash         TEXT NOT NULL,
      pin_salt         TEXT NOT NULL,
      failed_attempts  INTEGER DEFAULT 0,
      locked_until     TEXT,
      created_at       TEXT NOT NULL,
      last_login_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_hash  TEXT PRIMARY KEY,
      src           TEXT NOT NULL REFERENCES sources(src),
      created_at    TEXT NOT NULL,
      expires_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_src ON sessions(src);

    CREATE TABLE IF NOT EXISTS dashboards (
      id           TEXT PRIMARY KEY,
      src          TEXT NOT NULL REFERENCES sources(src),
      name         TEXT NOT NULL,
      panels_json  TEXT NOT NULL,
      layout_mode  TEXT DEFAULT 'grid',
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dashboards_src ON dashboards(src);

    CREATE TABLE IF NOT EXISTS public_shares (
      share_id     TEXT PRIMARY KEY,
      dashboard_id TEXT NOT NULL REFERENCES dashboards(id),
      src          TEXT NOT NULL REFERENCES sources(src),
      created_at   TEXT NOT NULL,
      revoked      INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_shares_dashboard ON public_shares(dashboard_id);
    CREATE INDEX IF NOT EXISTS idx_shares_src ON public_shares(src);
  `);
}

// ── Lockout ────────────────────────────────────────
function checkLockout(srcRow) {
  if (!srcRow) return { ok: false, reason: 'no_such_src' };
  if (srcRow.locked_until) {
    const lockedUntilMs = new Date(srcRow.locked_until).getTime();
    if (lockedUntilMs > Date.now()) {
      const remainSec = Math.ceil((lockedUntilMs - Date.now()) / 1000);
      return { ok: false, reason: 'locked', lockedUntil: srcRow.locked_until, remainSec };
    }
  }
  return { ok: true };
}

function recordFailedAttempt(db, src) {
  const row = db.prepare('SELECT failed_attempts FROM sources WHERE src = ?').get(src);
  if (!row) return;
  const attempts = (row.failed_attempts || 0) + 1;
  if (attempts >= PIN_MAX_ATTEMPTS) {
    const lockedUntil = new Date(Date.now() + PIN_LOCKOUT_MS).toISOString();
    db.prepare('UPDATE sources SET failed_attempts = 0, locked_until = ? WHERE src = ?')
      .run(lockedUntil, src);
  } else {
    db.prepare('UPDATE sources SET failed_attempts = ? WHERE src = ?')
      .run(attempts, src);
  }
}

function resetFailedAttempts(db, src) {
  db.prepare('UPDATE sources SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE src = ?')
    .run(new Date().toISOString(), src);
}

// ── Сессии ────────────────────────────────────────
function createSession(db, src) {
  const token = genSessionToken();
  const sessionHash = hashSessionToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.prepare('INSERT INTO sessions (session_hash, src, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sessionHash, src, now.toISOString(), expiresAt.toISOString());
  return { token, expiresAt };
}

function resolveSession(db, token) {
  if (!token) return null;
  const sessionHash = hashSessionToken(token);
  const row = db.prepare(`
    SELECT s.session_hash, s.src, s.expires_at
    FROM sessions s WHERE s.session_hash = ?
  `).get(sessionHash);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE session_hash = ?').run(sessionHash);
    return null;
  }
  return { src: row.src, expiresAt: row.expires_at };
}

function deleteSession(db, token) {
  if (!token) return;
  const sessionHash = hashSessionToken(token);
  db.prepare('DELETE FROM sessions WHERE session_hash = ?').run(sessionHash);
}

function deleteSessionsForSrc(db, src) {
  db.prepare('DELETE FROM sessions WHERE src = ?').run(src);
}

// ── Регистрация / логин ───────────────────────────
function registerSrc(db, src, pin) {
  if (!IDENT_RE.test(src)) return { ok: false, code: 400, error: 'invalid_src' };
  if (!PIN_RE.test(pin)) return { ok: false, code: 400, error: 'invalid_pin' };
  const existing = db.prepare('SELECT src FROM sources WHERE src = ?').get(src);
  if (existing) return { ok: false, code: 409, error: 'src_taken' };

  const salt = genSalt();
  const pinHash = hashPin(pin, salt);
  const now = new Date().toISOString();

  // Дефолтный дашборд «Основной» с панелью логов на всю ширину
  const defaultPanels = [
    {
      id: 'panel_' + crypto.randomBytes(8).toString('hex'),
      title: 'Лог всех событий',
      viz: 'logs',
      type: '',
      group: 'raw',
      field: '',
      agg: 'count',
      aggfield: '',
      range: '24h',
      width: 12,
      autorefresh: 10
    }
  ];

  // Создаём источник и первый дашборд в одной транзакции
  const dashboardId = 'db_' + crypto.randomBytes(8).toString('hex');
  db.transaction(() => {
    db.prepare('INSERT INTO sources (src, pin_hash, pin_salt, created_at) VALUES (?, ?, ?, ?)')
      .run(src, pinHash, salt, now);
    db.prepare(`
      INSERT INTO dashboards (id, src, name, panels_json, layout_mode, created_at, updated_at)
      VALUES (?, ?, 'Основной', ?, 'grid', ?, ?)
    `).run(dashboardId, src, JSON.stringify(defaultPanels), now, now);
  })();

  const session = createSession(db, src);
  return { ok: true, code: 200, session, src };
}

function loginSrc(db, src, pin) {
  if (!IDENT_RE.test(src)) return { ok: false, code: 400, error: 'invalid_src' };
  if (!PIN_RE.test(pin)) return { ok: false, code: 400, error: 'invalid_pin' };

  const srcRow = db.prepare('SELECT * FROM sources WHERE src = ?').get(src);
  if (!srcRow) return { ok: false, code: 404, error: 'no_such_src' };

  const lockout = checkLockout(srcRow);
  if (!lockout.ok) {
    return { ok: false, code: 423, error: 'locked', lockedUntil: lockout.lockedUntil, remainSec: lockout.remainSec };
  }

  const candidate = hashPin(pin, srcRow.pin_salt);
  if (candidate !== srcRow.pin_hash) {
    recordFailedAttempt(db, src);
    return { ok: false, code: 401, error: 'wrong_pin' };
  }

  resetFailedAttempts(db, src);
  const session = createSession(db, src);
  return { ok: true, code: 200, session, src };
}

// ── Token из запроса ──────────────────────────────
function extractToken(req) {
  // 1. Authorization: Bearer <token>
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  // 2. ?token= query
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const t = url.searchParams.get('token');
    if (t) return t.trim();
  } catch (_) {}
  return null;
}

// ── Дашборды ───────────────────────────────────────
function listDashboards(db, src) {
  return db.prepare(`
    SELECT id, src, name, panels_json, layout_mode, created_at, updated_at
    FROM dashboards WHERE src = ? ORDER BY created_at ASC
  `).all(src).map(rowToDashboard);
}

function getDashboard(db, id) {
  const row = db.prepare(`
    SELECT id, src, name, panels_json, layout_mode, created_at, updated_at
    FROM dashboards WHERE id = ?
  `).get(id);
  return row ? rowToDashboard(row) : null;
}

function rowToDashboard(row) {
  let panels = [];
  try { panels = JSON.parse(row.panels_json); } catch (_) { panels = []; }
  return {
    id: row.id,
    src: row.src,
    name: row.name,
    panels,
    layoutMode: row.layout_mode === 'canvas' ? true : (row.layout_mode === 'grid' ? false : true),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createDashboard(db, src, name, panels, layoutMode) {
  const id = 'db_' + crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  const lm = layoutMode ? 'canvas' : 'grid';
  db.prepare(`
    INSERT INTO dashboards (id, src, name, panels_json, layout_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, src, name || 'Основной', JSON.stringify(panels || []), lm, now, now);
  return getDashboard(db, id);
}

function updateDashboard(db, id, src, fields) {
  const existing = getDashboard(db, id);
  if (!existing) return { ok: false, code: 404, error: 'not_found' };
  if (existing.src !== src) return { ok: false, code: 403, error: 'forbidden' };

  const name = fields.name !== undefined ? String(fields.name) : existing.name;
  const panels = fields.panels !== undefined ? fields.panels : existing.panels;
  const layoutMode = fields.layoutMode !== undefined
    ? (fields.layoutMode ? 'canvas' : 'grid')
    : (existing.layoutMode ? 'canvas' : 'grid');

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE dashboards SET name = ?, panels_json = ?, layout_mode = ?, updated_at = ?
    WHERE id = ?
  `).run(name, JSON.stringify(panels), layoutMode, now, id);

  return { ok: true, code: 200, dashboard: getDashboard(db, id) };
}

function deleteDashboard(db, id, src) {
  const existing = getDashboard(db, id);
  if (!existing) return { ok: false, code: 404, error: 'not_found' };
  if (existing.src !== src) return { ok: false, code: 403, error: 'forbidden' };
  // Каскадно отзываем все публичные ссылки на этот дашборд
  db.prepare('UPDATE public_shares SET revoked = 1 WHERE dashboard_id = ?').run(id);
  db.prepare('DELETE FROM dashboards WHERE id = ?').run(id);
  return { ok: true, code: 200 };
}

// ── Публичные ссылки ──────────────────────────────
function createShare(db, dashboardId, src) {
  const db1 = getDashboard(db, dashboardId);
  if (!db1) return { ok: false, code: 404, error: 'not_found' };
  if (db1.src !== src) return { ok: false, code: 403, error: 'forbidden' };

  // Если уже есть активная (не отозванная) ссылка на этот дашборд — возвращаем её
  const existing = db.prepare(
    'SELECT share_id FROM public_shares WHERE dashboard_id = ? AND revoked = 0'
  ).get(dashboardId);
  if (existing) {
    return { ok: true, code: 200, shareId: existing.share_id, dashboard: db1, reused: true };
  }

  // Генерируем уникальный share_id (с защитой от коллизий)
  let shareId;
  for (let i = 0; i < 5; i++) {
    shareId = genShareId();
    const exists = db.prepare('SELECT 1 FROM public_shares WHERE share_id = ?').get(shareId);
    if (!exists) break;
    shareId = null;
  }
  if (!shareId) return { ok: false, code: 500, error: 'share_id_collision' };

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO public_shares (share_id, dashboard_id, src, created_at, revoked)
    VALUES (?, ?, ?, ?, 0)
  `).run(shareId, dashboardId, src, now);

  return { ok: true, code: 200, shareId, dashboard: db1, reused: false };
}

// ── Перегенерация ссылки: отзывает все старые, создаёт новую ──
function regenerateShare(db, dashboardId, src) {
  const db1 = getDashboard(db, dashboardId);
  if (!db1) return { ok: false, code: 404, error: 'not_found' };
  if (db1.src !== src) return { ok: false, code: 403, error: 'forbidden' };

  // Отзываем все существующие ссылки на этот дашборд
  db.prepare('UPDATE public_shares SET revoked = 1 WHERE dashboard_id = ? AND revoked = 0')
    .run(dashboardId);

  // Создаём новую
  let shareId;
  for (let i = 0; i < 5; i++) {
    shareId = genShareId();
    const exists = db.prepare('SELECT 1 FROM public_shares WHERE share_id = ?').get(shareId);
    if (!exists) break;
    shareId = null;
  }
  if (!shareId) return { ok: false, code: 500, error: 'share_id_collision' };

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO public_shares (share_id, dashboard_id, src, created_at, revoked)
    VALUES (?, ?, ?, ?, 0)
  `).run(shareId, dashboardId, src, now);

  return { ok: true, code: 200, shareId, dashboard: db1 };
}

function revokeShare(db, shareId, src) {
  const row = db.prepare('SELECT * FROM public_shares WHERE share_id = ?').get(shareId);
  if (!row) return { ok: false, code: 404, error: 'not_found' };
  if (row.src !== src) return { ok: false, code: 403, error: 'forbidden' };
  if (row.revoked) return { ok: true, code: 200, alreadyRevoked: true };
  db.prepare('UPDATE public_shares SET revoked = 1 WHERE share_id = ?').run(shareId);
  return { ok: true, code: 200 };
}

function resolveShare(db, shareId) {
  const row = db.prepare(`
    SELECT s.share_id, s.dashboard_id, s.src, s.revoked, s.created_at,
           d.name, d.panels_json, d.layout_mode
    FROM public_shares s
    JOIN dashboards d ON d.id = s.dashboard_id
    WHERE s.share_id = ?
  `).get(shareId);
  if (!row) return { ok: false, code: 404, error: 'not_found' };
  if (row.revoked) return { ok: false, code: 410, error: 'revoked' };
  let panels = [];
  try { panels = JSON.parse(row.panels_json); } catch (_) { panels = []; }
  return {
    ok: true,
    code: 200,
    share: {
      shareId: row.share_id,
      dashboardId: row.dashboard_id,
      src: row.src,
      createdAt: row.created_at,
    },
    dashboard: {
      name: row.name,
      panels,
      layoutMode: row.layout_mode === 'canvas',
    },
  };
}

// ── HTTP-хелперы ──────────────────────────────────
function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

async function readJsonBody(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        req.destroy();
        reject(new Error('body timeout'));
      }
    }, 10000); // 10 сек — защита от Slowloris

    req.on('data', c => {
      size += c.length;
      if (size > max) {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          req.destroy();
          reject(new Error('body too large'));
        }
        return;
      }
      body += c;
    });
    req.on('end', () => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        if (!body) return resolve({});
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('invalid json')); }
      }
    });
    req.on('error', e => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        reject(e);
      }
    });
  });
}

module.exports = {
  // хеширование и токены
  hashPin, genSalt, genSessionToken, hashSessionToken, genShareId,
  // сессии
  createSession, resolveSession, deleteSession, deleteSessionsForSrc, extractToken,
  // auth
  initAuthTables, registerSrc, loginSrc, checkLockout, recordFailedAttempt, resetFailedAttempts,
  checkLoginRateLimit,
  // dashboards
  listDashboards, getDashboard, createDashboard, updateDashboard, deleteDashboard,
  // shares
  createShare, regenerateShare, revokeShare, resolveShare,
  // http helpers
  json, readJsonBody,
  // реекспорт регексов для удобства
  IDENT_RE, PIN_RE,
};
