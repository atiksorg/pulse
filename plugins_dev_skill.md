---
name: pulse-plugin-dev
description: Используй этот скилл, когда нужно создать, изменить или отладить плагин для Pulse (аналитическая платформа: SQLite + better-sqlite3, ванильный JS фронтенд без сборщиков). Триггеры — любые запросы вида "создай плагин для Pulse", "добавь фичу X в дашборд Pulse", "плагин, который делает Y и шлёт в Telegram/email/API", упоминания plugins/*/index.js, PLUGIN_DIRS, alert_configs/report_configs-подобных таблиц.
---

# Разработка плагинов для Pulse

## 1. Ментальная модель

Pulse — это HTTP-сервер (`events_server.js`) + SQLite (better-sqlite3) + ванильный JS
фронтенд без сборщиков. Плагины — это **опциональные модули с тремя lifecycle-хуками**,
которые ядро вызывает по порядку при старте:

```
schema(db)             → создать/мигрировать свои таблицы
registerRoutes(server, db) → навесить свои HTTP-маршруты поверх общего http.Server
hooks(db)               → подписаться на события ядра (flush) + завести свои таймеры
```

Ядро НЕ знает деталей плагина. Плагин НЕ должен трогать чужие таблицы/маршруты
напрямую (кроме чтения `dashboards`/`sources`/`sessions` через `auth.js`).
Ошибка в одном плагине не должна ронять сервер и не должна ронять другие плагины.

Golden rule: **скопируй паттерн из `plugins/reports/`**, не изобретай новый.
Reports — эталонный плагин: конфиг на дашборд/панель + расписание + внешняя
отправка + история. 90% новых плагинов — вариация этой же схемы.

## 2. Структура файлов (обязательная)

```
plugins/<plugin-name>/
  index.js         — точка входа: schema/registerRoutes/hooks, ничего больше
  schema.js         — initXxxTables(db): CREATE TABLE + миграции (idempotent!)
  config-crud.js     — HTTP CRUD эндпоинтов (авторизация через auth.js)
  <core-logic>.js    — основная бизнес-логика (проверка/генерация/расчёт)
  <dispatch>.js       — отправка во внешний мир (Telegram/email/webhook/API)
  scheduler.js        — тиковый механизм (если плагину нужно расписание)

public/plugins/<plugin-name>/
  <name>-modal.js    — логика модалки (открыть/закрыть/загрузить/сохранить)
  <name>-ui.js         — инъекция HTML модалки в DOM + публичная точка входа
```

Общий код для нескольких плагинов — в `plugins/shared/` (уже есть
`http-client.js`, `schedule-utils.js`, `xml-builder.js`). Не дублируй — если
твоя логика похожа на существующую в shared, переиспользуй.

## 3. Регистрация плагина в реестре

Единственное изменение в существующем коде ядра:

```js
// plugins/index.js
const PLUGIN_DIRS = ['reports', 'panel-triggers', '<твой-плагин>'];
```

Порядок в массиве = порядок загрузки. Если плагин зависит от таблиц другого
плагина — ставь после него.

## 4. schema.js — правила

- Всегда `CREATE TABLE IF NOT EXISTS`.
- Миграции столбцов — через `PRAGMA table_info(table)` + `ALTER TABLE ADD COLUMN`,
  обёрнутые в try/catch с логом (см. `plugins/reports/schema.js` — эталон).
- Если правило привязано к сущности 1:1 (например, к панели) — добавь
  `UNIQUE INDEX`, создавай через `PRAGMA index_list` проверку (SQLite не
  поддерживает `CREATE UNIQUE INDEX IF NOT EXISTS`).
- Именование: `<plugin>_configs` (правила) + `<plugin>_history` (журнал
  срабатываний/отправок). Обязательные поля в configs: `id` (текст, префикс
  плагина, напр. `ac_...`), `dashboard_id`, `src`, `is_active`, `created_at`,
  `updated_at`. Обязательные в history: `config_id`, `ts`, `status`
  (`sent|error|skipped|done`), `error_message`.

## 5. config-crud.js — правила HTTP-слоя

- Подключается через `auth.js`: `extractToken(req)` → `resolveSession(db, token)`.
  401, если сессии нет.
- CORS-заголовки + `OPTIONS` → 204 в начале обработчика (скопируй один в один
  из `plugins/reports/config-crud.js`).
- Владение проверяй ВСЕГДА: `row.src !== session.src` → 403. Никогда не
  доверяй `dashboard_id`/`panel_id` из URL без проверки, что дашборд
  принадлежит текущей сессии (`auth.getDashboard(db, id)`).
- Секреты (боты, токены) — не отдавай в открытом виде в общем GET. Делай
  отдельный `sanitizeConfig()` (маскирует токен, показывает последние 4
  символа) для списков, и отдельный эндпоинт `/tokens` для формы редактирования
  (см. reports).
- Rate-limit ручных/тестовых действий (`POST .../test`) — не чаще раза в
  1–5 минут через `SELECT ... WHERE started_at > ?` на history-таблице.
- Валидацию тела запроса выноси в отдельную чистую функцию `validateConfig(body,
  isUpdate, existingRow)`, возвращающую `{ok: true, config}` или `{ok:false,
  error}`. Не бросай исключения — только явные коды ошибок.
- `INSERT ... ON CONFLICT(unique_col) DO UPDATE SET ...` — если у сущности
  UNIQUE-ограничение (защита от гонки двух параллельных PUT).

## 6. Бизнес-логика: как получить данные метрики/панели

Не обращайся к таблицам `events_YYYY_MM` напрольную — переиспользуй уже
готовый паттерн из `plugins/reports/xml-generator.js::queryPanelData` (или
скопируй урезанную версию под свою задачу, как сделано в
`metric-query.js` у `threshold-alerts`). Ключевые правила:

- Таблицы событий шардированы по месяцам (`events_YYYY_MM`), их список
  бери через `sqlite_master`, фильтруй по диапазону дат ДО запроса
  (`filterTablesByDate`), не читай все таблицы подряд.
- WHERE всегда начинается с `src = ?` — это чужие данные, никогда не мешай
  разных `src`.
- Поля из `payload` — только через `json_extract(payload, '$."field"')` с
  предварительной проверкой `IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/` —
  это защита от SQL-инъекции через имя поля (сам JSON-путь нельзя
  параметризовать через `?`).
- Фильтры (`eq/gt/lt/neq/contains/in`) — копируй блок из `queryPanelData`
  один в один, это уже отлаженный код.

## 7. Отправка во внешний мир

- HTTP — только через `plugins/shared/http-client.js` (`httpPost`,
  `pollUntilDone`). Не добавляй `axios`/`node-fetch` в зависимости — сервер
  работает на голом `https`/`http`.
- Для Telegram — `POST https://api.telegram.org/bot<token>/sendMessage`,
  `parse_mode: 'HTML'`, экранируй пользовательский текст вручную
  (`&`, `<`, `>`) — telegram HTML не прощает сырых тегов.
- Если получателей несколько (chat_id CSV, email CSV) — рассылай
  параллельно (`Promise.all`), не последовательно, и собирай частичный
  успех: `{ok: sent > 0, sent, total, errors: [...]}`. Одна неверная запись
  не должна ронять всю рассылку.
- Long-running задачи (генерация через внешний AI-API) — паттерн run+poll:
  запусти задачу, получи `task_id`, поллингом с интервалом (обычно 5–10 сек)
  и таймаутом (обычно 5–10 мин) дожидайся `status: done|error`. Ограничивай
  параллелизм отправок константой `MAX_PARALLEL` + своя очередь
  (`plugins/reports/dispatcher.js` — эталон).

## 8. Планировщик (если плагину нужно расписание)

- Один общий "тик" — не заводи `setInterval` на каждое правило. Планировщик
  раз в N секунд проходит по всем `is_active = 1` конфигам и для каждого
  сам решает, пора ли действовать.
- Дедупликация гонки между двумя тиками — атомарный
  `UPDATE ... SET last_sent_at = ? WHERE id = ? AND last_sent_at IS NOT
  DISTINCT FROM ?` (compare-and-swap). Если `changes === 0` — другой тик уже
  забрал это правило, пропускай.
- Если у правила есть состояние типа "было нарушение / нет" (алерты,
  триггеры) — используй state machine с cooldown, а не шли на каждый тик:
  `ok → breached` шлём, `breached → breached` молчим N минут (антиспам),
  `breached → ok` опционально шлём "восстановлено" (см. `checker.js` у
  threshold-alerts).
- Регистрируй проверку планировщика в `hooks(db)` ДВУМЯ путями одновременно:
  1) встраивайся в общий `global._pluginOnFlush` (не перезаписывай — оборачивай
     существующую функцию), чтобы ловить активность; 2) заводи fallback
     `setInterval`, чтобы расписание не завязло, если трафика нет.
  Защищайся от повторной регистрации хуков через `global._<plugin>HooksRegistered`.

## 9. Фронтенд (модалка настройки)

Паттерн: `<name>-ui.js` инъектирует HTML модалки в `document.body` один раз
(`if (document.getElementById('xxxModal')) return;`), экспортирует
`window.XxxUI.open(...)`. `<name>-modal.js` содержит всю логику
(`_loadConfig`, `_fillForm`, `_saveConfig`, `_sendTest`, `_loadHistory`,
`_init`), экспортирует `window.XxxModal = {open, close, bindEvents}`.

Обязательно:
- Все запросы — `fetch(API + '/...', {headers: authHeaders()})`, на 401 —
  `clearSession(); closeModal(); return;`.
- `escapeHtml()` при вставке пользовательских данных в innerHTML.
- Секретные поля — `type="password"` + кнопка-глазик (см. `.eye-btn`
  паттерн), не подставляй реальный токен в общий список конфигов.
- Подключение в `index.html`: два `<script>` рядом с уже существующими
  `plugins/reports/*` тегами, порядок — modal.js раньше ui.js? нет, наоборот:
  сначала modal.js (объявляет `window.XxxModal`), потом ui.js (использует его).
- Точка входа в UI дашборда — как правило, пункт в `panelMenuItems` (панель)
  или кнопка в тулбаре (дашборд целиком) — смотри на существующий массив
  `panelMenuItems` в `panels-render.js` и `bindPanelMenuActions` в
  `panels-edit.js`, добавляй туда новый `act`, не переписывай остальные.

## 10. Чек-лист перед тем как считать плагин готовым

- [ ] `PLUGIN_DIRS` обновлён
- [ ] `schema()` идемпотентен (повторный вызов на существующей БД не падает)
- [ ] Все HTTP-ручки проверяют сессию и владение (`src`)
- [ ] Секреты не текут в общих GET-ответах
- [ ] Есть rate-limit на тестовые/ручные действия
- [ ] Планировщик не спамит (cooldown/state machine) и не гонится (CAS-обновление)
- [ ] Внешние вызовы обёрнуты в try/catch, ошибка пишется в history, а не
      роняет процесс
- [ ] UI: 401 обрабатывается, токены маскируются, escapeHtml на месте
- [ ] Плагин не трогает файлы/таблицы других плагинов напрямую

## 11. Частые ошибки (не повторяй)

- Забыть `WHERE src = ?` в SQL — утечка данных между источниками.
- Хранить сырой bot_token в ответе `GET /list` — используй `sanitizeConfig`.
- `setInterval` без `checkAndDispatch...`-обёртки на каждый конфиг вместо
  одного общего тика — при 1000 правил это 1000 таймеров.
- Не проверять `IDENT_RE` на имени поля из `payload` перед вставкой в
  `json_extract` — потенциальная SQL-инъекция через имя поля.
- Синхронный `fs`/тяжёлые SQL в обработчике HTTP без try/catch — одна ошибка
  роняет весь `request`-listener (не забывай, что плагин подменяет
  `server.listeners('request')[0]`, ошибка в нём ломает вообще все роуты).
