'use strict';
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const filePath = process.argv[2];
const content = fs.readFileSync(filePath, 'utf8');
const rows = parse(content, {
  relax_quotes: true,
  relax_column_count: true,
  skip_empty_lines: false,
  quote: '"',
  escape: '"',
});
console.log('総行数:', rows.length);
for (let i = 0; i < Math.min(rows.length, 20); i++) {
  const a = (rows[i][0] || '').trim().slice(0, 70);
  const b = (rows[i][1] || '').trim().slice(0, 50);
  console.log(`row[${i}] A=${JSON.stringify(a)}`);
  if (b) console.log(`       B=${JSON.stringify(b)}`);
}
