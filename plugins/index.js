// plugins/index.js — Реестр плагинов
// Сканирует plugins/*/index.js и вызывает lifecycle-хуки:
//   - schema(db)           — создание таблиц (миграции)
//   - registerRoutes(server, db) — HTTP-маршруты
//   - hooks(db)            — подписка на события (flush, event)
//
// Плагины загружаются в порядке PLUGIN_DIRS.
'use strict';

const fs   = require('fs');
const path = require('path');

// Порядок загрузки плагинов (важен для зависимостей в будущем)
const PLUGIN_DIRS = ['reports', 'alert', 'panel-triggers'];

function loadPlugins(server, db) {
  const loaded = [];
  const errors = [];

  for (const dir of PLUGIN_DIRS) {
    const pluginPath = path.join(__dirname, dir, 'index.js');
    if (!fs.existsSync(pluginPath)) continue;

    try {
      const plugin = require(pluginPath);

      // 1. Миграции
      if (typeof plugin.schema === 'function') {
        plugin.schema(db);
      }

      // 2. HTTP-маршруты
      if (typeof plugin.registerRoutes === 'function') {
        plugin.registerRoutes(server, db);
      }

      // 3. Хуки (flush, event и т.д.)
      if (typeof plugin.hooks === 'function') {
        plugin.hooks(db);
      }

      loaded.push(dir);
      console.log(`[plugins] ✓ ${dir} loaded`);
    } catch (e) {
      errors.push({ dir, error: e.message });
      console.error(`[plugins] ✗ ${dir} failed: ${e.message}`);
    }
  }

  // Экспортируем список загруженных плагинов для /status
  global._loadedPlugins = loaded;
  global._pluginErrors = errors;

  return { loaded, errors };
}

module.exports = { loadPlugins };
