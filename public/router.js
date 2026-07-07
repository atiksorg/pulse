/* ═══════════════════════════════════════════════════
   router.js — routing, hero enter, help toggle, init
   ═══════════════════════════════════════════════════ */

/* ── Detect /src/XXX in URL path ─────────────────── */
(function detectSrcPath(){
  var m = location.pathname.match(/^\/src\/([a-zA-Z_][a-zA-Z0-9_]*)/);
  if(m){
    // НЕ пишем в localStorage. Просто подставляем src в поле ввода
    // после загрузки DOM (см. initHeroEnter).
    window.__pendingSrc = m[1];
  }
})();

/* ── Router ──────────────────────────────────────── */
function currentRoute(){
  var hash = location.hash.replace(/^#/,'') || 'docs';
  return hash.split('?')[0];
}

function render(){
  var route = currentRoute();
  if(demoPulseTimer){ clearInterval(demoPulseTimer); demoPulseTimer = null; }
  document.querySelectorAll('.view').forEach(function(v){ v.classList.remove('active'); });

  if (route !== 'dashboard' && route !== 'view' && route !== 'public') {
    if (typeof refreshTimers !== 'undefined') {
      Object.values(refreshTimers).forEach(clearInterval);
      refreshTimers = {};
    }
  }

  // Обновляем UI-индикатор сессии
  var sess = getSession();
  var ind = $('#sessionIndicator');
  if (ind) {
    if (sess) {
      $('#sessionSrcName').textContent = sess.src;
      ind.style.display = 'flex';
    } else {
      ind.style.display = 'none';
    }
  }

  // Защита роута #dashboard: если нет сессии — редирект на #docs
  if(route === 'dashboard' && !sess){
    location.hash = '#docs';
    return;
  }

  if(route === 'public'){
    $('#view-dashboard').classList.add('active');
    renderPublicView();
  } else if(route === 'view'){
    $('#view-dashboard').classList.add('active');
    renderSharedView();
  } else if(route === 'dashboard'){
    $('#view-dashboard').classList.add('active');
    initDashboard();
  } else {
    $('#view-docs').classList.add('active');
  }
}
window.addEventListener('hashchange', render);

/* ── Hero Enter — login / register ───────────────── */
(function initHeroEnter(){
  var heroInput = document.getElementById('heroSrcInput');
  var heroPin = document.getElementById('heroPinInput');
  var heroBtn = document.getElementById('heroEnterBtn');
  if(!heroInput || !heroBtn) return;

  // Если пришли по /src/:id — подставляем src в поле ввода
  if (window.__pendingSrc) {
    heroInput.value = window.__pendingSrc;
    window.__pendingSrc = null;
  }

  async function tryEnter(){
    var v = heroInput.value.trim();
    var pin = (heroPin && heroPin.value || '').trim();
    if(!v){ heroInput.focus(); return; }
    if(!pin){
      toast('Введите 4-значный PIN');
      heroPin && heroPin.focus();
      return;
    }
    if(!/^\d{4}$/.test(pin)){ toast('PIN должен быть 4 цифры'); heroPin.focus(); return; }

    heroBtn.disabled = true;
    heroBtn.textContent = 'Входим…';
    var r = await authLogin(v, pin);
    heroBtn.disabled = false; heroBtn.textContent = 'Войти →';
    if(r.ok){
      setSession({ src: r.data.src, token: r.data.token, expiresAt: r.data.expiresAt });
      location.hash = '#dashboard';
      return;
    }
    // если src не найден — пробуем зарегистрировать
    if(r.status === 404){
      var reg = await authRegister(v, pin);
      if(reg.ok){
        setSession({ src: reg.data.src, token: reg.data.token, expiresAt: reg.data.expiresAt });
        toast('Кабинет создан');
        location.hash = '#dashboard';
      } else {
        toast('Ошибка: ' + (reg.data.error || reg.status));
      }
      return;
    }
    // 401 = неверный PIN
    if(r.status === 401){ toast('Неверный PIN'); heroPin.select(); return; }
    // 423 = лок
    if(r.status === 423){
      toast('Слишком много попыток. Повторите через ' + Math.ceil((r.data.remainSec||60)/60) + ' мин');
      return;
    }
    // 409 = src занят но без pin
    if(r.status === 409){ toast('Этот src уже занят. Введите верный PIN.'); heroPin.focus(); return; }
    toast('Ошибка: ' + (r.data.error || r.status));
  }

  heroBtn.addEventListener('click', tryEnter);
  heroInput.addEventListener('keydown', function(e){ if(e.key === 'Enter'){ heroBtn.click(); } });
  if(heroPin) heroPin.addEventListener('keydown', function(e){ if(e.key === 'Enter'){ heroBtn.click(); } });
  // только цифры в pin
  if(heroPin){
    heroPin.addEventListener('input', function(){ this.value = (this.value || '').replace(/\D/g,'').slice(0,4); });
  }
})();

/* ── Session Logout Binding ──────────────────────── */
(function initLogoutBinding(){
  var btn = document.getElementById('btnSessionLogout');
  if (btn) {
    btn.onclick = async function(){
      await authLogout();
      location.hash = '#docs';
    };
  }

  // Кнопка копирования src в буфер обмена
  var copyBtn = document.getElementById('btnCopySrc');
  if (copyBtn) {
    copyBtn.onclick = function(){
      var sess = getSession();
      if(!sess || !sess.src) return;
      navigator.clipboard.writeText(sess.src).then(function(){
        toast('src скопирован в буфер обмена');
      }).catch(function(){
        toast('Не удалось скопировать');
      });
    };
  }
})();

/* ── Help Section Toggle ─────────────────────────── */
(function initHelpSection(){
  document.addEventListener('click', function(e){
    var toggle = e.target.closest('#helpToggle');
    if(!toggle) return;
    var section = document.getElementById('helpSection');
    var body = document.getElementById('helpBody');
    if(!section || !body) return;
    var isOpen = section.classList.contains('open');
    if(isOpen){
      section.classList.remove('open');
      body.style.display = 'none';
    } else {
      section.classList.add('open');
      body.style.display = '';
    }
  });
})();

/* ── INIT ────────────────────────────────────────── */
render();
