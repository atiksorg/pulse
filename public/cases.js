/* ═══════════════════════════════════════════════════
   cases.js — catalog, seedMockData, quick setup wizard
   ═══════════════════════════════════════════════════ */

/* ── Cases catalog ───────────────────────────────── */
var cases = [
  {
    id:'page_view', icon:'', title:'Просмотры страниц',
    desc:'Трафик сайта или лендинга — какие страницы смотрят чаще всего',
    type:'page_view',
    spec:'type: <code>page_view</code> · payload: <code>{page}</code>',
    generatePayload(){ var pages=['/','/pricing','/docs','/blog','/about','/signup','/features','/contact']; return { page:pages[Math.floor(Math.random()*pages.length)] }; },
    buildUrl(src){ var p=this.generatePayload(); return { url:API+'/e?src='+encodeURIComponent(src)+'&type='+this.type+'&page='+encodeURIComponent(p.page), payload:p }; },
    panels:[
      { title:'Просмотры по дням', viz:'line', type:'page_view', group:'day', agg:'count', field:'', aggfield:'', range:'7d', width:6, autorefresh:0 },
      { title:'Популярные страницы', viz:'table', type:'page_view', group:'__field', agg:'count', field:'page', aggfield:'', range:'7d', width:6, autorefresh:0 },
    ]
  },
  {
    id:'signup', icon:'', title:'Регистрации',
    desc:'Воронка сайтов и приложений — откуда приходят новые пользователи',
    type:'signup',
    spec:'type: <code>signup</code> · payload: <code>{plan}</code>',
    generatePayload(){ var plans=['free','pro','business','enterprise']; return { plan:plans[Math.floor(Math.random()*plans.length)] }; },
    buildUrl(src){ var p=this.generatePayload(); return { url:API+'/e?src='+encodeURIComponent(src)+'&type='+this.type+'&plan='+encodeURIComponent(p.plan), payload:p }; },
    panels:[
      { title:'Регистрации (KPI за 24ч)', viz:'kpi', type:'signup', group:'', agg:'count', field:'', aggfield:'', range:'24h', width:4, autorefresh:0 },
      { title:'Регистрации по дням', viz:'line', type:'signup', group:'day', agg:'count', field:'', aggfield:'', range:'7d', width:8, autorefresh:0 },
    ]
  },
  {
    id:'purchase', icon:'', title:'Покупки',
    desc:'E-commerce и подписки — выручка, средний чек, динамика',
    type:'purchase',
    spec:'type: <code>purchase</code> · payload: <code>{amount, currency}</code>',
    generatePayload(){ return { amount:Math.floor(Math.random()*1901)+100, currency:'rub' }; },
    buildUrl(src){ var p=this.generatePayload(); return { url:API+'/e?src='+encodeURIComponent(src)+'&type='+this.type+'&amount='+p.amount+'&currency='+p.currency, payload:p }; },
    panels:[
      { title:'Выручка (сумма за 7д)', viz:'kpi', type:'purchase', group:'', agg:'sum', field:'', aggfield:'amount', range:'7d', width:4, autorefresh:0 },
      { title:'Выручка по дням', viz:'line', type:'purchase', group:'day', agg:'sum', field:'', aggfield:'amount', range:'7d', width:8, autorefresh:0 },
    ]
  },
  {
    id:'error', icon:'', title:'Ошибки приложения',
    desc:'Мониторинг багов — какие коды ошибок встречаются чаще всего',
    type:'error',
    spec:'type: <code>error</code> · payload: <code>{message, code}</code>',
    generatePayload(){ var codes=[400,403,404,500,502,503]; var msgs=['timeout','not_found','forbidden','bad_request','internal','bad_gateway']; var i=Math.floor(Math.random()*codes.length); return { message:msgs[i], code:codes[i] }; },
    buildUrl(src){ var p=this.generatePayload(); return { url:API+'/e?src='+encodeURIComponent(src)+'&type='+this.type+'&message='+encodeURIComponent(p.message)+'&code='+p.code, payload:p }; },
    panels:[
      { title:'Ошибки по кодам', viz:'table', type:'error', group:'__field', agg:'count', field:'code', aggfield:'', range:'24h', width:6, autorefresh:0 },
      { title:'Ошибки по часам', viz:'line', type:'error', group:'hour', agg:'count', field:'', aggfield:'', range:'24h', width:6, autorefresh:0 },
    ]
  },
  {
    id:'click', icon:'', title:'Клики по кнопке / CTA',
    desc:'Конверсии интерфейса — какие элементы нажимают чаще',
    type:'click',
    spec:'type: <code>click</code> · payload: <code>{element}</code>',
    generatePayload(){ var els=['cta_hero','cta_pricing','btn_signup','btn_demo','link_docs','btn_download']; return { element:els[Math.floor(Math.random()*els.length)] }; },
    buildUrl(src){ var p=this.generatePayload(); return { url:API+'/e?src='+encodeURIComponent(src)+'&type='+this.type+'&element='+encodeURIComponent(p.element), payload:p }; },
    panels:[
      { title:'Клики по элементам', viz:'bar', type:'click', group:'__field', agg:'count', field:'element', aggfield:'', range:'7d', width:6, autorefresh:0 },
      { title:'Клики по дням', viz:'line', type:'click', group:'day', agg:'count', field:'', aggfield:'', range:'7d', width:6, autorefresh:0 },
    ]
  },
  {
    id:'feature_used', icon:'', title:'Использование фичи',
    desc:'Продуктовая аналитика — какие функции продукта востребованы',
    type:'feature_used',
    spec:'type: <code>feature_used</code> · payload: <code>{feature}</code>',
    generatePayload(){ var f=['export_csv','dark_mode','api_access','team_collab','custom_domain','analytics']; return { feature:f[Math.floor(Math.random()*f.length)] }; },
    buildUrl(src){ var p=this.generatePayload(); return { url:API+'/e?src='+encodeURIComponent(src)+'&type='+this.type+'&feature='+encodeURIComponent(p.feature), payload:p }; },
    panels:[
      { title:'Фичи: круговая', viz:'pie', type:'feature_used', group:'__field', agg:'count', field:'feature', aggfield:'', range:'30d', width:6, autorefresh:0 },
      { title:'Фичи по дням', viz:'line', type:'feature_used', group:'day', agg:'count', field:'', aggfield:'', range:'30d', width:6, autorefresh:0 },
    ]
  },
];

