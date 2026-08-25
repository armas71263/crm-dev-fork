// RubberTrack preview — data-driven SPA
const NAV = [
  { id: 'dashboard', label: 'Dashboard', ico: '◈', grp: 'Core' },
  { id: 'orders',    label: 'Order Records', ico: '▤' },
  { id: 'suppliers', label: 'Suppliers', ico: '◉' },
  { id: 'customers', label: 'Customers', ico: '◧' },
  { id: 'issues',    label: 'Issues', ico: '⚠' },
  { grp: 'Team' },
  { id: 'attendance', label: 'Attendance', ico: '⏱' },
  { grp: 'Control' },
  { id: 'news',      label: 'News Feed', ico: '◆' },
  { id: 'docs',      label: 'Doc Tools', ico: '▦' },
  { id: 'checklists', label: 'Checklists', ico: '✓' },
];

const DATA = {
  tenant: 'RubberTrack Demo',
  ticker: [
    ['TSR-20','$1.87/kg','+0.8%','up'], ['RSS-3','$2.24/kg','−0.3%','down'],
    ['Latex 60%','$2.31/kg','+1.2%','up'], ['SICOM 20','IDR 14,650/kg','+0.4%','up'],
    ['Cup Lump','THB 68.5','+2.1%','up'], ['Natural + Styrene','spread +0.5','+stable','up'],
  ],
  kpis: [
    { lbl:'Open Orders', val:37, sub:'+4 this week', dir:'up', c:'--amber' },
    { lbl:'Active MT', val:'612.4', sub:'across 19 FCL', dir:'up', c:'--teal' },
    { lbl:'Revenue (Aug)', val:'$1.28M', sub:'−2.1% vs Jul', dir:'down', c:'--green' },
    { lbl:'Open Issues', val:6, sub:'2 quality · 3 doc · 1 shipment', dir:'down', c:'--red' },
    { lbl:'Suppliers', val:12, sub:'4 TH · 4 ID · 3 MY · 1 VN', dir:'up', c:'--amber' },
    { lbl:'Customers', val:9, sub:'BKT · JK · MRF · CEAT +5', dir:'up', c:'--teal' },
  ],
  trendMonths: ['Mar','Apr','May','Jun','Jul','Aug'],
  trendMT:      [420, 486, 512, 588, 604, 612.4],
  trendRev:     [0.92, 1.04, 1.11, 1.24, 1.31, 1.28],
  grades: [
    { name:'TSR-20', mt:286.2, fcl:11 },
    { name:'RSS-3',  mt:201.6, fcl:8 },
    { name:'Latex 60%', mt:88.4, fcl:3 },
    { name:'SICOM 20', mt:36.2, fcl:2 },
  ],
  orders: [
    ['ORD-2026-0042','JK Tyre','Tiong Huat','TSR-20','100.8','4','$1,875','In Production','teal'],
    ['ORD-2026-0039','BKT','Lexley Rubber','T30M','50.4','2','$2,240','Docs Pending','amber'],
    ['ORD-2026-0038','MRF','Vietnam Rubber','RSS-3','100.8','4','$2,020','Shipped','green'],
    ['ORD-2026-0035','CEAT','SMR Malaysia','Latex 60%','21.0','1','$2,310','Docs Pending','amber'],
    ['ORD-2026-0031','Apollo','SICOM Indonesia','SICOM 20','16.0','1','$1,840','Quality Issue','red'],
    ['ORD-2026-0027','JK Tyre','Lexley Rubber','TSR-20','100.8','4','$1,890','Delivered','green'],
    ['ORD-2026-0022','BKT','Tiong Huat','RSS-3','50.4','2','$2,150','Delivered','green'],
  ],
  issues: [
    ['#Q-118','Quality','SMR moisture above spec (0.9%)','Open','red'],
    ['#Q-117','Quality','VOCB check failed on 2 lots','Open','red'],
    ['#D-204','Document','Missing COO for O-0035','Open','amber'],
    ['#D-203','Document','B/L amendment pending','Open','amber'],
    ['#S-071','Shipment','Vessel rollover ETA +9d','Monitoring','teal'],
    ['#S-067','Shipment','QA container damage (photos recvd)','Resolved','green'],
  ],
  feed: [
    ['⚡','Price alert: TSR-20 +0.8% on SICOM close','12m ago','danger'],
    ['◉','BKT requested revised PI for O-0038','40m ago'],
    ['⚠','Issue #Q-118 assigned to QA team','2h ago','danger'],
    ['✓','Docs complete: O-0031 cleared for shipping','5h ago'],
    ['▤','New order O-0042 created for JK Tyre','1d ago'],
  ],
  checklist: [
    ['Verify FFA % on 14_CL001 (must be < 1.0%)', false],
    ['Confirm HS Code 4001.10 with broker', true],
    ['Attach packing list (PDF ≤ 2MB) to PI', false],
    ['Request TDS/SDS from supplier', true],
    ['Log container seals in Doc Tools', false],
    ['Update Incoterms DAP → FOB quote', true],
  ],
  employees: [
    ['A. Checkout (Sales)','IN','IN','IN','OUT','IN'],
    ['B. Docs (Logistics)','IN','IN','IN','IN','IN'],
    ['C. Tech (QA)','OUT','IN','IN','IN','IN'],
    ['D. Ops (Admin)','IN','OUT','OUT','IN','OUT'],
    ['E. Finance','IN','IN','IN','IN','IN'],
  ],
  suppliers: ['Lexley Rubber (TH)','Tiong Huat (ID)','SMR Malaysia','Vietnam Rubber','SICOM Indonesia','PT Halcyon','Halycon Binh'],
  customers: ['BKT','JK Tyre','MRF','CEAT','Apollo','Titan Tires','Maxxis','Yokohama','TriDe'],
};

