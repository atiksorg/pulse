/* ═══════════════════════════════════════════════════
   extras.js — hero playground, code examples, p5, config builder
   ═══════════════════════════════════════════════════ */

/* ── HERO PLAYGROUND (Live Demo) ─────────────────── */
(function initHeroPlayground(){
  var codeEl = document.getElementById('pg-url');
  var btn = document.getElementById('pg-send-btn');
  var canvas = document.getElementById('pg-chart');
  if(!codeEl || !canvas) return;

  function waitForChart(cb, attempts){
    attempts = attempts || 0;
    if(typeof Chart !== 'undefined'){ cb(); return; }
    if(attempts > 50){ console.warn('Chart.js not loaded'); canvas.parentElement.innerHTML='<div style="color:var(--muted-2);font-family:var(--mono);font-size:12px;padding:20px;">График недоступен</div>'; return; }
    setTimeout(function(){ waitForChart(cb, attempts + 1); }, 100);
  }
  waitForChart(function runPlayground(){
    var DEMO_SRC = 'hero_playground_' + Math.random().toString(36).substr(2,5);
    var ctx = canvas.getContext('2d');
    var MAX_POINTS = 24, labels = [], values = [];
    var now = Date.now();
    for(var i=MAX_POINTS;i>0;i--){ var t=new Date(now-i*2000); labels.push(t.toLocaleTimeString('ru-RU',{minute:'2-digit',second:'2-digit'})); values.push(null); }

    var chart = new Chart(ctx,{type:'line',data:{labels:labels,datasets:[{label:'value',data:values,borderColor:'#4DECC7',backgroundColor:'rgba(77,236,199,0.08)',borderWidth:2,tension:0.35,fill:true,pointBackgroundColor:'#4DECC7',pointRadius:3,pointHoverRadius:5,spanGaps:false}]},options:{responsive:true,maintainAspectRatio:false,animation:{duration:300},interaction:{intersect:false,mode:'index'},scales:{x:{grid:{color:'#1A2130'},ticks:{color:'#4E5768',font:{family:'JetBrains Mono',size:10},maxTicksLimit:8}},y:{grid:{color:'#1A2130'},ticks:{color:'#4E5768',font:{family:'JetBrains Mono',size:10}},beginAtZero:true,suggestedMax:100}},plugins:{legend:{display:false}}}});

    function randVal(){ return Math.floor(Math.random()*90)+10; }
    function updateCodeSnippet(val){ codeEl.textContent='https://events.atiks.org/e?src='+DEMO_SRC+'&type=action&value='+val; }

    setInterval(function(){ var t2=new Date(); labels.push(t2.toLocaleTimeString('ru-RU',{minute:'2-digit',second:'2-digit'})); values.push(null); if(labels.length>MAX_POINTS){labels.shift();values.shift();} chart.update('none'); },2000);
    setInterval(function(){ updateCodeSnippet(randVal()); },3000);

    btn.addEventListener('click', async function(){
      var val=randVal(); var url=API+'/e?src='+encodeURIComponent(DEMO_SRC)+'&type=action&value='+val;
      btn.disabled=true; btn.innerHTML='<span class="qs-spinner"></span> Отправка…'; updateCodeSnippet(val);
      try{ await fetch(url); var last=values.length-1; values[last]=val; chart.update(); btn.innerHTML='✓ 204 OK — записано!'; setTimeout(function(){ btn.innerHTML='<span class="pg-btn-icon">▶</span> Отправить ещё раз'; btn.disabled=false; },1500); }
      catch(e){ btn.innerHTML='✕ Ошибка: '+e.message; setTimeout(function(){ btn.innerHTML='<span class="pg-btn-icon">▶</span> Попробовать снова'; btn.disabled=false; },2000); }
    });
    updateCodeSnippet(randVal());
  });
})();

