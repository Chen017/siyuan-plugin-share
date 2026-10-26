(() => {
  "use strict";
  const form = document.querySelector("[data-pdf-export-form]");
  if (form) {
    const scope = form.querySelector("[data-pdf-scope]");
    const updateScope = () => {
      form.querySelector("[data-pdf-selection]").hidden = scope.value !== "selected";
      form.querySelector("[data-pdf-root]").hidden = !["single", "tree"].includes(scope.value);
    };
    scope.addEventListener("change", updateScope);
    updateScope();
    const fingerprint = async () => {
      // Coarse properties only: no canvas, installed fonts, or persistent tracking ID.
      // Exact equality is an auxiliary CAPTCHA signal; Cookie owns the quota.
      const source = JSON.stringify([
        navigator.userAgent, navigator.language, navigator.languages,
        screen.width, screen.height, screen.colorDepth,
        Intl.DateTimeFormat().resolvedOptions().timeZone,
        navigator.hardwareConcurrency || 0, navigator.maxTouchPoints || 0,
      ]);
      if (!globalThis.crypto?.subtle) return "0".repeat(64);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    const ready = fingerprint();
    const challenge = form.querySelector('[data-pdf-challenge]');
    const formStatus = form.querySelector('[data-pdf-form-status]');
    let challengeToken = '';
    const request = async (action, extra = {}) => {
      const response = await fetch(`${form.action}/${action}`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' },
        body: new URLSearchParams({ csrf: form.querySelector('[name=csrf]').value, fingerprint: await ready, ...extra }),
      });
      const result = await response.json();
      if (!response.ok && !(response.status === 428 && result.captcha_required)) throw new Error(result.error || '导出验证失败，请重试。');
      return result;
    };
    const refreshChallenge = async () => {
      const result = await request('captcha');
      if (result.ok) { challenge.hidden = true; return; }
      challengeToken = result.token;
      challenge.querySelector('[data-pdf-captcha-image]').src = result.image;
      challenge.hidden = false;
      form.querySelector('[name=captcha_answer]').value = '';
      form.querySelector('[name=captcha_answer]').focus();
    };
    form.querySelector('[data-pdf-captcha-refresh]').addEventListener('click', () => {
      refreshChallenge().catch((error) => { formStatus.textContent = error.message; });
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = form.querySelector("button[type=submit]");
      if (button.disabled) return;
      button.disabled = true;
      try {
        let input = form.querySelector("input[name=fingerprint]");
        if (!input) {
          input = document.createElement("input");
          input.type = "hidden";
          input.name = "fingerprint";
          form.append(input);
        }
        input.value = await ready;
        if (!challenge.hidden) {
          const answer = form.querySelector('[name=captcha_answer]').value.trim();
          if (!answer) { formStatus.textContent = '请输入图片中的验证码。'; return; }
          await request('captcha-verify', { token: challengeToken, answer });
          challenge.hidden = true;
        }
        const check = await request('check');
        if (check.captcha_required) {
          formStatus.textContent = check.error;
          await refreshChallenge();
          return;
        }
        // Submit in the user's gesture where possible; no server-side browser process.
        HTMLFormElement.prototype.submit.call(form);
        formStatus.textContent = "已打开导出预览；如未出现，请允许此站点打开新窗口。";
      } catch (error) {
        formStatus.textContent = error.message || "导出准备失败，请刷新页面后重试。";
      } finally {
        button.disabled = false;
      }
    });
  }

  const preview = document.querySelector("[data-pdf-preview]");
  if (!preview) return;
  const button = preview.querySelector("[data-pdf-download]");
  const status = preview.querySelector("[data-pdf-status]");
  const documentBody = document.querySelector(".pdf-document");
  const url = preview.dataset.exportUrl;
  const fields = () => new URLSearchParams({ csrf: preview.dataset.csrf, lease: preview.dataset.lease });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    updateControls();
    navigator.sendBeacon?.(`${url}/release`, fields());
  };
  window.addEventListener("pagehide", release);
  const verify = async (renew = false) => {
    const body = fields();
    if (renew) body.set('renew', '1');
    const response = await fetch(`${url}/verify`, { method: "POST", body, credentials: "same-origin", cache: "no-store" });
    if (!response.ok) {
      const result = await response.json();
      documentBody.replaceChildren();
      throw new Error(result.error || "分享权限已失效，请重新打开分享页。");
    }
  };
  const claim = async (index) => {
    const body = fields();
    body.set('index', String(index));
    const response = await fetch(`${url}/claim`, { method: 'POST', body, credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error((await response.json()).error || '无法取得此篇的导出额度。');
  };
  const sections = Array.from(documentBody.querySelectorAll('.pdf-doc'));
  const completed = new Set();
  let busy = false;
  let prepared = false;
  function updateControls() {
    const unavailable = !prepared || busy || released || !documentBody.children.length;
    button.disabled = unavailable || completed.size === sections.length;
  }
  updateControls();
  let library;
  const loadScript = (source) => new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = source;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('PDF 组件加载失败，请重试。'));
    document.head.append(script);
  });
  const loadLibrary = () => library || (library = Promise.all([
    loadScript(preview.dataset.pdfLibrary), loadScript(preview.dataset.pdfTextLibrary),
  ]).catch((error) => { library = null; throw error; }));
  const names = new Map();
  let provenanceFont;
  const loadProvenanceFont = () => provenanceFont || (provenanceFont = (async () => {
    const response = await fetch(preview.dataset.pdfFont, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('来源信息字体加载失败，请重试。');
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  })().catch((error) => { provenanceFont = null; throw error; }));
  const addProvenance = async (pdf, section) => {
    const source = new URL(section.dataset.pdfSource, location.origin).href;
    const author = '塵';
    const rights = '随意传播，禁止售卖';
    const xml = (value) => value.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char]));
    pdf.setProperties({ author, subject: rights });
    pdf.addMetadata(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:source>${xml(source)}</dc:source><dc:creator><rdf:Seq><rdf:li>${xml(author)}</rdf:li></rdf:Seq></dc:creator><dc:rights><rdf:Alt><rdf:li xml:lang="x-default">${xml(rights)}</rdf:li></rdf:Alt></dc:rights></rdf:Description></rdf:RDF></x:xmpmeta>`, true);
    pdf.addFileToVFS('pdf-provenance.ttf', await loadProvenanceFont());
    pdf.addFont('pdf-provenance.ttf', 'SharePDFHidden', 'normal');
    pdf.setFont('SharePDFHidden', 'normal');
    pdf.setFontSize(8);
    const lines = [`原文网址：${source}`, `作者：${author}`, `版权说明：${rights}`]
      .flatMap((line) => pdf.splitTextToSize(line, 182));
    for (let page = 1; page <= pdf.getNumberOfPages(); page++) {
      pdf.setPage(page);
      pdf.text(lines, 14, 6, { renderingMode: 'invisible' });
    }
  };
  const filenames = sections.map((section, index) => {
    let title = Array.from((section.dataset.pdfTitle || `文档-${index + 1}`).normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')).slice(0, 100).join('').replace(/[. ]+$/, '').trim() || `文档-${index + 1}`;
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(title)) title = `文档_${title}`;
    const key = title.toLowerCase();
    const count = (names.get(key) || 0) + 1;
    names.set(key, count);
    return `${title}${count > 1 ? ` (${count})` : ''}.pdf`;
  });
  const makePdf = async (section) => {
    const root = document.createElement('div');
    root.className = 'pdf-document pdf-download-document';
    const copy = section.cloneNode(true);
    copy.querySelectorAll('.markdown-source').forEach((node) => node.remove());
    const originalCanvas = Array.from(section.querySelectorAll('canvas'));
    copy.querySelectorAll('canvas').forEach((canvas, index) => {
      const image = document.createElement('img');
      image.src = originalCanvas[index].toDataURL('image/png');
      image.style.cssText = canvas.style.cssText;
      canvas.replaceWith(image);
    });
    root.append(copy);
    // Keep the final block's margin inside the measured flow.
    const tail = document.createElement('div');
    tail.style.cssText = 'height:8px;clear:both';
    root.append(tail);
    let worker = window.html2pdf().set({
      margin: [16, 14], image: { type: 'jpeg', quality: .98 },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait', compress: true },
      pagebreak: { mode: ['css'], avoid: ['img', 'svg', 'tr', '.katex-display', 'pre'] },
    }).from(root);
    try {
      worker = worker.toContainer();
      await worker;
      const size = await worker.get('pageSize');
      const container = await worker.get('container');
      const height = container.getBoundingClientRect().height;
      // Match jsPDF's canvas rounding, otherwise a 1px remainder creates a page.
      const pageHeight = Math.floor(size.inner.px.width * size.inner.ratio);
      const pages = Math.max(1, Math.ceil(height / pageHeight));
      const text = await SPSPdfTextLayer.capture(container);
      let pdf;
      for (let page = 0; page < pages; page++) {
        // toCanvas detaches its overlay. Reuse this exact paginated layout so
        // later pages cannot be reflowed or measured differently.
        if (!container.isConnected) document.body.append(worker.prop.overlay);
        worker = worker.set({ html2canvas: { scale: 2, backgroundColor: '#ffffff', useCORS: true, allowTaint: false, logging: false,
          windowWidth: innerWidth, scrollX: 0, scrollY: 0, y: page * pageHeight, width: size.inner.px.width,
          height: Math.min(pageHeight, Math.ceil(height - page * pageHeight)) } }).toCanvas();
        await worker;
        const canvas = await worker.get('canvas');
        if (!pdf) {
          worker = worker.toPdf();
          await worker;
          pdf = await worker.get('pdf');
        } else {
          pdf.addPage();
          pdf.addImage(canvas.toDataURL('image/jpeg', .98), 'JPEG', 14, 16, size.inner.width, canvas.height * size.inner.width / canvas.width);
        }
        canvas.width = canvas.height = 0;
        await verify(true);
      }
      SPSPdfTextLayer.write(pdf, text, { width: size.inner.width, pixelWidth: size.inner.px.width, pixelHeight: pageHeight }, await loadProvenanceFont());
      await addProvenance(pdf, section);
      return pdf.output('blob');
    } finally {
      worker.prop?.overlay?.remove();
    }
  };
  button.addEventListener("click", async () => {
    if (!prepared || busy || released) return;
    busy = true;
    updateControls();
    let heartbeatError;
    let ticking = false;
    const heartbeat = setInterval(async () => {
      if (ticking) return;
      ticking = true;
      try { await verify(true); } catch (error) { heartbeatError = error; }
      finally { ticking = false; }
    }, 20000);
    try {
      await verify(true);
      await loadLibrary();
      await loadProvenanceFont();
      for (let index = 0; index < sections.length; index++) {
        if (completed.has(index)) continue;
        if (heartbeatError) throw heartbeatError;
        status.textContent = `正在生成第 ${index + 1} / ${sections.length} 篇：${filenames[index]}`;
        await claim(index);
        const blob = await makePdf(sections[index]);
        await verify(true);
        if (heartbeatError) throw heartbeatError;
        const blobUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = blobUrl;
        anchor.download = filenames[index];
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
        completed.add(index);
      }
      status.textContent = `已逐篇触发 ${completed.size} 个独立 PDF 下载。若文件未全部出现，请允许浏览器连续下载多个文件。`;
      release();
    } catch (error) {
      status.textContent = `已下载 ${completed.size} / ${sections.length} 篇。${error.message || '下载失败，请重试剩余文档。'}`;
    } finally {
      clearInterval(heartbeat);
      busy = false;
      updateControls();
    }
  });
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const prepare = async () => {
    const deadline = Date.now() + 25000;
    while (!Array.from(documentBody.querySelectorAll(".markdown-body")).every((node) => node.dataset.spsRendered === "1")) {
      if (Date.now() > deadline) throw new Error("排版组件未能加载，请刷新预览后重试。");
      await pause(100);
    }
    documentBody.querySelectorAll("details").forEach((item) => { item.open = true; });
    // Observe asynchronous Mermaid/Graphviz rendering until it settles.
    let lastChange = Date.now();
    const observer = new MutationObserver(() => { lastChange = Date.now(); });
    observer.observe(documentBody, { childList: true, subtree: true, attributes: true });
    try {
      if (document.fonts) await Promise.race([document.fonts.ready, pause(10000)]);
      do {
        const images = Array.from(documentBody.querySelectorAll("img"));
        images.forEach((img) => { if (img.loading !== "eager") img.loading = "eager"; });
        const pending = images.some((img) => !img.complete);
        const diagrams = Array.from(documentBody.querySelectorAll(".mermaid")).some((node) => !node.querySelector("svg, img"))
          || !!documentBody.querySelector(".md-graphviz:empty");
        if (!pending && !diagrams && Date.now() - lastChange > 1000) break;
        await pause(150);
      } while (Date.now() < deadline);
    } finally {
      observer.disconnect();
    }
    const incomplete = Array.from(documentBody.querySelectorAll("img")).some((img) => !img.complete || img.naturalWidth === 0);
    documentBody.querySelectorAll(".pdf-doc").forEach((section, index) => {
      const ids = new Map();
      section.querySelectorAll("[id]").forEach((node) => {
        // Diagram IDs are generated uniquely by the renderer. Renaming SVG IDs
        // would break embedded CSS, gradients, clip paths and marker references.
        if (node.closest("svg")) return;
        const previous = node.id;
        node.id = `pdf-${index}-${previous}`;
        ids.set(previous, node.id);
      });
      section.querySelectorAll('a[href^="#"]').forEach((anchor) => {
        const id = anchor.getAttribute("href").slice(1);
        if (ids.has(id)) anchor.setAttribute("href", `#${ids.get(id)}`);
      });
    });
    await verify();
    const diagramPending = !!documentBody.querySelector(".md-graphviz:empty")
      || Array.from(documentBody.querySelectorAll(".mermaid")).some((node) => !node.querySelector("svg, img"));
    status.textContent = incomplete || diagramPending
      ? "部分图片未能加载。请检查下方预览，必要时重新打开后再保存。"
      : "预览已就绪。点击保存即可逐篇下载，每篇一个 PDF。";
    prepared = true;
    updateControls();
  };
  prepare().catch((error) => {
    status.textContent = error.message || "导出准备失败，请重新打开预览。";
    release();
  });
})();