/* ── Build cases grid ────────────────────────────── */
(function buildCasesGrid(){
  var grid = document.getElementById('casesGrid');
  if(!grid) return;
  cases.forEach(function(c){
    var card = document.createElement('div');
    card.className = 'case-card';
    card.innerHTML = '<div class="cc-icon">'+c.icon+'</div><div class="cc-title">'+c.title+'</div><div class="cc-desc">'+c.desc+'</div><div class="cc-spec">'+c.spec+'</div><button class="cc-btn" data-case="'+c.id+'">Попробовать →</button>';
    grid.appendChild(card);
  });
})();

/* ── Seed mock data ──────────────────────────────── */
async function seedMockData(src, caseId){
  var caseObj = cases.find(function(c){ return c.id===caseId; });
  if(!caseObj) return;
  var promises = [];
  for(var i=0;i<30;i++){ var url=caseObj.buildUrl(src).url; promises.push(fetch(url).catch(function(){})); }
  await Promise.race([Promise.all(promises), new Promise(function(r){ setTimeout(r,1500); })]);
}

/* ── Quick setup wizard ──────────────────────────── */
function qsGetValue(){ return Math.floor(Math.random()*100)+1; }
function qsBuildUrlClassic(src,val){ return API+'/e?src='+encodeURIComponent(src)+'&type=test_event&value='+val; }

function qsUpdateLinkbox(){
  var src=$('#qsSrc').value.trim()||getSrc();
  var esc=escapeHtml;
  if(currentCase){
    var built=currentCase.buildUrl(src);
    $('#qsLinkbox').innerHTML='GET <span class="qs-param">'+esc(built.url)+'</span>';
    return { src:src, url:built.url, payload:built.payload, isCase:true };
  } else {
    var val=qsGetValue();
    var url=qsBuildUrlClassic(src,val);
    $('#qsLinkbox').innerHTML='GET <span class="qs-param">'+esc(url)+'</span>';
    return { src:src, val:val, url:url, isCase:false };
  }
}

function openCaseWizard(caseId){
  var c=cases.find(function(x){return x.id===caseId;});
  if(!c) return;
  currentCase=c;
  $('#qsSrc').value=getSrc();
  $('#qsModal').querySelector('h2').textContent='Попробовать: '+c.title;
  $('#qsModal').querySelector('.sub').textContent='Отправим событие «'+c.type+'» и покажем результат.';
  $('#qsStep1').querySelector('.step-title').textContent='Отправить событие «'+c.type+'»';
  $('#qsStep1').querySelector('.step-desc').innerHTML='Нажмите кнопку — событие будет отправлено на сервер.';
  qsUpdateLinkbox();
  $('#qsStep1').className='qs-step active';
  $('#qsStep2').style.opacity='0.4'; $('#qsStep2').style.pointerEvents='none';
  $('#qsSendBtn').disabled=false; $('#qsSendBtn').textContent='Отправить событие →';
  $('#qsSendResult').innerHTML='';
  $('#qsModal').classList.add('active');
}

