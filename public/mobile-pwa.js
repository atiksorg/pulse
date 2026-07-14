/* ═══════════════════════════════════════════════════
   mobile-pwa.js — PWA: Service Worker, Install Prompt
   ─────────────────────────────────────────────────
   Загружается ТОЛЬКО при width < 860px + touch.
   Регистрирует Service Worker для кэширования
   и обрабатывает Install Prompt (A2HS).
   ═══════════════════════════════════════════════════ */

(function MobilePWA(){
  'use strict';

  /* ── Service Worker Registration ───────────────── */
  if('serviceWorker' in navigator){
    window.addEventListener('load', function(){
      // Регистрируем SW только если файл существует
      // (сервер должен отдать 200 на /sw.js)
      navigator.serviceWorker.register('/pulse/public/sw.js').then(function(reg){
        console.log('[Pulse PWA] Service Worker registered:', reg.scope);
      }).catch(function(err){
        // SW файл может не существовать — это нормально
        console.log('[Pulse PWA] SW registration skipped:', err.message);
      });
    });
  }

  /* ── Install Prompt (A2HS) ─────────────────────── */
  var _deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', function(e){
    e.preventDefault();
    _deferredPrompt = e;
    console.log('[Pulse PWA] Install prompt available');
  });

  window.addEventListener('appinstalled', function(){
    _deferredPrompt = null;
    console.log('[Pulse PWA] App installed');
  });

  /* ── Public API: showInstallPrompt() ───────────── */
  // Может быть вызвана из Bottom Nav или другого UI
  window.showInstallPrompt = function(){
    if(!_deferredPrompt) return Promise.resolve(false);
    _deferredPrompt.prompt();
    return _deferredPrompt.userChoice.then(function(choice){
      _deferredPrompt = null;
      return choice.outcome === 'accepted';
    });
  };

})();
