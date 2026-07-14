![Pulse](https://wl.atiks.org/helpers/pulse_ss.jpg)

# 📊 Pulse (Events Analytics)

Pulse — это минималистичный и сверхбыстрый сервис для сбора событий и построения дашбордов в реальном времени. Создан для разработчиков, которым нужна аналитика «здесь и сейчас», без сложной настройки баз данных, регистрации и тяжеловесных SDK.

Один HTTP-запрос для отправки события, два клика для создания красивого графика, бесконечный холст для компоновки дашборда, встроенный AI-помощник и скилл для ИИ-агентов.

---

## ✨ Ключевые возможности

- **Zero-Setup интеграция**: Отправляйте события простым `GET` или `POST` запросом. Не нужно создавать таблицы или схемы — база данных (SQLite) автоматически подстроится под ваш JSON payload.
- **Сверхбыстрый бэкенд**: Написан на чистом Node.js поверх `better-sqlite3`. Использует WAL-журналирование, шардирование таблиц по месяцам, адаптивную batch-запись в памяти и **Worker Threads** для тяжелых аналитических запросов (чтобы не блокировать прием событий).
- **Crash Recovery**: Встроенный WAL-буфер (`*.walbuf`) гарантирует, что события не потеряются даже при внезапном падении сервера до сброса буфера в БД.
- **8 типов визуализации**: Line, Bar, Pie, KPI, Gauge (индикатор), Heatmap (тепловая карта), Таблица (с поиском и сортировкой), Логи (с пагинацией).
- **Бесконечный холст (Infinite Canvas)**: Свободное позиционирование панелей с панорамированием (Space+drag / средняя кнопка мыши) и зумом (колесо мыши). Привязка к сетке 20px, drag & resize с dead zone.
- **AI-помощник по метрикам**: Опишите на русском «выручка по дням за неделю» — модель подберёт конфиг панели. Встроена оптимизация существующих графиков (AI анализирует данные и предлагает улучшения).
- **Мощный агрегационный движок**: Группировка по дням/часам/неделям/месяцам/минутам, по произвольным полям payload. Агрегации: count, sum, avg, min, max, median, p95, p99. Фильтры (eq, neq, gt, lt, in, contains), сортировка, лимит топ-N, breakdown (multi-series), timezone-aware группировка.
- **Продвинутые опции графиков**: Stacked, нарастающий итог (cumulative), сравнение с предыдущим периодом, вторая ось Y, пороговые линии (thresholds), настраиваемый tension (плавность линии), drill-down в логи по клику.
- **3 цветовые темы**: Тёмная, светлая и высокий контраст (для доступности / a11y). Переключение одной кнопкой.
- **Готовые сценарии (Cases)**: 6 шаблонов (Просмотры страниц, Регистрации, Покупки, Ошибки, Клики, Использование фичи) с генерацией мок-данных в один клик.
- **Конструктор дашбордов (JSON)**: Визуальный редактор конфигурации панелей с предпросмотром и импортом.
- **Скилл для ИИ-агентов**: Встроенный системный промпт, позволяющий LLM-агентам автономно отправлять события и генерировать ссылки на дашборды для пользователей.
- **Безопасность и Приватность**: Никаких email и паролей. Доступ в кабинет по `src` и 4-значному PIN-коду. Защита от брутфорса (PIN lockout + IP rate-limiting). Сессии хранятся в `sessionStorage` (никаких данных в `localStorage`).
- **Публичные ссылки**: Делитесь дашбордами с командой или клиентами (Read-only режим). Ссылки можно перегенерировать (отзыв старой + создание новой) или отозвать.
- **Мобильная адаптация**: Bottom Sheets для модалок, FAB-кнопка, горизонтальный свайп-тулбар, предотвращение автозума на iOS.

---

## 🚀 Быстрый старт (Отправка событий)

Вам не нужно устанавливать библиотеки. Просто отправьте запрос на сервер:

**JavaScript (Браузер / Node.js):**
```javascript
// Отправка покупки
fetch("https://events.atiks.org/e?src=my_app&type=purchase&amount=1500&currency=rub");

// Отправка клика
fetch("https://events.atiks.org/e?src=my_app&type=click&button=hero_cta");
```

**Python:**
```python
import requests
requests.get("https://events.atiks.org/e", params={
    "src": "my_app",
    "type": "error",
    "code": 500,
    "message": "DB timeout"
})
```

**Отправка сырого JSON (POST) и пакетная запись:**
```bash
# Одно событие
curl -X POST https://events.atiks.org/e \
     -H "Content-Type: application/json" \
     -d '{"src":"my_app", "type":"signup", "plan":"pro", "country":"kz"}'

# Пакетная запись (до 1000 за раз)
curl -X POST https://events.atiks.org/e/batch \
     -H "Content-Type: application/json" \
     -d '[{"src":"my_app","type":"click","element":"btn_a"},{"src":"my_app","type":"click","element":"btn_b"}]'
```

После отправки перейдите на веб-интерфейс, введите ваш `src` (в данном случае `my_app`), придумайте 4-значный PIN-код и сразу стройте графики!
*Совет: Используйте прямой вход по ссылке `https://events.atiks.org/src/my_app`, чтобы автоматически подставить ваш источник.*

---

## 🛠 Установка (Self-Hosted)

Pulse не требует сборки фронтенда (No Webpack/Vite). Работает «из коробки».

### Требования
- Node.js v18+
- Python & Build tools (необходимы для компиляции `better-sqlite3` под вашу ОС).

### Запуск
```bash
# 1. Клонируйте репозиторий
git clone https://github.com/atiksorg/pulse.git
cd pulse

# 2. Установите зависимости
npm install better-sqlite3

# 3. Запустите сервер
node events_server.js
```
Сервер запустится на порту `3333`. UI будет доступен по адресу `http://localhost:3333/`.

### Переменные окружения (Environment Variables)

| Переменная | Описание | По умолчанию |
|---|---|---|
| `PORT` | Порт HTTP сервера | `3333` |
| `DB_PATH` | Путь к файлу SQLite | `./events.db` |
| `BATCH_SIZE` | Размер буфера событий перед записью в БД | `200` |
| `BATCH_INTERVAL_MS` | Максимальный интервал между сбросами буфера | `1500` |
| `RETENTION_MONTHS` | Сколько месяцев хранить сырые данные (авто-удаление старых таблиц) | `6` |
| `ALLOWED_SRC` | Строгий список разрешенных `src` (через запятую) | *разрешены все* |
| `MAX_PAYLOAD_LENGTH` | Макс. длина JSON payload (в байтах) | `10000` |
| `STATUS_TOKEN` | Токен (Bearer) для защиты эндпоинта `/status` | *без защиты* |
| `TRUST_PROXY` | Доверять заголовку `X-Forwarded-For` (если за Nginx/Cloudflare) | `false` |
| `WORKER_COUNT` | Количество Worker Threads для аналитических запросов | `min(cpus-1, 4)` |

---

## 🏗 Архитектура проекта

Проект разделён на логические части в минималистичном стиле (Vanilla JS + Node.js). Без сборщиков, без фреймворков.

### Бэкенд

| Файл | Описание |
|---|---|
| **`events_server.js`** | Основной HTTP-сервер. Приём событий (`/e`), агрегация (`/s`), экспорт (`/export`), статика, роутинг API. Реализует In-memory буферизацию с адаптивным flush, партиционирование таблиц по месяцам (`events_YYYY_MM`), кэш агрегаций (TTL 5 сек), backpressure (429 при переполнении буфера >50K), WAL checkpoint каждые 5 минут, периодический ANALYZE для query planner. |
| **`analytics_worker.js`** | Пул Worker Threads для тяжёлых SQL-запросов (агрегации `/s`, логи `group=raw`, suggestions). Read-only подключение к БД. Автоматический перезапуск при краше. Не блокирует основной event loop — запись событий (`/e`) продолжается без задержек. |
| **`auth.js`** | Модуль аутентификации: PIN-хеширование (scrypt), сессии (SHA-256 хеш токена), lockout (5 попыток → 15 мин), IP rate-limiting для `/auth/login` (10 попыток за 5 мин). Управление дашбордами (CRUD) и публичными ссылками (share/regenerate/revoke). Таблицы: `sources`, `sessions`, `dashboards`, `public_shares`. |
| **`ai.js`** | Интеграция с LLM (xiaomi/mimo-v2.5 через ai.pro-talk.ru). Две функции: `suggestPanel` (текстовый промпт → JSON-конфиг панели) и `optimizePanel` (конфиг + сэмпл данных → рекомендации). Валидация ответов модели (allowlist визуализаций, агрегаций, группировок), устойчивый парсинг JSON (извлечение из markdown-обёрток), retry при ошибках валидации, rate-limiting (10 запросов/мин на src), метрики (latency, ошибки). |

### Фронтенд (`/public`)

| Файл | Описание |
|---|---|
| **`index.html`** | Единая точка входа. Содержит все view (Landing/Docs, Dashboard), модальные окна (панель, шеринг, быстрая настройка, справка, подтверждение, ввод, fullscreen overlay), floating toolbar, FAB-кнопку. Подключает Chart.js (multi-CDN fallback), p5.js, все JS-модули. |
| **`core.js`** | In-Memory State (`AppState`), сетевые функции (auth, dashboards, suggestions API), утилиты (`escapeHtml`, `formatNum`, `formatCompact`, `describeMeta`, `uid`), сессии (только `sessionStorage`), санитизация панелей перед сохранением (strip runtime-данных). |
| **`panels-render.js`** | Оркестратор рендера: `renderPanels`, `loadPanel`, `renderViz` (все 8 типов), `renderLogs` (с пагинацией), `renderTableViz` (с поиском и сортировкой), zero-fill для временных рядов, drill-down в логи по клику на график, cross-chart hover sync, compare period overlay. |
| **`panels-canvas.js`** | Бесконечный холст: auto-layout (адаптивные колонки, коллизии с locked-панелями), drag & resize (dead zone 5px, привязка к сетке 20px), z-index management, сохранение/восстановление viewport, DnD для grid-mode. |
| **`panels-edit.js`** | Модалка редактирования панели: шаблоны, продвинутые настройки (фильтры, thresholds, breakdown, stacked/cumulative/compare/secondAxis, gauge min/max, tension slider), AI-оптимизация существующих панелей, экспорт PNG/TSV, дублирование, lock/unlock, share modal (серверные + локальные ссылки), CSV экспорт, онбординг-баннер. |
| **`interactive-canvas.js`** | Движок бесконечного холста: pan (Space+drag, средняя кнопка, drag на пустом месте), zoom (колесо мыши, pinch-to-zoom), fit-to-content, screenToLocal, dead zone для скролла внутри карточек, auto-hide toolbar. |
| **`dashboard-init.js`** | Инициализация дашборда: привязка кнопок тулбара, часы в шапке (с индикатором дрифта сервера), auto-hide floating toolbar, рендер табов дашбордов (dblclick → переименование, contextmenu → удаление). |
| **`router.js`** | Hash-based роутинг (`#docs`, `#dashboard`, `#view`, `#public`), вход по `src` + PIN (login → register fallback), обнаружение `/src/XXX` в URL path, logout, инициализация темы. |
| **`share.js`** | Рендер публичных ссылок: `renderSharedView` (Base64-encoded dashboard в URL), `renderPublicView` (серверная ссылка `#public?id=...`), live demo pulse для cases, «Забрать дашборд себе». |
| **`cases.js`** | Каталог из 6 готовых сценариев (Просмотры страниц, Регистрации, Покупки, Ошибки, Клики, Использование фичи). Генерация мок-данных (30 событий), quick setup wizard (2 шага), кнопка «Попробовать» с автоматическим созданием демо-дашборда. |
| **`extras.js`** | Hero playground (live demo с Chart.js), code examples (JS/Python/cURL/PHP/Go), p5.js particle effects, JSON config builder (визуальный редактор + предпросмотр + импорт панелей). |
| **`themes.js`** | 3 цветовые темы (dark/light/high-contrast) через CSS-переменные. API для чартов: `getChartPalette()`, `getThemeColor()`, `getPanelBorderColor()`. Раннее применение темы (до DOMContentLoaded) для предотвращения «вспышки». |
| **`chart-plugins.js`** | Плагины Chart.js: `thresholdPlugin` (горизонтальные пунктирные линии порогов), `applyCumulative` (нарастающий итог), `computeCompareRange` (вычисление предыдущего периода для сравнения). |
| **`chart-gauge.js`** | Gauge-визуализация (чистый Canvas, без Chart.js). Дуга с зонами цветов, glow-эффект, пороговые маркеры, подписи min/max. |
| **`chart-heatmap.js`** | Heatmap-визуализация (HTML-таблица). Интерполяция цвета (HSL), адаптивные подписи, легенда градиента. |
| **`styles.css`** | CSS-переменные, 3 темы, адаптивная верстка (Bottom Sheets, FAB, Scroll Shrink, горизонтальный свайп), canvas mode, locked panels, skeleton loader, heatmap, gauge, floating toolbar, модальные окна. |

---

## 📡 API Справочник

Базовый URL: `https://events.atiks.org`. CORS открыт — обращайтесь напрямую из браузера, мобильного приложения или бэкенда.

### Запись данных (Events)

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/e` | Запись одного события через query-параметры. Обязательные: `src`, `type`. Остальное — произвольные ключи payload. Ответ: `204`. |
| `POST` | `/e` | Запись одного события через JSON body `{"src":"...","type":"...","key":"value"}`. Ответ: `204`. |
| `POST` | `/e/batch` | Пакетная запись массива событий (до 1000 за раз). Ответ: `204`. |
| `POST` | `/e/clear` | Удаление событий по `src` (и опционально `type`). Требует авторизации. Ответ: `{"deleted": N}`. |

### Чтение данных (Аналитика)

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/s` | Мощный агрегационный движок (подробнее ниже). |
| `GET` | `/suggestions` | Уникальные типы событий и поля payload для автодополнения (требует авторизации). |
| `GET` | `/export` | Экспорт сырых событий в CSV (требует авторизации, до 100K строк). |

#### Параметры `GET /s`

| Параметр | Описание | Примеры |
|---|---|---|
| `src` | **(обязательно)** Идентификатор источника | `my_app` |
| `type` | Фильтр по типу события | `purchase` |
| `group` | Группировка: `day`, `hour`, `minute`, `week`, `month`, `field:ИМЯ`, `raw` | `day`, `field:country`, `raw` |
| `agg` | Агрегация: `count` (по умолч.), `sum:ПОЛЕ`, `avg:ПОЛЕ`, `min:ПОЛЕ`, `max:ПОЛЕ`, `median:ПОЛЕ`, `p95:ПОЛЕ`, `p99:ПОЛЕ` | `sum:amount`, `p95:duration` |
| `from` | Начало диапазона (ISO дата) | `2025-01-01` |
| `to` | Конец диапазона (ISO дата) | `2025-01-31` |
| `sort` | Сортировка: `key` (по умолч.), `value_desc`, `value_asc` | `value_desc` |
| `limit` | Лимит групп (макс. 500, по умолч. 500) | `10` |
| `filters` | JSON-массив фильтров (до 5 штук) | `[{"field":"country","op":"eq","value":"ru"}]` |
| `breakdown` | Поле для multi-series разбивки | `plan` |
| `tz` | Смещение часового пояса в часах (для корректной группировки по дням/часам) | `3` |

#### Фильтры

Операторы: `eq` (равно), `neq` (не равно), `gt` (больше), `lt` (меньше), `in` (в списке), `contains` (содержит).

```json
[
  {"field": "country", "op": "eq", "value": "ru"},
  {"field": "amount", "op": "gt", "value": 100},
  {"field": "plan", "op": "in", "value": ["pro", "enterprise"]}
]
```

#### Ответ `GET /s`

```json
{
  "total": 1234,
  "groups": [
    {"bucket": "2025-01-15", "value": 42},
    {"bucket": "2025-01-16", "value": 38}
  ]
}
```

При `breakdown`:
```json
{
  "total": 1234,
  "series": [
    {"key": "free", "points": [{"bucket": "2025-01-15", "value": 20}, ...]},
    {"key": "pro", "points": [{"bucket": "2025-01-15", "value": 22}, ...]}
  ]
}
```

При `group=raw` (логи):
```json
{
  "events": [
    {"ts": "2025-01-15T12:34:56.789Z", "type": "purchase", "payload": "{\"amount\":42}"},
    ...
  ]
}
```

### Дашборды и Шеринг (требуют авторизации)

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/dashboards` | Список дашбордов текущего `src`. |
| `POST` | `/dashboards` | Создать дашборд. Body: `{name, panels, layoutMode}`. |
| `PUT` | `/dashboards/:id` | Обновить дашборд. Body: `{name, panels, layoutMode}`. |
| `DELETE` | `/dashboards/:id` | Удалить дашборд (каскадно отзывает все публичные ссылки). |
| `POST` | `/dashboards/:id/share` | Создать/получить публичную ссылку (возвращает `shareId`). |
| `POST` | `/dashboards/:id/share/regenerate` | Перегенерировать ссылку (отзывает старые, создаёт новую). |
| `GET` | `/shares` | Список публичных ссылок текущего пользователя. |
| `POST` | `/shares/:id/revoke` | Отозвать публичную ссылку. |
| `GET` | `/public/:share_id` | Получение конфига дашборда по публичной ссылке (без auth). |

### Авторизация

| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/auth/register` | Регистрация нового `src`. Body: `{src, pin}`. Ответ: `{src, token, expiresAt}`. |
| `POST` | `/auth/login` | Вход. Body: `{src, pin}`. Ответ: `{src, token, expiresAt}`. |
| `POST` | `/auth/logout` | Выход (удаляет сессию). Требует `Authorization: Bearer <token>`. |
| `GET` | `/auth/me` | Текущий `src` сессии. Требует авторизации. |

### AI

| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/ai/suggest-panel` | AI-помощник: текстовый промпт → JSON-конфиг панели. Требует авторизации. Rate-limit: 10 запросов/мин. |
| `POST` | `/ai/optimize-panel` | AI-оптимизация: конфиг панели + сэмпл данных → рекомендации. Требует авторизации. |

### Инфраструктура

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/health` | Лёгкая проверка состояния (uptime, размер буфера, кол-во таблиц). |
| `GET` | `/status` | Детальная сводка: RAM, размер БД, скорость записи, воркеры, AI-метрики (может быть закрыт `STATUS_TOKEN`). |
| `GET` | `/src/:id` | Прямой вход в кабинет с предзаполненным `src` (отдаёт `index.html`). |

---

## 🎨 Типы визуализации

| Тип | Описание | Особенности |
|---|---|---|
| **Line** | Линейный график | Stacked, cumulative, compare period, second Y axis, thresholds, tension (плавность), breakdown (multi-series) |
| **Bar** | Столбчатая диаграмма | Stacked, cumulative, compare period, second Y axis, thresholds, breakdown |
| **Pie** | Круговая диаграмма | Breakdown (multi-series), кастомная HTML-легенда на мобилках |
| **KPI** | Одно число (KPI) | Drill-down в логи по клику, кастомный цвет, единицы измерения |
| **Gauge** | Индикатор-дуга | Настраиваемый min/max, пороговые зоны, glow-эффект (чистый Canvas) |
| **Heatmap** | Тепловая карта | Требует breakdown, HSL-интерполяция цвета, легенда градиента |
| **Table** | Таблица с агрегацией | Поиск, сортировка, data bars, до 200 строк |
| **Logs** | Логи (сырые события) | Пагинация (10 на страницу), автообновление, индикатор дрифта сервера |

---

## 📦 Структура базы данных

SQLite с WAL-журналированием. Таблицы событий шардируются по месяцам.

### Системные таблицы

| Таблица | Описание |
|---|---|
| `sources` | Источники: `src` (PK), `pin_hash`, `pin_salt`, `failed_attempts`, `locked_until`, `created_at`, `last_login_at` |
| `sessions` | Сессии: `session_hash` (SHA-256 токена, PK), `src`, `created_at`, `expires_at` (TTL 30 дней) |
| `dashboards` | Дашборды: `id`, `src`, `name`, `panels_json`, `layout_mode`, `created_at`, `updated_at` |
| `public_shares` | Публичные ссылки: `share_id` (10 символов base36), `dashboard_id`, `src`, `created_at`, `revoked` |

### Таблицы событий

```
events_YYYY_MM (например: events_2025_01)
├── id       INTEGER PRIMARY KEY AUTOINCREMENT
├── ts       TEXT NOT NULL (ISO timestamp)
├── src      TEXT NOT NULL
├── type     TEXT NOT NULL
├── payload  TEXT NOT NULL DEFAULT '{}' (JSON)
├── ip       TEXT
├── ua       TEXT
├── INDEX idx_..._src_ts ON (src, ts DESC)
└── INDEX idx_..._type   ON (src, type)
```

Старые таблицы автоматически удаляются через `RETENTION_MONTHS`.

---

## 🔒 Безопасность

- **PIN-коды**: Хешируются через `scrypt` (64 байта) с уникальным salt для каждого `src`. Raw-токены никогда не хранятся — в БД пишется SHA-256 хеш.
- **Lockout**: После 5 неверных попыток PIN — блокировка на 15 минут.
- **IP rate-limiting**: `/auth/login` — максимум 10 попыток с одного IP за 5 минут.
- **AI rate-limiting**: 10 запросов на `src` в минуту для `/ai/suggest-panel` и `/ai/optimize-panel`.
- **Body timeout**: 10 секунд на чтение тела запроса — защита от Slowloris.
- **Path traversal**: Запрет на `..` в URL, проверка что файл находится внутри `public/`.
- **Backpressure**: При переполнении буфера (>50K событий) — ответ `429 Retry-After: 5`.
- **Session storage**: Данные сессии хранятся только в `sessionStorage` (очищается при закрытии вкладки). Единственное исключение — тема UI (`localStorage`).
- **CORS**: Полностью открыт для записи событий. Дашборды и AI требуют `Authorization: Bearer <token>`.

---

## 🤖 AI-помощник

### Генерация панелей

Опишите на русском, что хотите увидеть — AI подберёт конфиг:

```
POST /ai/suggest-panel
{"prompt": "выручка по дням за неделю"}
```

Модель учитывает существующие типы событий пользователя (подсказки для поля `type`), валидирует ответ (allowlist визуализаций, агрегаций, группировок) и автоматически повторяет запрос при ошибках.

### Оптимизация графиков

AI анализирует текущий конфиг панели и сэмпл данных, предлагает улучшения:

```
POST /ai/optimize-panel
{
  "config": { "viz": "line", "type": "purchase", "group": "day", ... },
  "dataSample": { "labels": [...], "values": [...], "totalPoints": 7 }
}
```

Критерии оптимизации: выбор типа графика (line vs kpi при малом количестве точек), корректность группировки, диапазон данных, необходимость limit/sort.

### Скилл для ИИ-агентов

В интерфейсе (раздел «Справка») встроен готовый **Системный промпт (Skill)** для LLM-агентов. Скопировав его, вы можете настроить любого AI-агента (ChatGPT, Claude, Cursor, локальный LLM) так, чтобы он:
1. Самостоятельно отправлял события на ваш `src`.
2. Формировал JSON-конфигурацию дашборда.
3. Кодировал её в Base64 и выдавал готовую прямую ссылку на визуализацию.

---

## 📋 Готовые сценарии (Cases)

| Сценарий | Тип события | Payload | Графики |
|---|---|---|---|
| **Просмотры страниц** | `page_view` | `{page}` | Линия по дням + Таблица популярных страниц |
| **Регистрации** | `signup` | `{plan}` | KPI за 24ч + Линия по дням |
| **Покупки** | `purchase` | `{amount, currency}` | KPI (сумма за 7д) + Линия (выручка по дням) |
| **Ошибки приложения** | `error` | `{message, code}` | Таблица по кодам + Линия по часам |
| **Клики по CTA** | `click` | `{element}` | Столбцы по элементам + Линия по дням |
| **Использование фичи** | `feature_used` | `{feature}` | Круговая диаграмма + Линия по дням |

Нажмите «Попробовать →» — Pulse автоматически сгенерирует 30 мок-событий и откроет готовый дашборд.

---

## 📂 Структура файлов

```
pulse/
├── events_server.js          # HTTP-сервер (порт 3333)
├── analytics_worker.js       # Worker Thread для SQL-запросов
├── auth.js                   # Аутентификация, дашборды, шеринг
├── ai.js                     # AI-интеграция (LLM suggest + optimize)
├── package.json              # Зависимости (better-sqlite3)
├── readme.md                 # Этот файл
├── .gitignore
└── public/                   # Фронтенд (Vanilla JS, без сборщиков)
    ├── index.html            # Точка входа
    ├── core.js               # State, API, утилиты
    ├── panels-render.js      # Рендер графиков, таблиц, логов
    ├── panels-canvas.js      # Бесконечный холст, layout, drag/resize
    ├── panels-edit.js        # Редактирование панелей, AI, шеринг
    ├── interactive-canvas.js # Движок pan/zoom
    ├── dashboard-init.js     # Инициализация дашборда, тулбар, часы
    ├── router.js             # Hash-based роутинг
    ├── share.js              # Публичные ссылки, demo pulse
    ├── cases.js              # Каталог сценариев, мок-данные
    ├── extras.js             # Playground, code examples, p5, config builder
    ├── themes.js             # 3 темы (dark/light/high-contrast)
    ├── chart-plugins.js      # Плагины Chart.js (thresholds, cumulative, compare)
    ├── chart-gauge.js        # Gauge-визуализация (чистый Canvas)
    ├── chart-heatmap.js      # Heatmap-визуализация (HTML)
    └── styles.css            # CSS-переменные, темы, адаптив
```

---

## 🤝 Контрибьютинг

Пулл-реквесты приветствуются!
При добавлении новых фич во фронтенд, пожалуйста, придерживайтесь философии **Vanilla JS**: мы не используем React/Vue и тяжёлые библиотеки, чтобы интерфейс загружался моментально и работал без сборщиков.

## 📄 Лицензия
MIT License. Делайте с кодом что хотите.
