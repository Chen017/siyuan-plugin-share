"""Real Chromium checks for heading hierarchy or an actual SVG attachment URL."""
import argparse
import html
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
    else:
        css = [(root / 'php-site/assets/vendor/github-markdown.min.css').as_uri(),
               (root / 'php-site/assets/style.css').as_uri(),
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
const body=parseFloat(getComputedStyle(g.querySelector('p')).fontSize);return sizes.every((v,i)=>v>body && (!i || sizes[i-1]>v)) && [...g.querySelectorAll('h1,h2,h3,h4,h5,h6')].every(h=>parseInt(getComputedStyle(h).fontWeight)>=700 && getComputedStyle(h).fontWeight===getComputedStyle(h.querySelector('strong')).fontWeight);}});
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
