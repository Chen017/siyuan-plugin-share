// Isolated DOM regression for copying rendered reader selections as standard Markdown.
// NODE_PATH=/path/to/node_modules node tests/markdown-copy.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, VirtualConsole} = require('jsdom');

const assets = path.join(__dirname, '../php-site/assets');
const app = fs.readFileSync(process.env.SPS_TEST_APP || path.join(assets, 'app.js'), 'utf8');
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const core = [
  'markdown-it.min.js', 'markdown-it-task-lists.min.js',
  'markdown-it-emoji.min.js', 'markdown-it-footnote.min.js',
  'markdown-it-deflist.min.js', 'markdown-it-mark.min.js',
  'markdown-it-sub.min.js', 'markdown-it-sup.min.js', 'markdown-it-abbr.min.js',
  'markdown-it-ins.min.js', 'markdown-it-container.min.js',
  'markdown-it-anchor.min.js', 'katex.min.js', 'highlight.min.js',
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition, message) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await delay(20);
  }
}

async function createPage(rawMarkdown, {
  bodyClass = 'layout-share',
  title = 'Article Title',
  includeHeader = false,
  mockDiagrams = false,
} = {}) {
  const headerHtml = includeHeader
    ? `<div class="kb-header"><div class="kb-breadcrumbs"><a class="kb-back" href="/s/test">Library</a><span>Folder</span></div><div class="kb-title-row"><h1 class="kb-title">${escapeHtml(title)}</h1><div class="share-document-actions"><button type="button" data-share-toggle><span data-share-toggle-label>Source</span></button><a href="/s/test/export">Export PDF</a></div></div></div>`
    : '';
  const mainHtml = `<div class="kb-main" role="main"><div class="share-article" data-share-view="preview">${headerHtml}<div class="markdown-body" data-md-id="doc"></div><textarea class="markdown-source" data-md-id="doc">${escapeHtml(rawMarkdown)}</textarea></div></div>`;
  const dom = new JSDOM(
    `<body class="${bodyClass}"><div class="share-shell"><aside class="kb-sidebar" data-share-sidebar><div data-share-tabs data-share-default="toc"><button data-share-tab="toc">Contents</button></div><div data-share-panel="toc"><div data-share-toc="doc"></div></div></aside>${mainHtml}<footer class="share-footer">Footer credit</footer></div><input id="outside-input" value="input text"><p class="reader-status sr-only" data-reader-status></p><script src="https://reader.test/assets/app.js?v=fixture"></script></body>`,
    {
      url: 'https://reader.test/s/test/doc1',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      virtualConsole: new VirtualConsole(),
    }
  );
  const w = dom.window;
  const d = w.document;
  const errors = [];
  w.console.error = (err) => errors.push(err);
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLElement.prototype.scrollTo = () => {};
  w.matchMedia = () => ({matches: false, addEventListener() {}, addListener() {}});
  w.requestIdleCallback = (fn) => w.setTimeout(fn, 0);
  w.SVGElement.prototype.getBBox = () => ({x: 0, y: 0, width: 100, height: 50});
  for (const file of core) w.eval(fs.readFileSync(path.join(assets, 'vendor', file), 'utf8'));

  if (mockDiagrams) {
    const append = d.head.appendChild.bind(d.head);
    const svg = () => d.createElementNS('http://www.w3.org/2000/svg', 'svg');
    d.head.appendChild = (node) => {
      const result = append(node);
      if (node.tagName !== 'SCRIPT') return result;
      const file = new URL(node.src).pathname.split('/').pop();
      w.setTimeout(() => {
        switch (file) {
          case 'mermaid.min.js':
            w.mermaid = {initialize() {}, render: async () => ({svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>diagram</text></svg>'})};
            break;
          case 'echarts.min.js':
            w.echarts = {init: () => ({setOption() {}, resize() {}})};
            break;
          case 'abcjs-basic-min.js':
            w.ABCJS = {renderAbc: (id) => d.getElementById(id).appendChild(svg())};
            break;
          case 'viz.js':
            w.Viz = function () { this.renderSVGElement = async () => svg(); };
            break;
          case 'full.render.js':
            w.Viz.render = () => {};
            w.Viz.Module = () => {};
            break;
          case 'raphael.min.js':
            w.Raphael = () => {};
            break;
          case 'flowchart.min.js':
            w.flowchart = {parse: () => ({drawSVG: (id) => d.getElementById(id).appendChild(svg())})};
            break;
          default:
            break;
        }
        node.onload();
      }, 0);
      return result;
    };
  }

  w.eval(app);
  await waitFor(() => d.querySelector('.markdown-body')?.dataset.spsRendered === '1', 'markdown rendered');
  if (mockDiagrams) {
    await delay(50);
  }

  const copyRange = (range, target = d.body) => {
    const sel = w.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const data = {};
    const event = new w.Event('copy', {bubbles: true, cancelable: true});
    Object.defineProperty(event, 'clipboardData', {
      value: {
        setData(type, val) { data[type] = val; },
        getData(type) { return data[type] || ''; },
      },
    });
    target.dispatchEvent(event);
    return {
      prevented: event.defaultPrevented,
      text: data['text/plain'] ?? null,
      data,
    };
  };

  const selectAll = (el) => {
    const r = d.createRange();
    r.selectNodeContents(el);
    return r;
  };

  const findTextNode = (root, substr) => {
    const walker = d.createTreeWalker(root, w.NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if ((node.nodeValue || '').includes(substr)) return node;
    }
    throw new Error(`Text node containing ${JSON.stringify(substr)} not found`);
  };

  return {w, d, errors, copyRange, selectAll, findTextNode, close: () => w.close()};
}

(async () => {
  // 1. User's exact example + KaTeX boundary snapping cases
  {
    const src = [
      'Since $F$ and $\\overline{X}$ are differentiable, $H$ is differentiable.',
      '',
      'For every $z \\in V \\cap S$, define something.',
    ].join('\n');
    const p = await createPage(src);
    try {
      const body = p.d.querySelector('.markdown-body');
      const paras = body.querySelectorAll('p');
      const rUser = p.d.createRange();
      const startNode = p.findTextNode(paras[0], 'Since');
      const endNode = p.findTextNode(paras[1], 'define something.');
      rUser.setStart(startNode, 0);
      rUser.setEnd(endNode, ', defin'.length);
      const resUser = p.copyRange(rUser);
      assert.equal(resUser.prevented, true);
      assert.equal(
        resUser.text,
        'Since $F$ and $\\overline{X}$ are differentiable, $H$ is differentiable.\n\nFor every $z \\in V \\cap S$, defin'
      );

      // Start inside .katex-html of \overline{X}
      const katexList = paras[0].querySelectorAll('.katex');
      const rMidStart = p.d.createRange();
      const xHtmlText = p.findTextNode(katexList[1].querySelector('.katex-html'), 'X');
      const diffNode = p.findTextNode(paras[0], 'are differentiable');
      rMidStart.setStart(xHtmlText, 0);
      rMidStart.setEnd(diffNode, diffNode.nodeValue.indexOf('are differentiable') + 'are differentiable'.length);
      assert.equal(p.copyRange(rMidStart).text, '$\\overline{X}$ are differentiable');

      // Start at trailing end of .katex-html of $F$ -> should NOT include $F$
      const fHtml = katexList[0].querySelector('.katex-html');
      const rTrailingStart = p.d.createRange();
      rTrailingStart.setStart(fHtml, fHtml.childNodes.length);
      rTrailingStart.setEnd(p.findTextNode(paras[0], ' and '), ' and'.length);
      assert.equal(p.copyRange(rTrailingStart).text, 'and');

      // End inside .katex-html of $H$ -> includes $H$
      const diffCommaNode = p.findTextNode(paras[0], 'differentiable, ');
      const diffStart = diffCommaNode.nodeValue.indexOf('differentiable, ');
      const hHtmlText = p.findTextNode(katexList[2].querySelector('.katex-html'), 'H');
      const rMidEnd = p.d.createRange();
      rMidEnd.setStart(diffCommaNode, diffStart);
      rMidEnd.setEnd(hHtmlText, 1);
      assert.equal(p.copyRange(rMidEnd).text, 'differentiable, $H$');

      // End at offset 0 of .katex-mathml and offset 0 of .katex-html -> should NOT include $H$
      const hMathml = katexList[2].querySelector('.katex-mathml');
      const hHtml = katexList[2].querySelector('.katex-html');
      const rZeroMathml = p.d.createRange();
      rZeroMathml.setStart(diffCommaNode, diffStart);
      rZeroMathml.setEnd(hMathml, 0);
      assert.equal(p.copyRange(rZeroMathml).text, 'differentiable,');

      const rZeroHtml = p.d.createRange();
      rZeroHtml.setStart(diffCommaNode, diffStart);
      rZeroHtml.setEnd(hHtml, 0);
      assert.equal(p.copyRange(rZeroHtml).text, 'differentiable,');

      // End between .katex-mathml and .katex-html on .katex itself (offset 1) -> should NOT include $H$
      const rBetween = p.d.createRange();
      rBetween.setStart(diffCommaNode, diffStart);
      rBetween.setEnd(katexList[2], 1);
      assert.equal(p.copyRange(rBetween).text, 'differentiable,');

      // Select inside single inline math
      const zText = p.findTextNode(paras[1].querySelector('.katex .katex-html'), 'z');
      const rSingleMath = p.d.createRange();
      rSingleMath.setStart(zText, 0);
      rSingleMath.setEnd(zText, 1);
      assert.equal(p.copyRange(rSingleMath).text, '$z \\in V \\cap S$');

      assert.equal(p.errors.length, 0);
    } finally {
      p.close();
    }
  }

  // 2. Display math, SiYuan entity decoding, bold math, katex-error
  {
    const src = [
      String.raw`$\frac{\partial^2 U}{\partial x^2}&lt;0$`,
      '',
      String.raw`$$`,
      String.raw`\begin{aligned}`,
      String.raw`a &amp;= b \\`,
      String.raw`c &amp;= d`,
      String.raw`\end{aligned}`,
      String.raw`$$`,
      '',
      String.raw`**$p_0 \in x(A)$**: condition`,
      '',
      String.raw`$\frac{1$`,
    ].join('\n');
    const p = await createPage(src);
    try {
      const body = p.d.querySelector('.markdown-body');
      assert.equal(
        p.copyRange(p.selectAll(body)).text,
        [
          String.raw`$\frac{\partial^2 U}{\partial x^2}<0$`,
          '',
          '$$',
          String.raw`\begin{aligned}`,
          String.raw`a &= b \\`,
          String.raw`c &= d`,
          String.raw`\end{aligned}`,
          '$$',
          '',
          String.raw`**$p_0 \in x(A)$**: condition`,
          '',
          String.raw`$\frac{1$`,
        ].join('\n')
      );

      // Select single display math partially via .katex-html
      const blockHtmlText = p.findTextNode(body.querySelector('.katex-block .katex-html'), 'a');
      const rBlock = p.d.createRange();
      rBlock.setStart(blockHtmlText, 0);
      rBlock.setEnd(blockHtmlText, 1);
      assert.equal(
        p.copyRange(rBlock).text,
        '$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$'
      );
    } finally {
      p.close();
    }
  }

  // 3. Inline formatting, soft breaks, search highlights, code spans, links & images
  {
    const src = [
      '**bold** *italic* ~~del~~ ++ins++ ==mark== H~2~O x^2^ <kbd>Ctrl</kbd>',
      '',
      'Line one\nLine two',
      '',
      'Inline `code` and `` `tick` `` and [ext](https://example.com) and https://example.org and [sec](#sec) and [doc](/s/test/doc2 "Next Doc").',
      '',
      '![alt](/assets/pic.png) ![emoji](/emojis/smile.png) ![spaced](</assets/my pic (1).png> "Pic")',
    ].join('\n');
    const p = await createPage(src);
    try {
      const body = p.d.querySelector('.markdown-body');
      const paras = body.querySelectorAll('p');

      // Inject search highlight <mark class="kb-search-hl"> and space-padded <strong>
      const markHl = p.d.createElement('mark');
      markHl.className = 'kb-search-hl';
      markHl.textContent = 'italic';
      const em = paras[0].querySelector('em');
      em.textContent = '';
      em.appendChild(markHl);

      assert.equal(
        p.copyRange(p.selectAll(paras[0])).text,
        '**bold** *italic* ~~del~~ ++ins++ ==mark== H~2~O x^2^ <kbd>Ctrl</kbd>'
      );
      assert.equal(p.copyRange(p.selectAll(paras[1])).text, 'Line one\nLine two');
      assert.equal(
        p.copyRange(p.selectAll(paras[2])).text,
        'Inline `code` and `` `tick` `` and [ext](https://example.com) and https://example.org and [sec](#sec) and [doc](https://reader.test/s/test/doc2 "Next Doc").'
      );
      assert.equal(
        p.copyRange(p.selectAll(paras[3])).text,
        '![alt](https://reader.test/assets/pic.png) ![emoji](https://reader.test/emojis/smile.png) ![spaced](<https://reader.test/assets/my%20pic%20(1).png> "Pic")'
      );

      // Spaces at <strong> boundary
      const edgePara = p.d.createElement('p');
      edgePara.innerHTML = 'Start <strong> bold </strong> text.';
      body.appendChild(edgePara);
      assert.equal(p.copyRange(p.selectAll(edgePara)).text, 'Start **bold** text.');
    } finally {
      p.close();
    }
  }

  // 4. Headings, partial heading, <h3><strong>Definition</strong></h3>, article title drag
  {
    const src = '## Section Heading\n\nBody paragraph.\n\n### **Definition** <span id="20261119083945-cy31h7h" class="sps-block-anchor"></span>';
    const p = await createPage(src, {includeHeader: true, title: 'Main Title'});
    try {
      const article = p.d.querySelector('.share-article');
      const body = p.d.querySelector('.markdown-body');
      const h2 = body.querySelector('h2');
      const h3 = body.querySelector('h3');

      // Full heading + paragraph
      const rFullH2 = p.d.createRange();
      rFullH2.setStartBefore(h2);
      rFullH2.setEndAfter(body.querySelector('p'));
      assert.equal(p.copyRange(rFullH2).text, '## Section Heading\n\nBody paragraph.');

      // Partial substring inside h2 stays plain inline text
      const h2Text = p.findTextNode(h2, 'Section Heading');
      const rPartH2 = p.d.createRange();
      rPartH2.setStart(h2Text, 0);
      rPartH2.setEnd(h2Text, 7);
      assert.equal(p.copyRange(rPartH2).text, 'Section');

      // Full <h3><strong>Definition</strong></h3> via inner <strong>
      const defStrong = h3.querySelector('strong');
      const defText = p.findTextNode(defStrong, 'Definition');
      const rFullDef = p.d.createRange();
      rFullDef.setStart(defText, 0);
      rFullDef.setEnd(defText, 'Definition'.length);
      assert.equal(p.copyRange(rFullDef).text, '### **Definition**');

      // Partial inside <h3><strong>Definition</strong></h3> stays plain
      const rPartDef = p.d.createRange();
      rPartDef.setStart(defText, 0);
      rPartDef.setEnd(defText, 3);
      assert.equal(p.copyRange(rPartDef).text, 'Def');

      // Drag from .kb-title across .share-document-actions into .markdown-body
      const kbTitle = article.querySelector('h1.kb-title');
      const rFromTitle = p.d.createRange();
      rFromTitle.setStart(kbTitle.firstChild, 0);
      rFromTitle.setEndAfter(body.querySelector('p'));
      assert.equal(p.copyRange(rFromTitle).text, '# Main Title\n\n## Section Heading\n\nBody paragraph.');

      // Selecting ONLY .kb-title does NOT intercept
      assert.equal(p.copyRange(p.selectAll(kbTitle)).prevented, false);
    } finally {
      p.close();
    }
  }

  // 5. Lists, task lists, multi-block items, partial ordered lists
  {
    const src = [
      '- Tight A',
      '- Tight B',
      '',
      'Between lists.',
      '',
      '* Loose 1',
      '',
      '  Second paragraph.',
      '',
      '  $$',
      '  E = mc^2',
      '  $$',
      '',
      '  ```js',
      '  const x = 1;',
      '  ```',
      '',
      '* Loose 2',
      '',
      '+ [x] Done task',
      '+ [ ] Open task',
      '',
      '1. First',
      '   - Nested',
      '2. Second',
      '3. Third',
      '',
      'Another ordered list:',
      '',
      '5. Five',
      '6. Six',
    ].join('\n');
    const p = await createPage(src);
    try {
      const body = p.d.querySelector('.markdown-body');
      const lists = body.querySelectorAll(':scope > ul, :scope > ol');
      assert.equal(p.copyRange(p.selectAll(lists[0])).text, '- Tight A\n- Tight B');
      assert.equal(
        p.copyRange(p.selectAll(lists[1])).text,
        '- Loose 1\n\n  Second paragraph.\n\n  $$\n  E = mc^2\n  $$\n\n  ```js\n  const x = 1;\n  ```\n\n- Loose 2'
      );
      assert.equal(p.copyRange(p.selectAll(lists[2])).text, '- [x] Done task\n- [ ] Open task');

      // Single task list item full text selection
      const taskLi = lists[2].querySelectorAll('li')[0];
      const taskText = p.findTextNode(taskLi, 'Done task');
      const rTask = p.d.createRange();
      rTask.setStart(taskText, taskText.nodeValue.indexOf('Done task'));
      rTask.setEnd(taskText, taskText.nodeValue.length);
      assert.equal(p.copyRange(rTask).text, '- [x] Done task');

      // Partial selection of items 2-3 in <ol>
      const ol1 = lists[3];
      const ol1Items = ol1.querySelectorAll(':scope > li');
      const rOlPart = p.d.createRange();
      rOlPart.setStart(p.findTextNode(ol1Items[1], 'Second'), 0);
      rOlPart.setEnd(p.findTextNode(ol1Items[2], 'Third'), 'Third'.length);
      assert.equal(p.copyRange(rOlPart).text, '2. Second\n3. Third');

      // <ol start="5"> partial: start at trailing end of item 1 ("Five") -> 6. Six
      const ol2 = lists[4];
      const ol2Items = ol2.querySelectorAll(':scope > li');
      const fiveNode = p.findTextNode(ol2Items[0], 'Five');
      const sixNode = p.findTextNode(ol2Items[1], 'Six');
      const rOlStart = p.d.createRange();
      rOlStart.setStart(fiveNode, fiveNode.nodeValue.length);
      rOlStart.setEnd(sixNode, 'Six'.length);
      assert.equal(p.copyRange(rOlStart).text, '6. Six');
    } finally {
      p.close();
    }
  }

  // 6. Blockquotes, callouts, containers
  {
    const src = [
      '> Quote one',
      '>',
      '> Quote two',
      '',
      '> [!NOTE]',
      '> Callout body with $x$.',
      '>',
      '> Second callout paragraph.',
      '',
      '> [!TIP] Custom Title',
      '> Tip body',
      '',
      '::: info',
      'Inside container',
      ':::',
      '',
      '<div align="center"><h2>Wrapped Subheading</h2><p>Inside div.</p></div>',
    ].join('\n');
    const p = await createPage(src);
    try {
      const body = p.d.querySelector('.markdown-body');
      const bq = body.querySelector('blockquote');
      assert.equal(p.copyRange(p.selectAll(bq)).text, '> Quote one\n>\n> Quote two');

      const alerts = body.querySelectorAll('.md-alert');
      assert.equal(
        p.copyRange(p.selectAll(alerts[0])).text,
        '> [!NOTE]\n> Callout body with $x$.\n>\n> Second callout paragraph.'
      );
      assert.equal(p.copyRange(p.selectAll(alerts[1])).text, '> [!TIP] Custom Title\n> Tip body');
      assert.equal(p.copyRange(p.selectAll(alerts[2])).text, '::: info\nInside container\n:::');

      // Selecting only body paragraphs inside callout (without title) does not emit [!NOTE]
      const bodyParas = alerts[0].querySelectorAll('p');
      assert.equal(p.copyRange(p.selectAll(bodyParas[0])).text, 'Callout body with $x$.');
      const rTwoCalloutParas = p.d.createRange();
      rTwoCalloutParas.setStartBefore(bodyParas[0]);
      rTwoCalloutParas.setEndAfter(bodyParas[1]);
      assert.equal(
        p.copyRange(rTwoCalloutParas).text,
        'Callout body with $x$.\n\nSecond callout paragraph.'
      );

      // Generic <div> block wrapper preserves block separation
      const divBlock = body.querySelector('div[align="center"]');
      assert(divBlock);
      assert.equal(p.copyRange(p.selectAll(divBlock)).text, '## Wrapped Subheading\n\nInside div.');
    } finally {
      p.close();
    }
  }

  // 7. Tables (full, alignments, pipes, <br>, math, partial cell/row/tbody)
  {
    const src = [
      '| Left | Center | Right |',
      '| :--- | :---: | ---: |',
      '| a \\| b | `c \\| d` | $x \\| y$ |',
      '| line1<br>line2 | plain | end |',
    ].join('\n');
    const p = await createPage(src);
    try {
      const body = p.d.querySelector('.markdown-body');
      const table = body.querySelector('table');
      // Add SiYuan style text-align on cells to verify style.textAlign detection
      const rows = table.querySelectorAll('tr');
      rows[0].children[0].style.textAlign = 'left';
      rows[0].children[1].style.textAlign = 'center';
      rows[0].children[2].style.textAlign = 'right';
      rows[1].children[0].style.textAlign = 'left';
      rows[1].children[1].style.textAlign = 'center';
      rows[1].children[2].style.textAlign = 'right';
      rows[2].children[0].style.textAlign = 'left';
      rows[2].children[1].style.textAlign = 'center';
      rows[2].children[2].style.textAlign = 'right';

      assert.equal(
        p.copyRange(p.selectAll(table)).text,
        [
          '| Left | Center | Right |',
          '| :--- | :---: | ---: |',
          '| a \\| b | `c \\| d` | $x \\| y$ |',
          '| line1<br>line2 | plain | end |',
        ].join('\n')
      );

      // Single-cell partial selection
      const plainCell = rows[2].children[1];
      assert.equal(p.copyRange(p.selectAll(plainCell)).text, 'plain');

      // Single-row 2-cell selection
      const rRowCells = p.d.createRange();
      rRowCells.setStart(rows[2].children[1], 0);
      rRowCells.setEnd(rows[2].children[2], 1);
      assert.equal(p.copyRange(rRowCells).text, '| plain | end |');

      // Multi-row tbody-only selection preserves alignments
      const tbody = table.querySelector('tbody');
      assert.equal(
        p.copyRange(p.selectAll(tbody)).text,
        [
          '| a \\| b | `c \\| d` | $x \\| y$ |',
          '| :--- | :---: | ---: |',
          '| line1<br>line2 | plain | end |',
        ].join('\n')
      );
    } finally {
      p.close();
    }
  }

  // 8. Code blocks (decorated, unlabeled, backticks inside, pure <pre> selection)
  {
    const src = [
      'Before code.',
      '',
      '```js',
      'const a = 1;',
      'const b = 2;',
      '```',
      '',
      '```',
      'plain block',
      '```',
      '',
      '```text',
      'plain text block',
      '```',
      '',
      '````md',
      '```js',
      'nested',
      '```',
      '````',
      '',
      'After code.',
    ].join('\n');
    const p = await createPage(src);
    try {
      const body = p.d.querySelector('.markdown-body');
      assert.equal(
        p.copyRange(p.selectAll(body)).text,
        [
          'Before code.',
          '',
          '```js',
          'const a = 1;',
          'const b = 2;',
          '```',
          '',
          '```',
          'plain block',
          '```',
          '',
          '```',
          'plain text block',
          '```',
          '',
          '````md',
          '```js',
          'nested',
          '```',
          '````',
          '',
          'After code.',
        ].join('\n')
      );

      // Pure selection strictly inside <pre><code> copies raw text without fences
      const jsPre = body.querySelector('.code-block .code-body pre:not(.code-lines)');
      const rInsideCode = p.d.createRange();
      rInsideCode.setStart(p.findTextNode(jsPre, 'const'), 0);
      const semi = p.findTextNode(jsPre, ';');
      rInsideCode.setEnd(semi, semi.nodeValue.indexOf(';') + 1);
      assert.equal(p.copyRange(rInsideCode).text, 'const a = 1;');
    } finally {
      p.close();
    }
  }

  // 9. Diagrams (Mermaid, Mindmap, ECharts, Graphviz, ABC, Flowchart, PlantUML)
  {
    const src = [
      '```mermaid\ngraph LR\nA-->B\n```',
      '',
      '```mindmap\n- Root\n  - Child\n```',
      '',
      '```echarts\n{"series":[{"type":"bar","data":[1,2]}]}\n```',
      '',
      '```dot\ndigraph { A -> B }\n```',
      '',
      '```abc\n%%params {"staffwidth":500}\nX:1\nK:C\nCDEF|\n```',
      '',
      '```flowchart\nst=>start: Start\ne=>end: End\nst->e\n```',
      '',
      '```plantuml\n@startuml\nAlice -> Bob: hello\n@enduml\n```',
    ].join('\n');
    const p = await createPage(src, {mockDiagrams: true});
    try {
      const body = p.d.querySelector('.markdown-body');
      assert.equal(
        p.copyRange(p.selectAll(body)).text,
        [
          '```mermaid\ngraph LR\nA-->B\n```',
          '',
          '```mindmap\n- Root\n  - Child\n```',
          '',
          '```echarts\n{"series":[{"type":"bar","data":[1,2]}]}\n```',
          '',
          '```dot\ndigraph { A -> B }\n```',
          '',
          '```abc\n%%params {"staffwidth":500}\nX:1\nK:C\nCDEF|\n```',
          '',
          '```flowchart\nst=>start: Start\ne=>end: End\nst->e\n```',
          '',
          '```plantuml\n@startuml\nAlice -> Bob: hello\n@enduml\n```',
        ].join('\n')
      );
    } finally {
      p.close();
    }
  }

  // 10. Footnotes (hidden on normal reader, visible on PDF preview, floating window) & block refs
  {
    const src = 'Claim[^1] and [def](#20261119083945-cy31h7h).\n\n### **Def** <span id="20261119083945-cy31h7h" class="sps-block-anchor"></span>\n\n[^1]: Footnote body.';
    const p = await createPage(src);
    try {
      const body = p.d.querySelector('.markdown-body');
      // Normal reader hides .footnotes so copying whole article omits footnote definition
      assert.equal(
        p.copyRange(p.selectAll(body)).text,
        'Claim[^1] and [def](#20261119083945-cy31h7h).\n\n### **Def**'
      );

      // Open floating footnote window and copy from inside it
      const fnAction = body.querySelector('.sps-footnote-action');
      assert(fnAction);
      fnAction.click();
      const winBody = p.d.querySelector('.sps-footnote-window__body');
      assert(winBody);
      assert.equal(p.copyRange(p.selectAll(winBody), winBody).text, 'Footnote body.');
    } finally {
      p.close();
    }

    const pdfPage = await createPage(src, {bodyClass: 'layout-share pdf-export-preview'});
    try {
      const body = pdfPage.d.querySelector('.markdown-body');
      assert.equal(
        p2Text(pdfPage, body),
        'Claim[^1] and [def](#20261119083945-cy31h7h).\n\n### **Def**\n\n[^1]: Footnote body.'
      );
    } finally {
      pdfPage.close();
    }
  }

  // 11. Trailing empty boundary block pruning & non-interference cases
  {
    const src = 'First paragraph.\n\n## Second Heading\n\nThird paragraph.';
    const p = await createPage(src, {includeHeader: true, title: 'Article'});
    try {
      const body = p.d.querySelector('.markdown-body');
      const paras = body.querySelectorAll('p');
      const h2 = body.querySelector('h2');
      const rEndZero = p.d.createRange();
      rEndZero.setStart(paras[0].firstChild, 0);
      rEndZero.setEnd(h2, 0);
      assert.equal(p.copyRange(rEndZero).text, 'First paragraph.');

      // Source view (.share-article.is-markdown) -> do not intercept
      const toggle = p.d.querySelector('[data-share-toggle]');
      toggle.click();
      assert.equal(p.copyRange(p.selectAll(body)).prevented, false);
      toggle.click();

      // Input / textarea -> do not intercept
      const input = p.d.getElementById('outside-input');
      input.focus();
      const rIn = p.d.createRange();
      rIn.selectNodeContents(p.d.querySelector('.markdown-source'));
      assert.equal(p.copyRange(rIn, input).prevented, false);

      // Sidebar / footer -> do not intercept
      const footer = p.d.querySelector('.share-footer');
      assert.equal(p.copyRange(p.selectAll(footer), footer).prevented, false);

      // Collapsed selection -> do not intercept
      const rCollapsed = p.d.createRange();
      rCollapsed.setStart(paras[0].firstChild, 1);
      rCollapsed.collapse(true);
      assert.equal(p.copyRange(rCollapsed).prevented, false);

      // Non-share layout -> do not intercept
      p.d.body.className = 'layout-app';
      assert.equal(p.copyRange(p.selectAll(paras[0])).prevented, false);
    } finally {
      p.close();
    }
  }

  console.log('Markdown copy passed: math boundaries, formatting, headings, lists, callouts, tables, code blocks, diagrams, footnotes and non-interference.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function p2Text(page, body) {
  return page.copyRange(page.selectAll(body)).text;
}
