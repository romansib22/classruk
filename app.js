/*
 * Классрук — интерфейс веб-версии: список, поиск, карточка, импорт/экспорт.
 * Логика (xlsx, МЭШ, телефоны, поиск) — в core.js.
 */
(function () {
  'use strict';

  const C = window.ClassRukCore;
  const STORE_KEY = 'classruk.v1';
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  // ----------------------------------------------------------------- svg ----

  const SVG = {
    search: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
    clear: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    chevron: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    phone: '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    mail: '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>',
    sms: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    copy: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    person: '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    school: '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m22 10-10-5L2 10l10 5 10-5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>',
    upload: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>',
  };

  // --------------------------------------------------------------- данные ----

  let state = loadState();
  let query = '';

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (Array.isArray(data.students)) {
          data.students.forEach((s, i) => { s.id = i + 1; });
          return { classLabel: data.classLabel || null, students: data.students };
        }
      }
    } catch (e) { /* повреждённые данные — начинаем с пустого списка */ }
    return { classLabel: null, students: [] };
  }

  function saveState() {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  }

  function bySortKey(a, b) {
    const ka = C.sortKey(a.fullName);
    const kb = C.sortKey(b.fullName);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  }

  // -------------------------------------------------------------utilites ----

  const $ = (sel) => document.querySelector(sel);

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function shortName(full) {
    const parts = String(full).split(/\s+/).filter(Boolean);
    if (parts.length < 2) return full;
    const initials = parts.slice(1).map((p) => (p[0] ? p[0] + '.' : '')).filter(Boolean);
    return [parts[0], ...initials].join(' ');
  }

  function initials(full) {
    return String(full).split(/\s+/).filter(Boolean).slice(0, 2)
      .map((p) => (p[0] || '').toUpperCase()).join('');
  }

  let toastTimer = null;
  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  /** confirm в стиле приложения; возвращает Promise<boolean>. */
  function confirmDialog(title, text, okLabel) {
    return new Promise((resolve) => {
      const backdrop = $('#modal');
      backdrop.innerHTML =
        '<div class="modal" role="dialog"><h3>' + esc(title) + '</h3><p>' + esc(text) + '</p>' +
        '<div class="row"><button data-act="no">Отмена</button>' +
        '<button data-act="yes">' + esc(okLabel || 'ОК') + '</button></div></div>';
      backdrop.hidden = false;
      backdrop.onclick = (e) => {
        const act = e.target.getAttribute && e.target.getAttribute('data-act');
        if (act || e.target === backdrop) {
          backdrop.hidden = true;
          backdrop.innerHTML = '';
          resolve(act === 'yes');
        }
      };
    });
  }

  function copyText(value, label) {
    const done = () => toast((label || 'Значение') + ' скопирован');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done, () => fallbackCopy(value, done));
    } else {
      fallbackCopy(value, done);
    }
  }

  function fallbackCopy(value, done) {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('Не удалось скопировать'); }
    document.body.removeChild(ta);
  }

  // -------------------------------------------------------------- роутинг ----

  function route() {
    const m = /^#\/student\/(\d+)$/.exec(location.hash);
    return m ? { screen: 'card', id: parseInt(m[1], 10) } : { screen: 'list' };
  }

  function render() {
    const r = route();
    const main = $('#main');
    if (r.screen === 'card') {
      renderCard(main, r.id);
    } else {
      renderListScreen(main);
    }
    $('#btnBack').hidden = r.screen !== 'card';
    updateTitle();
    refreshButtons();
  }

  function updateTitle() {
    const r = route();
    if (r.screen === 'card') {
      const s = state.students.find((x) => x.id === r.id);
      $('#title').textContent = s ? s.fullName : '';
    } else {
      $('#title').textContent = state.classLabel || 'Классрук';
    }
  }

  function refreshButtons() {
    $('#btnExport').disabled = state.students.length === 0;
  }

  // ------------------------------------------------------------ экран списка ----

  function renderListScreen(main) {
    main.innerHTML =
      '<div class="search-wrap">' + SVG.search.replace('<svg ', '<svg class="lead" ') +
      '<input id="searchInput" type="search" autocomplete="off" placeholder="Поиск: ФИО, телефон, email" value="' + esc(query) + '">' +
      (query ? '<button id="clearSearch" class="icon-btn" aria-label="Очистить">' + SVG.clear + '</button>' : '') +
      '</div>' +
      '<div id="progress" class="progress" hidden></div>' +
      '<div id="list"></div>';

    const input = $('#searchInput');
    input.addEventListener('input', () => {
      query = input.value;
      const clearBtn = $('#clearSearch');
      if (query && !clearBtn) {
        const b = document.createElement('button');
        b.id = 'clearSearch';
        b.className = 'icon-btn';
        b.setAttribute('aria-label', 'Очистить');
        b.innerHTML = SVG.clear;
        b.onclick = () => { query = ''; render(); };
        $('.search-wrap').appendChild(b);
      } else if (!query && clearBtn) {
        clearBtn.remove();
      }
      renderList();
    });
    const clearBtn = $('#clearSearch');
    if (clearBtn) clearBtn.onclick = () => { query = ''; render(); };

    renderList();
  }

  function renderList() {
    const list = $('#list');
    if (!list) return;

    if (state.students.length === 0) {
      list.innerHTML =
        '<div class="empty">' + SVG.school +
        '<h2>Список класса пуст</h2>' +
        '<p>Импортируйте выгрузку МЭШ —<br>файл .xlsx «Список детей и родителей»</p>' +
        '<button class="btn" id="btnEmptyImport">' + SVG.upload + 'Импортировать из МЭШ</button></div>';
      $('#btnEmptyImport').onclick = () => $('#fileInput').click();
      return;
    }

    const q = query.trim();
    const items = q
      ? state.students.filter((s) => C.searchMatches({ student: s, parents: s.parents }, q))
      : state.students;

    if (items.length === 0) {
      list.innerHTML = '<div class="empty"><p>Ничего не найдено</p></div>';
      return;
    }

    list.innerHTML = items.map((s) =>
      '<a class="card student-card" href="#/student/' + s.id + '">' +
      '<div class="body"><div class="name">' + esc(s.fullName) + '</div>' +
      (s.parents.length
        ? '<div class="parents">' + esc(s.parents.map((p) => shortName(p.fullName)).join(', ')) + '</div>'
        : '') +
      '</div>' + SVG.chevron + '</a>'
    ).join('');
  }

  // ----------------------------------------------------------- экран карточки ----

  function contactRow(kind, contact) {
    const icon = kind === 'phone' ? SVG.phone : SVG.mail;
    if (!contact.value) {
      return '<div class="contact missing">' + icon.replace('<svg ', '<svg class="lead" ') +
        '<div class="body"><div class="label">' + (kind === 'phone' ? 'Телефон' : 'Email') + ' не указан</div></div></div>';
    }
    const href = kind === 'phone' ? 'tel:' + encodeURIComponent(contact.raw) : 'mailto:' + encodeURIComponent(contact.value);
    const actions = kind === 'phone'
      ? '<a class="icon-btn" href="sms:' + encodeURIComponent(contact.raw) + '" aria-label="SMS">' + SVG.sms + '</a>'
      : '';
    return '<a class="contact" href="' + href + '">' +
      icon.replace('<svg ', '<svg class="lead" ') +
      '<div class="body"><div class="label">' + (kind === 'phone' ? 'Телефон' : 'Email') + '</div>' +
      '<div class="value">' + esc(contact.value) + '</div></div>' +
      '<div class="actions">' + actions +
      '<button class="icon-btn copy-btn" data-copy="' + esc(contact.value) + '" aria-label="Копировать">' + SVG.copy + '</button>' +
      '</div></a>';
  }

  function personContacts(person, withName) {
    const rows = [
      contactRow('phone', { value: person.phoneDisplay || person.phone, raw: person.phone }),
      '<div class="divider"></div>',
      contactRow('mail', { value: person.email, raw: person.email }),
    ];
    if (withName) {
      return '<div class="parent-name">' + SVG.person + '<div class="name">' + esc(person.fullName) + '</div></div>' + rows.join('');
    }
    return rows.join('');
  }

  function renderCard(main, id) {
    const s = state.students.find((x) => x.id === id);
    if (!s) {
      location.hash = '';
      return;
    }

    main.innerHTML =
      '<div class="card header-card">' +
      '<div class="avatar">' + esc(initials(s.fullName)) + '</div>' +
      '<div class="info"><div class="name">' + esc(s.fullName) + '</div>' +
      (state.classLabel ? '<div class="klass">Класс ' + esc(state.classLabel) + '</div>' : '') +
      '</div></div>' +

      '<div class="section">Контакты ученика</div>' +
      '<div class="card">' + personContacts(s, false) + '</div>' +

      '<div class="section">Родители</div>' +
      (s.parents.length
        ? s.parents.map((p) => '<div class="card">' + personContacts(p, true) + '</div>').join('')
        : '<div style="margin:0 4px; font-size:14px; color:var(--on-surface-variant)">Родители не указаны</div>');

    main.querySelectorAll('.copy-btn').forEach((btn) => {
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const isPhone = btn.closest('.contact').querySelector('.label').textContent.includes('Телефон');
        copyText(btn.getAttribute('data-copy'), isPhone ? 'Телефон' : 'Email');
      };
    });
  }

  // ---------------------------------------------------------- импорт/экспорт ----

  async function importFile(file) {
    const progress = $('#progress');
    if (progress) progress.hidden = false;
    try {
      const buffer = await file.arrayBuffer();
      const sheet = await C.parseXlsx(buffer);
      const parsed = C.importMesh(sheet);

      if (state.students.length > 0) {
        const ok = await confirmDialog(
          'Заменить данные класса?',
          'Текущий список (' + state.students.length + ' уч.) будет удалён и загружен заново из выбранного файла.',
          'Заменить',
        );
        if (!ok) return;
      }

      state = {
        classLabel: parsed.classLabel || state.classLabel,
        students: parsed.students.slice().sort(bySortKey).map((s, i) => ({ id: i + 1, ...s })),
      };
      saveState();
      query = '';
      render();
      toast('Импортировано учеников: ' + state.students.length);
    } catch (e) {
      toast('Ошибка импорта: ' + (e.message || 'файл не распознан'));
    } finally {
      const p = $('#progress');
      if (p) p.hidden = true;
    }
  }

  function exportXlsx() {
    if (state.students.length === 0) { toast('Список класса пуст'); return; }
    try {
      const rows = C.buildExportRows({ students: state.students });
      const bytes = C.buildXlsx(rows);
      const blob = new Blob([bytes], { type: XLSX_MIME });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (state.classLabel ? 'Класс ' + state.classLabel : 'Класс') + '.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      toast('Экспортировано учеников: ' + state.students.length);
    } catch (e) {
      toast('Ошибка экспорта: ' + (e.message || ''));
    }
  }

  // ------------------------------------------------------------------ init ----

  $('#btnBack').onclick = () => { history.back(); };
  $('#btnImport').onclick = () => $('#fileInput').click();
  $('#btnExport').onclick = exportXlsx;
  $('#fileInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // чтобы повторный выбор того же файла тоже вызвал change
    if (file) importFile(file);
  });
  window.addEventListener('hashchange', render);

  render();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* офлайн не критичен */ });
  }
})();
