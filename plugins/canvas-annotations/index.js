'use strict';

// Плагин canvas-annotations: статические объекты на холсте дашборда.
// Не требует серверных таблиц — данные хранятся в JSON структуре dashboard.panels.
// Поддерживаемые viz: annotation-text, sticky-note

module.exports = {
  schema: function (db) {
    // Нет миграций — всё хранится в JSON дашборда.
  },

  registerRoutes: function (server, db) {
    // Нет HTTP-маршрутов — фронтенд работает через существующий CRUD дашбордов.
  },

  hooks: function (db) {
    // Нет хуков — это UI-only плагин.
  }
};