// ---------- Router ----------
const content = document.getElementById('content');
const navEl = document.getElementById('nav');
navEl.innerHTML = NAV.map(n => n.grp
  ? `<div class="grp">${n.grp}</div>`
  : `<a href="#/${n.id}" data-id="${n.id}"><span class="ico">${n.ico}</span>${n.label}</a>`).join('');

const bottomnav = document.getElementById('bottomnav');
const primary5 = ['dashboard','orders','issues','docs','checklists'];
bottomnav.innerHTML = primary5.map(id => {
  const n = NAV.find(x => x.id === id);
  return `<a href="#/${n.id}" data-id="${n.id}"><span class="ico">${n.ico}</span>${n.label.split(' ')[0]}</a>`;
}).join('');

function route(){
  const id = (location.hash.split('/')[1] || 'dashboard');
  const n = NAV.find(x => x.id === id) || {label:'Dashboard'};
  document.title = 'RubberTrack — ' + n.label;
  const title = document.getElementById('pageTitle');
  const crumb = document.getElementById('pageCrumb');
  if (title) title.textContent = n.label;
  if (crumb) crumb.textContent = DATA.tenant + ' · ' + n.label;
  render(id);
  document.querySelectorAll('.nav a, .bottomnav a').forEach(a => a.classList.toggle('active', a.dataset.id === id));
}
window.addEventListener('hashchange', route);

// ---------- Views ----------
const charts = [];
function render(id){
  charts.forEach(c => c.dispose()); charts.length = 0;
  content.innerHTML = VIEWS[id] ? VIEWS[id]() : VIEWS.dashboard();
  if (window.echarts) initCharts();
}
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function chartBase(){ return {
  textStyle:{fontFamily:'IBM Plex Mono',color:css('--muted')},
  grid:{left:8,right:14,top:26,bottom:6,containLabel:true},
};}
function initCharts(){
  document.querySelectorAll('[data-chart]').forEach(el => {
    const c = echarts.init(el, null, {renderer:'canvas'});
    c.setOption(CHARTS[el.dataset.chart]());
    charts.push(c);
  });
}
window.addEventListener('resize', () => charts.forEach(c => c.resize()));

