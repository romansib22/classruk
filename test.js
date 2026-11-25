/*
 * Тест ядра на реальной выгрузке МЭШ: парсинг -> проверки -> экспорт -> повторный
 * парсинг экспортированного файла (roundtrip). Запуск: node test.js
 */
const assert = require('assert');
const fs = require('fs');
const C = require('./core.js');

async function toArrayBuffer(path) {
  const buf = fs.readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function main() {
  const xlsxPath = process.argv[2] || '../students_parents_list.xlsx';
  console.log('Файл:', xlsxPath);

  // --- 1. Парсинг выгрузки МЭШ
  const sheet = await C.parseXlsx(await toArrayBuffer(xlsxPath));
  const data = C.importMesh(sheet);

  console.log('Класс:', data.classLabel, '| учеников:', data.students.length);
  assert.strictEqual(data.classLabel, '5-А', 'класс из шапки');
  assert.strictEqual(data.students.length, 32, 'количество учеников');

  // Алфавитная сортировка по sortKey
  const sorted = [...data.students].sort((a, b) => C.sortKey(a.fullName).localeCompare(C.sortKey(b.fullName)));
  assert.deepStrictEqual(
    data.students.map((s) => s.fullName),
    sorted.map((s) => s.fullName),
    'список уже алфавитный (проверка сортировки)',
  );

  // --- 2. Первый ученик: контакты и родители
  const first = data.students[0];
  console.log('Первый:', JSON.stringify(first, null, 2));
  assert.ok(first.fullName.length > 3, 'ФИО ученика');
  assert.ok(/^\+7\d{10}$/.test(first.phone), 'телефон нормализован к +7: ' + first.phone);
  assert.strictEqual(first.phoneDisplay, '+7 916 208-41-77', 'отображение телефона');
  assert.ok(first.email && first.email.includes('@'), 'email ученика');
  assert.ok(first.parents.length >= 1, 'есть родители');
  assert.ok(/^\+7\d{10}$/.test(first.parents[0].phone), 'телефон родителя с +7');

  // --- 3. Ученик без email (в файле такие есть)
  const noEmail = data.students.filter((s) => !s.email).length;
  console.log('Без email:', noEmail, 'учеников');
  assert.ok(noEmail > 0, 'есть ученики без email');

  // --- 4. Поиск (та же логика, что в приложении)
  const withParents = data.students.map((s) => ({ student: s, parents: s.parents }));
  const check = (q) => withParents.filter((it) => C.searchMatches(it, q)).length;
  console.log('Поиск "барин" ->', check('барин'));
  assert.ok(check('Баринов') >= 1, 'поиск по фамилии ученика');
  assert.ok(check('баринова') >= 1, 'поиск по фамилии родителя');
  assert.ok(check('9162084177') === check('Баринов Владимир'), 'поиск по полному телефону');
  assert.ok(check('916') >= 1, 'поиск по части телефона (цифры)');
  assert.ok(check('vova-15bar') >= 1, 'поиск по части email');
  assert.strictEqual(check('несуществующеевключение'), 0, 'мусорный запрос — пусто');

  // --- 5. Экспорт и повторный импорт
  const rows = C.buildExportRows(data);
  assert.strictEqual(rows.length, 33, 'строки экспорта: шапка + 32');
  assert.deepStrictEqual(
    rows[0].slice(0, 6),
    ['ФИО ученика', 'Телефон', 'Email', 'ФИО родителя 1', 'Телефон', 'Email'],
    'шапка экспорта',
  );

  const xlsxBytes = C.buildXlsx(rows);
  fs.writeFileSync('/tmp/export_test.xlsx', xlsxBytes);
  console.log('Экспорт:', xlsxBytes.length, 'байт -> /tmp/export_test.xlsx');

  const reparsed = C.importMesh(await C.parseXlsx(await toArrayBuffer('/tmp/export_test.xlsx')));
  assert.strictEqual(reparsed.students.length, 32, 'roundtrip: количество');
  assert.strictEqual(reparsed.students[0].phone, first.phone, 'roundtrip: телефон 1-го');
  assert.strictEqual(reparsed.students[0].email, first.email, 'roundtrip: email 1-го');
  assert.strictEqual(reparsed.students[0].parents.length, first.parents.length, 'roundtrip: родители 1-го');
  assert.strictEqual(reparsed.students[0].parents[0].phone, first.parents[0].phone, 'roundtrip: телефон родителя');
  assert.strictEqual(reparsed.students[0].parents[0].email, first.parents[0].email, 'roundtrip: email родителя');

  console.log('\nOK: все проверки пройдены');
}

main().catch((e) => {
  console.error('ПРОВАЛ:', e.message);
  process.exit(1);
});
