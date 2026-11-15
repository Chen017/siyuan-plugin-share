"""Real Chromium checks for heading hierarchy or an actual SVG attachment URL."""
import argparse
import base64
import html
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import subprocess
import tempfile
import threading

parser = argparse.ArgumentParser()
parser.add_argument('--browser', required=True)
parser.add_argument('--svg-url')
parser.add_argument('--mermaid', action='store_true')
parser.add_argument('--list-guides', action='store_true')
parser.add_argument('--pdf-list-guides', action='store_true')
parser.add_argument('--screenshot', type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]

with tempfile.TemporaryDirectory(prefix='siyuan-browser-ui-') as directory:
    work = Path(directory)
    flags = [args.browser, '--headless', '--disable-gpu', '--no-sandbox',
             '--disable-background-networking', '--no-first-run', '--allow-file-access-from-files',
             '--user-data-dir=' + str(work / 'profile'), '--virtual-time-budget=5000']

    def browser(url, extra):
        result = subprocess.run([*flags, *extra, url], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=45)
        if result.returncode:
            raise RuntimeError(result.stderr[-2000:])
        return result.stdout

    if args.svg_url:
        # Test the real attachment response in both image and document contexts.
        img = '<html><body><img src="' + html.escape(args.svg_url, quote=True) + '" onload="document.body.dataset.result=this.naturalWidth+\'x\'+this.naturalHeight" onerror="document.body.dataset.result=\'error\'"></body></html>'
        class FixtureHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.end_headers()
                self.wfile.write(img.encode('utf-8'))

            def log_message(self, *args):
                pass

        # A loopback HTTP page has the same security context as a real site;
        # data: pages are blocked from loading private-network resources by Chromium.
        with ThreadingHTTPServer(('127.0.0.1', 0), FixtureHandler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                page = browser(f'http://127.0.0.1:{server.server_port}/', ['--dump-dom'])
            finally:
                server.shutdown()
                thread.join()
        assert 'data-result="80x40"' in page, page[-1500:]
        svg = browser(args.svg_url, ['--dump-dom'])
        assert re.search(r'<svg\b[^>]*data-executed=', svg, re.I) is None, svg[-1500:]
        print('Chromium SVG passed: image displayed at 80×40 and direct-open script did not execute.')
    elif args.mermaid:
        bundle = (root / 'php-site/assets/vendor/mermaid.min.js').as_uri()
        page = work / 'mermaid.html'
        page.write_text('''<!doctype html><html><head><meta charset="utf-8"><script src="''' + html.escape(bundle, quote=True) + '''"></script></head>
<body><script>
window.addEventListener('load', async () => {
  try {
    mermaid.initialize({startOnLoad:false,theme:'default',securityLevel:'loose',htmlLabels:false,flowchart:{htmlLabels:false},gantt:{useMaxWidth:false,useWidth:1200}});
    const sources=['graph LR\\nA[Start] --> B[End]','sequenceDiagram\\nAlice->>Bob: Hello','gantt\\n dateFormat YYYY-MM-DD\\n section Work\\n Task :2026-01-01, 2d','classDiagram\\n class Animal\\n Animal : +name'];
    for (let i=0;i<sources.length;i++) { const result=await mermaid.render('test-diagram-'+i,sources[i]); const el=document.createElement('div');el.innerHTML=result.svg;document.body.appendChild(el); }
    document.body.dataset.result=document.querySelectorAll('svg').length===sources.length?'pass':'fail';
  } catch(error) { document.body.dataset.result='error'; document.body.dataset.error=String(error); }
});
</script></body></html>''', encoding='utf-8')
        result = browser(page.as_uri(), ['--dump-dom'])
        assert 'data-result="pass"' in result, result[-3000:]
        print('Chromium Mermaid passed: flowchart, sequence, Gantt and class diagrams render as SVG.')
    elif args.list_guides:
        css = [(root / 'php-site/assets/vendor/github-markdown.min.css').as_uri(),
               (root / 'php-site/assets/reader-style.css').as_uri()]
        links = ''.join('<link rel="stylesheet" href="' + html.escape(url, quote=True) + '">' for url in css)
        page = work / 'list-guides.html'
        page.write_text('''<!doctype html><html><head><meta charset="utf-8">''' + links + '''
<style>.sample { width: 320px; } .markdown-body { font-size: 16px; }</style></head>
<body class="layout-share"><article class="markdown-body sample"><ol>
<li id="single">Short item</li>
<li id="parent">Parent<ul><li id="child">Child<ol><li id="grandchild">Grandchild</li></ol></li><li id="sibling">Sibling</li></ul></li>
<li id="wrapped">A long list item whose words wrap over multiple lines when the available reading width becomes narrow enough to require it.</li>
</ol><section class="footnotes"><ol><li id="footnote">Footnote</li></ol></section></article>
<script>
const guide = id => { const el=document.getElementById(id), s=getComputedStyle(el,'::before'), r=el.getBoundingClientRect();
  return {height:parseFloat(s.height)||0,width:parseFloat(s.width)||0,top:parseFloat(s.top)||0,itemHeight:r.height,left:r.left,marker:getComputedStyle(el).listStyleType}; };
const single=guide('single'), parent=guide('parent'), child=guide('child'), grandchild=guide('grandchild'), sibling=guide('sibling'), wrapped=guide('wrapped'), footnote=guide('footnote');
const longEnough = g => g.height > 16 && Math.abs(g.height + g.top - g.itemHeight + 3.2) < 1;
let valid=single.height===0 && grandchild.height===0 && sibling.height===0 && longEnough(parent) && longEnough(child) && longEnough(wrapped)
  && parent.width===1 && child.width===1 && wrapped.width===1 && parent.left<child.left && child.left<grandchild.left
  && single.marker==='decimal' && child.marker!=='none' && footnote.height===0;
document.querySelector('.sample').style.width='1400px';
valid = valid && guide('wrapped').height===0;
document.body.dataset.result=valid?'pass':'fail';
document.body.dataset.guides=JSON.stringify({single,parent,child,grandchild,sibling,wrapped,footnote,wide:guide('wrapped')});
</script></body></html>''', encoding='utf-8')
        for extra in ([], ['--force-dark-mode']):
            result = browser(page.as_uri(), ['--window-size=1280,1200', '--dump-dom', *extra])
            assert 'data-result="pass"' in result, result[-4000:]
        # Check the actual painted marker against the guide, rather than only
        # measuring list-item boxes (which do not include outside markers).
        from PIL import Image
        alignment = work / 'list-alignment.html'
        alignment.write_text('''<!doctype html><html><head><meta charset="utf-8">''' + links + '''
<style>
html,body { margin:0; background:white !important; }
.fixture { position:absolute; left:100px; width:300px; font:24px/1.8 Arial,sans-serif !important; }
#ordered { top:20px; } #unordered { top:150px; }
.fixture li { color:transparent; }
.fixture li::marker { color:black; }
.fixture li::before { background:black !important; }
#unordered ul { list-style-type:square; }
</style></head><body class="layout-share">
<article id="ordered" class="markdown-body fixture"><ol><li>First<br>Second</li></ol></article>
<article id="unordered" class="markdown-body fixture"><ul><li>First<br>Second</li></ul></article>
</body></html>''', encoding='utf-8')
        shot = work / 'list-alignment.png'
        browser(alignment.as_uri(), ['--window-size=500,400', '--hide-scrollbars', '--screenshot=' + str(shot)])
        image = Image.open(shot).convert('RGB')
        def ink_center(y1, y2):
            xs = [x for y in range(y1, y2) for x in range(80, 148)
                  if max(image.getpixel((x, y))) < 160]
            assert xs, f'No marker or guide pixels found at y={y1}..{y2}'
            return (min(xs) + max(xs)) / 2
        for top, kind in ((20, 'number'), (150, 'square bullet')):
            marker_x = ink_center(top, top + 43)
            guide_x = ink_center(top + 50, top + 78)
            assert abs(marker_x - guide_x) <= 3, f'{kind} marker at {marker_x}, guide at {guide_x}'
        print('Chromium list guides passed: nested and wrapped items, single lines, reflow, markers and footnotes.')
    elif args.pdf_list_guides:
        import pypdfium2 as pdfium
        css = [(root / 'php-site/assets/vendor/github-markdown.min.css').as_uri(),
               (root / 'php-site/assets/reader-style.css').as_uri(),
               (root / 'php-site/assets/pdf-export.css').as_uri()]
        links = ''.join('<link rel="stylesheet" href="' + html.escape(url, quote=True) + '">' for url in css)
        library = html.escape((root / 'php-site/assets/vendor/html2pdf.bundle.min.js').as_uri(), quote=True)
        page = work / 'pdf-list-guides.html'
        page.write_text('''<!doctype html><html><head><meta charset="utf-8">''' + links + '''
<script src="''' + library + '''"></script></head><body class="layout-share pdf-export-preview">
<div id="fixture" class="pdf-document pdf-download-document"><section class="pdf-doc"><div class="markdown-body">
<ol><li id="parent">TEST parent<ul><li id="child">TEST child<br>Child second line<ul>
<li id="grandchild">TEST grandchild<br>Grandchild second line</li></ul></li></ul></li>
<li id="single">Single line</li></ol></div></section><div style="height:40px"></div></div>
<pre id="out">pending</pre><script>
(async () => {
  try {
    let worker=html2pdf().set({margin:[16,14],image:{type:'jpeg',quality:.98},
      jsPDF:{unit:'mm',format:'a4',orientation:'portrait',compress:true},
      pagebreak:{mode:[]},html2canvas:{scale:2,backgroundColor:'#ffffff',useCORS:true,logging:false}})
      .from(document.querySelector('#fixture')).toContainer();
    await worker;
    const container=await worker.get('container'), size=await worker.get('pageSize'), bounds=container.getBoundingClientRect();
    const items={};
    for (const id of ['parent','child','grandchild','single']) {
      const el=container.querySelector('#'+id), rect=el.getBoundingClientRect(), style=getComputedStyle(el,'::before');
      items[id]={x:rect.left-bounds.left+parseFloat(style.left)+0.5, y:rect.top-bounds.top+parseFloat(style.top),
        height:parseFloat(style.height), itemBottom:rect.bottom-bounds.top,
        left:rect.left-bounds.left, top:rect.top-bounds.top,
        fontSize:parseFloat(getComputedStyle(el).fontSize), lineHeight:parseFloat(getComputedStyle(el).lineHeight)};
    }
    worker=worker.toCanvas(); await worker;
    worker=worker.toPdf(); await worker;
    const pdf=await worker.get('pdf');
    document.querySelector('#out').textContent=JSON.stringify({items,width:size.inner.px.width,pdf:pdf.output('datauristring').split(',')[1]});
  } catch (error) { document.querySelector('#out').textContent=JSON.stringify({error:String(error)}); }
})();
</script></body></html>''', encoding='utf-8')
        result = browser(page.as_uri(), ['--force-dark-mode', '--dump-dom'])
        match = re.search(r'<pre id="out">(.*?)</pre>', result, re.S)
        assert match, result[-2000:]
        data = json.loads(html.unescape(match.group(1)))
        assert 'error' not in data, data.get('error')
        assert all(data['items'][name]['height'] > 10 for name in ('parent', 'child', 'grandchild')), data['items']
        assert data['items']['single']['height'] == 0, data['items']
        pdf = pdfium.PdfDocument(base64.b64decode(data['pdf']))
        image = pdf[0].render(scale=3).to_pil().convert('RGB')
        scale = 182 / data['width'] * 72 / 25.4 * 3
        def pixel(css_x, css_y):
            return round(14 * 72 / 25.4 * 3 + css_x * scale), round(16 * 72 / 25.4 * 3 + css_y * scale)
        def has_ink(x, y):
            return any(max(image.getpixel((xx, yy))) < 245 for xx in range(x-2, x+3) for yy in range(y-2, y+3))
        for name in ('parent', 'child', 'grandchild'):
            item = data['items'][name]
            x, y = pixel(item['x'], item['y'] + item['height'] / 2)
            assert has_ink(x, y), f'{name} guide missing from generated PDF at {(x, y)}'
            x1, y1 = pixel(item['left'] - 1.8 * item['fontSize'], item['top'])
            x2, y2 = pixel(item['left'] - .12 * item['fontSize'], item['top'] + item['lineHeight'])
            marker = [(xx, yy) for yy in range(y1, y2) for xx in range(x1, x2)
                      if max(image.getpixel((xx, yy))) < 140]
            assert marker, f'{name} marker missing from generated PDF'
            marker_center = (min(p[0] for p in marker) + max(p[0] for p in marker)) / 2
            assert abs(marker_center - x) <= 3 * scale, f'{name} marker at {marker_center}, guide at {x}'
            text_x1, _ = pixel(item['left'], item['top'])
            text_x2, _ = pixel(item['left'] + 2.8 * item['fontSize'], item['top'])
            letters = [(xx, yy) for yy in range(y1, y2) for xx in range(text_x1, text_x2)
                       if max(image.getpixel((xx, yy))) < 140]
            assert letters, f'{name} text missing from generated PDF'
            if name == 'parent':
                delta = abs(max(p[1] for p in marker) - max(p[1] for p in letters))
            else:
                delta = abs((min(p[1] for p in marker) + max(p[1] for p in marker)) / 2
                            - (min(p[1] for p in letters) + max(p[1] for p in letters)) / 2)
            assert delta <= 3 * scale, f'{name} marker and text differ vertically by {delta} pixels'
        item = data['items']['single']
        x, y = pixel(item['x'], item['itemBottom'] + 8)
        assert not has_ink(x, y), 'Single-line item unexpectedly has a guide in the generated PDF'
        print('PDFium list guides passed: exported nested guides render, and a single-line item has no guide.')
    else:
        css = [(root / 'php-site/assets/vendor/github-markdown.min.css').as_uri(),
               (root / 'php-site/assets/reader-style.css').as_uri(),
               (root / 'php-site/assets/pdf-export.css').as_uri()]
        links = ''.join('<link rel="stylesheet" href="' + html.escape(url, quote=True) + '">' for url in css)
        headings = ''.join(f'<h{n}>Heading {n} <strong>数学标题与公式 x²</strong></h{n}>' for n in range(1, 7))
        page = work / 'headings.html'
        page.write_text(f'''<!doctype html><html><head><meta charset="utf-8">{links}
<style>.sample{{width:320px;max-width:100%;}} body{{padding:20px}} .sample h1,.sample h2,.sample h3,.sample h4,.sample h5,.sample h6{{margin-top:.45em;margin-bottom:.2em}}</style></head>
<body class="layout-share"><section class="sample"><article class="markdown-body">{headings}<p>Body 正文大小和数学 x²</p></article></section>
<section class="pdf-download-document"><article class="markdown-body">{headings}<p>Body 正文大小</p></article></section>
<script>
const groups=[...document.querySelectorAll('.markdown-body')];
const valid=groups.every(g=>{{const sizes=[1,2,3,4,5,6].map(n=>parseFloat(getComputedStyle(g.querySelector('h'+n)).fontSize));
const body=parseFloat(getComputedStyle(g.querySelector('p')).fontSize);return sizes.every((v,i)=>v>body && (!i || sizes[i-1]>v)) && [...g.querySelectorAll('h1,h2,h3,h4,h5,h6')].every(h=>parseInt(getComputedStyle(h).fontWeight)===600 && getComputedStyle(h).fontWeight===getComputedStyle(h.querySelector('strong')).fontWeight);}});
const sample=document.querySelector('.sample');document.body.dataset.result=valid && sample.scrollWidth<=sample.clientWidth?'pass':'fail';
document.body.dataset.sizes=[...groups[0].querySelectorAll('h1,h2,h3,h4,h5,h6,p')].map(x=>getComputedStyle(x).fontSize).join(',');
document.body.dataset.viewport=String(window.innerWidth);
</script></body></html>''', encoding='utf-8')
        result = browser(page.as_uri(), ['--window-size=1280,1200', '--dump-dom'])
        assert 'data-result="pass"' in result, result[-3000:]
        mobile = browser(page.as_uri(), ['--window-size=320,900', '--force-dark-mode', '--dump-dom'])
        assert 'data-result="pass"' in mobile, mobile[-3000:]
        # Chromium on desktop may enforce a 500px minimum window; the sample itself
        # remains 320px wide even on those systems.
        if args.screenshot:
            args.screenshot.parent.mkdir(parents=True, exist_ok=True)
            browser(page.as_uri(), ['--window-size=1280,1200', '--screenshot=' + str(args.screenshot.resolve())])
        print('Chromium headings passed: six descending sizes above body text, including PDF and 320px layout.')