const CHARTS = {
  trend: () => ({
    ...chartBase(),
    tooltip:{trigger:'axis'},
    legend:{data:['Volume (MT)','Revenue ($M)'],textStyle:{color:css('--muted')},top:0},
    xAxis:{type:'category',data:DATA.trendMonths,axisLine:{lineStyle:{color:css('--line')}}},
    yAxis:[{type:'value',axisLine:{show:false},splitLine:{lineStyle:{color:css('--line')}}},
           {type:'value',axisLine:{show:false},splitLine:{show:false}}],
    series:[
      {name:'Volume (MT)',type:'bar',data:DATA.trendMT,barWidth:16,
        itemStyle:{color:{type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:'#2dd4bf'},{offset:1,color:'#1a4f45'}]}}},
      {name:'Revenue ($M)',type:'line',yAxisIndex:1,data:DATA.trendRev,smooth:true,symbol:'circle',symbolSize:7,
        lineStyle:{color:css('--amber'),width:2.5},itemStyle:{color:css('--amber')}},
    ] }),
  grades: () => ({
    ...chartBase(),
    tooltip:{trigger:'axis'},
    xAxis:{type:'category',data:DATA.grades.map(g=>g.name),axisLabel:{color:css('--muted')},axisLine:{lineStyle:{color:css('--line')}}},
    yAxis:{type:'value',name:'MT',axisLine:{show:false},splitLine:{lineStyle:{color:css('--line')}}},
    series:[{type:'bar',data:DATA.grades.map(g=>g.mt),barWidth:22,
      itemStyle:{color:p=>['#f5a524','#2dd4bf','#8fd169','#f27171'][p.dataIndex]}}],
  }),
  issues: () => ({
    ...chartBase(),
    tooltip:{trigger:'item'},
    series:[{type:'pie',radius:['52%','78%'],itemStyle:{borderColor:'transparent'},
      label:{color:css('--muted')},
      data:[{name:'Quality',value:2,itemStyle:{color:'#f87171'}},
            {name:'Document',value:3,itemStyle:{color:'#f5a524'}},
            {name:'Shipment',value:1,itemStyle:{color:'#2dd4bf'}}],
    }],
  }),
};

const VIEWS = {
  dashboard: () => `
    <section class="kpis">${DATA.kpis.map(k=>`
      <div class="kpi" style="--c:var(${k.c})">
        <div class="lbl">${k.lbl}</div>
        <div class="val">${k.val}</div>
        <div class="sub"><span class="delta ${k.dir}">${k.dir==='down'?'▼':'▲'}</span> ${k.sub}</div>
      </div>`).join('')}</section>
    <section class="grid">
      <div class="card span-8"><h3>Volume &amp; Revenue — 6 months</h3><div class="chart" data-chart="trend"></div></div>
      <div class="card span-4"><h3>Active grades</h3><div class="chart" data-chart="grades"></div></div>
      <div class="card span-4"><h3>Issue mix</h3><div class="chart chart-sm" data-chart="issues"></div></div>
      <div class="card span-8"><h3>Recent orders</h3>${ordersTable(DATA.orders.slice(0,4))}</div>
      <div class="card span-6"><h3>Live feed</h3>${feedList(DATA.feed)}</div>
      <div class="card span-6"><h3>Open issues</h3>${issuesTable(DATA.issues.slice(0,5))}</div>
    </section>`,
  orders: () => `
    <div class="card span-12"><h3>Order Records — ${DATA.orders.length} open</h3>${ordersTable(DATA.orders)}</div>`,
  issues: () => `
    <section class="grid">
      <div class="card span-7"><h3>Issues</h3>${issuesTable(DATA.issues)}</div>
      <div class="card span-5"><h3>Issue mix</h3><div class="chart" data-chart="issues"></div></div>
    </section>`,
  attendance: () => `
    <div class="card span-12"><h3>Attendance — Week 34</h3>${attTable(DATA.employees)}</div>`,
  news: () => `
    <div class="card span-12"><h3>News Feed</h3>${feedList(DATA.feed.concat(DATA.feed.slice(0,4)))}</div>`,
  docs: () => `
    <div class="card span-12"><h3>Document Tools</h3>
      <p style="color:var(--muted);font-family:var(--font-m);font-size:12px">PI · PO · Invoice · B/L · COO · Packing List — attach, sign, version.</p>
      ${feedList([['▦','PI-2026-0042 signed (JK Tyre)','today'],['▦','B/L amendment requested (O-0035)','1d'],['▦','Packing list re-upload for O-0031','2d']])}</div>`,
  checklists: () => `
    <div class="card span-12"><h3>Checklists</h3><div class="check">${DATA.checklist.map(([t,done])=>
      `<label class="${done?'done':''}"><input type="checkbox" ${done?'checked':''}>${t}</label>`).join('')}</div></div>`,
  suppliers: () => `<div class="card span-12"><h3>Suppliers (${DATA.suppliers.length})</h3>${pillList(DATA.suppliers)}</div>`,
  customers: () => `<div class="card span-12"><h3>Customers (${DATA.customers.length})</h3>${pillList(DATA.customers)}</div>`,
};