/* ── DOCS: code examples ─────────────────────────── */
var codeExamples = {
  "JavaScript": '<span class="c1">// fetch</span>\n<span class="k1">fetch</span>(<span class="s1">"'+API+'/e?src=my_app&type=purchase&amount=42"</span>);',
  "Python": '<span class="c1"># requests</span>\n<span class="k1">import</span> requests\nrequests.get(<span class="s1">"'+API+'/e"</span>, params={<span class="s1">"src"</span>: <span class="s1">"my_app"</span>, <span class="s1">"type"</span>: <span class="s1">"purchase"</span>, <span class="s1">"amount"</span>: 42})',
  "cURL": '<span class="c1"># GET</span>\ncurl <span class="s1">"'+API+'/e?src=my_app&type=purchase&amount=42"</span>',
  "PHP": '<span class="c1">// file_get_contents</span>\n$url = <span class="s1">"'+API+'/e?"</span> . http_build_query([<span class="s1">"src"</span> => <span class="s1">"my_app"</span>, <span class="s1">"type"</span> => <span class="s1">"purchase"</span>, <span class="s1">"amount"</span> => 42]);\nfile_get_contents($url);',
  "Go": '<span class="c1">// net/http</span>\nresp, _ := http.Get(<span class="s1">"'+API+'/e?src=my_app&type=purchase&amount=42"</span>)'
};
(function buildCodeTabs(){
  var tabsEl=$('#codeTabs'), bodyEl=$('#codeBody');
  var langs=Object.keys(codeExamples);
  langs.forEach(function(lang,i){
    var btn=document.createElement('button'); btn.className='code-tab'+(i===0?' active':''); btn.textContent=lang;
    btn.onclick=function(){ $$('.code-tab',tabsEl).forEach(function(b){b.classList.remove('active');}); $$('.code-panel',bodyEl).forEach(function(p){p.classList.remove('active');}); btn.classList.add('active'); $('#code-'+i).classList.add('active'); };
    tabsEl.appendChild(btn);
    var panel=document.createElement('div'); panel.className='code-panel'+(i===0?' active':''); panel.id='code-'+i; panel.innerHTML='<pre>'+codeExamples[lang]+'</pre>'; bodyEl.appendChild(panel);
  });
  var copyBtn=document.createElement('button'); copyBtn.className='code-copy-btn'; copyBtn.textContent='Копировать';
  copyBtn.onclick=function(){ var active=$$('.code-panel.active pre'); if(active.length){ navigator.clipboard.writeText(active[0].textContent).then(function(){copyBtn.textContent='Скопировано!';setTimeout(function(){copyBtn.textContent='Копировать';},1500);}); } };
  tabsEl.appendChild(copyBtn);
})();

/* ── P5 EFFECTS ──────────────────────────────────── */
(function initP5Effects(){
  if(typeof p5==='undefined') return;
  // На мобилке отключаем p5-частицы — они жрут батарею и CPU
  if(window.innerWidth < 860) return;
  var sketch=function(p){
    var particles=[], COUNT=32, MAX_DIST=140, mouseTrail=[];
    p.setup=function(){
      var canvas=p.createCanvas(p.windowWidth,p.windowHeight);
      canvas.parent(document.body); canvas.style('position','fixed'); canvas.style('top','0'); canvas.style('left','0'); canvas.style('z-index','0'); canvas.style('pointer-events','none'); canvas.style('opacity','0.35');
      p.colorMode(p.HSB,360,100,100,100);
      for(var i=0;i<COUNT;i++) particles.push({x:p.random(p.width),y:p.random(p.height),vx:p.random(-0.3,0.3),vy:p.random(-0.3,0.3),r:p.random(1.5,3),hue:p.random([160,190,35,280])});
    };
    p.windowResized=function(){ p.resizeCanvas(p.windowWidth,p.windowHeight); };
    p.draw=function(){
      p.clear();
      if(p.mouseX>0&&p.mouseY>0){ mouseTrail.push({x:p.mouseX,y:p.mouseY,age:0}); if(mouseTrail.length>8) mouseTrail.shift(); }
      mouseTrail.forEach(function(t){t.age++;});
      for(var i=0;i<particles.length;i++){
        var a=particles[i]; a.x+=a.vx; a.y+=a.vy;
        if(a.x<0||a.x>p.width) a.vx*=-1; if(a.y<0||a.y>p.height) a.vy*=-1;
        for(var j=i+1;j<particles.length;j++){ var b=particles[j], d=p.dist(a.x,a.y,b.x,b.y); if(d<MAX_DIST){ p.stroke(165,60,70,p.map(d,0,MAX_DIST,18,0)); p.strokeWeight(0.5); p.line(a.x,a.y,b.x,b.y); } }
        p.noStroke(); p.fill(a.hue,70,85,50); p.circle(a.x,a.y,a.r*2);
      }
      if(p.mouseX>0&&p.mouseY>0){ var glowR=120+p.sin(p.frameCount*0.03)*20; for(var r=glowR;r>0;r-=20){ p.noStroke(); p.fill(165,50,90,p.map(r,0,glowR,6,0)); p.circle(p.mouseX,p.mouseY,r*2); } }
    };
  };
  new p5(sketch);
})();

