/*
 * Классрук — ядро веб-версии. Порт логики Android-приложения (Kotlin) на JS.
 * Внешних зависимостей нет: zip читаем сами, XML — своим токенизатором,
 * распаковка — стандартным DecompressionStream.
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- XML ----

  /** Простой потоковый XML-токенизатор (аналог XmlPullParser из Android-версии). */
  function tokenizeXml(text) {
    const events = [];
    const pushText = (raw) => {
      if (raw.length > 0) events.push({ t: '#', text: decodeEntities(raw) });
    };
    let i = 0;
    const n = text.length;
    while (i < n) {
      const lt = text.indexOf('<', i);
      if (lt < 0) { pushText(text.slice(i)); break; }
      if (lt > i) pushText(text.slice(i, lt));
      if (text.startsWith('<!--', lt)) { i = text.indexOf('-->', lt) + 3; continue; }
      if (text.startsWith('<?', lt)) { i = text.indexOf('?>', lt) + 2; continue; }
      if (text.startsWith('<![CDATA[', lt)) {
        const end = text.indexOf(']]>', lt);
        events.push({ t: '#', text: text.slice(lt + 9, end) });
        i = end + 3;
        continue;
      }
      const gt = text.indexOf('>', lt);
      if (gt < 0) break;
      let inner = text.slice(lt + 1, gt).trim();
      if (inner.endsWith('/')) {
        emitStart(events, inner.slice(0, -1));
        events.push({ t: 'e', name: events[events.length - 1].name });
      } else if (inner.startsWith('/')) {
        events.push({ t: 'e', name: localName(inner.slice(1)) });
      } else {
        emitStart(events, inner);
      }
      i = gt + 1;
    }
    return events;
  }

  function emitStart(events, inner) {
    const sp = inner.search(/\s/);
    const name = sp < 0 ? inner : inner.slice(0, sp);
    const attrs = {};
    const rest = sp < 0 ? '' : inner.slice(sp);
    const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(rest)) !== null) {
      attrs[localName(m[1])] = m[2] !== undefined ? m[2] : m[3];
    }
    events.push({ t: 's', name: localName(name), attrs });
  }

  function localName(name) {
    const c = name.indexOf(':');
    return c < 0 ? name : name.slice(c + 1);
  }

  function decodeEntities(s) {
    return s
      .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  // ---------------------------------------------------------------- ZIP ----

  /** Читает центральную директорию zip: [{name, method, compSize, localOffset}]. */
  function zipDirectory(buffer) {
    const dv = new DataView(buffer);
    const len = buffer.byteLength;
    let eocd = -1;
    const minStart = Math.max(0, len - 65558);
    for (let i = len - 22; i >= minStart; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Файл не распознан (это не xlsx/zip)');
    const count = dv.getUint16(eocd + 10, true);
    const u8 = new Uint8Array(buffer);
    const decoder = new TextDecoder();
    const entries = [];
    let p = dv.getUint32(eocd + 16, true);
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOffset = dv.getUint32(p + 42, true);
      entries.push({
        name: decoder.decode(u8.subarray(p + 46, p + 46 + nameLen)),
        method,
        compSize,
        localOffset,
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  async function zipRead(buffer, entry) {
    const dv = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    const nameLen = dv.getUint16(entry.localOffset + 26, true);
    const extraLen = dv.getUint16(entry.localOffset + 28, true);
    const start = entry.localOffset + 30 + nameLen + extraLen;
    const raw = u8.subarray(start, start + entry.compSize);
    if (entry.method === 0) return raw.slice();
    if (entry.method === 8) return inflateRaw(raw);
    throw new Error('Неизвестный метод сжатия в zip: ' + entry.method);
  }

  async function inflateRaw(u8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Браузер устарел — нужен iOS 16.4+, Android 80+ или современный браузер');
    }
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ---------------------------------------------------------------- XLSX ----

  /** xlsx -> { rows: [[ячейки]] } (пропущенные ячейки == ''). */
  async function parseXlsx(arrayBuffer) {
    const dir = zipDirectory(arrayBuffer);
    const sharedEntry = dir.find((e) => e.name === 'xl/sharedStrings.xml');
    const sheetEntry = dir.find((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name));
    if (!sheetEntry) throw new Error('В файле не найден лист таблицы — это не xlsx?');
    const decoder = new TextDecoder();

    const shared = sharedEntry
      ? readSharedStrings(tokenizeXml(decoder.decode(await zipRead(arrayBuffer, sharedEntry))))
      : [];

    return readSheet(tokenizeXml(decoder.decode(await zipRead(arrayBuffer, sheetEntry))), shared);
  }

  function readSharedStrings(events) {
    const result = [];
    let inSi = false;
    let inT = false;
    let current = '';
    for (const ev of events) {
      if (ev.t === 's') {
        if (ev.name === 'si') { inSi = true; current = ''; }
        else if (ev.name === 't' && inSi) inT = true;
      } else if (ev.t === '#') {
        if (inSi && inT) current += ev.text;
      } else {
        if (ev.name === 't') inT = false;
        else if (ev.name === 'si') { inSi = false; result.push(current); }
      }
    }
    return result;
  }

  function readSheet(events, shared) {
    const rows = [];
    const cells = new Map();
    let maxCol = -1;
    let cellType = null;
    let cellCol = -1;
    let value = '';
    let inValue = false;
    let inInline = false;

    const closeCell = () => {
      if (cellCol >= 0) {
        const text = value.trim();
        cells.set(cellCol, cellType === 's' ? (shared[parseInt(text, 10)] || '') : text);
        if (cellCol > maxCol) maxCol = cellCol;
      }
      cellType = null;
      cellCol = -1;
      value = '';
    };
    const closeRow = () => {
      if (cells.size > 0) {
        const row = [];
        for (let c = 0; c <= maxCol; c++) row.push(cells.get(c) || '');
        rows.push(row);
        cells.clear();
        maxCol = -1;
      }
    };

    for (const ev of events) {
      if (ev.t === 's') {
        switch (ev.name) {
          case 'row': closeRow(); break;
          case 'c':
            cellType = ev.attrs['t'] || null;
            cellCol = columnIndex(ev.attrs['r']);
            break;
          case 'v': inValue = true; value = ''; break;
          case 'is': inInline = true; break;
          case 't': if (inInline) inValue = true; break;
        }
      } else if (ev.t === '#') {
        if (inValue) value += ev.text;
      } else {
        switch (ev.name) {
          case 'v': inValue = false; break;
          case 't': if (inInline) inValue = false; break;
          case 'is': inInline = false; break;
          case 'c': closeCell(); break;
          case 'row': closeRow(); break;
        }
      }
    }
    closeRow();
    return { rows };
  }

  /** 'B4' -> 1 (A = 0). */
  function columnIndex(ref) {
    if (!ref) return -1;
    let col = 0;
    for (const ch of ref) {
      const u = ch.toUpperCase();
      if (u < 'A' || u > 'Z') break;
      col = col * 26 + (u.charCodeAt(0) - 64);
    }
    return col - 1;
  }

  // ---------------------------------------------------------------- МЭШ ----

  const CLASS_LABEL_RE = /^\d{1,2}\s*[-–—]?\s*[А-ЯЁа-яё]$/;
  const EMAIL_PART_RE = /[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+/;

  /**
   * Разбор выгрузки МЭШ «Список детей и родителей» (контакты в одной ячейке:
   * телефон\nemail) и собственного экспорта приложения (телефон и email
   * в отдельных колонках).
   * Возвращает { classLabel, students: [{fullName, phone, phoneDisplay, email,
   * parents: [{fullName, phone, phoneDisplay, email}]}] }.
   */
  function importMesh(sheet) {
    const rows = sheet.rows;

    const headerRowIdx = rows.findIndex((row) => row.some(isStudentHeader));
    if (headerRowIdx < 0) {
      throw new Error('В файле нет колонки «ФИО учащегося» — это не выгрузка МЭШ');
    }
    const header = rows[headerRowIdx];
    const colStudent = header.findIndex(isStudentHeader);

    const h = (i) => normHeader(header[i] || '');
    // «Контакты учащегося» в одной ячейке (МЭШ) либо отдельные «Телефон»/«Email» (наш экспорт)
    const flatLayout = !h(colStudent + 1).includes('контакт') && h(colStudent + 1).includes('телефон');

    const parentCols = [];
    if (flatLayout) {
      let c = colStudent + 3;
      while (c < header.length && h(c).includes('фио') && h(c).includes('родител')) {
        parentCols.push({ nameCol: c, phoneCol: c + 1, emailCol: c + 2 });
        c += 3;
      }
    } else {
      let c = colStudent + 2;
      while (c < header.length && h(c).includes('родител') && !h(c).includes('контакт')) {
        parentCols.push({ nameCol: c, contactCol: c + 1 });
        c += 2;
      }
    }

    let classLabel = null;
    for (let r = 0; r < headerRowIdx; r++) {
      for (const cell of rows[r]) {
        if (CLASS_LABEL_RE.test(cell.trim())) { classLabel = cell.trim(); break; }
      }
      if (classLabel) break;
    }

    const students = [];
    for (let r = headerRowIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      const name = (row[colStudent] || '').trim();
      if (!name) continue;

      const studentContact = flatLayout
        ? contactsFromCells(row[colStudent + 1], row[colStudent + 2])
        : parseContacts(row[colStudent + 1]);

      const parents = [];
      for (const col of parentCols) {
        const parentName = (row[col.nameCol] || '').trim();
        if (!parentName) continue;
        const contact = 'phoneCol' in col
          ? contactsFromCells(row[col.phoneCol], row[col.emailCol])
          : parseContacts(row[col.contactCol]);
        parents.push({ fullName: parentName, ...contact });
      }
      students.push({ fullName: name, ...studentContact, parents });
    }
    if (students.length === 0) throw new Error('В файле не найден ни один ученик');

    return { classLabel, students };
  }

  function isStudentHeader(cell) {
    const h = normHeader(cell);
    return h.includes('фио') && (h.includes('учащ') || h.includes('ученик'));
  }

  /** Телефон и email из двух отдельных ячеек (формат собственного экспорта). */
  function contactsFromCells(phoneCell, emailCell) {
    const pRaw = String(phoneCell || '').trim();
    const phone = pRaw ? normalizePhone(pRaw) : null;
    const email = String(emailCell || '').trim() || null;
    return { phone, phoneDisplay: formatPhone(phone), email };
  }

  /** Ячейка контактов: телефон и/или email, обычно каждый на своей строке. */
  function parseContacts(cell) {
    let phone = null;
    let email = null;
    String(cell || '')
      .split(/[\n\r]+/)
      .forEach((rawLine) => {
        const line = rawLine.trim();
        if (!line) return;
        const emailMatch = EMAIL_PART_RE.exec(line);
        if (emailMatch) {
          if (!email) email = emailMatch[0];
          const rest = line.replace(emailMatch[0], '');
          if (!phone && rest.replace(/\D/g, '').length >= 10) phone = normalizePhone(rest);
        } else if (/\d/.test(line) && !phone) {
          phone = normalizePhone(line);
        }
      });
    return { phone, phoneDisplay: formatPhone(phone), email };
  }

  function normHeader(s) {
    return s.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
  }

  // ------------------------------------------------------------- Телефоны ----

  /** 9162084177 -> +79162084177 — номер сразу готов к tel:. */
  function normalizePhone(raw) {
    const digits = String(raw).replace(/\D/g, '');
    const trimmed = String(raw).trim();
    if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) return '+7' + digits.slice(1);
    if (digits.length === 10 && digits[0] === '9') return '+7' + digits;
    if (digits.length >= 7 && trimmed.startsWith('+')) return trimmed;
    if (digits.length >= 7) return digits;
    return null;
  }

  /** +79162084177 -> '+7 916 208-41-77'. */
  function formatPhone(normalized) {
    if (!normalized) return null;
    const m = /^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(normalized);
    return m ? `+7 ${m[1]} ${m[2]}-${m[3]}-${m[4]}` : normalized;
  }

  // --------------------------------------------------------------- Поиск ----

  /** Ключ сортировки: нижний регистр, ё -> е, схлопнутые пробелы. */
  function sortKey(name) {
    return name.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  }

  /**
   * Поиск по ученику и родителям: ФИО, телефон, email — частичное совпадение.
   * Телефон ищется по цифрам: «916» найдёт +7 916 208-41-77.
   */
  function searchMatches(item, rawQuery) {
    const q = sortKey(rawQuery);
    if (!q) return true;
    const qDigits = (rawQuery.match(/\d/g) || []).join('');

    const text = (s) => s != null && sortKey(s).includes(q);
    const phone = (p) => p != null && (
      sortKey(p).includes(q) || (qDigits.length >= 3 && p.replace(/\D/g, '').includes(qDigits))
    );

    const s = item.student;
    if (text(s.fullName) || text(s.email) || phone(s.phone) || phone(s.phoneDisplay)) return true;
    return item.parents.some((p) => text(p.fullName) || text(p.email) || phone(p.phone) || phone(p.phoneDisplay));
  }

  // ------------------------------------------------------- Экспорт в xlsx ----

  /**
   * Таблица экспорта: ФИО | Телефон | Email | ФИО родителя 1 | Телефон | Email | ...
   */
  function buildExportRows(data) {
    const maxParents = data.students.reduce((m, s) => Math.max(m, s.parents.length), 0);
    const header = ['ФИО ученика', 'Телефон', 'Email'];
    for (let i = 1; i <= maxParents; i++) {
      header.push(`ФИО родителя ${i}`, 'Телефон', 'Email');
    }
    const rows = [header];
    for (const s of data.students) {
      const row = [s.fullName, s.phone || '', s.email || ''];
      for (const p of s.parents) row.push(p.fullName, p.phone || '', p.email || '');
      while (row.length < header.length) row.push('');
      rows.push(row);
    }
    return rows;
  }

  /** rows -> байты xlsx (zip без сжатия, строки inlineStr). */
  function buildXlsx(rows) {
    const encoder = new TextEncoder();
    const files = [
      ['[Content_Types].xml', CONTENT_TYPES],
      ['_rels/.rels', ROOT_RELS],
      ['xl/workbook.xml', WORKBOOK],
      ['xl/_rels/workbook.xml.rels', WORKBOOK_RELS],
      ['xl/worksheets/sheet1.xml', sheetXml(rows)],
    ].map(([name, text]) => ({ name, data: encoder.encode(text) }));
    return buildZip(files);
  }

  function sheetXml(rows) {
    let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
    const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    if (cols > 0) {
      xml += '<cols>';
      for (let i = 0; i < cols; i++) {
        const width = i % 3 === 0 ? 34 : 24;
        xml += `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
      }
      xml += '</cols>';
    }
    xml += '<sheetData>';
    rows.forEach((row, rowIdx) => {
      xml += `<row r="${rowIdx + 1}">`;
      row.forEach((value, colIdx) => {
        if (value) {
          xml += `<c r="${colName(colIdx)}${rowIdx + 1}" t="inlineStr"><is><t>` +
            escapeXml(value) + '</t></is></c>';
        }
      });
      xml += '</row>';
    });
    xml += '</sheetData></worksheet>';
    return xml;
  }

  /** 0 -> A, 25 -> Z, 26 -> AA. */
  function colName(index) {
    let i = index;
    let out = '';
    while (i >= 0) {
      out = String.fromCharCode(65 + (i % 26)) + out;
      i = Math.floor(i / 26) - 1;
    }
    return out;
  }

  function escapeXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  const CONTENT_TYPES =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '</Types>';

  const ROOT_RELS =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const WORKBOOK =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Список" sheetId="1" r:id="rId1"/></sheets>' +
    '</workbook>';

  const WORKBOOK_RELS =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '</Relationships>';

  // ---------------------------------------------------------------- zip ----

  function crc32(u8) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) {
      let c = (crc ^ u8[i]) & 0xFF;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
      crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /** Сборка zip-архива методом STORE (без сжатия) — Excel такое открывает. */
  function buildZip(files) {
    const now = new Date();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = (((now.getFullYear() - 1980) & 0x7F) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    const chunks = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const nameB = new TextEncoder().encode(f.name);
      const crc = crc32(f.data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);          // version needed
      lh.setUint16(6, 0x0800, true);      // флаг: имена в UTF-8
      lh.setUint16(8, 0, true);           // метод: STORE
      lh.setUint16(10, time, true);
      lh.setUint16(12, date, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, f.data.length, true);
      lh.setUint32(22, f.data.length, true);
      lh.setUint16(26, nameB.length, true);
      lh.setUint16(28, 0, true);
      chunks.push(new Uint8Array(lh.buffer), nameB, f.data);
      central.push({ nameB, crc, size: f.data.length, offset });
      offset += 30 + nameB.length + f.data.length;
    }

    const centralStart = offset;
    for (const e of central) {
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, time, true);
      ch.setUint16(14, date, true);
      ch.setUint32(16, e.crc, true);
      ch.setUint32(20, e.size, true);
      ch.setUint32(24, e.size, true);
      ch.setUint16(28, e.nameB.length, true);
      ch.setUint32(42, e.offset, true);
      chunks.push(new Uint8Array(ch.buffer), e.nameB);
      offset += 46 + e.nameB.length;
    }

    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, central.length, true);
    eocd.setUint16(10, central.length, true);
    eocd.setUint32(12, offset - centralStart, true);
    eocd.setUint32(16, centralStart, true);
    chunks.push(new Uint8Array(eocd.buffer));

    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }

  // --------------------------------------------------------------- экспорт ----

  const ClassRukCore = {
    parseXlsx,
    importMesh,
    normalizePhone,
    formatPhone,
    sortKey,
    searchMatches,
    buildExportRows,
    buildXlsx,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ClassRukCore;
  } else {
    global.ClassRukCore = ClassRukCore;
  }
})(typeof window !== 'undefined' ? window : globalThis);