const ordersTable = rows => `<table class="tbl">
  <thead><tr><th>Order</th><th>Customer</th><th>Supplier</th><th>Grade</th><th>MT</th><th>FCL</th><th>Price (USD)</th><th>Status</th></tr></thead>
  <tbody>${rows.map(r=>`<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td><td>${r[4]}</td><td>${r[5]}</td><td>${r[6]}</td><td><span class="tag ${r[8]}">${r[7]}</span></td></tr>`).join('')}</tbody></table>`;

const issuesTable = rows => `<table class="tbl">
  <thead><tr><th>ID</th><th>Type</th><th>Summary</th><th>Status</th></tr></thead>
  <tbody>${rows.map(r=>`<tr><td>${r[0]}</td><td><span class="tag ${r[4]}">${r[1]}</span></td><td style="font-family:var(--font-b)">${r[2]}</td><td>${r[3]}</td></tr>`).join('')}</tbody></table>`;

const feedList = items => `<div class="feed">${items.map(f=>`
  <div class="feed-item"><div class="ic">${f[0]}</div><div><div class="t">${f[1]}</div><div class="m">${f[2]}</div></div></div>`).join('')}</div>`;

const attTable = rows => `<table class="tbl">
  <thead><tr><th>Employee</th><th>Mon</th><th>Tue</th><th>Wed</th><th>Thu</th><th>Fri</th></tr></thead>
  <tbody>${rows.map(r=>`<tr><td style="font-family:var(--font-b)">${r[0]}</td>${r.slice(1).map(d=>`<td><span class="tag ${d==='IN'?'green':'red'}">${d}</span></td>`).join('')}</tr>`).join('')}</tbody></table>`;

const pillList = items => `<div style="display:flex;flex-wrap:wrap;gap:8px">${items.map(s=>`<span class="tag teal">${s}</span>`).join('')}</div>`;

// ---------- Ticker ----------
const track = document.getElementById('tickerTrack');
const items = DATA.ticker.map(([sym,p,chg,dir]) =>
  `<span><b>${sym}</b> ${p} <span class="${dir}">${chg}</span></span>`);
track.innerHTML = items.join('') + items.join(''); // duplicate for seamless loop

// ---------- Theme toggle ----------
document.getElementById('themeBtn').addEventListener('click', () => {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
  charts.forEach(c => c.dispose()); charts.length = 0;
  initCharts();
});

// ---------- Mobile menu ----------
const sidebar = document.getElementById('sidebar');
const scrim = document.getElementById('scrim');
document.getElementById('menuBtn').addEventListener('click', () => {
  sidebar.classList.toggle('open'); scrim.classList.toggle('on');
});
scrim.addEventListener('click', () => { sidebar.classList.remove('open'); scrim.classList.remove('on'); });
window.addEventListener('hashchange', () => { sidebar.classList.remove('open'); scrim.classList.remove('on'); });

// ---------- Search (demo) ----------
document.getElementById('globalSearch').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.value.trim()){
    content.innerHTML = `<div class="card span-12"><h3>Search: “${e.target.value}”</h3>
      <p style="color:var(--muted);font-family:var(--font-m);font-size:12px">Hybrid search (keyword + semantic) lands in Phase 2 — powered by pgvector + tsvector + trigram.</p></div>`;
  }
});

route();
