/**
 * plugins/shared/xml-builder.js — Утилиты для построения XML
 *
 * Экранирование атрибутов, форматирование элементов.
 * Используется и reports/xml-generator.js, и (будущим) panel-triggers.
 */
'use strict';

/** Экранирование спецсимволов для XML-атрибутов */
function xa(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Создание XML-строки из массива строк (join с \n) */
function buildXml(declaration, rootOpen, lines, rootClose) {
  const L = [];
  if (declaration) L.push(declaration);
  if (rootOpen)    L.push(rootOpen);
  for (const line of lines) L.push(line);
  if (rootClose)   L.push(rootClose);
  return L.join('\n');
}

module.exports = { xa, buildXml };