/* ── CONFIG BUILDER ──────────────────────────────── */
(function initConfigBuilder(){
  var editor=document.getElementById('configEditor');
  var panelsPreview=document.getElementById('configPreviewPanels');
  var statusEl=document.getElementById('configStatus');
  var addBtn=document.getElementById('configAddBtn');
  var resetBtn=document.getElementById('configReset');
  if(!editor) return;
  var DEFAULT_CONFIG=editor.value.trim();
  var lastParsedConfig=null;

  function updatePreview(){
    var raw=editor.value.trim();
    if(!raw){ panelsPreview.innerHTML=''; statusEl.textContent=''; statusEl.className='config-status'; addBtn.disabled=true; lastParsedConfig=null; return; }
    try{
      var config=JSON.parse(raw);
      if(!config.dashboard||!Array.isArray(config.dashboard.panels)) throw new Error('Отсутствует dashboard.panels');
      var panels=config.dashboard.panels;
      statusEl.textContent='✓ валидно · '+panels.length+' панелей'; statusEl.className='config-status ok';
      panelsPreview.innerHTML=panels.map(function(p){ return '<span class="config-panel-tag"><span class="cpt-viz">'+escapeHtml(p.viz||'?')+'</span><span class="cpt-title">'+escapeHtml(p.title||'—')+'</span></span>'; }).join('');
      lastParsedConfig=config; addBtn.disabled=false;
    }catch(e){ statusEl.textContent='✕ '+e.message; statusEl.className='config-status err'; panelsPreview.innerHTML=''; addBtn.disabled=true; lastParsedConfig=null; }
  }

  editor.addEventListener('input', updatePreview);
  addBtn.addEventListener('click', async function(){
    if(!lastParsedConfig) return;
    var sess = getSession();
    if (!sess) {
      toast('Войдите в кабинет, чтобы добавить панели');
      return;
    }
    var db = getActiveDashboard();
    if (!db) return;
    var panels=lastParsedConfig.dashboard.panels;
    var added=0;
    panels.forEach(function(p){ db.panels.push(Object.assign({id:uid('panel')},p)); added++; });
    try {
      await updateDashboardOnServer(db);
      renderPanels();
      toast('Добавлено панелей: '+added);
    } catch(e) {
      toast('Ошибка сохранения: ' + e.message);
    }
  });
  resetBtn.addEventListener('click', function(){ editor.value=DEFAULT_CONFIG; updatePreview(); toast('Шаблон восстановлен'); });
  editor.addEventListener('keydown', function(e){ if(e.key==='Tab'){ e.preventDefault(); var s=this.selectionStart, end=this.selectionEnd; this.value=this.value.substring(0,s)+'  '+this.value.substring(end); this.selectionStart=this.selectionEnd=s+2; updatePreview(); } });
  updatePreview();
})();