/* ── Quick setup wizard bindings ─────────────────── */
(function(){
  var qsBtn=document.getElementById('btnQuickSetup');
  if(!qsBtn) return;
  qsBtn.onclick=function(){
    currentCase=null;
    $('#qsSrc').value=getSrc();
    $('#qsModal').querySelector('h2').textContent='Настроить в 2 клика';
    $('#qsModal').querySelector('.sub').textContent='Отправим тестовое событие.';
    $('#qsStep1').querySelector('.step-title').textContent='Отправить тестовое событие';
    $('#qsStep1').querySelector('.step-desc').innerHTML='Событие <code>test_event</code> с рандомным <code>value</code>.';
    qsUpdateLinkbox();
    $('#qsStep1').className='qs-step active';
    $('#qsStep2').style.opacity='0.4'; $('#qsStep2').style.pointerEvents='none';
    $('#qsSendBtn').disabled=false; $('#qsSendBtn').textContent='Отправить тестовое событие →';
    $('#qsSendResult').innerHTML='';
    $('#qsModal').classList.add('active');
  };
})();

$('#qsSrc').addEventListener('input',qsUpdateLinkbox);
$('#qsCloseBtn').onclick=function(){ $('#qsModal').classList.remove('active'); };

$('#qsSendBtn').onclick=async function(){
  var btn=this;
  var info=qsUpdateLinkbox();
  if(info.src!==getSrc()) setSrc(info.src);
  btn.disabled=true;
  btn.innerHTML='<span class="qs-spinner"></span> Отправка…';
  $('#qsSendResult').innerHTML='';
  try{
    var res=await fetch(info.url);
    if(!res.ok) throw new Error('HTTP '+res.status);
    $('#qsStep1').className='qs-step done';
    if(info.isCase){
      var summary=Object.entries(info.payload).map(function(kv){ return escapeHtml(kv[0])+'='+escapeHtml(String(kv[1])); }).join(', ');
      $('#qsSendResult').innerHTML='<div class="qs-result ok"><span class="qs-icon">✓</span> Записано ('+summary+')</div>';
    } else {
      $('#qsSendResult').innerHTML='<div class="qs-result ok"><span class="qs-icon">✓</span> Записано (value='+escapeHtml(String(info.val))+')</div>';
    }
    btn.disabled=false; btn.textContent='Отправить ещё раз →';
    $('#qsStep2').style.opacity=''; $('#qsStep2').style.pointerEvents=''; $('#qsStep2').classList.add('active');
  }catch(e){
    $('#qsSendResult').innerHTML='<div class="qs-result err"><span class="qs-icon">✕</span> Ошибка: '+escapeHtml(e.message)+'</div>';
    btn.disabled=false; btn.textContent='Попробовать снова →';
  }
};

$('#qsGoBtn').onclick=function(){
  var db=getActiveDashboard();
  if(currentCase){
    var existingTypes=new Set(db.panels.map(function(p){return p.type;}));
    var added=false;
    currentCase.panels.forEach(function(cfg){ if(!existingTypes.has(cfg.type)){ db.panels.push(Object.assign({id:uid('panel')},cfg)); added=true; } });
    if(added){ saveDashboards(getDashboards()); renderPanels(); }
  } else {
    if(!db.panels.length){
      addPanelFromConfig({ title:'Тестовые события (сумма value)', viz:'kpi', type:'test_event', group:'', field:'', agg:'sum', aggfield:'value', range:'24h', width:4, autorefresh:0 });
    }
  }
  $('#qsModal').classList.remove('active');
  location.hash='#dashboard';
};

/* ── "Попробовать" buttons ───────────────────────── */
document.addEventListener('click', async function(e){
  var btn=e.target.closest('.cc-btn[data-case]');
  if(!btn) return;
  var caseId=btn.dataset.case;
  var caseObj=cases.find(function(c){return c.id===caseId;});
  if(!caseObj) return;
  var origText=btn.textContent;
  btn.disabled=true;
  btn.innerHTML='<span class="qs-spinner"></span> Генерация демо…';
  var demoSrc='demo_'+caseId+'_'+Math.random().toString(36).substr(2,6);
  await seedMockData(demoSrc, caseId);
  var demoDashboard={ id:'temp_demo', name:'Демо: '+caseObj.title, panels:caseObj.panels.map(function(p){return Object.assign({},p,{id:uid('panel')});}) };
  var encoded=encodeDashboard(demoDashboard, demoSrc);
  location.hash='#view?d='+encodeURIComponent(encoded);
  btn.disabled=false; btn.textContent=origText;
});
