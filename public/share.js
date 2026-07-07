/* ═══════════════════════════════════════════════════
   share.js — shared view, demo pulse, public view
   ═══════════════════════════════════════════════════ */

function renderSharedView(){
  var hashStr = location.hash.split('?')[1] || '';
  var dMatch = hashStr.match(/(?:^|&)d=([^&]*)/);
  var encoded = dMatch ? decodeURIComponent(dMatch[1]) : null;
  if(!encoded){ initDashboard(); return; }
  var payload;
  try{ payload = decodeDashboard(encoded); }
  catch(e){ toast('Не удалось прочитать ссылку'); initDashboard(); return; }

  isPublicView = false;
  publicShare = null;

  if(demoPulseTimer){ clearInterval(demoPulseTimer); demoPulseTimer = null; }

  $('#dashTabs').style.display = 'none';

  var isDemo = payload.src && payload.src.startsWith('demo_');

  if(isDemo){
    $('#viewBanner').innerHTML = '<div class="view-banner" style="border-color: var(--teal); background: linear-gradient(90deg, rgba(77,236,199,0.15), transparent);"><span><b>Это живое демо.</b> Данные уже на сервере и графики обновляются.<br>Понравилось? Сохраните эту настройку себе, чтобы не потерять.</span></div>';
    $('.toolbar').innerHTML = '<button class="btn btn-primary" id="btnSaveCopy" style="white-space:nowrap;">Забрать дашборд себе →</button>';

    var demoCaseId = payload.src.split('_')[1];
    var caseObj = cases.find(function(c){ return c.id === demoCaseId; });
    if(caseObj){
      demoPulseTimer = setInterval(async function(){
        var built = caseObj.buildUrl(payload.src);
        try{ await fetch(built.url); } catch(_){}
        payload.dashboard.panels.forEach(function(p){ loadPanel(p, payload.src); });
      }, 5000);
    }
  } else {
    $('#viewBanner').innerHTML = '<div class="view-banner"><span>Вы просматриваете общий дашборд <b>'+escapeHtml(payload.dashboard.name)+'</b> (только чтение) · источник <b>'+escapeHtml(payload.src)+'</b></span></div>';
    $('.toolbar').innerHTML = '<button class="btn btn-primary" id="btnSaveCopy" style="white-space:nowrap;">Забрать дашборд себе →</button>';
  }

  $('#btnSaveCopy').onclick = async function(){
    var sess = getSession();
    if (!sess) {
      toast('Войдите в кабинет, чтобы сохранить дашборд');
      location.hash = '#docs';
      return;
    }
    try {
      var copyPanels = JSON.parse(JSON.stringify(payload.dashboard.panels)).map(function(p){
        return Object.assign(p, { id: uid('panel') });
      });
      var db = await createDashboardOnServer(payload.dashboard.name + ' (копия)', copyPanels);
      setActiveId(db.id);
      location.hash = '#dashboard';
      toast('Дашборд сохранён в ваш кабинет');
    } catch(e) {
      toast('Ошибка сохранения: ' + e.message);
    }
  };

  renderPanels({ dashboard: payload.dashboard, src: payload.src, layoutMode: payload.layoutMode !== undefined ? payload.layoutMode : true });
}

/* ── Public server-shared view (#public?id=...) ─── */
async function renderPublicView(){
  var hashStr = location.hash.split('?')[1] || '';
  var idMatch = hashStr.match(/(?:^|&)id=([^&]*)/);
  var shareId = idMatch ? decodeURIComponent(idMatch[1]) : null;
  if(!shareId){
    toast('Ссылка не указана');
    location.hash = '#docs';
    return;
  }

  if(demoPulseTimer){ clearInterval(demoPulseTimer); demoPulseTimer = null; }

  var data;
  try{
    data = await loadSharedDashboard(shareId);
  } catch(e){
    toast('Ссылка не найдена или отозвана');
    location.hash = '#docs';
    return;
  }

  isPublicView = true;
  publicShare = data.share || { shareId: shareId, src: data.dashboard && data.dashboard.src };

  $('#dashTabs').style.display = 'none';

  var bannerText = '🔒 Публичный дашборд <b>' + escapeHtml(data.dashboard.name) + '</b> (только чтение)';
  if (data.share && data.share.src) bannerText += ' · источник <b>' + escapeHtml(data.share.src) + '</b>';
  $('#viewBanner').innerHTML = '<div class="view-banner"><span>' + bannerText + '</span></div>';

  $('.toolbar').innerHTML =
    '<button class="btn btn-ghost" id="btnRefreshAll">↻ Обновить</button>' +
    '<button class="btn btn-primary" id="btnSaveCopy" style="white-space:nowrap;">Открыть в кабинете →</button>';

  $('#btnRefreshAll').onclick = function(){
    payload_dashboard_panels.forEach(function(p){ loadPanel(p, data.share && data.share.src); });
  };
  $('#btnSaveCopy').onclick = async function(){
    var sess = getSession();
    if (!sess) {
      toast('Войдите в кабинет, чтобы сохранить дашборд');
      location.hash = '#docs';
      return;
    }
    try {
      var copyPanels = JSON.parse(JSON.stringify(data.dashboard.panels)).map(function(p){
        return Object.assign(p, { id: uid('panel') });
      });
      var db = await createDashboardOnServer(data.dashboard.name + ' (копия)', copyPanels);
      setActiveId(db.id);
      isPublicView = false;
      publicShare = null;
      location.hash = '#dashboard';
      toast('Дашборд сохранён в ваш кабинет');
    } catch(e) {
      toast('Ошибка сохранения: ' + e.message);
    }
  };

  // Сохраняем ссылку на панели для refresh
  var payload_dashboard_panels = data.dashboard.panels;

  renderPanels({
    dashboard: { name: data.dashboard.name, panels: data.dashboard.panels },
    src: data.share && data.share.src,
    layoutMode: data.dashboard.layoutMode !== undefined ? data.dashboard.layoutMode : true
  });
}
