// Mockup shell: wraps <main id="content"> in sidebar + top bar + optional banner/tray + footer.
// <body data-page="upload" data-title="Încărcare" data-banner="warn|crit" data-banner-text="…" data-tray="1"
//       data-s3="down" data-role="Administrator" data-theme="dispecerat">
(function () {
  const I = {
    home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
    upload: '<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3"/>',
    files: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
    meter: '<circle cx="12" cy="13" r="8"/><path d="M12 13l4-4"/><path d="M8 3h8"/>',
    pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    policy: '<path d="M4 6h10M4 12h16M4 18h7"/><circle cx="17" cy="6" r="2"/><circle cx="14" cy="18" r="2"/>',
    audit: '<path d="M9 4h6v3H9z"/><path d="M7 5H5v16h14V5h-2"/><path d="M9 12h6M9 16h4"/>',
    bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
    stop: '<path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z"/><path d="M9 9l6 6M15 9l-6 6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
    pause: '<path d="M9 5v14M15 5v14"/>',
    play: '<path d="M7 4l13 8-13 8z"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    cloud: '<path d="M7 18a4 4 0 01-.5-8 6 6 0 0111.5 1.5A3.5 3.5 0 0117.5 18z"/><path d="M12 12v6M9.5 14.5L12 12l2.5 2.5"/>',
    drone: '<circle cx="5" cy="5" r="2.5"/><circle cx="19" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M7 7l3 3M17 7l-3 3M7 17l3-3M17 17l-3-3"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/>',
    fault: '<path d="M13 2L5 13h6l-1 9 8-12h-6z"/>',
    doc: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/><circle cx="10" cy="13" r="2"/><path d="M7 18c.6-1.6 1.7-2.3 3-2.3s2.4.7 3 2.3"/>',
    db: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    tower: '<path d="M12 2l-5 20M12 2l5 20M8.5 9h7M7.5 14h9M6 20h12M4 6h16"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    download: '<path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/>',
    map: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
  };
  window.ic = (n, cls) => `<svg class="i ${cls || ''}" viewBox="0 0 24 24" aria-hidden="true">${I[n] || ''}</svg>`;
  document.querySelectorAll('[data-i]').forEach(el => { el.insertAdjacentHTML('afterbegin', ic(el.dataset.i, el.dataset.iclass)); });

  const b = document.body.dataset;
  if (b.theme && !location.search.includes('light')) document.documentElement.dataset.theme = b.theme;
  const wordmark = `<svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">${[0,1,2].map(r => [0,1,2].map(c => {
    const k = r * 3 + c; const fill = k >= 7 ? 'var(--fg-brand-orange)' : (k % 2 ? 'var(--fg-brand-cyan)' : '#FFFFFF');
    return `<rect x="${c*10+1}" y="${r*10+1}" width="8" height="8" rx="2" fill="${fill}"/>`; }).join('')).join('')}</svg>`;
  const nav = [
    ['Monitorizare'],
    ['home', 'garantii', 'Garanții de business', '1'], ['meter', 'contoare', 'Contoare live'], ['pulse', 'observabilitate', 'Observabilitate'], ['chart', 'statistici', 'Statistici'],
    ['Fișiere'],
    ['upload', 'upload', 'Încărcare'], ['files', 'fisiere', 'Fișiere'],
    ['Administrare'],
    ['policy', 'politici', 'Politici'], ['audit', 'audit', 'Jurnal de audit'],
    ['Demo'],
    ['bolt', 'demo', 'Cameră de control']
  ].map(n => n.length === 1 ? `<div class="group">${n[0]}</div>` :
    `<a href="#" ${n[1] === b.page ? 'aria-current="page"' : ''}>${ic(n[0])}<span class="label">${n[2]}</span>${n[3] && b.banner ? `<span class="count">${n[3]}</span>` : ''}</a>`).join('');
  const s3down = b.s3 === 'down';
  const health = [['Postgres', '4 ms', false], ['S3', s3down ? 'căzut' : '11 ms', s3down], ['FTP', '23 ms', false]]
    .map(([n, l, d]) => `<span class="hchip ${d ? 'down' : ''}">${d ? ic('stop', 'sm') : '<span class="dot"></span>'}${n}<span class="lat">${l}</span></span>`).join('');
  const banner = b.banner ? `<div class="banner ${b.banner === 'crit' ? 'crit' : ''}" role="status">${ic(b.banner === 'crit' ? 'stop' : 'warn')}<span>${b.banner === 'crit' ? 'Garanție încălcată' : 'Garanție în pericol'}</span><span class="grow">${b.bannerText || ''}</span><a class="btn sm secondary" href="#">Vezi detalii</a></div>` : '';
  const tray = b.tray ? `<aside class="tray" aria-label="Încărcări în curs"><header>${ic('upload')}Încărcări<span class="meta" style="margin-left:auto">1 în curs · 1 verificat</span>${ic('down')}</header>
    <div class="item"><div class="row between"><b>Inspectie_LEA_110kV_Calarasi.mp4</b><span class="chip warn">${ic('warn')}Reconectare 6 s</span></div><div class="bar"><span style="width:58%"></span></div><div class="row between meta"><span>712 MB din 1,23 GB · pornit ca Echipă de teren</span><span>58 %</span></div></div>
    <div class="item"><div class="row between"><b>Avarie_PT_Medgidia_0412.pdf</b><span class="chip ok">${ic('check')}Verificat</span></div><div class="meta">Disponibil pentru dispecerat în 1,2 s</div></div></aside>` : '';
  const content = document.getElementById('content');
  const app = document.createElement('div'); app.className = 'app';
  app.innerHTML = `<nav class="sidebar" aria-label="Navigare principală"><a class="wordmark" href="#">${wordmark}<span><b>FileGrid</b><small>Fișiere de teren · Rețea</small></span></a><div class="nav">${nav}</div><div class="foot">Prototip FileGrid · Hackathon PPC</div></nav>
    <div class="main"><header class="topbar"><h1>${b.title || ''}</h1><span class="spacer"></span><div class="health" aria-label="Stare storage">${health}</div><span class="env">${ic('info', 'sm')}Demo · VPS</span><span class="role">Rol activ: ${b.role || 'Administrator'}${b.acting ? '<span class="tag">ROL DEMO</span>' : ''}${ic('down', 'sm')}</span><span class="avatar" aria-label="Utilizator: admin">AD</span></header>${banner}</div>`;
  document.body.prepend(app);
  const main = app.querySelector('.main');
  main.appendChild(content);
  main.insertAdjacentHTML('beforeend', `<footer class="footer"><span>Prototip FileGrid · Hackathon PPC</span><span>Nu este un produs oficial PPC sau Rețele Electrice România</span></footer>`);
  if (tray) document.body.insertAdjacentHTML('beforeend', tray);
})();
