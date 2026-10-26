(() => {
  "use strict";
  let dialog;
  let dialogFrame;
  let closeTimer;
  const closeDialog = () => {
    if (!dialog?.open || closeTimer) return;
    dialogFrame.contentWindow.postMessage({ type: 'sps-pdf-cancel' }, location.origin);
    dialog.dataset.closing = '1';
    const delay = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160;
    closeTimer = setTimeout(() => {
      dialog.close();
      dialogFrame.src = 'about:blank';
      document.documentElement.classList.remove('pdf-dialog-open');
      delete dialog.dataset.closing;
      closeTimer = null;
    }, delay);
  };
  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('[data-pdf-export-link]');
    if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'pdf-export-dialog';
      dialog.setAttribute('aria-labelledby', 'pdf-dialog-title');
      dialog.innerHTML = '<header class="pdf-dialog-header"><h2 id="pdf-dialog-title">导出 PDF</h2><button type="button" class="button ghost pdf-dialog-close" aria-label="关闭导出弹窗">×</button></header><p class="pdf-dialog-loading" role="status">正在读取导出选项…</p><iframe data-pdf-dialog-frame title="导出范围与文档选择"></iframe>';
      dialogFrame = dialog.querySelector('iframe');
      dialog.querySelector('button').addEventListener('click', closeDialog);
      dialog.addEventListener('cancel', (cancel) => { cancel.preventDefault(); closeDialog(); });
      dialog.addEventListener('click', (click) => {
        if (click.target !== dialog) return;
        const bounds = dialog.getBoundingClientRect();
        if (click.clientX < bounds.left || click.clientX > bounds.right || click.clientY < bounds.top || click.clientY > bounds.bottom) closeDialog();
      });
      dialogFrame.addEventListener('load', () => {
        if (dialogFrame.getAttribute('src') === 'about:blank') return;
        const loaded = dialogFrame.contentDocument;
        if (loaded?.querySelector('[data-pdf-export-form]')) {
          dialog.querySelector('.pdf-dialog-loading').hidden = true;
          dialogFrame.hidden = false;
        } else {
          dialog.querySelector('.pdf-dialog-loading').textContent = loaded?.querySelector('[role=alert]')?.textContent || '无法读取导出选项，请关闭弹窗并刷新分享页重试。';
          dialogFrame.hidden = true;
        }
      });
      window.addEventListener('message', (message) => {
        if (message.origin !== location.origin || message.source !== dialogFrame.contentWindow) return;
        if (message.data?.type === 'sps-pdf-dialog-close') { closeDialog(); return; }
        if (message.data?.type !== 'sps-pdf-dialog-size') return;
        const height = Number(message.data.height);
        if (Number.isFinite(height)) dialogFrame.style.height = `${Math.max(180, Math.min(height, innerHeight - 130))}px`;
      });
      document.body.append(dialog);
    }
    if (dialog.open) return;
    const url = new URL(link.href);
    url.searchParams.set('dialog', '1');
    dialogFrame.src = url.href;
    dialogFrame.hidden = false;
    dialog.querySelector('.pdf-dialog-loading').hidden = false;
    dialog.querySelector('.pdf-dialog-loading').textContent = '正在读取导出选项…';
    document.documentElement.classList.add('pdf-dialog-open');
    dialog.showModal();
  });
  const form = document.querySelector("[data-pdf-export-form]");
  if (form) {
    // Warm only static PDF resources while the visitor chooses the scope.
    // This neither creates a task nor consumes quota or requests a CAPTCHA.
    for (const source of [form.dataset.pdfLibrary, form.dataset.pdfTextLibrary]) {
      const link = document.createElement('link');
      link.rel = 'preload'; link.as = 'script'; link.href = source;
      document.head.append(link);
    }
    let font;
    window.SPSPdfFont = () => font || (font = fetch(form.dataset.pdfFont, { credentials: 'same-origin' }).then(async (response) => {
      if (!response.ok) throw new Error('来源信息字体加载失败，请重试。');
      let binary = '';
      for (const byte of new Uint8Array(await response.arrayBuffer())) binary += String.fromCharCode(byte);
      return btoa(binary);
    }).catch((error) => { font = null; throw error; }));
    window.SPSPdfFont().catch(() => {});
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
    const worker = document.querySelector('[data-pdf-worker]');
    const submit = form.querySelector('button[type=submit]');
    const quota = document.querySelector('[data-pdf-quota]');
    let state = 'idle';
    const setState = (next) => {
      state = next;
      submit.disabled = next === 'checking' || next === 'running';
      submit.textContent = next === 'running' ? '正在导出…' : next === 'retry' ? '重试剩余文档' : next === 'done' ? '再次导出' : '确定导出';
      form.setAttribute('aria-busy', String(submit.disabled));
      form.querySelectorAll('[data-pdf-scope], [data-pdf-root], [data-pdf-selection], [data-pdf-challenge]').forEach((node) => { node.inert = ['checking', 'running', 'retry'].includes(next); });
    };
    const showQuota = (value) => {
      const next = value.next_recovery_at ? `下一次恢复：${new Date(value.next_recovery_at * 1000).toLocaleString('zh-CN')}（恢复 ${value.next_recovery_count} 篇，本地时间）。` : '当前额度充足。';
      quota.textContent = `每 ${value.window_seconds / 60} 分钟最多导出 ${value.limit} 篇，当前已用 ${value.used} 篇，剩余 ${value.remaining} 篇。${next}请合理导出，额度随时间逐篇恢复，并非整点重置。`;
    };
    showQuota(JSON.parse(quota.dataset.pdfQuota));
    const refreshQuota = async () => {
      const response = await fetch(`${form.action}/quota`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, body: new URLSearchParams({ csrf: form.querySelector('[name=csrf]').value }) });
      const result = await response.json();
      if (response.ok && result.quota) showQuota(result.quota);
    };
    const quotaTimer = setInterval(() => { refreshQuota().catch(() => {}); }, 30000);
    const cancelTask = () => {
      if (!['running', 'retry'].includes(state)) return;
      navigator.sendBeacon?.(`${form.action}/release`, new URLSearchParams({ csrf: form.querySelector('[name=csrf]').value, ticket: form.querySelector('[name=ticket]').value }));
      worker.src = 'about:blank';
      setState('idle');
    };
    window.addEventListener('pagehide', () => { clearInterval(quotaTimer); cancelTask(); });
    window.addEventListener('message', (message) => {
      if (message.origin === location.origin && message.source === parent && message.data?.type === 'sps-pdf-cancel') cancelTask();
    });
    if (window.parent !== window) {
      const resize = () => window.parent.postMessage({ type: 'sps-pdf-dialog-size', height: document.querySelector('.pdf-export-panel').getBoundingClientRect().height + 2 }, location.origin);
      new ResizeObserver(resize).observe(document.querySelector('.pdf-export-panel'));
      resize();
      document.addEventListener('keydown', (event) => { if (event.key === 'Escape') window.parent.postMessage({ type: 'sps-pdf-dialog-close' }, location.origin); });
    }
    window.addEventListener('message', (message) => {
      if (message.origin !== location.origin || message.source !== worker.contentWindow || message.data?.type !== 'sps-pdf-export') return;
      formStatus.textContent = String(message.data.message || '');
      if (message.data.state === 'done') setState('done');
      if (message.data.state === 'error') setState(message.data.retryable ? 'retry' : 'idle');
      if (['done', 'error'].includes(message.data.state)) refreshQuota().catch(() => {});
    });
    worker.addEventListener('load', () => {
      if (state !== 'running' || worker.contentWindow.location.href === 'about:blank' || worker.contentDocument?.querySelector('[data-pdf-preview]')) return;
      const body = worker.contentDocument;
      let error = body?.querySelector('[role=alert]')?.textContent;
      if (!error) { try { error = JSON.parse(body.body.textContent).error; } catch {} }
      formStatus.textContent = error || '导出失败，请重试。';
      setState('idle');
      refreshQuota().catch(() => {});
    });
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
      setTimeout(() => form.querySelector('[name=captcha_answer]').focus(), 0);
    };
    form.querySelector('[data-pdf-captcha-refresh]').addEventListener('click', () => {
      refreshChallenge().catch((error) => { formStatus.textContent = error.message; });
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = form.querySelector("button[type=submit]");
      if (button.disabled) return;
      if (state === 'retry') {
        setState('running');
        worker.contentWindow.postMessage({ type: 'sps-pdf-retry' }, location.origin);
        return;
      }
      setState('checking');
      try {
        let input = form.querySelector("input[name=fingerprint]");
        if (!input) {
          input = document.createElement("input");
          input.type = "hidden";
          input.name = "fingerprint";
          form.append(input);
        }
        input.value = await ready;
        let check;
        if (!challenge.hidden) {
          const answer = form.querySelector('[name=captcha_answer]').value.trim();
          if (!answer) { formStatus.textContent = '请输入图片中的验证码。'; return; }
          check = await request('captcha-verify', { token: challengeToken, answer });
          challenge.hidden = true;
        }
        check ||= await request('check');
        if (check.quota) showQuota(check.quota);
        if (check.captcha_required) {
          formStatus.textContent = check.error;
          await refreshChallenge();
          return;
        }
        // Submit in the user's gesture where possible; no server-side browser process.
        HTMLFormElement.prototype.submit.call(form);
        setState('running');
        formStatus.textContent = '正在整理文档并准备下载…';
      } catch (error) {
        formStatus.textContent = error.message || "导出准备失败，请刷新页面后重试。";
      } finally {
        if (state === 'checking') setState('idle');
      }
    });
  }

  function runJob(panel) {
    const docs = JSON.parse(document.querySelector('[data-pdf-manifest]').textContent);
    const button = panel.querySelector('[data-pdf-download]');
    const status = panel.querySelector('[data-pdf-status]');
    const automatic = panel.dataset.pdfAuto === '1';
    const url = panel.dataset.exportUrl;
    const fields = (extra = {}) => new URLSearchParams({ csrf: panel.dataset.csrf, lease: panel.dataset.lease, ...extra });
    const completed = new Set();
    const names = new Map();
    const filenames = docs.map((doc, index) => {
      let title = Array.from((doc.title || `文档-${index + 1}`).normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')).slice(0, 100).join('').replace(/[. ]+$/, '').trim() || `文档-${index + 1}`;
      if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(title)) title = `文档_${title}`;
      const count = (names.get(title.toLowerCase()) || 0) + 1;
      names.set(title.toLowerCase(), count);
      return `${title}${count > 1 ? ` (${count})` : ''}.pdf`;
    });
    if (parent !== window && typeof parent.SPSPdfFont === 'function') window.SPSPdfFont = () => parent.SPSPdfFont();
    let released = false;
    let busy = false;
    let stopRun = () => {};
    let renewAt = Date.now() + Number(panel.dataset.pdfRenewAfter) * 1000;
    const report = (message, state = 'progress', retryable = false) => {
      status.textContent = message;
      if (automatic && parent !== window) parent.postMessage({ type: 'sps-pdf-export', state, message, retryable }, location.origin);
    };
    const release = () => {
      if (released) return;
      released = true;
      stopRun(new Error('任务已取消。'));
      button.disabled = true;
      navigator.sendBeacon?.(`${url}/release`, fields());
    };
    window.addEventListener('pagehide', release);
    const request = async (extra, signal) => {
      const response = await fetch(`${url}/verify`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', body: fields(extra), signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '导出任务已失效，请重新打开弹窗。');
      renewAt = Date.now() + result.renew_after * 1000;
    };
    const run = async () => {
      if (busy || released) return;
      busy = true;
      button.disabled = true;
      const controller = new AbortController();
      const pending = new Map();
      const ready = new Map();
      let next = 0;
      let downloadIndex = 0;
      let draining = false;
      let error;
      let warning = '';
      const abort = (reason) => {
        if (error) return;
        error = reason;
        controller.abort();
        for (const item of pending.values()) item.reject(reason);
        for (const item of ready.values()) item.reject(reason);
        ready.clear();
      };
      stopRun = abort;
      const onMessage = (message) => {
        if (message.origin !== location.origin || message.data?.type !== 'sps-pdf-document') return;
        const item = pending.get(message.data.index);
        if (!item || message.source !== item.frame.contentWindow) return;
        if (message.data.error) item.reject(new Error(message.data.error));
        else if (message.data.blob instanceof Blob) {
          if (message.data.warning) warning = message.data.warning;
          item.resolve(message.data.blob);
        }
      };
      window.addEventListener('message', onMessage);
      const render = async (index) => {
        if (error) throw error;
        const frame = document.createElement('iframe');
        frame.className = 'pdf-export-worker';
        frame.name = `sps-pdf-doc-${index}-${Math.random().toString(36).slice(2)}`;
        frame.title = `PDF 文档 ${index + 1}`;
        frame.tabIndex = -1;
        frame.setAttribute('aria-hidden', 'true');
        let timeout;
        try {
          return await new Promise((resolve, reject) => {
            pending.set(index, { frame, resolve, reject });
            timeout = setTimeout(() => reject(new Error('此篇生成耗时过长，请重试剩余文档。')), 1800000);
            frame.addEventListener('load', () => {
              if (frame.contentWindow.location.href === 'about:blank') return;
              const page = frame.contentDocument;
              if (page?.querySelector('[data-pdf-child]')) return;
              reject(new Error(page?.querySelector('[role=alert]')?.textContent || '文档准备失败，请稍后重试。'));
            });
            document.body.append(frame);
            // A real same-origin document preserves fonts, protected resources,
            // location.origin and asynchronous diagram loaders in every frame.
            const submission = document.createElement('form');
            submission.method = 'POST';
            submission.action = `${url}/document`;
            submission.target = frame.name;
            for (const [name, value] of fields({ index })) {
              const input = document.createElement('input');
              input.type = 'hidden'; input.name = name; input.value = value;
              submission.append(input);
            }
            document.body.append(submission);
            HTMLFormElement.prototype.submit.call(submission);
            submission.remove();
          });
        } finally {
          clearTimeout(timeout);
          pending.delete(index);
          // Dispose all DOM, canvases and component instances before the next doc.
          frame.src = 'about:blank';
          frame.remove();
        }
      };
      const drain = async () => {
        if (draining) return;
        draining = true;
        try {
          while (!error && downloadIndex < docs.length) {
            if (completed.has(downloadIndex)) { downloadIndex++; continue; }
            const item = ready.get(downloadIndex);
            if (!item) break;
            // Final permission check and slot completion share one request.
            await request({ finish: downloadIndex, renew: '1' }, controller.signal);
            if (error || released) throw error || new Error('任务已取消。');
            const blobUrl = URL.createObjectURL(item.blob);
            const anchor = document.createElement('a');
            anchor.href = blobUrl;
            anchor.download = filenames[downloadIndex];
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
            completed.add(downloadIndex);
            ready.delete(downloadIndex++);
            item.resolve();
            report(`已下载 ${completed.size} / ${docs.length} 篇，正在准备其余文档…`);
          }
        } catch (reason) { abort(reason); }
        finally { draining = false; }
      };
      const worker = async () => {
        try {
          while (!error && !released) {
            while (next < docs.length && completed.has(next)) next++;
            if (next >= docs.length) return;
            const index = next++;
            report(`已下载 ${completed.size} / ${docs.length} 篇，正在生成：${filenames[index]}`);
            const blob = await render(index);
            if (error) throw error;
            // Await ordered download before preparing another doc. At most three
            // completed PDFs can wait in memory, even if the first doc is slow.
            await new Promise((resolve, reject) => {
              ready.set(index, { blob, resolve, reject });
              void drain();
            });
          }
        } catch (reason) { abort(reason); }
      };
      let ticking = false;
      const heartbeat = setInterval(async () => {
        if (ticking || error || Date.now() < renewAt) return;
        ticking = true;
        try { await request({ renew: '1' }, controller.signal); }
        catch (reason) { abort(reason); }
        finally { ticking = false; }
      }, 1000);
      try {
        if (Date.now() >= renewAt) await request({ renew: '1' }, controller.signal);
        await Promise.all(Array.from({ length: docs.length > 1 ? 3 : 1 }, worker));
        if (error) throw error;
        release();
        report(`已逐篇触发 ${completed.size} 个独立 PDF 下载。${warning}若文件未全部出现，请允许浏览器连续下载多个文件。`, 'done');
      } catch (reason) {
        abort(reason);
        let retryable = !released;
        if (retryable) {
          try { await request({ abandon: '1', renew: '1' }); }
          catch { retryable = false; release(); }
        }
        report(`已下载 ${completed.size} / ${docs.length} 篇。${reason.message || '下载失败，请重试。'}`, 'error', retryable);
      } finally {
        clearInterval(heartbeat);
        window.removeEventListener('message', onMessage);
        busy = false;
        button.disabled = released;
        button.textContent = released ? '导出已结束' : '重试剩余文档';
      }
    };
    button.addEventListener('click', run);
    window.addEventListener('message', (message) => {
      if (message.origin === location.origin && message.source === parent && message.data?.type === 'sps-pdf-retry') void run();
    });
    if (automatic) void run();
  }

  const preview = document.querySelector("[data-pdf-preview]");
  if (!preview) return;
  if (preview.dataset.pdfJob === '1') {
    runJob(preview);
    return;
  }
  if (preview.dataset.pdfChild !== '1') return;
  const button = preview.querySelector('[data-pdf-download]');
  const status = preview.querySelector('[data-pdf-status]');
  const documentBody = document.querySelector('.pdf-document');
  const section = documentBody.querySelector('.pdf-doc');
  let resourceWarning = '';
  let busy = false;
  let prepared = false;
  let finished = false;
  const send = (result) => parent.postMessage({ type: 'sps-pdf-document', index: Number(preview.dataset.pdfIndex), ...result }, location.origin);
  function updateControls() { button.disabled = !prepared || busy || finished; }
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
  let provenanceFont;
  const loadProvenanceFont = () => provenanceFont || (provenanceFont = (async () => {
    if (typeof parent.SPSPdfFont === 'function') return parent.SPSPdfFont();
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
      }
      SPSPdfTextLayer.write(pdf, text, { width: size.inner.width, pixelWidth: size.inner.px.width, pixelHeight: pageHeight }, await loadProvenanceFont());
      await addProvenance(pdf, section);
      return pdf.output('blob');
    } finally {
      worker.prop?.overlay?.remove();
    }
  };
  button.addEventListener('click', async () => {
    if (!prepared || busy || finished) return;
    busy = true;
    updateControls();
    try {
      await Promise.all([loadLibrary(), loadProvenanceFont()]);
      send({ blob: await makePdf(section), warning: resourceWarning });
    } catch (error) {
      send({ error: error.message || 'PDF 生成失败。' });
    } finally {
      finished = true;
      busy = false;
      updateControls();
    }
  });
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  Promise.all([loadLibrary(), loadProvenanceFont()]).catch(() => {});
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
        const settle = documentBody.querySelector('.mermaid, .md-graphviz') ? 1000 : 100;
        if (!pending && !diagrams && Date.now() - lastChange > settle) break;
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
    const diagramPending = !!documentBody.querySelector(".md-graphviz:empty")
      || Array.from(documentBody.querySelectorAll(".mermaid")).some((node) => !node.querySelector("svg, img"));
    status.textContent = incomplete || diagramPending
      ? "部分图片未能加载，请检查下载文件。"
      : "排版已就绪，正在生成 PDF…";
    if (incomplete || diagramPending) resourceWarning = '部分图片或图表未能加载，请检查下载文件。';
    prepared = true;
    updateControls();
    button.click();
  };
  prepare().catch((error) => {
    send({ error: error.message || '排版准备失败。' });
  });
})();
