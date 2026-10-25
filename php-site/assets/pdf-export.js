(() => {
  "use strict";
  const link = document.querySelector("[data-pdf-export-link]");
  if (link) {
    // Resolve the active document at click time, including after partial navigation.
    link.addEventListener("click", () => {
      const url = new URL(link.href);
      const shell = document.querySelector(".share-shell[data-share-doc-id]");
      if (shell) url.searchParams.set("doc", shell.dataset.shareDocId || "");
      link.href = url.href;
    });
  }
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
      // This is an auxiliary abuse signal; the independent IP allowance is mandatory.
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
        // Submit in the user's gesture where possible; no server-side browser process.
        HTMLFormElement.prototype.submit.call(form);
        form.querySelector("[data-pdf-form-status]").textContent = "已打开导出预览；如未出现，请允许此站点打开新窗口。";
      } catch {
        form.querySelector("[data-pdf-form-status]").textContent = "浏览器识别失败，请刷新页面后重试。";
      } finally {
        button.disabled = false;
      }
    });
  }

  const preview = document.querySelector("[data-pdf-preview]");
  if (!preview) return;
  const button = preview.querySelector("[data-pdf-print]");
  const status = preview.querySelector("[data-pdf-status]");
  const documentBody = document.querySelector(".pdf-document");
  const url = preview.dataset.exportUrl;
  const fields = () => new URLSearchParams({ csrf: preview.dataset.csrf, lease: preview.dataset.lease });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    navigator.sendBeacon?.(`${url}/release`, fields());
  };
  window.addEventListener("pagehide", release);
  window.addEventListener("afterprint", () => {
    release();
    button.disabled = true;
    status.textContent = "打印窗口已关闭。如需再次导出，请重新打开预览。";
  });
  const verify = async () => {
    const response = await fetch(`${url}/verify`, { method: "POST", body: fields(), credentials: "same-origin", cache: "no-store" });
    if (!response.ok) {
      const result = await response.json();
      documentBody.replaceChildren();
      throw new Error(result.error || "分享权限已失效，请重新打开分享页。");
    }
  };
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await verify();
      window.print();
    } catch (error) {
      status.textContent = error.message || "无法验证导出权限，请重新打开预览。";
      release();
    }
  });
  // Browser print is also available from its menu; provide the best local state
  // there, while the application's PDF action always revalidates on the server.
  window.addEventListener("beforeprint", () => {
    documentBody.querySelectorAll("details").forEach((item) => { item.open = true; });
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
      : "预览已就绪。点击保存，在打印窗口选择“另存为 PDF”。";
    button.disabled = false;
  };
  prepare().catch((error) => {
    status.textContent = error.message || "导出准备失败，请重新打开预览。";
    release();
  });
})();
