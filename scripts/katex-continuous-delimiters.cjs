/* Extend KaTeX 0.16's single-SVG tall delimiters to the curly family.
 * Run after replacing vendor/katex.min.js with an upstream distribution.
 * Curves derive from KaTeX_Size4 U+23A7/U+23A8/U+23A9 (MIT, see KaTeX.LICENSE.txt).
 * Joining ends are removed: straight sides and curves form ONE closed contour,
 * rather than independently rasterized font glyphs and SVG extender rectangles.
 */
const fs = require('node:fs');
const path = require('node:path');

function continuousCurlyPath(label, height) {
  const [right, hasMiddle] = label.slice(10).split('').map(Number);
  const center = height / 2;
  const commands = [];
  // KaTeX_Size4 has a 0.88889em advance; the stem is x=384..504.
  const add = (right, origin, direction, parts) => {
    for (const [command, ...points] of parts) {
      commands.push(command + points.map((n, i) => i % 2
        ? origin + direction * n : right ? 888 - n : n).join(' '));
    }
  };
  add(right, 0, 1, [
    ['M',712,0],['L',718,6],['L',718,23],
    ['Q',718,42,717,43],['Q',711,49,704,53],
    ['Q',627,106,576.5,189.5],['Q',526,273,510,374],
    ['Q',510,375,509,378],['Q',505,406,504,550],['L',504,565],
  ]);
  if (hasMiddle) {
    const inner = [
      ['L',504,-674],['Q',504,-441,503,-432],
      ['Q',492,-275,396,-148],['Q',332,-64,229,0],
      ['Q',235,4,243,9],['Q',373,89,442,220],
      ['Q',496,320,503,432],['Q',504,441,504,674],
    ];
    add(right, center, 1, inner);
  }
  // Lower inner edge, bottom tip, then lower outer edge (vertical reflection).
  add(right, height, -1, [
    ['L',504,565],['Q',504,555,504,550],['Q',505,406,509,378],
    ['Q',510,375,510,374],['Q',526,273,576.5,189.5],
    ['Q',627,106,704,53],['Q',711,49,717,43],['Q',718,42,718,23],
    ['L',718,6],['L',712,0],['L',677,0],['L',664,7],
    ['Q',596,45,546,92],['Q',397,236,385,423],['Q',384,432,384,669],
  ]);
  if (hasMiddle) {
    const outer = [
      ['L',384,675],['Q',384,441,383,429],
      ['Q',367,166,183,29],['Q',171,20,171,18],['L',170,15],
      ['L',170,-15],['L',171,-18],['Q',171,-20,183,-29],
      ['Q',272,-96,324,-199],['Q',376,-302,383,-429],['L',384,-675],
    ];
    add(right, center, 1, outer);
  }
  add(right, 0, 1, [
    ['L',384,669],['Q',384,432,385,423],['Q',397,236,546,92],
    ['Q',596,45,664,7],['L',677,0],
  ]);
  return commands.join(' ') + ' Z';
}

const file = path.resolve(__dirname, '../php-site/assets/vendor/katex.min.js');
let source = fs.readFileSync(file, 'utf8');
if (source.includes('function continuousCurlyPath(')) process.exit(0);
if (require(file).version !== '0.16.9') throw new Error('Review delimiter geometry before applying to a new KaTeX version');
const replace = (before, after) => {
  if (source.split(before).length !== 2) throw new Error('KaTeX changed; review the continuous delimiter integration: ' + before);
  source = source.replace(before, after);
};
replace('var d=lr(o,p,a)', 'if(h==="\\u23aa"&&((o==="\\u23a7"&&c==="\\u23a9")||(o==="\\u23ab"&&c==="\\u23ad"))){m="sps-curly-"+(o==="\\u23ab"?1:0)+(s===null?0:1);u=888.89}var d=lr(o,p,a)');
replace('q=function(e,t){switch(e)', 'q=function(e,t){if(e.indexOf("sps-curly-")===0)return continuousCurlyPath(e,N);switch(e)');
replace('dr={type:"kern",size:-.008}', 'continuousCurlyPath=' + continuousCurlyPath.toString() + ',dr={type:"kern",size:-.008}');
fs.writeFileSync(file, source);
