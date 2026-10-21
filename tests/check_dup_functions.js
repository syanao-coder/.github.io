/* 同名の関数宣言が2つ以上ないかを調べる（★2026-10-21 debug_suite v1.19.1 で新設）。
   関数宣言は巻き上げで後の方が勝ち、前の方は黙って消える（testS1・moveMouseTo で実際に起きた）。
   使い方: node tests/check_dup_functions.js [ファイル…]（既定は debug_suite.js）。重複があれば終了コード 1。 */
const fs = require('fs');
const path = require('path');
const files = process.argv.slice(2);
if (!files.length) files.push(path.join(__dirname, '..', 'debug_suite.js'));
let bad = 0;
files.forEach(function (file) {
    const s = fs.readFileSync(file, 'utf8');
    const c = {};
    [...s.matchAll(/^\s*(?:async\s+)?function\s+(\w+)\s*\(/gm)].forEach(function (m) { c[m[1]] = (c[m[1]] || 0) + 1; });
    const dup = Object.entries(c).filter(function (e) { return e[1] > 1; });
    console.log(path.basename(file) + ':', dup);
    bad += dup.length;
});
process.exit(bad ? 1 : 0);
