(() => {
  "use strict";

  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const scrollBehavior = () => reduceMotion?.matches ? "auto" : "smooth";
  // Animate only the surface that changed. Never delay input, fetching or rendering.
  const interfaceAnimations = new WeakMap();
  const revealSurface = (element, distance = 4) => {
    if (!element) return;
    interfaceAnimations.get(element)?.cancel();
    interfaceAnimations.delete(element);
    if (reduceMotion?.matches || !element.animate) return;
    const animation = element.animate([
      {opacity: .4, transform: `translateY(${distance}px)`},
      {opacity: 1, transform: "translateY(0)"},
    ], {duration: 220, easing: "cubic-bezier(.2,.8,.2,1)"});
    interfaceAnimations.set(element, animation);
    animation.onfinish = animation.oncancel = () => {
      if (interfaceAnimations.get(element) === animation) interfaceAnimations.delete(element);
    };
  };
  const readerAnnounce = (message) => {
    const status = document.querySelector("[data-reader-status]");
    if (status) status.textContent = message;
  };

  // Shared account/share fields. Passwords are revealed only from a local input;
  // no saved hash is sent to the browser or treated as a recoverable password.
  document.addEventListener("click", event => {
    const button = event.target.closest?.("[data-password-visibility]");
    if (!button) return;
    const input = document.getElementById(button.dataset.passwordVisibility);
    if (!input) return;
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    button.textContent = visible ? "Hide" : "Show";
    button.setAttribute("aria-pressed", String(visible));
  });
  document.addEventListener("input", event => {
    if (!event.target.matches?.("[data-share-new-password]")) return;
    const form = event.target.form;
    if (event.target.value) form?.querySelector('[name="password_mode"][value="set"]')?.click();
  });
  // Shared, interruptible presentation lifecycle. Timers are bounded and cancelled on reopening.
  const surfaceTimers = new WeakMap();
  const showSurface = (surface) => {
    if (!surface) return;
    clearTimeout(surfaceTimers.get(surface));
    surfaceTimers.delete(surface);
    surface.classList.remove("is-dismissing");
    surface.hidden = false;
  };
  const hideSurface = (surface, finish = () => { surface.hidden = true; }) => {
    if (!surface || surface.hidden || surfaceTimers.has(surface)) return;
    if (reduceMotion?.matches) { finish(); return; }
    surface.classList.add("is-dismissing");
    surfaceTimers.set(surface, window.setTimeout(() => {
      surfaceTimers.delete(surface);
      surface.classList.remove("is-dismissing");
      finish();
    }, 180));
  };

  // One last position per share; no note text, account data, or server writes.
  const readerKey = () => {
    const slug = document.querySelector("[data-share-sidebar]")?.dataset.shareSlug;
    return slug ? `sps:reading:${slug}` : "";
  };
  const readerDocumentLink = (id) => Array.from(document.querySelectorAll(".kb-tree-item[data-doc-id]"))
    .find((link) => link.dataset.docId === id);
  const readerRevealDocument = (id) => {
    let node = readerDocumentLink(id)?.closest(".kb-tree-node");
    while (node) {
      node.classList.remove("is-collapsed");
      node.classList.add("is-open");
      node.querySelector(":scope > .kb-tree-row .kb-tree-toggle")?.setAttribute("aria-expanded", "true");
      node = node.parentElement?.closest(".kb-tree-node");
    }
  };
  const readerSavePosition = () => {
    const key = readerKey();
    const id = document.querySelector(".share-shell")?.dataset.shareDocId;
    const title = document.querySelector(".kb-title")?.textContent?.trim();
    if (!key || !id || !title || !readerDocumentLink(id)) return;
    try { localStorage.setItem(key, JSON.stringify({id, title, y: Math.max(0, window.scrollY), time: Date.now()})); } catch (_) {}
  };
  let readerResume = null;
  const initReaderWelcome = () => {
    const resume = document.querySelector("[data-reader-resume]");
    if (!resume || !readerKey()) return;
    try {
      const record = JSON.parse(localStorage.getItem(readerKey()) || "null");
      const link = record && readerDocumentLink(record.id);
      if (!link || !Number.isFinite(record.time) || record.time > Date.now() || Date.now() - record.time > 30 * 86400000) return;
      resume.href = link.href;
      resume.querySelector("span").textContent = link.textContent.trim();
      resume.dataset.shareNav = "doc";
      resume.hidden = false;
      resume.onclick = () => {
        readerResume = {id: record.id, y: Math.max(0, Number(record.y) || 0)};
      };
    } catch (_) {}
  };

  const initReaderBehavior = () => {
    if (!document.body.classList.contains("layout-share")) return;
    const shortcut = document.querySelector(".kb-search-shortcut");
    if (shortcut && /Mac|iPhone|iPad/.test(navigator.platform)) shortcut.textContent = "⌘ K";
    document.querySelector("[data-share-search-input]")?.setAttribute("aria-keyshortcuts", "Control+k Meta+k");
    readerRevealDocument(document.querySelector(".share-shell")?.dataset.shareDocId);
    window.addEventListener("pagehide", readerSavePosition);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") readerSavePosition();
    });
    window.addEventListener("sps:share-dynamic-ready", () => {
      initReaderWelcome();
      const id = document.querySelector(".share-shell")?.dataset.shareDocId;
      if (!readerResume || readerResume.id !== id) return;
      const position = readerResume.y;
      readerResume = null;
      requestAnimationFrame(() => window.scrollTo({top: position, behavior: "auto"}));
    });
    // Native button feedback remains CSS-only; short content transitions never block navigation.
    document.addEventListener("keydown", (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k" || event.altKey) return;
      const input = document.querySelector("[data-share-search-input]");
      if (!input || document.querySelector("dialog[open], .image-viewer:not([hidden])")) return;
      event.preventDefault();
      document.querySelector("[data-reader-show-tree]")?.click();
      if (!document.body.classList.contains("share-side-open") && matchMedia("(max-width: 960px)").matches) {
        document.querySelector("[data-share-drawer-open]")?.click();
      }
      input.focus({preventScroll: true});
    });
    initReaderWelcome();
  };

  const scheduleIdle = (task, {timeout = 1200} = {}) => {
    const hidden =
      typeof document !== "undefined" &&
      (document.hidden || document.visibilityState === "hidden");
    if (hidden) {
      return window.setTimeout(task, 0);
    }
    if (typeof window.requestIdleCallback === "function") {
      return window.requestIdleCallback(task, {timeout});
    }
    return window.setTimeout(task, 0);
  };

  const tocCleanupMap = new WeakMap();
  const renderedMarkdown = new WeakMap();
  const diagramScripts = new Map();
  const appScriptUrl = document.currentScript?.src ||
    document.querySelector("script[src*='/assets/app.js']")?.src || "";
  const loadDiagramScript = (file, ready) => {
    if (ready()) return Promise.resolve();
    if (diagramScripts.has(file)) return diagramScripts.get(file);
    const promise = new Promise((resolve, reject) => {
      const url = new URL(`vendor/${file}`, appScriptUrl || document.baseURI);
      const version = appScriptUrl ? new URL(appScriptUrl).searchParams.get("v") : "";
      if (version) url.searchParams.set("v", version);
      const script = document.createElement("script");
      script.src = url.href;
      script.async = true;
      script.onload = () => ready() ? resolve() : reject(new Error(`Diagram library unavailable: ${file}`));
      script.onerror = () => {
        script.remove();
        reject(new Error(`Could not load diagram library: ${file}`));
      };
      document.head.appendChild(script);
    }).catch(error => { diagramScripts.delete(file); throw error; });
    diagramScripts.set(file, promise);
    return promise;
  };
  let imageViewerReady = false;
  let shareNavReady = false;
  let shareDynamicToken = 0;
  let markdownInitRetryTimer = null;
  let markdownInitRetryCount = 0;
  const markdownInitRetryLimit = 40;
  const FOOTNOTE_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h4"/></svg>';
  const footnoteWindows = new Set();
  const footnoteActionWindows = new WeakMap();
  const footnoteWindowActions = new WeakMap();
  let footnoteOpenTimer = 0;
  let footnoteCloseTimer = 0;
  let hoveredFootnoteAction = null;
  let footnoteWindowZ = 1300;
  let footnoteWindowSeq = 0;
  let footnotePreviewBound = false;

  const initKnowledgeTree = () => {
    const toggles = document.querySelectorAll(".kb-tree-toggle");
    if (!toggles.length) return;
    const getShareSlug = () => {
      const host = document.querySelector("[data-share-slug]");
      const slug = host?.dataset?.shareSlug || "";
      if (slug) return slug;
      const match = window.location.pathname.match(/\/s\/([^/]+)/);
      return match ? match[1] : "";
    };
    const getStorageKey = () => {
      const slug = getShareSlug();
      return slug ? `sps-tree-state:${slug}` : "";
    };
    const readState = () => {
      const key = getStorageKey();
      if (!key) return new Set();
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return new Set();
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return new Set();
        return new Set(parsed.filter(Boolean));
      } catch {
        return new Set();
      }
    };
    const writeState = (set) => {
      const key = getStorageKey();
      if (!key) return;
      try {
        const payload = JSON.stringify(Array.from(set));
        localStorage.setItem(key, payload);
      } catch {
        // ignore
      }
    };
    const syncState = () => {
      const openKeys = new Set();
      document.querySelectorAll(".kb-tree-node.is-open[data-tree-key]").forEach((node) => {
        const key = node.dataset.treeKey || "";
        if (key) openKeys.add(key);
      });
      writeState(openKeys);
    };
    const toggleNode = (node, nextOpen, animate = false) => {
      node.classList.toggle("is-open", nextOpen);
      node.classList.toggle("is-collapsed", !nextOpen);
      const btn = node.querySelector(".kb-tree-toggle");
      if (btn) btn.setAttribute("aria-expanded", String(nextOpen));
      const children = node.querySelector(":scope > .kb-tree-children");
      if (nextOpen && animate) revealSurface(children, -3);
      else if (children) interfaceAnimations.get(children)?.cancel();
    };
    const treeScope = document.querySelector("[data-share-panel='tree']") || document;
    const toggleAll = (nextOpen) => {
      const nodes = treeScope.querySelectorAll(".kb-tree-node[data-tree-key]");
      if (!nodes.length) return;
      nodes.forEach((node) => {
        if (!node.querySelector(".kb-tree-toggle")) return;
        toggleNode(node, nextOpen);
      });
      syncState();
    };
    const applyState = () => {
      const openKeys = readState();
      if (!openKeys.size) return;
      document.querySelectorAll(".kb-tree-node[data-tree-key]").forEach((node) => {
        if (!node.querySelector(".kb-tree-toggle")) return;
        const key = node.dataset.treeKey || "";
        if (!key) return;
        toggleNode(node, openKeys.has(key));
      });
    };
    toggles.forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        const node = btn.closest(".kb-tree-node");
        if (!node) return;
        const nextOpen = !node.classList.contains("is-open");
        toggleNode(node, nextOpen, true);
        syncState();
      });
    });
    document.querySelectorAll(".kb-tree-folder").forEach((label) => {
      label.addEventListener("click", () => {
        const node = label.closest(".kb-tree-node");
        if (!node || !node.querySelector(".kb-tree-toggle")) return;
        const nextOpen = !node.classList.contains("is-open");
        toggleNode(node, nextOpen, true);
        syncState();
      });
    });
    const collapseBtn = document.querySelector("[data-tree-collapse]");
    if (collapseBtn) {
      collapseBtn.addEventListener("click", (event) => {
        event.preventDefault();
        toggleAll(false);
      });
    }
    const expandBtn = document.querySelector("[data-tree-expand]");
    if (expandBtn) {
      expandBtn.addEventListener("click", (event) => {
        event.preventDefault();
        toggleAll(true);
      });
    }
    applyState();
  };

  const initDocTreeScroll = () => {
    const sidebar = document.querySelector(".kb-side-body");
    if (!sidebar) return;
    const active = sidebar.querySelector(".kb-tree-item.is-active");
    if (!active) return;
    const sidebarRect = sidebar.getBoundingClientRect();
    const itemRect = active.getBoundingClientRect();
    if (itemRect.top >= sidebarRect.top && itemRect.bottom <= sidebarRect.bottom) {
      return;
    }
    const offset = itemRect.top - sidebarRect.top - sidebar.clientHeight / 3;
    sidebar.scrollTo({top: sidebar.scrollTop + offset, behavior: scrollBehavior()});
  };

  const initShareToc = () => {
    const containers = Array.from(
      document.querySelectorAll("[data-share-toc]"),
    );
    if (!containers.length) return;

    const normalizeId = (text) => {
      const raw = String(text || "").trim().toLowerCase();
      const base = raw
        .replace(/\s+/g, "-")
        .replace(/[^\w\-\u4e00-\u9fff]+/g, "")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
      return base;
    };

    const ensureHeadingId = (heading, index) => {
      heading.tabIndex = -1;
      // Markdown-it may supply percent-encoded IDs. HTML IDs themselves must
      // contain the decoded text so native fragment links and focus agree.
      if (heading.id) {
        try {
          const decoded = decodeURIComponent(heading.id);
          const existing = document.getElementById(decoded);
          if (!existing || existing === heading) heading.id = decoded;
        } catch { /* Keep literal percent signs in user-supplied IDs. */ }
      }
      if (heading.id) return heading.id;
      const base = normalizeId(heading.textContent || "") || `section-${index + 1}`;
      let nextId = base;
      let counter = 1;
      while (document.getElementById(nextId)) {
        nextId = `${base}-${counter}`;
        counter += 1;
      }
      heading.id = nextId;
      return nextId;
    };

    const isFootnoteHeading = (heading, separator) => {
      if (!heading) return false;
      if (heading.closest(".footnotes")) return true;
      if (heading.closest(".markdown-footnotes")) return true;
      if (!separator) return false;
      return Boolean(separator.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING);
    };

    const buildTree = (headings, section) => {
      const root = {level: 0, children: []};
      const stack = [root];
      headings.forEach((heading, index) => {
        const level = Number(String(heading.tagName || "H2").slice(1)) || 2;
        const node = {
          heading,
          level,
          id: ensureHeadingId(heading, index),
          section,
          children: [],
        };
        while (stack.length > 1 && level <= stack[stack.length - 1].level) {
          stack.pop();
        }
        stack[stack.length - 1].children.push(node);
        stack.push(node);
      });
      return root.children;
    };

    const renderTree = (
      nodes,
      level = 0,
      section = "main",
      baseLevel = 1,
      footnoteMeta = null,
    ) => {
      const list = document.createElement("ul");
      list.className = "share-toc-list";
      if (section === "footnotes") {
        list.classList.add("share-toc-list--footnotes");
      }
      list.dataset.level = String(level);
      if (level > 0) list.classList.add("share-toc-children");
      nodes.forEach((node) => {
        const item = document.createElement("li");
        item.className = "share-toc-node";
        if (section === "footnotes") {
          item.classList.add("is-footnote");
        }
        const hasChildren = node.children.length > 0;

        const row = document.createElement("div");
        row.className = "share-toc-row";
        row.dataset.section = section;
        const indent = Math.max(0, level);
        row.style.setProperty("--toc-abs-indent", `${indent * 20}px`);

        const link = document.createElement("a");
        link.className = "share-toc-link";
        if (section === "footnotes") {
          link.classList.add("share-toc-link--footnote");
        }
        link.href = `#${node.id}`;
        link.setAttribute("draggable", "false");

        const levelBadge = document.createElement("span");
        levelBadge.className = "share-toc-level";
        levelBadge.textContent = "H";
        const levelNum = document.createElement("span");
        levelNum.className = "share-toc-level-num";
        levelNum.textContent = String(node.level);
        levelBadge.appendChild(levelNum);
        link.appendChild(levelBadge);

        const linkText = document.createElement("span");
        linkText.className = "share-toc-text";
        linkText.textContent = node.heading.textContent || "Untitled";

        if (section === "footnotes" && footnoteMeta) {
          const meta = footnoteMeta.get(node.heading);
          if (meta && meta.index) {
            link.dataset.footnoteIndex = String(meta.index);
            const backref = meta.backref || `#fnref${meta.index}`;
            link.dataset.footnoteBackref = backref;
            const sup = document.createElement("sup");
            sup.className = "share-toc-footnote-index";
            sup.textContent = `[${meta.index}]`;
            sup.setAttribute("role", "link");
            sup.tabIndex = 0;
            sup.dataset.footnoteIndex = String(meta.index);
            sup.dataset.footnoteBackref = backref;
            linkText.appendChild(sup);
          }
        }
        link.appendChild(linkText);
        row.appendChild(link);
        item.appendChild(row);

        if (hasChildren) {
          item.appendChild(
            renderTree(node.children, level + 1, section, baseLevel, footnoteMeta),
          );
        }
        list.appendChild(item);
      });
      return list;
    };

    containers.forEach((container) => {
      const prevCleanup = tocCleanupMap.get(container);
      if (typeof prevCleanup === "function") {
        prevCleanup();
        tocCleanupMap.delete(container);
      }
      const targetId = container.getAttribute("data-share-toc") || "";
      const target = document.querySelector(
        `.markdown-body[data-md-id="${targetId}"]`,
      );
      const body =
        container.querySelector(".share-toc-body") || container;
      const scrollBox = body;
      const hideFootnotesForToc =
        container.getAttribute("data-sps-hide-footnotes") === "1" ||
        document.body.classList.contains("sps-footnote-tab");
      const FOOTNOTE_ROOT_SELECTOR = ".footnotes > ol > li, .markdown-footnotes > ol > li";
      const parseFootnoteIndex = (value) => {
        const raw = String(value || "").trim();
        if (!raw) return 0;
        const match = raw.match(/^#?fn(?:ref)?[:\-_]?(\d+)/i);
        if (match) return Number(match[1]) || 0;
        const num = Number(raw);
        return Number.isFinite(num) ? num : 0;
      };
      const resolveFootnoteIndex = (item) => {
        if (!item) return 0;
        let index = parseFootnoteIndex(
          item.dataset.footnoteIndex || item.getAttribute("value") || item.id || "",
        );
        if (!index) {
          const list = item.closest?.("ol");
          if (list) {
            const siblings = Array.from(list.children || []);
            const pos = siblings.indexOf(item);
            if (pos >= 0) index = pos + 1;
          }
        }
        if (index) {
          item.dataset.footnoteIndex = String(index);
        }
        return index;
      };
      const ensureVisible = (element) => {
        if (!scrollBox || !element) return;
        const box = scrollBox.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        if (rect.top >= box.top && rect.bottom <= box.bottom) {
          return;
        }
        const offset = rect.top - box.top - 24;
        scrollBox.scrollTo({
          top: scrollBox.scrollTop + offset,
          behavior: scrollBehavior(),
        });
      };
      body.innerHTML = "";
      if (!target) return;

      const separator = target.querySelector("hr.footnotes-sep");
      const allHeadings = Array.from(
        target.querySelectorAll("h1, h2, h3, h4, h5, h6"),
      );
      if (!allHeadings.length) {
        const empty = document.createElement("div");
        empty.className = "share-toc-empty";
        empty.textContent = "No headings yet.";
        body.appendChild(empty);
        return;
      }

      const headingLevels = allHeadings
        .map((heading) => Number(String(heading.tagName || "H2").slice(1)) || 2)
        .filter((level) => Number.isFinite(level));
      const baseLevel = headingLevels.length ? Math.min(...headingLevels) : 1;
      const footnoteMeta = new Map();
      container.classList.add("share-toc--abs");

      const mainHeadings = [];
      const footnoteHeadings = [];
      allHeadings.forEach((heading) => {
        if (isFootnoteHeading(heading, separator)) {
          if (hideFootnotesForToc) return;
          footnoteHeadings.push(heading);
          const item = heading.closest(FOOTNOTE_ROOT_SELECTOR);
          const index = resolveFootnoteIndex(item);
          let backref = "";
          const backrefEl = item?.querySelector?.(
            ".footnote-backref, [data-footnote-backref], a[href^=\"#fnref\"]",
          );
          if (backrefEl) backref = backrefEl.getAttribute("href") || "";
          if (index > 0) {
            footnoteMeta.set(heading, {index, backref});
          }
        } else {
          mainHeadings.push(heading);
        }
      });
      const headings = [...mainHeadings, ...footnoteHeadings];
      if (!headings.length) {
        const empty = document.createElement("div");
        empty.className = "share-toc-empty";
        empty.textContent = "No headings yet.";
        body.appendChild(empty);
        return;
      }

      if (mainHeadings.length) {
        const nodes = buildTree(mainHeadings, "main");
        const list = renderTree(nodes, 0, "main", baseLevel, footnoteMeta);
        body.appendChild(list);
      }

      if (footnoteHeadings.length) {
        if (mainHeadings.length) {
          const divider = document.createElement("div");
          divider.className = "share-toc-divider";
          divider.setAttribute("aria-hidden", "true");
          body.appendChild(divider);
        }
        const nodes = buildTree(footnoteHeadings, "footnotes");
        const list = renderTree(nodes, 0, "footnotes", baseLevel, footnoteMeta);
        body.appendChild(list);
      }


      const scrollToElementWithOffset = (element) => {
        if (!element) return;
        const raw = window.getComputedStyle(element).scrollMarginTop;
        const marginTop = Number.parseFloat(raw || "0");
        const baseOffset = document.body.classList.contains("layout-share") ? 120 : 0;
        const offset = Math.max(baseOffset, Number.isFinite(marginTop) ? marginTop : 0);
        const top = element.getBoundingClientRect().top + window.scrollY - offset;
        window.scrollTo({top, behavior: scrollBehavior()});
      };

      const jumpToBackref = (href) => {
        if (!href) return null;
        if (href.startsWith("#")) {
          const id = href.slice(1);
          const targetEl = document.getElementById(id);
          if (targetEl) {
            scrollToElementWithOffset(targetEl);
            history.replaceState(null, "", href);
            return targetEl;
          }
        }
        window.location.href = href;
        return null;
      };

      const onFootnoteJump = (event) => {
        const sup = event.target?.closest?.(".share-toc-footnote-index");
        if (!sup) return;
        const href = sup.dataset.footnoteBackref || "";
        if (!href) return;
        event.preventDefault();
        event.stopPropagation();
        const targetEl = jumpToBackref(href);
        if (targetEl) {
          activeLock.id = "";
          activeLock.target = targetEl;
          activeLock.until = Date.now() + 2000;
          scheduleActiveByElement(targetEl);
        }
      };

      const onFootnoteKey = (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const sup = event.target?.closest?.(".share-toc-footnote-index");
        if (!sup) return;
        const href = sup.dataset.footnoteBackref || "";
        if (!href) return;
        event.preventDefault();
        event.stopPropagation();
        const targetEl = jumpToBackref(href);
        if (targetEl) {
          activeLock.id = "";
          activeLock.target = targetEl;
          activeLock.until = Date.now() + 2000;
          scheduleActiveByElement(targetEl);
        }
      };


      const onContentLinkClick = (event) => {
        const anchor = event.target?.closest?.("a");
        if (!anchor) return;
        const href = anchor.getAttribute("href") || "";
        if (!href.startsWith("#fn")) return;
        if (href.startsWith("#fnref")) return;
        const id = href.slice(1);
        const targetEl = document.getElementById(id);
        if (!targetEl) return;
        event.preventDefault();
        scrollToElementWithOffset(targetEl);
        history.replaceState(null, "", href);
        const index =
          parseFootnoteIndex(href) || findFootnoteIndexForElement(targetEl);
        if (setActiveByFootnoteIndex(index)) {
          activeLock.target = targetEl;
          activeLock.until = Date.now() + 2400;
        }
        scheduleActiveByElement(targetEl);
      };

      const onContentBackrefClick = (event) => {
        const anchor = event.target?.closest?.("a");
        if (!anchor) return;
        const href = anchor.getAttribute("href") || "";
        if (!href.startsWith("#fnref")) return;
        const id = href.slice(1);
        const targetEl = document.getElementById(id);
        if (!targetEl) return;
        event.preventDefault();
        scrollToElementWithOffset(targetEl);
        history.replaceState(null, "", href);
        activeLock.id = "";
        activeLock.target = targetEl;
        activeLock.until = Date.now() + 2000;
        scheduleActiveByElement(targetEl);
      };

      const onHashChange = () => {
        const id = window.location.hash.replace(/^#/, "");
        if (!id) return;
        const targetEl = document.getElementById(id);
        if (!targetEl) return;
        scheduleActiveByElement(targetEl);
      };

      if (target) {
        target.addEventListener("click", onContentLinkClick);
        target.addEventListener("click", onContentBackrefClick);
      }
      window.addEventListener("hashchange", onHashChange);

      body.addEventListener("click", onFootnoteJump);
      body.addEventListener("keydown", onFootnoteKey);

      const dragState = {
        isDown: false,
        isDragging: false,
        startX: 0,
        scrollLeft: 0,
        suppressUntil: 0,
      };
      const dragThreshold = 3;

      const onMouseDown = (event) => {
        if (event.button !== 0) return;
        dragState.isDown = true;
        dragState.isDragging = false;
        dragState.startX = event.clientX;
        dragState.scrollLeft = scrollBox.scrollLeft;
      };

      const onMouseMove = (event) => {
        if (!dragState.isDown) return;
        const deltaX = event.clientX - dragState.startX;
        if (!dragState.isDragging && Math.abs(deltaX) >= dragThreshold) {
          dragState.isDragging = true;
        }
        if (dragState.isDragging) {
          scrollBox.scrollLeft = dragState.scrollLeft - deltaX;
        }
      };

      const stopDrag = () => {
        if (!dragState.isDown) return;
        dragState.isDown = false;
        if (dragState.isDragging) {
          dragState.suppressUntil = Date.now() + 250;
        }
        dragState.isDragging = false;
      };

      const onDragStart = (event) => {
        event.preventDefault();
      };
      const onClickCapture = (event) => {
        if (Date.now() < dragState.suppressUntil) {
          event.preventDefault();
          event.stopPropagation();
        }
      };

      scrollBox.addEventListener("mousedown", onMouseDown);
      scrollBox.addEventListener("mousemove", onMouseMove);
      scrollBox.addEventListener("mouseup", stopDrag);
      scrollBox.addEventListener("mouseleave", stopDrag);
      scrollBox.addEventListener("dragstart", onDragStart);
      scrollBox.addEventListener("click", onClickCapture, true);

      const linkMap = new Map();
      const activeLock = {
        id: "",
        until: 0,
        scrollEndTimer: 0,
        scrollTicking: false,
        scrollOffset: 0,
        target: null,
      };
      const setActiveLink = (link) => {
        body.querySelectorAll(".share-toc-link").forEach((item) => {
          item.classList.remove("is-active");
        });
        body.querySelectorAll(".share-toc-row").forEach((row) => {
          row.classList.remove("is-active");
        });
        if (link) {
          link.classList.add("is-active");
          const row = link.closest(".share-toc-row");
          if (row) row.classList.add("is-active");
        }
      };
      body.querySelectorAll(".share-toc-link").forEach((link) => {
        const href = link.getAttribute("href") || "";
        if (href.startsWith("#")) {
          linkMap.set(href.slice(1), link);
        }
      });

      const isFnRefId = (value) => /^fnref[:\-_]?\d+/i.test(String(value || ""));

      const footnoteIndexToLink = new Map();
      body.querySelectorAll(".share-toc-link--footnote").forEach((link) => {
        const idx = parseFootnoteIndex(link.dataset.footnoteIndex || "");
        if (idx > 0 && !footnoteIndexToLink.has(idx)) {
          footnoteIndexToLink.set(idx, link);
        }
      });

      const footnoteItems = [];
      if (target && !hideFootnotesForToc) {
        const candidates = Array.from(
          target.querySelectorAll(FOOTNOTE_ROOT_SELECTOR),
        );
        candidates.forEach((item) => {
          const index = resolveFootnoteIndex(item);
          if (!index) return;
          footnoteItems.push(item);
        });
      }

      const activeTargets = [];
      headings.forEach((heading) => {
        if (!heading?.id) return;
        activeTargets.push({type: "heading", element: heading, id: heading.id});
      });
      footnoteItems.forEach((item) => {
        const index = parseFootnoteIndex(item.dataset.footnoteIndex || item.id);
        if (!index) return;
        activeTargets.push({type: "footnote", element: item, index});
      });
      activeTargets.sort((a, b) => {
        if (a.element === b.element) return 0;
        const pos = a.element.compareDocumentPosition(b.element);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });

      const findFootnoteIndexForElement = (element) => {
        if (hideFootnotesForToc) return 0;
        if (!element) return 0;
        const item = element.closest?.(FOOTNOTE_ROOT_SELECTOR);
        if (item) {
          return resolveFootnoteIndex(item);
        }
        const id = element.id || "";
        if (id && isFnRefId(id)) {
          return 0;
        }
        if (id) {
          return parseFootnoteIndex(id);
        }
        return 0;
      };

      const findHeadingForElement = (element) => {
        if (!element || !headings.length) return null;
        let chosen = null;
        headings.forEach((heading) => {
          if (!heading) return;
          if (heading === element) {
            chosen = heading;
            return;
          }
          const pos = heading.compareDocumentPosition(element);
          if (
            pos & Node.DOCUMENT_POSITION_FOLLOWING ||
            pos & Node.DOCUMENT_POSITION_CONTAINED_BY
          ) {
            chosen = heading;
          }
        });
        return chosen;
      };

      const setActiveByElement = (element) => {
        const footnoteIndex = findFootnoteIndexForElement(element);
        if (footnoteIndex && setActiveByFootnoteIndex(footnoteIndex)) {
          return;
        }
        const targetHeading = findHeadingForElement(element);
        if (!targetHeading) return;
        const link = linkMap.get(targetHeading.id);
        if (!link) return;
        activeLock.id = targetHeading.id;
        activeLock.until = Date.now() + 900;
        setActiveLink(link);
        ensureVisible(link);
      };

      const highlightByElement = (element) => {
        const footnoteIndex = findFootnoteIndexForElement(element);
        if (footnoteIndex) {
          const link = footnoteIndexToLink.get(footnoteIndex);
          if (link) {
            setActiveLink(link);
            ensureVisible(link);
            return true;
          }
        }
        const targetHeading = findHeadingForElement(element);
        if (!targetHeading) return false;
        const link = linkMap.get(targetHeading.id);
        if (!link) return false;
        setActiveLink(link);
        ensureVisible(link);
        return true;
      };

      const scheduleActiveByElement = (element) => {
        if (!element) return;
        requestAnimationFrame(() => {
          setTimeout(() => setActiveByElement(element), 40);
        });
      };

      const setActiveByFootnoteIndex = (index) => {
        if (!index) return false;
        const link = footnoteIndexToLink.get(index);
        if (!link) return false;
        const href = link.getAttribute("href") || "";
        if (href.startsWith("#")) {
          activeLock.id = href.slice(1);
          activeLock.until = Date.now() + 900;
        }
        setActiveLink(link);
        ensureVisible(link);
        return true;
      };

      body.querySelectorAll(".share-toc-link").forEach((link) => {
        link.addEventListener("click", (event) => {
          if (Date.now() < dragState.suppressUntil) {
            event.preventDefault();
            return;
          }
          const href = link.getAttribute("href") || "";
          if (!href.startsWith("#")) return;
          const target = document.getElementById(href.slice(1));
          if (!target) return;
          event.preventDefault();
          activeLock.id = target.id;
          activeLock.until = Date.now() + 1200;
          target.scrollIntoView({behavior: scrollBehavior(), block: "start"});
          target.focus({preventScroll: true});
          history.replaceState(null, "", href);
          setActiveLink(link);
          ensureVisible(link);
        });
      });

      const getScrollOffset = () => {
        const sample = headings[0];
        if (!sample) return 0;
        const raw = window.getComputedStyle(sample).scrollMarginTop;
        const value = Number.parseFloat(raw || "0");
        if (Number.isFinite(value) && value > 0) return value;
        return document.body.classList.contains("layout-share") ? 120 : 0;
      };
      activeLock.scrollOffset = getScrollOffset();
      const activeThreshold = 8;

      const pickActiveTarget = () => {
        if (!activeTargets.length) return null;
        const offset = activeLock.scrollOffset || 0;
        let current = null;
        for (const target of activeTargets) {
          const top = target.element.getBoundingClientRect().top;
          if (top - offset <= activeThreshold) {
            current = target;
          } else {
            break;
          }
        }
        return current;
      };

      const updateActiveByScroll = () => {
        if (activeLock.target) {
          const now = Date.now();
          const offset = activeLock.scrollOffset || 0;
          const distance = Math.abs(
            activeLock.target.getBoundingClientRect().top - offset,
          );
          const shouldUnlock =
            now >= activeLock.until ||
            (Number.isFinite(distance) && distance <= activeThreshold);
          if (shouldUnlock) {
            activeLock.target = null;
          } else {
            if (highlightByElement(activeLock.target)) {
              return;
            }
          }
        }
        if (activeLock.id) {
          if (Date.now() < activeLock.until) {
            const locked = linkMap.get(activeLock.id);
            if (locked) {
              setActiveLink(locked);
              ensureVisible(locked);
              return;
            }
          }
          activeLock.id = "";
          activeLock.until = 0;
        }

        const activeTarget = pickActiveTarget();
        if (!activeTarget) return;
        if (activeTarget.type === "footnote") {
          if (setActiveByFootnoteIndex(activeTarget.index)) {
            return;
          }
          const fallback = findHeadingForElement(activeTarget.element);
          if (!fallback) return;
          const fallbackLink = linkMap.get(fallback.id);
          if (!fallbackLink) return;
          setActiveLink(fallbackLink);
          ensureVisible(fallbackLink);
          return;
        }

        const link = linkMap.get(activeTarget.id);
        if (!link) return;
        setActiveLink(link);
        ensureVisible(link);
      };

      const onScroll = () => {
        if (!activeLock.scrollTicking) {
          activeLock.scrollTicking = true;
          requestAnimationFrame(() => {
            activeLock.scrollTicking = false;
            updateActiveByScroll();
          });
        }
        clearTimeout(activeLock.scrollEndTimer);
        activeLock.scrollEndTimer = window.setTimeout(() => {
          updateActiveByScroll();
        }, 160);
      };

      const scrollOpts = {passive: true};
      const onResize = () => {
        activeLock.scrollOffset = getScrollOffset();
        updateActiveByScroll();
      };
      window.addEventListener("scroll", onScroll, scrollOpts);
      window.addEventListener("resize", onResize);
      updateActiveByScroll();

      tocCleanupMap.set(container, () => {
        scrollBox.removeEventListener("mousedown", onMouseDown);
        scrollBox.removeEventListener("mousemove", onMouseMove);
        scrollBox.removeEventListener("mouseup", stopDrag);
        scrollBox.removeEventListener("mouseleave", stopDrag);
        scrollBox.removeEventListener("dragstart", onDragStart);
        scrollBox.removeEventListener("click", onClickCapture, true);
        window.removeEventListener("scroll", onScroll, scrollOpts);
        window.removeEventListener("resize", onResize);
        body.removeEventListener("click", onFootnoteJump);
        body.removeEventListener("keydown", onFootnoteKey);
        if (target) {
          target.removeEventListener("click", onContentLinkClick);
          target.removeEventListener("click", onContentBackrefClick);
        }
        window.removeEventListener("hashchange", onHashChange);

      });
    });
  };

  const escapeHtml = (value) =>
    String(value || "").replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        case "'":
          return "&#39;";
        default:
          return ch;
      }
    });

  const shareDangerousStyleRe =
    /expression\s*\(|javascript\s*:|vbscript\s*:|url\s*\(\s*['"]?\s*data\s*:\s*text\/html/i;

  const isSafeShareUrl = (value, {tag = "", attr = ""} = {}) => {
    const raw = String(value || "").trim();
    if (!raw) return true;
    const compact = raw.replace(/[\u0000-\u0020\u007f\s]+/g, "") || raw;
    const safeTag = String(tag || "").toLowerCase();
    const safeAttr = String(attr || "").toLowerCase();

    if (/^(?:javascript|vbscript)\s*:/i.test(compact)) return false;
    if (/^data\s*:/i.test(compact)) {
      if (
        safeTag === "img" &&
        safeAttr === "src" &&
        /^data:image\/(?:png|gif|jpe?g|webp|bmp|avif);base64,[a-z0-9+/=\r\n]+$/i.test(compact)
      ) {
        return true;
      }
      return false;
    }
    if (safeTag === "iframe" && safeAttr === "src") {
      if (!compact) return true;
      if (/^(?:https?:)?\/\//i.test(compact)) return true;
      if (compact.startsWith("/") || compact.startsWith("./") || compact.startsWith("../")) {
        return true;
      }
      if (/^about:blank(?:[?#].*)?$/i.test(compact)) return true;
      return false;
    }
    if (compact.startsWith("#")) return true;
    if (compact.startsWith("/") && !compact.startsWith("//")) return true;
    if (compact.startsWith("./") || compact.startsWith("../")) return true;
    if (compact.startsWith("//")) return true;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(compact)) {
      return /^(?:https?|mailto|tel):/i.test(compact);
    }
    return true;
  };

  const sanitizeShareHtml = (html) => {
    const template = document.createElement("template");
    template.innerHTML = String(html || "");
    const blockedTags = new Set([
      "script",
      "object",
      "embed",
      "svg",
      "math",
      "base",
      "meta",
      "link",
    ]);
    const katexSvgAllowedTags = new Set(["svg", "path", "line", "g"]);
    const katexSvgAllowedAttrs = {
      svg: new Set([
        "class",
        "style",
        "xmlns",
        "xmlns:xlink",
        "width",
        "height",
        "viewbox",
        "preserveaspectratio",
        "role",
        "aria-hidden",
        "focusable",
      ]),
      path: new Set([
        "class",
        "style",
        "d",
        "fill",
        "fill-rule",
        "fill-opacity",
        "stroke",
        "stroke-width",
        "stroke-linecap",
        "stroke-linejoin",
        "stroke-miterlimit",
        "stroke-dasharray",
        "stroke-dashoffset",
        "stroke-opacity",
        "transform",
        "opacity",
      ]),
      line: new Set([
        "class",
        "style",
        "x1",
        "y1",
        "x2",
        "y2",
        "fill",
        "fill-opacity",
        "stroke",
        "stroke-width",
        "stroke-linecap",
        "stroke-linejoin",
        "stroke-miterlimit",
        "stroke-dasharray",
        "stroke-dashoffset",
        "stroke-opacity",
        "transform",
        "opacity",
      ]),
      g: new Set([
        "class",
        "style",
        "transform",
        "fill",
        "fill-rule",
        "fill-opacity",
        "stroke",
        "stroke-width",
        "stroke-linecap",
        "stroke-linejoin",
        "stroke-miterlimit",
        "stroke-dasharray",
        "stroke-dashoffset",
        "stroke-opacity",
        "opacity",
      ]),
    };
    const urlAttrs = new Set(["href", "src", "xlink:href", "formaction", "action", "poster"]);
    const iframeAllowedAttrs = new Set([
      "src",
      "width",
      "height",
      "title",
      "allow",
      "allowfullscreen",
      "loading",
      "referrerpolicy",
      "sandbox",
      "frameborder",
    ]);

    const nodes = Array.from(template.content.querySelectorAll("*"));
    nodes.forEach((node) => {
      if (!(node instanceof Element)) return;
      const tag = node.tagName.toLowerCase();
      const insideSvg = tag === "svg" || !!node.closest("svg");
      const insideKatex = !!node.closest(".katex");
      const isKatexSvgNode = insideSvg && insideKatex && katexSvgAllowedTags.has(tag);
      if (blockedTags.has(tag)) {
        if (!(tag === "svg" && isKatexSvgNode)) {
          node.remove();
          return;
        }
      } else if (insideSvg && !isKatexSvgNode) {
        node.remove();
        return;
      }

      const allowedSvgAttrs = isKatexSvgNode ? katexSvgAllowedAttrs[tag] : null;
      Array.from(node.attributes).forEach((attribute) => {
        const name = String(attribute.name || "").toLowerCase();
        const value = String(attribute.value || "");
        if (name.startsWith("on")) {
          node.removeAttribute(attribute.name);
          return;
        }
        if (name === "srcdoc") {
          node.removeAttribute(attribute.name);
          return;
        }
        if (allowedSvgAttrs && !allowedSvgAttrs.has(name)) {
          node.removeAttribute(attribute.name);
          return;
        }
        if (name === "style" && shareDangerousStyleRe.test(value)) {
          node.removeAttribute(attribute.name);
          return;
        }
        if (tag === "iframe" && !iframeAllowedAttrs.has(name)) {
          node.removeAttribute(attribute.name);
          return;
        }
        if (urlAttrs.has(name) && !isSafeShareUrl(value, {tag, attr: name})) {
          node.removeAttribute(attribute.name);
        }
      });

      if (tag === "iframe") {
        const src = (node.getAttribute("src") || "").trim();
        if (src && !isSafeShareUrl(src, {tag: "iframe", attr: "src"})) {
          node.remove();
        }
      }
    });

    return template.innerHTML;
  };

  const parseFootnoteIndexLoose = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return 0;
    const match = raw.match(/^#?fn(?:ref)?[:\-_]?(\d+)/i);
    if (match) return Number(match[1]) || 0;
    const num = Number(raw);
    return Number.isFinite(num) ? num : 0;
  };

  const getFootnoteIndexForItem = (item, fallbackIndex) => {
    if (!item) return 0;
    let index = parseFootnoteIndexLoose(item.dataset.footnoteIndex || item.id || "");
    if (!index) {
      const list = item.closest("ol");
      if (list) {
        const siblings = Array.from(list.children || []);
        const pos = siblings.indexOf(item);
        if (pos >= 0) index = pos + 1;
      }
    }
    if (!index && Number.isFinite(fallbackIndex)) {
      index = fallbackIndex + 1;
    }
    if (index) {
      item.dataset.footnoteIndex = String(index);
    }
    return index;
  };

  const stripFootnoteExtras = (element) => {
    if (!element) return;
    element
      .querySelectorAll(
        ".footnote-backref, [data-footnote-backref], a[href^=\"#fnref\"]",
      )
      .forEach((node) => node.remove());
  };

  const syncRichMediaFromSource = (sourceRoot, cloneRoot) => {
    if (!sourceRoot || !cloneRoot) return;

    cloneRoot.querySelectorAll(".iframe-fullscreen-toggle").forEach((button) => {
      button.remove();
    });
    cloneRoot.querySelectorAll("[data-sps-iframe-fs-bound]").forEach((node) => {
      node.removeAttribute("data-sps-iframe-fs-bound");
    });
    cloneRoot.querySelectorAll(".md-echarts").forEach((chartEl) => {
      chartEl.removeAttribute("data-sps-echarts-inited");
    });
    cloneRoot.querySelectorAll(".sps-footnote-action").forEach((button) => {
      button.remove();
    });
    cloneRoot
      .querySelectorAll("[data-sps-footnote-preview]")
      .forEach((node) => node.removeAttribute("data-sps-footnote-preview"));

    const sourceCharts = Array.from(
      sourceRoot.querySelectorAll(".md-diagram--echarts"),
    );
    const cloneCharts = Array.from(
      cloneRoot.querySelectorAll(".md-diagram--echarts"),
    );
    sourceCharts.forEach((sourceChart, idx) => {
      const cloneChart = cloneCharts[idx];
      if (!cloneChart) return;
      const raw = sourceChart.getAttribute("data-sps-echarts-source") || "";
      if (raw && !cloneChart.getAttribute("data-sps-echarts-source")) {
        cloneChart.setAttribute("data-sps-echarts-source", raw);
      }
    });

    const sourceCanvases = Array.from(sourceRoot.querySelectorAll("canvas"));
    const cloneCanvases = Array.from(cloneRoot.querySelectorAll("canvas"));
    const count = Math.min(sourceCanvases.length, cloneCanvases.length);
    for (let i = 0; i < count; i += 1) {
      const sourceCanvas = sourceCanvases[i];
      const cloneCanvas = cloneCanvases[i];
      if (!sourceCanvas || !cloneCanvas) continue;
      let dataUrl = "";
      try {
        dataUrl = sourceCanvas.toDataURL("image/png");
      } catch {
        dataUrl = "";
      }
      if (!dataUrl || dataUrl.length < 32) continue;
      const img = document.createElement("img");
      img.src = dataUrl;
      img.alt =
        cloneCanvas.getAttribute("aria-label") ||
        sourceCanvas.getAttribute("aria-label") ||
        "diagram";
      const className = cloneCanvas.getAttribute("class") || "";
      if (className) img.setAttribute("class", className);
      const width = cloneCanvas.getAttribute("width") || sourceCanvas.getAttribute("width");
      const height = cloneCanvas.getAttribute("height") || sourceCanvas.getAttribute("height");
      if (width) img.setAttribute("width", width);
      if (height) img.setAttribute("height", height);
      const styleText =
        cloneCanvas.getAttribute("style") || sourceCanvas.getAttribute("style") || "";
      if (styleText) img.setAttribute("style", styleText);
      cloneCanvas.replaceWith(img);
    }
  };

  const buildFootnoteContentHtml = (item) => {
    if (!item) return "";
    const clone = item.cloneNode(true);
    syncRichMediaFromSource(item, clone);
    stripFootnoteExtras(clone);
    clone.removeAttribute("id");
    clone.removeAttribute("data-footnote-index");
    return clone.innerHTML;
  };

  const getFootnoteAnchorPointFromEvent = (event) => {
    if (!event) return null;
    const touch = event.touches?.[0] || event.changedTouches?.[0] || null;
    const rawX = touch ? touch.clientX : event.clientX;
    const rawY = touch ? touch.clientY : event.clientY;
    const x = Number(rawX);
    const y = Number(rawY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x <= 0 && y <= 0 && Number(event.detail || 0) === 0) {
      return null;
    }
    return {x, y};
  };

  const getFootnoteAnchorPointFromElement = (element) => {
    if (!element || typeof element.getBoundingClientRect !== "function") return null;
    const rect = element.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  };

  const resolveFootnoteAnchorPoint = (event, element) =>
    getFootnoteAnchorPointFromEvent(event) || getFootnoteAnchorPointFromElement(element);

  const getShareAssetsBaseUrl = () => {
    const source =
      document.querySelector("script[src*='/assets/app.js']")?.src ||
      document.querySelector("link[href*='/assets/style.css']")?.href ||
      "";
    if (!source) return "";
    try {
      return new URL(".", source).href;
    } catch {
      return "";
    }
  };

  const resolveShareAssetUrl = (selector, relativePath, baseUrl) => {
    const node = document.querySelector(selector);
    const direct = node?.href || node?.src || "";
    if (direct) return direct;
    if (!baseUrl) return "";
    try {
      return new URL(relativePath, baseUrl).href;
    } catch {
      return "";
    }
  };

  const getShareMarkdownScriptEntries = (assetsBaseUrl) => {
    const entries = [
      {
        selector: "script[src*='/assets/app.js']",
        path: "app.js",
        readyEvent: false,
      },
      {
        selector: "script[src*='/assets/vendor/markdown-it.min.js']",
        path: "vendor/markdown-it.min.js",
        readyEvent: false,
      },
      {
        selector: "script[src*='/assets/vendor/markdown-it-task-lists.min.js']",
        path: "vendor/markdown-it-task-lists.min.js",
        readyEvent: false,
      },
      {
        selector: "script[src*='/assets/vendor/markdown-it-emoji.min.js']",
        path: "vendor/markdown-it-emoji.min.js",
        readyEvent: false,
      },
      {
        selector: "script[src*='/assets/vendor/markdown-it-footnote.min.js']",
        path: "vendor/markdown-it-footnote.min.js",
        readyEvent: false,
      },
      {
        selector: "script[src*='/assets/vendor/markdown-it-deflist.min.js']",
        path: "vendor/markdown-it-deflist.min.js",
        readyEvent: false,
      },
      {
        selector: "script[src*='/assets/vendor/markdown-it-mark.min.js']",
        path: "vendor/markdown-it-mark.min.js",
        readyEvent: false,
      },
      {
        selector: "script[src*='/assets/vendor/markdown-it-sub.min.js']",
        path: "vendor/markdown-it-sub.min.js",
        readyEvent: false,
      },
      {
        selector: "script[src*='/assets/vendor/markdown-it-sup.min.js']",
        path: "vendor/markdown-it-sup.min.js",
        readyEvent: false,
      },
      {
        selector: "script[src*='/assets/vendor/markdown-it-abbr.min.js']",
        path: "vendor/markdown-it-abbr.min.js",
        readyEvent: false,
      },
      {
        selector: "script[src*='/assets/vendor/markdown-it-ins.min.js']",
        path: "vendor/markdown-it-ins.min.js",
        readyEvent: false,
      },
      {
        selector: "script[src*='/assets/vendor/markdown-it-container.min.js']",
        path: "vendor/markdown-it-container.min.js",
        readyEvent: false,
      },
      {
        selector: "script[src*='/assets/vendor/markdown-it-anchor.min.js']",
        path: "vendor/markdown-it-anchor.min.js",
        readyEvent: false,
      },
      {
        selector: "script[src*='/assets/vendor/katex.min.js']",
        path: "vendor/katex.min.js",
        readyEvent: false,
      },
      {
        selector: "script[src*='/assets/vendor/highlight.min.js']",
        path: "vendor/highlight.min.js",
        readyEvent: false,
      },
    ];
    return entries
      .map((entry) => ({
        ...entry,
        url: resolveShareAssetUrl(entry.selector, entry.path, assetsBaseUrl),
      }))
      .filter((entry) => Boolean(entry.url))
      .sort((a, b) => Number(a.path === "app.js") - Number(b.path === "app.js"));
  };

  const collectFootnoteTargetIds = (root) => {
    if (!root) return [];
    const ids = new Set();
    root
      .querySelectorAll("a[href^=\"#fn\"]")
      .forEach((anchor) => {
        const href = String(anchor.getAttribute("href") || "");
        if (!href || href.startsWith("#fnref")) return;
        const id = href.replace(/^#/, "").trim();
        if (id) ids.add(id);
      });
    return Array.from(ids);
  };

  const resolveFootnoteItemByTargetId = (targetId) => {
    if (!targetId) return null;
    const direct = document.getElementById(targetId);
    if (direct) {
      return (
        direct.closest(".footnotes li, .markdown-footnotes li") ||
        direct.closest("li[id]") ||
        null
      );
    }
    return null;
  };

  const bindLocalFnrefAnchors = (root, fnrefByIndex, usedIds) => {
    if (!root) return;
    root
      .querySelectorAll("a[href^=\"#fn\"]")
      .forEach((anchor) => {
        const href = String(anchor.getAttribute("href") || "");
        if (!href || href.startsWith("#fnref")) return;
        const index = parseFootnoteIndexLoose(href);
        if (!index || fnrefByIndex.has(index)) return;
        const existingId = String(anchor.getAttribute("id") || "").trim();
        if (existingId) {
          usedIds.add(existingId);
          fnrefByIndex.set(index, `#${existingId}`);
          return;
        }
        let id = `fnref${index}`;
        if (usedIds.has(id)) {
          let suffix = 1;
          while (usedIds.has(`${id}:${suffix}`)) {
            suffix += 1;
          }
          id = `${id}:${suffix}`;
        }
        anchor.setAttribute("id", id);
        usedIds.add(id);
        fnrefByIndex.set(index, `#${id}`);
      });
  };

  const ensureFallbackFnrefAnchor = (
    index,
    fallbackHost,
    fnrefByIndex,
    usedIds,
  ) => {
    if (!index || fnrefByIndex.has(index) || !fallbackHost) return "";
    let id = `fnref${index}`;
    if (usedIds.has(id)) {
      let suffix = 1;
      while (usedIds.has(`${id}:${suffix}`)) {
        suffix += 1;
      }
      id = `${id}:${suffix}`;
    }
    const marker = document.createElement("span");
    marker.setAttribute("id", id);
    marker.setAttribute("data-sps-fnref-fallback", String(index));
    marker.setAttribute("aria-hidden", "true");
    marker.style.cssText = "display:block;height:0;overflow:hidden;";
    fallbackHost.appendChild(marker);
    usedIds.add(id);
    const href = `#${id}`;
    fnrefByIndex.set(index, href);
    return href;
  };

  const rewriteFootnoteBackrefs = (item, backrefHref) => {
    if (!item || !backrefHref) return;
    const backrefNodes = Array.from(
      item.querySelectorAll(
        ".footnote-backref, [data-footnote-backref], a[href^=\"#fnref\"]",
      ),
    );
    if (!backrefNodes.length) {
      const marker = document.createElement("span");
      marker.hidden = true;
      marker.setAttribute("data-footnote-backref", backrefHref);
      item.insertBefore(marker, item.firstChild);
      return;
    }
    backrefNodes.forEach((node) => {
      node.setAttribute("data-footnote-backref", backrefHref);
      if (node.tagName === "A") {
        node.setAttribute("href", backrefHref);
      }
    });
  };

  const buildFootnoteRegistryPayload = (sourceHtml, primaryIndex = 0) => {
    const template = document.createElement("template");
    template.innerHTML = String(sourceHtml || "");
    const fallbackHost = document.createElement("div");
    fallbackHost.setAttribute("aria-hidden", "true");
    fallbackHost.style.cssText =
      "display:block;height:0;overflow:hidden;pointer-events:none;";
    fallbackHost.setAttribute("data-sps-fnref-fallback-host", "1");
    template.content.insertBefore(fallbackHost, template.content.firstChild);
    const usedIds = new Set();
    template.content.querySelectorAll("[id]").forEach((node) => {
      const id = String(node.getAttribute("id") || "").trim();
      if (id) usedIds.add(id);
    });
    const fnrefByIndex = new Map();
    bindLocalFnrefAnchors(template.content, fnrefByIndex, usedIds);
    if (primaryIndex > 0) {
      ensureFallbackFnrefAnchor(primaryIndex, fallbackHost, fnrefByIndex, usedIds);
    }
    const queue = collectFootnoteTargetIds(template.content);
    if (!queue.length) {
      if (!fallbackHost.childNodes.length) fallbackHost.remove();
      return {
        contentHtml: template.innerHTML,
        registryHtml: "",
      };
    }

    const visitedTargets = new Set();
    const seenItems = new Set();
    const rows = [];

    while (queue.length) {
      const targetId = String(queue.shift() || "").trim();
      if (!targetId || visitedTargets.has(targetId)) continue;
      visitedTargets.add(targetId);

      const item = resolveFootnoteItemByTargetId(targetId);
      if (!item) continue;

      const index = getFootnoteIndexForItem(item, 0);
      const rawId = String(item.getAttribute("id") || "").trim();
      const resolvedId = rawId || targetId || (index > 0 ? `fn${index}` : "");
      const key = resolvedId || (index > 0 ? `idx:${index}` : "");
      if (!key || seenItems.has(key)) continue;
      seenItems.add(key);

      const clone = item.cloneNode(true);
      syncRichMediaFromSource(item, clone);
      if (resolvedId) clone.setAttribute("id", resolvedId);
      if (index > 0) {
        clone.setAttribute("data-footnote-index", String(index));
        clone.setAttribute("value", String(index));
      }
      bindLocalFnrefAnchors(clone, fnrefByIndex, usedIds);
      if (index > 0) {
        const backrefHref =
          fnrefByIndex.get(index) ||
          ensureFallbackFnrefAnchor(index, fallbackHost, fnrefByIndex, usedIds) ||
          `#fnref${index}`;
        rewriteFootnoteBackrefs(clone, backrefHref);
      }
      collectFootnoteTargetIds(clone).forEach((id) => {
        if (!visitedTargets.has(id)) queue.push(id);
      });
      rows.push(clone.outerHTML);
    }

    if (!fallbackHost.childNodes.length) fallbackHost.remove();
    return {
      contentHtml: template.innerHTML,
      registryHtml: rows.length
        ? `<hr class="footnotes-sep">` +
          `<section class="footnotes sps-footnote-registry">` +
          `<ol>${rows.join("")}</ol>` +
          `</section>`
        : "",
    };
  };

  const openFootnoteInNewTab = (index, contentHtml) => {
    const title = index ? `Footnote ${index}` : "Footnote";
    const tab = window.open("", "_blank");
    if (!tab || !tab.document) return;
    const assetsBaseUrl = getShareAssetsBaseUrl();
    const markdownCssUrl = resolveShareAssetUrl(
      "link[href*='/assets/vendor/github-markdown.min.css']",
      "vendor/github-markdown.min.css",
      assetsBaseUrl,
    );
    const katexCssUrl = resolveShareAssetUrl(
      "link[href*='/assets/vendor/katex.min.css']",
      "vendor/katex.min.css",
      assetsBaseUrl,
    );
    const highlightCssUrl = resolveShareAssetUrl(
      "link[href*='/assets/vendor/highlight.min.css']",
      "vendor/highlight.min.css",
      assetsBaseUrl,
    );
    const siteCssUrl = resolveShareAssetUrl(
      "link[href*='/assets/style.css']",
      "style.css",
      assetsBaseUrl,
    );
    const scriptEntries = getShareMarkdownScriptEntries(assetsBaseUrl);
    const currentUrl = new URL(window.location.href);
    currentUrl.hash = "";
    const safeTitle = escapeHtml(title);
    const baseHref = escapeHtml(currentUrl.toString());
    const headerTitle = escapeHtml(title);
    const rawContent = contentHtml || "<p>No content</p>";
    const footnotePayload = buildFootnoteRegistryPayload(rawContent, index);
    const renderedContent = footnotePayload.contentHtml || rawContent;
    const registryHtml = footnotePayload.registryHtml || "";
    const initialHtml = `${renderedContent}${registryHtml}`;
    const sourceValue = escapeHtml(initialHtml);
    const headLinks = [
      markdownCssUrl,
      katexCssUrl,
      highlightCssUrl,
      siteCssUrl,
    ]
      .filter(Boolean)
      .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
      .join("");
    const scriptTags = scriptEntries
      .map((entry) => {
        const onload = entry.readyEvent
          ? ` onload="window.dispatchEvent(new Event('sps:markdown-ready'))"`
          : "";
        return `<script defer src="${escapeHtml(entry.url)}"${onload}><\/script>`;
      })
      .join("");
    const footnoteTabStyle =
      `<style>` +
      `body.sps-footnote-tab .markdown-body hr.footnotes-sep,` +
      `body.sps-footnote-tab .markdown-body .footnotes,` +
      `body.sps-footnote-tab .markdown-body .markdown-footnotes,` +
      `body.sps-footnote-tab .markdown-body sup.footnote-ref,` +
      `body.sps-footnote-tab .markdown-body .footnote-ref,` +
      `body.sps-footnote-tab .markdown-body .sps-footnote-registry{display:none !important;}` +
      `</style>`;
    const doc = tab.document;
    doc.open();
    doc.write(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<base href="${baseHref}">` +
        `<title>${safeTitle}</title>` +
        headLinks +
        footnoteTabStyle +
        `</head><body class="layout-share sps-footnote-tab">` +
        `<div class="share-page">` +
        `<div class="reader-frame">` +
        `<header class="reader-mobile-bar"><button class="reader-nav-button" type="button" data-share-drawer-open aria-label="Open navigation" aria-expanded="false">Navigation</button><span class="reader-mobile-title">${headerTitle}</span></header>` +
        `<div class="share-shell share-shell--notebook">` +
        `<aside class="kb-sidebar" data-share-sidebar data-share-slug="">` +
        `<div class="kb-side-tabs" data-share-tabs data-share-default="toc">` +
        `<button class="kb-side-tab is-active" type="button" data-share-tab="toc">Contents</button>` +
        `</div>` +
        `<div class="kb-side-panel" data-share-panel="toc" data-share-toc="doc" data-sps-hide-footnotes="1">` +
        `<div class="kb-side-body share-toc-body"></div>` +
        `</div>` +
        `</aside>` +
        `<div class="kb-main">` +
        `<div class="share-article" data-share-view="preview">` +
        `<div class="kb-header">` +
        `<div class="kb-title-row"><h1 class="kb-title">${headerTitle}</h1></div>` +
        `</div>` +
        `<div class="markdown-body" data-md-id="doc">${initialHtml}</div>` +
        `<textarea class="markdown-source" data-md-id="doc" readonly spellcheck="false" aria-label="Markdown source">${sourceValue}</textarea>` +
        `</div>` +
        `</div>` +
        `</div>` +
        `<footer class="share-footer">Maintained by <a href="https://github.com/Chen017/siyuan-plugin-share" target="_blank" rel="noopener noreferrer">Chen017</a> · Upstream: <a href="https://github.com/b8l8u8e8/siyuan-plugin-share" target="_blank" rel="noopener noreferrer">Siyuan Share</a></footer>` +
        `</div>` +
        `<div class="share-side-backdrop" data-share-drawer-close></div>` +
        `<button class="scroll-top" type="button" data-scroll-top aria-label="Back to top"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2c-2.76 0-5 2.24-5 5v2.5L4 13l4.5 1L12 22l3.5-8L20 13l-3-3.5V7c0-2.76-2.24-5-5-5zm0 3a2 2 0 0 1 2 2v1.5l-2 2-2-2V7a2 2 0 0 1 2-2z"/></svg></button>` +
        `</div>` +
        scriptTags +
        `</body></html>`,
    );
    doc.close();
  };

  const bringFootnoteWindowToFront = (windowEl) => {
    if (!windowEl) return;
    footnoteWindowZ += 1;
    windowEl.style.zIndex = String(footnoteWindowZ);
  };

  const closeFootnoteWindow = (windowEl) => {
    if (!windowEl) return;
    const action = footnoteWindowActions.get(windowEl);
    if (action && footnoteActionWindows.get(action) === windowEl) {
      action.setAttribute("aria-expanded", "false");
      action.removeAttribute("aria-controls");
      footnoteActionWindows.delete(action);
    }
    if (windowEl.contains(document.activeElement) && action?.isConnected) action.focus({preventScroll: true});
    footnoteWindows.delete(windowEl);
    hideSurface(windowEl, () => windowEl.remove());
  };

  const clearFootnoteWindows = () => {
    clearTimeout(footnoteOpenTimer);
    clearTimeout(footnoteCloseTimer);
    hoveredFootnoteAction = null;
    footnoteWindows.forEach((windowEl) => {
      windowEl.remove();
    });
    footnoteWindows.clear();
    footnoteWindowSeq = 0;
    footnoteWindowZ = 1300;
  };

  const createFootnoteWindow = (index, contentHtml, options = {}) => {
    const anchorPoint =
      options &&
      Number.isFinite(options.anchorPoint?.x) &&
      Number.isFinite(options.anchorPoint?.y)
        ? {
            x: Number(options.anchorPoint.x),
            y: Number(options.anchorPoint.y),
          }
        : null;
    const windowEl = document.createElement("section");
    windowEl.className = "sps-footnote-window";
    windowEl.dataset.footnoteIndex = String(index || "");
    windowEl.dataset.pinned = "0";
    windowEl.setAttribute("role", "dialog");
    windowEl.setAttribute("aria-label", index ? `Footnote ${index}` : "Footnote");
    bringFootnoteWindowToFront(windowEl);

    const header = document.createElement("div");
    header.className = "sps-footnote-window__header";

    const title = document.createElement("div");
    title.className = "sps-footnote-window__title";
    title.textContent = index ? `Footnote ${index}` : "Footnote";

    const actions = document.createElement("div");
    actions.className = "sps-footnote-window__actions";

    const btnOpen = document.createElement("button");
    btnOpen.type = "button";
    btnOpen.className = "sps-footnote-window__btn";
    btnOpen.innerHTML =
      '<svg class="sps-footnote-line-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7"></path><path d="M10 14L21 3"></path><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"></path></svg>';
    btnOpen.setAttribute("title", "Open in new tab");
    btnOpen.setAttribute("aria-label", "Open in new tab");

    const btnPin = document.createElement("button");
    btnPin.type = "button";
    btnPin.className = "sps-footnote-window__btn";
    btnPin.innerHTML =
      '<svg class="sps-footnote-pin-icon" viewBox="0 0 1024 1024" aria-hidden="true"><path d="M916.8 380.8L645 109.4c-7.2-7.2-16.5-10.7-25.9-10.7-9.4 0-18.8 3.5-25.9 10.7L415.5 286.9c-13.5-1.5-27-2.2-40.6-2.2-80.7 0-161.5 26.5-227.8 79.6-17 13.5-18.4 39-3 54.4l200.4 200.1L106.9 856c-2.9 2.9-4.7 6.7-5.1 10.8l-3.7 41c-1 10.4 7.3 19.2 17.5 19.2 0.6 0 1.1 0 1.7-0.1l41-3.7c4.1-0.3 7.9-2.2 10.8-5.1l237.6-237.3 200.4 200.1c7.2 7.2 16.5 10.7 25.9 10.7 10.7 0 21.3-4.6 28.6-13.7 62.1-77.4 87.9-174.4 77.4-268.1l177.7-177.4c14.4-14.2 14.4-37.3 0.1-51.6zM682.9 553.9l-27 27 4.2 37.9c4.1 37.1 1.1 74-9 109.8-6 20.9-14.1 40.9-24.5 59.7L237 399.2c14.2-7.8 29-14.4 44.5-19.7 30-10.4 61.4-15.5 93.4-15.5 10.6 0 21.3 0.5 31.9 1.8l37.9 4.2 174.5-174.3 211.2 210.9-147.5 147.3z m0 0" fill="currentColor"></path></svg>';
    btnPin.setAttribute("title", "Pin");
    btnPin.setAttribute("aria-label", "Pin");

    const btnClose = document.createElement("button");
    btnClose.type = "button";
    btnClose.className = "sps-footnote-window__btn";
    btnClose.innerHTML =
      '<svg class="sps-footnote-line-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"></path><path d="M18 6L6 18"></path></svg>';
    btnClose.setAttribute("title", "Close");
    btnClose.setAttribute("aria-label", "Close");

    actions.append(btnOpen, btnPin, btnClose);
    header.append(title, actions);

    const body = document.createElement("div");
    body.className = "sps-footnote-window__body markdown-body";
    body.innerHTML = contentHtml || "<p>No content</p>";
    applyFootnotePreviewToContainer(body);

    windowEl.style.visibility = "hidden";
    windowEl.append(header, body);
    document.body.appendChild(windowEl);
    footnoteWindows.add(windowEl);

    const setPinned = (nextState) => {
      const pinned = Boolean(nextState);
      windowEl.dataset.pinned = pinned ? "1" : "0";
      btnPin.classList.toggle("is-pinned", pinned);
      btnPin.setAttribute("aria-pressed", pinned ? "true" : "false");
      const label = pinned ? "Unpin" : "Pin";
      btnPin.setAttribute("title", label);
      btnPin.setAttribute("aria-label", label);
      if (pinned) bringFootnoteWindowToFront(windowEl);
    };

    btnOpen.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      bringFootnoteWindowToFront(windowEl);
      openFootnoteInNewTab(index, contentHtml || "");
    });

    btnPin.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const pinned = windowEl.dataset.pinned === "1";
      setPinned(!pinned);
      bringFootnoteWindowToFront(windowEl);
    });

    btnClose.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeFootnoteWindow(windowEl);
    });

    windowEl.addEventListener("mousedown", () => {
      clearTimeout(footnoteCloseTimer);
      windowEl.dataset.hoverPreview = "0";
      bringFootnoteWindowToFront(windowEl);
    });

    body.addEventListener("click", (event) => {
      const anchor = event.target?.closest?.("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href") || "";
      if (!href.startsWith("#fn")) return;
      if (href.startsWith("#fnref")) return;
      event.preventDefault();
      event.stopPropagation();
      const targetId = href.slice(1);
      const index = parseFootnoteIndexLoose(href);
      let item = null;
      if (index) {
        const localItems = Array.from(
          body.querySelectorAll(".footnotes li, .markdown-footnotes li"),
        );
        for (const candidate of localItems) {
          const candidateIndex = getFootnoteIndexForItem(candidate, 0);
          if (candidateIndex === index) {
            item = candidate;
            break;
          }
        }
      }
      if (!item && targetId) {
        item = document
          .getElementById(targetId)
          ?.closest?.(".footnotes li, .markdown-footnotes li");
      }
      if (!item && index) {
        const globalItems = Array.from(
          document.querySelectorAll(".footnotes li, .markdown-footnotes li"),
        );
        for (const candidate of globalItems) {
          const candidateIndex = getFootnoteIndexForItem(candidate, 0);
          if (candidateIndex === index) {
            item = candidate;
            break;
          }
        }
      }
      if (!item) return;
      const nextIndex = getFootnoteIndexForItem(item, 0);
      const nextHtml = buildFootnoteContentHtml(item);
      const nextAnchor = resolveFootnoteAnchorPoint(event, anchor);
      createFootnoteWindow(nextIndex, nextHtml, {anchorPoint: nextAnchor});
    });

    const dragState = {
      active: false,
      startX: 0,
      startY: 0,
      startLeft: 0,
      startTop: 0,
    };
    let touchPressTimer = null;
    let touchStartX = 0;
    let touchStartY = 0;
    let lastTouch = null;
    const touchMoveOpts = {passive: false};
    const longPressDelay = 320;
    const touchSlop = 6;

    const clearTouchTimer = () => {
      if (touchPressTimer) {
        clearTimeout(touchPressTimer);
        touchPressTimer = null;
      }
    };

    const applyDrag = (clientX, clientY) => {
      const deltaX = clientX - dragState.startX;
      const deltaY = clientY - dragState.startY;
      const rect = windowEl.getBoundingClientRect();
      const minLeft = 8;
      const minTop = 8;
      const maxLeft = Math.max(minLeft, window.innerWidth - rect.width - 8);
      const maxTop = Math.max(minTop, window.innerHeight - rect.height - 8);
      const nextLeft = Math.min(
        Math.max(minLeft, dragState.startLeft + deltaX),
        maxLeft,
      );
      const nextTop = Math.min(
        Math.max(minTop, dragState.startTop + deltaY),
        maxTop,
      );
      windowEl.style.left = `${nextLeft}px`;
      windowEl.style.top = `${nextTop}px`;
    };

    const onDragMove = (event) => {
      if (!dragState.active) return;
      applyDrag(event.clientX, event.clientY);
    };

    const onTouchMove = (event) => {
      if (!event.touches || !event.touches[0]) return;
      const touch = event.touches[0];
      lastTouch = touch;
      if (dragState.active) {
        if (event.currentTarget !== window) return;
        event.preventDefault();
        applyDrag(touch.clientX, touch.clientY);
        return;
      }
      if (touchPressTimer) {
        const dx = touch.clientX - touchStartX;
        const dy = touch.clientY - touchStartY;
        if (Math.hypot(dx, dy) > touchSlop) {
          clearTouchTimer();
        }
      }
    };

    const onDragEnd = (event) => {
      clearTouchTimer();
      if (!dragState.active) return;
      if (event?.type && event.type.startsWith("touch")) {
        event.preventDefault();
        event.stopPropagation();
      }
      dragState.active = false;
      document.body.classList.remove("sps-footnote-dragging");
      window.removeEventListener("mousemove", onDragMove);
      window.removeEventListener("mouseup", onDragEnd);
      window.removeEventListener("touchmove", onTouchMove, touchMoveOpts);
      window.removeEventListener("touchend", onDragEnd);
      window.removeEventListener("touchcancel", onDragEnd);
    };

    header.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      if (event.target?.closest?.(".sps-footnote-window__btn")) return;
      event.preventDefault();
      bringFootnoteWindowToFront(windowEl);
      const rect = windowEl.getBoundingClientRect();
      dragState.active = true;
      dragState.startX = event.clientX;
      dragState.startY = event.clientY;
      dragState.startLeft = rect.left;
      dragState.startTop = rect.top;
      document.body.classList.add("sps-footnote-dragging");
      window.addEventListener("mousemove", onDragMove);
      window.addEventListener("mouseup", onDragEnd);
    });

    header.addEventListener(
      "touchstart",
      (event) => {
      if (!event.touches || event.touches.length !== 1) return;
      if (event.target?.closest?.(".sps-footnote-window__btn")) return;
      event.preventDefault();
      bringFootnoteWindowToFront(windowEl);
      const touch = event.touches[0];
      lastTouch = touch;
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      clearTouchTimer();
      touchPressTimer = window.setTimeout(() => {
        const activeTouch = lastTouch || touch;
        if (!activeTouch) return;
        const rect = windowEl.getBoundingClientRect();
        dragState.active = true;
        dragState.startX = activeTouch.clientX;
        dragState.startY = activeTouch.clientY;
        dragState.startLeft = rect.left;
        dragState.startTop = rect.top;
        document.body.classList.add("sps-footnote-dragging");
        window.addEventListener("touchmove", onTouchMove, touchMoveOpts);
        window.addEventListener("touchend", onDragEnd);
        window.addEventListener("touchcancel", onDragEnd);
      }, longPressDelay);
    },
    {passive: false},
    );

    header.addEventListener("touchmove", onTouchMove, touchMoveOpts);
    header.addEventListener("touchend", onDragEnd);
    header.addEventListener("touchcancel", onDragEnd);

    const handleDefs = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
    handleDefs.forEach((dir) => {
      const handle = document.createElement("div");
      handle.className = `sps-footnote-window__resize-handle is-${dir}`;
      handle.dataset.dir = dir;
      windowEl.appendChild(handle);
    });

    const resizeState = {
      active: false,
      dir: "",
      cursor: "",
      startX: 0,
      startY: 0,
      startLeft: 0,
      startTop: 0,
      startWidth: 0,
      startHeight: 0,
    };

    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

    const onResizeMove = (event) => {
      if (!resizeState.active) return;
      const dx = event.clientX - resizeState.startX;
      const dy = event.clientY - resizeState.startY;
      const margin = 8;
      const minWidth = 220;
      const minHeight = 140;
      let nextLeft = resizeState.startLeft;
      let nextTop = resizeState.startTop;
      let nextWidth = resizeState.startWidth;
      let nextHeight = resizeState.startHeight;

      if (resizeState.dir.includes("e")) {
        const maxWidth = Math.max(minWidth, window.innerWidth - resizeState.startLeft - margin);
        nextWidth = clamp(resizeState.startWidth + dx, minWidth, maxWidth);
      }
      if (resizeState.dir.includes("s")) {
        const maxHeight = Math.max(minHeight, window.innerHeight - resizeState.startTop - margin);
        nextHeight = clamp(resizeState.startHeight + dy, minHeight, maxHeight);
      }
      if (resizeState.dir.includes("w")) {
        const maxWidth = Math.max(minWidth, resizeState.startWidth + (resizeState.startLeft - margin));
        nextWidth = clamp(resizeState.startWidth - dx, minWidth, maxWidth);
        nextLeft = resizeState.startLeft + (resizeState.startWidth - nextWidth);
      }
      if (resizeState.dir.includes("n")) {
        const maxHeight = Math.max(
          minHeight,
          resizeState.startHeight + (resizeState.startTop - margin),
        );
        nextHeight = clamp(resizeState.startHeight - dy, minHeight, maxHeight);
        nextTop = resizeState.startTop + (resizeState.startHeight - nextHeight);
      }

      nextLeft = Math.max(margin, nextLeft);
      nextTop = Math.max(margin, nextTop);
      windowEl.style.left = `${nextLeft}px`;
      windowEl.style.top = `${nextTop}px`;
      windowEl.style.width = `${nextWidth}px`;
      windowEl.style.height = `${nextHeight}px`;
    };

    const onResizeEnd = () => {
      if (!resizeState.active) return;
      resizeState.active = false;
      resizeState.dir = "";
      windowEl.dataset.userSized = "1";
      document.body.classList.remove("sps-footnote-resizing");
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onResizeMove);
      window.removeEventListener("mouseup", onResizeEnd);
    };

    windowEl.addEventListener("mousedown", (event) => {
      const handle = event.target?.closest?.(".sps-footnote-window__resize-handle");
      if (!handle) return;
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      bringFootnoteWindowToFront(windowEl);
      const rect = windowEl.getBoundingClientRect();
      resizeState.active = true;
      resizeState.dir = String(handle.dataset.dir || "");
      resizeState.startX = event.clientX;
      resizeState.startY = event.clientY;
      resizeState.startLeft = rect.left;
      resizeState.startTop = rect.top;
      resizeState.startWidth = rect.width;
      resizeState.startHeight = rect.height;
      document.body.classList.add("sps-footnote-resizing");
      const cursorMap = {
        n: "n-resize",
        s: "s-resize",
        e: "e-resize",
        w: "w-resize",
        ne: "ne-resize",
        nw: "nw-resize",
        se: "se-resize",
        sw: "sw-resize",
      };
      resizeState.cursor = cursorMap[resizeState.dir] || "se-resize";
      document.body.style.cursor = resizeState.cursor;
      window.addEventListener("mousemove", onResizeMove);
      window.addEventListener("mouseup", onResizeEnd);
    });

    const applyDefaultWindowSize = () => {
      windowEl.style.width = `${Math.min(400, window.innerWidth - 32)}px`;
      windowEl.style.height = "auto";
      windowEl.style.maxHeight = `${Math.min(460, window.innerHeight - 32)}px`;
    };

    const applyWindowPosition = () => {
      const margin = 8;
      const gap = 12;
      const rect = windowEl.getBoundingClientRect();
      const width = rect.width || parseFloat(windowEl.style.width) || 260;
      const height = rect.height || parseFloat(windowEl.style.height) || 180;
      const minLeft = margin;
      const minTop = margin;
      const maxLeft = Math.max(minLeft, window.innerWidth - width - margin);
      const maxTop = Math.max(minTop, window.innerHeight - height - margin);

      if (anchorPoint) {
        let nextLeft = anchorPoint.x + gap;
        let nextTop = anchorPoint.y + gap;
        if (nextLeft > maxLeft) nextLeft = anchorPoint.x - width - gap;
        if (nextTop > maxTop) nextTop = anchorPoint.y - height - gap;
        windowEl.style.left = `${Math.min(Math.max(minLeft, nextLeft), maxLeft)}px`;
        windowEl.style.top = `${Math.min(Math.max(minTop, nextTop), maxTop)}px`;
        return;
      }

      const offset = (footnoteWindowSeq % 6) * 18;
      footnoteWindowSeq += 1;
      const nextLeft = Math.min(Math.max(minLeft, 48 + offset), maxLeft);
      const nextTop = Math.min(Math.max(minTop, 120 + offset), maxTop);
      windowEl.style.left = `${nextLeft}px`;
      windowEl.style.top = `${nextTop}px`;
    };

    const revealWindow = () => {
      windowEl.style.visibility = "visible";
    };

    requestAnimationFrame(() => {
      applyDefaultWindowSize();
      applyWindowPosition();
      revealWindow();
    });

    return windowEl;
  };

  const findFootnoteItemForAction = (action) => {
    if (!action) return null;
    const container = action.closest(".markdown-body") || document;
    const targetId = String(action.dataset.footnoteTarget || "").replace(/^#/, "");
    if (targetId) {
      const direct = document.getElementById(targetId);
      if (direct) {
        const item = direct.closest(
          ".footnotes li, .markdown-footnotes li",
        );
        if (item) return item;
      }
    }
    const index = parseFootnoteIndexLoose(action.dataset.footnoteIndex || "");
    if (!index) return null;
    const items = Array.from(
      container.querySelectorAll(".footnotes li, .markdown-footnotes li"),
    );
    for (const item of items) {
      const itemIndex = getFootnoteIndexForItem(item, 0);
      if (itemIndex === index) return item;
    }
    return null;
  };

  const applyFootnotePreviewToContainer = (container) => {
    if (!container) return;
      const items = Array.from(
        container.querySelectorAll(".footnotes li, .markdown-footnotes li"),
      );
    items.forEach((item, idx) => {
      getFootnoteIndexForItem(item, idx);
    });

    const refs = Array.from(
      container.querySelectorAll(
        "sup.footnote-ref a[href^=\"#fn\"], .footnote-ref a[href^=\"#fn\"], a[href^=\"#fn\"]",
      ),
    );
    refs.forEach((anchor) => {
      const href = anchor.getAttribute("href") || "";
      if (!href || !href.startsWith("#fn") || href.startsWith("#fnref")) return;
      if (anchor.dataset.spsFootnotePreview === "1") return;
      anchor.dataset.spsFootnotePreview = "1";
      const sup = anchor.closest("sup") || anchor;
      if (sup.previousElementSibling?.classList?.contains("sps-footnote-action")) {
        return;
      }
      const index = parseFootnoteIndexLoose(href);
      const action = document.createElement("button");
      action.type = "button";
      action.className = "sps-footnote-action";
      action.innerHTML = FOOTNOTE_ICON_SVG;
      action.dataset.spsFootnoteAction = "1";
      action.dataset.footnoteTarget = href.slice(1);
      action.dataset.footnoteIndex = String(index || "");
      action.setAttribute("aria-label", "Preview footnote");
      action.setAttribute("aria-expanded", "false");
      action.setAttribute("aria-haspopup", "dialog");
      sup.parentNode?.insertBefore(action, sup);
    });
  };

  const initShareFootnotePreview = () => {
    const containers = Array.from(document.querySelectorAll(".markdown-body"));
    if (!containers.length) return;

    containers.forEach((container) => {
      applyFootnotePreviewToContainer(container);
    });

    if (!footnotePreviewBound) {
      footnotePreviewBound = true;
      const actionFor = target => {
        const direct = target?.closest?.(".sps-footnote-action");
        if (direct) return direct;
        const reference = target?.closest?.("sup.footnote-ref, .footnote-ref");
        return reference?.previousElementSibling?.matches(".sps-footnote-action") ? reference.previousElementSibling : null;
      };
      const openPreview = (action, hover) => {
        clearTimeout(footnoteOpenTimer);
        clearTimeout(footnoteCloseTimer);
        let preview = footnoteActionWindows.get(action);
        if (preview?.isConnected && !preview.classList.contains("is-dismissing")) {
          if (!hover) preview.dataset.hoverPreview = "0";
          return preview;
        }
        const item = findFootnoteItemForAction(action);
        if (!item) return null;
        Array.from(footnoteWindows).forEach(panel => {
          if (panel.dataset.pinned !== "1") closeFootnoteWindow(panel);
        });
        const rect = action.getBoundingClientRect();
        preview = createFootnoteWindow(getFootnoteIndexForItem(item, 0), buildFootnoteContentHtml(item), {anchorPoint: {x: rect.left, y: rect.bottom}});
        preview.id = `footnote-preview-${++footnoteWindowSeq}`;
        preview.dataset.hoverPreview = hover ? "1" : "0";
        footnoteActionWindows.set(action, preview);
        footnoteWindowActions.set(preview, action);
        action.setAttribute("aria-controls", preview.id);
        action.setAttribute("aria-expanded", "true");
        return preview;
      };
      const queueClose = action => {
        clearTimeout(footnoteOpenTimer);
        clearTimeout(footnoteCloseTimer);
        footnoteCloseTimer = setTimeout(() => {
          const panel = footnoteActionWindows.get(action);
          if (panel?.dataset.hoverPreview === "1" && panel.dataset.pinned !== "1" && !panel.contains(document.activeElement)) closeFootnoteWindow(panel);
        }, 240);
      };
      document.addEventListener("pointerover", event => {
        if (event.pointerType !== "mouse" || !matchMedia("(hover: hover) and (pointer: fine)").matches) return;
        const panel = event.target?.closest?.(".sps-footnote-window");
        if (panel) { clearTimeout(footnoteCloseTimer); return; }
        const action = actionFor(event.target);
        if (!action || actionFor(event.relatedTarget) === action) return;
        clearTimeout(footnoteOpenTimer);
        clearTimeout(footnoteCloseTimer);
        hoveredFootnoteAction = action;
        footnoteOpenTimer = setTimeout(() => {
          if (action.isConnected && hoveredFootnoteAction === action) openPreview(action, true);
        }, 350);
      });
      document.addEventListener("pointerout", event => {
        const action = actionFor(event.target);
        const panel = event.target?.closest?.(".sps-footnote-window");
        if (action && actionFor(event.relatedTarget) !== action) {
          hoveredFootnoteAction = null;
          queueClose(action);
        } else if (panel && !panel.contains(event.relatedTarget)) {
          const trigger = footnoteWindowActions.get(panel);
          if (trigger && actionFor(event.relatedTarget) !== trigger) queueClose(trigger);
        }
      });
      document.addEventListener("focusout", event => {
        const action = actionFor(event.target) || footnoteWindowActions.get(event.target?.closest?.(".sps-footnote-window"));
        if (action && !footnoteActionWindows.get(action)?.contains(event.relatedTarget) && actionFor(event.relatedTarget) !== action) queueClose(action);
      });
      document.addEventListener("click", (event) => {
        const action = event.target?.closest?.(".sps-footnote-action");
        if (!action) return;
        const item = findFootnoteItemForAction(action);
        if (!item) return;
        event.preventDefault();
        event.stopPropagation();
        const preview = openPreview(action, false);
        if (event.detail === 0 && preview) {
          preview.tabIndex = -1;
          preview.focus({preventScroll: true});
        }
      });

      document.addEventListener("mousedown", (event) => {
        const rawTarget = event.target;
        const target =
          rawTarget && typeof rawTarget.closest === "function"
            ? rawTarget
            : rawTarget?.parentElement;
        if (!target) return;
        if (target.closest(".sps-footnote-window")) return;
        if (target.closest(".sps-footnote-action")) return;
        clearTimeout(footnoteOpenTimer);
        hoveredFootnoteAction = null;
        Array.from(footnoteWindows).forEach((windowEl) => {
          if (windowEl.dataset.pinned === "1") return;
          closeFootnoteWindow(windowEl);
        });
      });

      document.addEventListener(
        "touchstart",
        (event) => {
          const rawTarget = event.target;
          const target =
            rawTarget && typeof rawTarget.closest === "function"
              ? rawTarget
              : rawTarget?.parentElement;
          if (!target) return;
          if (target.closest(".sps-footnote-window")) return;
          if (target.closest(".sps-footnote-action")) return;
          Array.from(footnoteWindows).forEach((windowEl) => {
            if (windowEl.dataset.pinned === "1") return;
            closeFootnoteWindow(windowEl);
          });
        },
        {passive: true},
      );

      document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        clearTimeout(footnoteOpenTimer);
        hoveredFootnoteAction = null;
        Array.from(footnoteWindows).forEach((windowEl) => {
          if (windowEl.dataset.pinned === "1") return;
          closeFootnoteWindow(windowEl);
        });
      });
      document.addEventListener("scroll", event => {
        if (event.target?.closest?.(".sps-footnote-window")) return;
        clearTimeout(footnoteOpenTimer);
        hoveredFootnoteAction = null;
        Array.from(footnoteWindows).forEach(panel => {
          if (panel.dataset.hoverPreview === "1" && panel.dataset.pinned !== "1") closeFootnoteWindow(panel);
        });
      }, {passive: true, capture: true});
    }
  };

  const initShareSidebarTabs = () => {
    const tabs = document.querySelector("[data-share-tabs]");
    if (!tabs) return;
    const buttons = Array.from(tabs.querySelectorAll("[data-share-tab]"));
    if (!buttons.length) return;
    const container = tabs.closest("[data-share-sidebar]") || document;
    const panels = Array.from(container.querySelectorAll("[data-share-panel]"));
    if (!panels.length) return;
    const treeActions =
      tabs.querySelector("[data-share-tree-actions]") ||
      container.querySelector("[data-share-tree-actions]");
    const defaultTab =
      tabs.getAttribute("data-share-default") ||
      buttons[0]?.dataset.shareTab ||
      "tree";
    const indicator = document.createElement("span");
    indicator.className = "kb-tab-indicator";
    indicator.setAttribute("aria-hidden", "true");
    tabs.prepend(indicator);
    const positionIndicator = () => {
      const active = buttons.find(btn => btn.classList.contains("is-active"));
      if (!active || !active.offsetWidth) return;
      indicator.style.width = `${active.offsetWidth}px`;
      indicator.style.transform = `translateX(${active.offsetLeft}px)`;
    };
    let activeTab = "";
    const setActive = (tab, animate = false) => {
      const changed = activeTab !== tab;
      activeTab = tab;
      buttons.forEach((btn) => {
        const isActive = (btn.dataset.shareTab || "") === tab;
        btn.classList.toggle("is-active", isActive);
        btn.removeAttribute("aria-selected");
        btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
      panels.forEach((panel) => {
        panel.hidden = (panel.dataset.sharePanel || "") !== tab;
        if (!panel.hidden && changed && animate) revealSurface(panel);
      });
      if (treeActions) {
        treeActions.hidden = tab !== "tree";
      }
      positionIndicator();
    };
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.shareTab || "";
        if (!tab) return;
        setActive(tab, true);
      });
    });
    setActive(defaultTab);
    // Re-measure after a hidden mobile drawer or a breakpoint becomes visible.
    if (window.ResizeObserver) new ResizeObserver(positionIndicator).observe(tabs);
    else window.addEventListener("resize", positionIndicator, {passive: true});
  };

  const initShareDrawer = () => {
    const openBtn = document.querySelector("[data-share-drawer-open]");
    const backdrop = document.querySelector("[data-share-drawer-close]");
    const sidebar = document.querySelector(".kb-sidebar, .share-toc");
    if (openBtn && !sidebar) {
      openBtn.hidden = true;
    }
    if (!openBtn && !backdrop) return;
    if (!sidebar) return;
    const mq = window.matchMedia("(max-width: 960px)");
    const heading = document.createElement("div");
    heading.className = "reader-drawer-heading";
    heading.innerHTML = '<span>Reading navigation</span><button class="reader-drawer-close" type="button" aria-label="Close navigation"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>';
    sidebar.prepend(heading);
    sidebar.id ||= "reader-navigation";
    openBtn?.setAttribute("aria-controls", sidebar.id);
    let returnFocus = null;
    const updateAccessibility = (open) => {
      const modal = mq.matches && open;
      sidebar.inert = mq.matches && !open;
      sidebar.setAttribute("aria-hidden", mq.matches && !open ? "true" : "false");
      if (modal) {
        sidebar.setAttribute("role", "dialog");
        sidebar.setAttribute("aria-modal", "true");
        sidebar.setAttribute("aria-label", "Reading navigation");
      } else {
        sidebar.removeAttribute("role");
        sidebar.removeAttribute("aria-modal");
      }
      document.querySelectorAll(".kb-main, .share-footer, .reader-mobile-bar, .scroll-top").forEach((node) => { node.inert = modal; });
      openBtn?.setAttribute("aria-expanded", String(modal));
      openBtn?.setAttribute("aria-label", modal ? "Close navigation" : "Open navigation");
    };
    const setOpen = (open, restoreFocus = true) => {
      const wasOpen = document.body.classList.contains("share-side-open");
      if (open && !wasOpen) returnFocus = document.activeElement;
      document.body.classList.toggle("share-side-open", open && mq.matches);
      updateAccessibility(open && mq.matches);
      if (open && mq.matches) heading.querySelector("button").focus({preventScroll: true});
      else if (wasOpen && restoreFocus) (returnFocus?.isConnected ? returnFocus : openBtn)?.focus({preventScroll: true});
    };
    heading.querySelector("button").addEventListener("click", () => setOpen(false));
    if (openBtn) {
      openBtn.addEventListener("click", () => {
        const isOpen = document.body.classList.contains("share-side-open");
        setOpen(!isOpen);
        if (!isOpen) returnFocus = openBtn;
      });
    }
    if (backdrop) {
      backdrop.addEventListener("click", () => setOpen(false));
    }
    document.addEventListener("keydown", (event) => {
      if (!document.body.classList.contains("share-side-open")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
      if (event.key === "Tab") {
        const targets = Array.from(sidebar.querySelectorAll('button, a[href], input, select, textarea'))
          .filter((node) => !node.disabled && !node.closest('[hidden]') && node.getClientRects().length);
        const first = targets[0], last = targets[targets.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    });
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (target.closest(".kb-sidebar a, .share-toc a") && !event.ctrlKey && !event.metaKey && !event.shiftKey) setOpen(false, false);
      if (target.closest("[data-reader-show-tree]")) {
        document.querySelector('[data-share-tab="tree"]')?.click();
        setOpen(true);
        const current = sidebar.querySelector('.kb-tree-item.is-active, .kb-tree-item');
        if (current?.dataset.docId) readerRevealDocument(current.dataset.docId);
        else sidebar.querySelector('.kb-tree-toggle[aria-expanded="false"]')?.click();
        current?.scrollIntoView?.({block: "nearest", behavior: "auto"});
        revealSurface(sidebar.querySelector('[data-share-panel="tree"]'));
        (sidebar.querySelector(".kb-tree-item.is-active, .kb-tree-item, .kb-tree-toggle") || heading.querySelector("button")).focus({preventScroll: true});
      }
    });
    if (openBtn && sidebar) {
      const updateTrigger = () => {
        const shouldShow = mq.matches;
        openBtn.hidden = !shouldShow;
        openBtn.style.display = shouldShow ? "inline-flex" : "none";
        if (!mq.matches) setOpen(false, false);
        else updateAccessibility(document.body.classList.contains("share-side-open"));
      };
      if (typeof mq.addEventListener === "function") {
        mq.addEventListener("change", updateTrigger);
      } else if (typeof mq.addListener === "function") {
        mq.addListener(updateTrigger);
      }
      window.addEventListener("resize", updateTrigger, {passive: true});
      window.addEventListener("orientationchange", updateTrigger, {passive: true});
      requestAnimationFrame(updateTrigger);
      updateTrigger();
    }
  };

  const initShareDocNavigation = () => {
    if (shareNavReady) return;
    if (!document.body.classList.contains("layout-share")) return;
    const container = document.querySelector(".share-shell");
    if (!container) return;
    shareNavReady = true;

    let requestId = 0;
    let controller = null;

    const cssEscape =
      (window.CSS && typeof window.CSS.escape === "function" && window.CSS.escape) ||
      ((value) => String(value || "").replace(/[^a-zA-Z0-9_-]/g, "\\$&"));

    const setActiveDoc = (docId) => {
      document.querySelectorAll(".kb-tree-item.is-active").forEach((item) => {
        item.classList.remove("is-active");
      });
      document.querySelectorAll('.kb-tree-item[aria-current]').forEach(item => item.removeAttribute("aria-current"));
      if (!docId) return;
      const selector = `.kb-tree-item[data-doc-id="${cssEscape(docId)}"]`;
      const active = document.querySelector(selector);
      if (active) active.classList.add("is-active");
      active?.setAttribute("aria-current", "page");
    };

    const replaceMain = (html) => {
      const shell = document.querySelector(".share-shell");
      const main = shell?.querySelector(".kb-main");
      if (!shell || !main || !html) return null;
      const wrapper = document.createElement("div");
      wrapper.innerHTML = html;
      const nextMain = wrapper.firstElementChild;
      if (!nextMain) return null;
      main.replaceWith(nextMain);
      revealSurface(nextMain, 6);
      return nextMain;
    };

    const updateAfterLoad = (payload, url, pushState) => {
      if (payload?.html) {
        replaceMain(payload.html);
      }
      if (container) {
        container.dataset.shareDocId = payload?.docId || "";
      }
      if (payload?.title) {
        document.title = payload.title;
        const mobileTitle = document.querySelector("[data-reader-mobile-title]");
        if (mobileTitle) mobileTitle.textContent = payload.title;
      }
      if (pushState) {
        history.pushState({spsDocId: payload?.docId || ""}, "", url);
      } else {
        history.replaceState({spsDocId: payload?.docId || ""}, "", url);
      }
      setActiveDoc(payload?.docId || "");
      readerRevealDocument(payload?.docId || "");
      const heading = document.querySelector(".kb-main .kb-title");
      if (heading) { heading.tabIndex = -1; heading.focus({preventScroll: true}); }
      readerAnnounce(payload?.docId ? `Opened: ${payload.title || "Document"}` : "Returned to notebook");
      initReaderWelcome();
      const hash = url.includes("#") ? url.slice(url.indexOf("#")) : "";
      if (hash) {
        const target = document.getElementById(hash.slice(1));
        if (target) {
          target.scrollIntoView({behavior: "auto", block: "start"});
        }
      } else {
        window.scrollTo({top: 0, behavior: "auto"});
      }
      refreshShareDynamicContent();
    };

    const loadDoc = async (url, {pushState = true} = {}) => {
      readerSavePosition();
      clearFootnoteWindows();
      const currentId = ++requestId;
      if (controller) controller.abort();
      controller = new AbortController();
      const main = document.querySelector(".kb-main");
      document.querySelectorAll(".kb-tree-item.is-pending").forEach((item) => item.classList.remove("is-pending"));
      const pending = Array.from(document.querySelectorAll(".kb-tree-item[href]")).find((item) => item.href === url);
      if (main) { main.classList.add("is-loading"); main.setAttribute("aria-busy", "true"); }
      pending?.classList.add("is-pending");
      const pendingTimer = window.setTimeout(() => {
        if (currentId === requestId) {
          container.classList.add("is-navigating");
          readerAnnounce("Opening document…");
        }
      }, 250);
      try {
        const targetUrl = new URL(url, window.location.href);
        targetUrl.searchParams.set("partial", "1");
        const resp = await fetch(targetUrl.toString(), {
          method: "GET",
          headers: {"X-SPS-Partial": "1"},
          credentials: "same-origin",
          signal: controller.signal,
        });
        const payload = await resp.json().catch(() => null);
        if (!resp.ok || !payload || payload.code !== 0 || !payload.data?.html) {
          throw new Error(payload?.msg || "Failed to load doc.");
        }
        if (currentId !== requestId) return;
        updateAfterLoad(payload.data, url, pushState);
      } catch (err) {
        if (err?.name === "AbortError") return;
        window.location.href = url;
      } finally {
        window.clearTimeout(pendingTimer);
        if (currentId === requestId) {
          container.classList.remove("is-navigating");
          const latestMain = document.querySelector(".kb-main");
          if (latestMain) { latestMain.classList.remove("is-loading"); latestMain.removeAttribute("aria-busy"); }
          pending?.classList.remove("is-pending");
        }
      }
    };

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!target) return;
      const link = target.closest("a[data-share-nav='doc']");
      if (!link) return;
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const href = link.getAttribute("href");
      if (!href) return;
      if (link.getAttribute("target") === "_blank") return;
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) return;
      event.preventDefault();
      loadDoc(url.toString(), {pushState: true});
    });

    window.addEventListener("popstate", () => {
      if (!document.body.classList.contains("layout-share")) return;
      loadDoc(window.location.href, {pushState: false});
    });
  };

  const initShareMarkdownToggle = () => {
    if (!document.body.classList.contains("layout-share")) return;
    document.querySelectorAll("[data-share-toggle]").forEach((btn) => {
      if (btn.dataset.shareToggleBound === "1") return;
      btn.dataset.shareToggleBound = "1";
      btn.addEventListener("click", () => {
        const container = btn.closest(".share-article");
        if (!container) return;
        const isMarkdown = container.classList.toggle("is-markdown");
        container.setAttribute("data-share-view", isMarkdown ? "markdown" : "preview");
        const label = btn.querySelector("[data-share-toggle-label]") || btn;
        label.textContent = isMarkdown ? "Preview" : "Source";
        btn.setAttribute("aria-pressed", isMarkdown ? "true" : "false");
        revealSurface(container.querySelector(isMarkdown ? ".markdown-source" : ".markdown-body"), 0);
      });
    });
  };

  const initScrollTop = () => {
    const btn = document.querySelector("[data-scroll-top]");
    if (!btn) return;
    const toggle = () => {
      btn.classList.toggle("is-visible", window.scrollY > 320);
    };
    btn.addEventListener("click", () => {
      window.scrollTo({top: 0, behavior: scrollBehavior()});
    });
    window.addEventListener("scroll", toggle, {passive: true});
    toggle();
  };

  const initActionTableOverflowState = () => {
    const wrappers = Array.from(
      document.querySelectorAll(
        "body.layout-app .table-scroll.table-scroll-has-actions",
      ),
    );
    if (!wrappers.length) return;

    const updateOne = (wrapper) => {
      const hasOverflow = wrapper.scrollWidth - wrapper.clientWidth > 1;
      wrapper.classList.toggle("is-overflowing", hasOverflow);
    };

    const updateAll = () => {
      wrappers.forEach((wrapper) => {
        updateOne(wrapper);
      });
    };

    wrappers.forEach((wrapper) => {
      updateOne(wrapper);
    });

    window.addEventListener("resize", updateAll, {passive: true});

    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(() => {
        updateAll();
      });
      wrappers.forEach((wrapper) => {
        observer.observe(wrapper);
        const table = wrapper.querySelector("table.table-has-actions");
        if (table) observer.observe(table);
      });
    }

    window.requestAnimationFrame(() => {
      updateAll();
    });
    window.setTimeout(() => {
      updateAll();
    }, 120);
  };

  const initFormConfirm = () => {
    let pending = null;
    const dialog = document.createElement("dialog");
    dialog.className = "confirm-dialog";
    dialog.innerHTML = '<form method="dialog"><h2 id="confirm-title">Confirm action</h2><p id="confirm-description"></p><div class="form-actions"><button class="button" value="cancel" autofocus>Cancel</button><button class="button danger" value="confirm">Confirm</button></div></form>';
    dialog.setAttribute("aria-labelledby", "confirm-title");
    dialog.setAttribute("aria-describedby", "confirm-description");
    document.body.append(dialog);
    dialog.addEventListener("close", () => {
      const saved = pending; pending = null;
      if (!saved) return;
      saved.trigger?.focus({preventScroll: true});
      if (dialog.returnValue === "confirm") {
        saved.form.dataset.confirmed = "true";
        saved.form.requestSubmit(saved.trigger?.type === "submit" ? saved.trigger : undefined);
      }
    });
    document.addEventListener("submit", event => {
      const form = event.target;
      if (!form.matches("form[data-confirm-message]")) return;
      if (form.dataset.confirmed) { delete form.dataset.confirmed; return; }
      event.preventDefault();
      if (pending) return;
      pending = {form, trigger: event.submitter || document.activeElement};
      dialog.querySelector("p").textContent = form.dataset.confirmMessage;
      dialog.querySelector('[value="confirm"]').textContent = event.submitter?.textContent.trim() || "Confirm";
      dialog.returnValue = "";
      dialog.showModal();
      revealSurface(dialog);
    });
    dialog.addEventListener("click", event => { if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close("cancel");
    }});
  };

  const initFlashToast = () => {
    const isApp = document.body.classList.contains("layout-app");
    const isShare = document.body.classList.contains("layout-share");
    if (!isApp && !isShare) return;
    const flashes = Array.from(document.querySelectorAll(".flash"));
    if (!flashes.length) return;
    let stack = document.querySelector(".toast-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "toast-stack";
      document.body.appendChild(stack);
    }
    flashes.forEach((flash) => {
      const toast = flash.cloneNode(true);
      toast.classList.add("toast");
      stack.appendChild(toast);
      flash.remove();
    });
    setTimeout(() => {
      stack.querySelectorAll(".toast").forEach((toast) => {
        toast.classList.add("is-hidden");
        toast.addEventListener("transitionend", () => toast.remove(), {
          once: true,
        });
      });
    }, 4200);
  };

const initImageViewer = () => {
    if (!document.body.classList.contains("layout-share")) return;
    if (imageViewerReady) return;
    imageViewerReady = true;

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const getImageSrc = (img) =>
      img.getAttribute("data-src") || img.currentSrc || img.src || "";

    const isEmojiImage = (img) => {
      if (!img) return false;
      if (img.classList.contains("sps-emoji")) return true;
      const src = img.getAttribute("src") || "";
      return src.includes("/emojis/") || src.includes("emojis/");
    };

    const collectImages = () =>
      Array.from(
        document.querySelectorAll(".markdown-body img"),
      ).filter((img) => !img.closest(".image-viewer") && !isEmojiImage(img));

    let viewer = document.querySelector(".image-viewer");
    if (!viewer) {
      viewer = document.createElement("div");
      viewer.className = "image-viewer";
      viewer.hidden = true;
      viewer.innerHTML = `
        <div class="image-viewer-backdrop" data-viewer-close></div>
        <div class="image-viewer-ui">
          <div class="image-viewer-count" data-viewer-count></div>
          <div class="image-viewer-actions">
            <button class="image-viewer-btn" type="button" data-viewer-zoom-out aria-label="Zoom out" title="Zoom out">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 12h12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
            <span class="image-viewer-zoom" data-viewer-zoom>100%</span>
            <button class="image-viewer-btn" type="button" data-viewer-zoom-in aria-label="Zoom in" title="Zoom in">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 6v12M6 12h12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
            <button class="image-viewer-btn image-viewer-btn-text" type="button" data-viewer-one-to-one aria-label="Actual size (1:1)" title="Actual size (1:1)">1:1</button>
            <button class="image-viewer-btn" type="button" data-viewer-rotate-ccw aria-label="Rotate counterclockwise" title="Rotate counterclockwise">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 3-6.708" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                <polyline points="3 4 3 10 9 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            <button class="image-viewer-btn" type="button" data-viewer-rotate-cw aria-label="Rotate clockwise" title="Rotate clockwise">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-3-6.708" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                <polyline points="21 4 21 10 15 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            <button class="image-viewer-btn" type="button" data-viewer-download aria-label="Download image" title="Download image">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <polyline points="7 10 12 15 17 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
            <button class="image-viewer-btn" type="button" data-viewer-close aria-label="Close preview" title="Close preview">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                <line x1="6" y1="18" x2="18" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
          </div>
          <div class="image-viewer-stage" data-viewer-stage>
            <img class="image-viewer-img" data-viewer-img alt="">
            <button class="image-viewer-nav prev" type="button" data-viewer-prev aria-label="Previous image" title="Previous image">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            <button class="image-viewer-nav next" type="button" data-viewer-next aria-label="Next image" title="Next image">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 18l6-6-6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </div>
          <div class="image-viewer-thumbs" data-viewer-thumbs></div>
        </div>
      `;
      document.body.appendChild(viewer);
    }

    const stage = viewer.querySelector("[data-viewer-stage]");
    const image = viewer.querySelector("[data-viewer-img]");
    const zoomOut = viewer.querySelector("[data-viewer-zoom-out]");
    const zoomIn = viewer.querySelector("[data-viewer-zoom-in]");
    const zoomLabel = viewer.querySelector("[data-viewer-zoom]");
    const oneToOne = viewer.querySelector("[data-viewer-one-to-one]");
    const rotateCw = viewer.querySelector("[data-viewer-rotate-cw]");
    const rotateCcw = viewer.querySelector("[data-viewer-rotate-ccw]");
    const download = viewer.querySelector("[data-viewer-download]");
    const prevBtn = viewer.querySelector("[data-viewer-prev]");
    const nextBtn = viewer.querySelector("[data-viewer-next]");
    const thumbs = viewer.querySelector("[data-viewer-thumbs]");
    const count = viewer.querySelector("[data-viewer-count]");
    let navPositionRaf = 0;

    const scheduleNavPosition = () => {
      if (!image || !prevBtn || !nextBtn) return;
      if (navPositionRaf) return;
      navPositionRaf = requestAnimationFrame(() => {
        navPositionRaf = 0;
        prevBtn.style.top = "";
        nextBtn.style.top = "";
      });
    };

    if (image) {
      image.setAttribute("draggable", "false");
    }
    if (thumbs) {
      thumbs.addEventListener("click", (event) => event.stopPropagation());
      thumbs.addEventListener("pointerdown", (event) => event.stopPropagation());
    }

    const MIN_SCALE = 0.01;
    let items = [];
    let index = 0;
    let scale = 1;
    let translateX = 0;
    let translateY = 0;
    let rotation = 0;
    let oneToOneActive = false;
    let oneToOneScale = 1;
    let oneToOneRestore = null;
    let isDragging = false;
    let dragMoved = false;
    let suppressClickUntil = 0;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragOriginX = 0;
    let dragOriginY = 0;

    const applyOneToOneScale = () => {
      if (!image) return;
      const naturalWidth = image.naturalWidth || 0;
      const naturalHeight = image.naturalHeight || 0;
      if (!naturalWidth || !naturalHeight) return;
      const rect = image.getBoundingClientRect();
      const baseWidth =
        image.offsetWidth || rect.width / Math.max(scale, MIN_SCALE);
      const baseHeight =
        image.offsetHeight || rect.height / Math.max(scale, MIN_SCALE);
      const ratioW = baseWidth ? naturalWidth / baseWidth : 1;
      const ratioH = baseHeight ? naturalHeight / baseHeight : 1;
      oneToOneScale = Math.max(ratioW, ratioH);
      scale = oneToOneScale;
      translateX = 0;
      translateY = 0;
      applyTransform();
      requestAnimationFrame(() => {
        clampTranslation();
        applyTransform();
      });
    };

    const updateZoomLabel = () => {
      if (zoomLabel) {
        zoomLabel.textContent = `${Math.round(scale * 100)}%`;
      }
    };

    const clearOneToOne = () => {
      oneToOneActive = false;
      oneToOneScale = 1;
      oneToOneRestore = null;
      if (image) {
        image.style.width = "";
        image.style.height = "";
        image.style.maxWidth = "";
        image.style.maxHeight = "";
      }
    };

    const applyTransform = () => {
      if (!image) return;
      image.style.transform = `translate(${translateX}px, ${translateY}px) rotate(${rotation}deg) scale(${scale})`;
      updateZoomLabel();
      scheduleNavPosition();
    };

    const clampTranslation = () => {
      if (!stage || !image) return;
      const stageRect = stage.getBoundingClientRect();
      const imgRect = image.getBoundingClientRect();
      const baseWidth = imgRect.width / Math.max(scale, MIN_SCALE);
      const baseHeight = imgRect.height / Math.max(scale, MIN_SCALE);
      const scaledWidth = baseWidth * scale;
      const scaledHeight = baseHeight * scale;
      const maxX = Math.max(0, (scaledWidth - stageRect.width) / 2);
      const maxY = Math.max(0, (scaledHeight - stageRect.height) / 2);
      translateX = clamp(translateX, -maxX, maxX);
      translateY = clamp(translateY, -maxY, maxY);
    };

    const setScale = (nextScale) => {
      scale = Math.max(nextScale, MIN_SCALE);
      if (oneToOneActive && Math.abs(scale - oneToOneScale) > 0.001) {
        clearOneToOne();
      }
      applyTransform();
      requestAnimationFrame(() => {
        clampTranslation();
        applyTransform();
      });
    };

    const resetZoom = () => {
      scale = 1;
      translateX = 0;
      translateY = 0;
      rotation = 0;
      clearOneToOne();
      applyTransform();
    };

    const toggleOneToOne = () => {
      if (!image) return;
      if (!oneToOneActive) {
        oneToOneRestore = {
          scale,
          translateX,
          translateY,
          width: image.style.width,
          height: image.style.height,
          maxWidth: image.style.maxWidth,
          maxHeight: image.style.maxHeight,
        };
        oneToOneActive = true;
        applyOneToOneScale();
        return;
      }
      oneToOneActive = false;
      oneToOneScale = 1;
      if (oneToOneRestore) {
        translateX = oneToOneRestore.translateX || 0;
        translateY = oneToOneRestore.translateY || 0;
        scale = oneToOneRestore.scale || 1;
        image.style.width = oneToOneRestore.width || "";
        image.style.height = oneToOneRestore.height || "";
        image.style.maxWidth = oneToOneRestore.maxWidth || "";
        image.style.maxHeight = oneToOneRestore.maxHeight || "";
        applyTransform();
        requestAnimationFrame(() => {
          clampTranslation();
          applyTransform();
        });
        oneToOneRestore = null;
      } else {
        resetZoom();
      }
    };

    const rotateBy = (degrees) => {
      rotation += degrees;
      applyTransform();
      requestAnimationFrame(() => {
        clampTranslation();
        applyTransform();
      });
    };

    const updateThumbs = () => {
      if (!thumbs) return;
      thumbs.innerHTML = "";
      items.forEach((item, idx) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `image-viewer-thumb${idx === index ? " is-active" : ""}`;
        const img = document.createElement("img");
        img.src = getImageSrc(item);
        img.alt = item.alt || "";
        const markThumbLoaded = () => btn.classList.add("is-loaded");
        if (img.complete) {
          markThumbLoaded();
        } else {
          img.addEventListener("load", markThumbLoaded, {once: true});
        }
        btn.appendChild(img);
        btn.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          setIndex(idx);
        });
        thumbs.appendChild(btn);
      });
      const active = thumbs.querySelector(".image-viewer-thumb.is-active");
      if (active && active.scrollIntoView) {
        active.scrollIntoView({block: "nearest", inline: "center"});
      }
    };

    const updateNav = () => {
      const disabled = items.length <= 1;
      if (prevBtn) prevBtn.disabled = disabled;
      if (nextBtn) nextBtn.disabled = disabled;
    };

    const updateView = () => {
      if (!image || !items.length) return;
      const item = items[index];
      const src = getImageSrc(item);
      image.classList.remove("is-loaded");
      image.src = src;
      image.alt = item.alt || "";
      if (count) count.textContent = `${index + 1} / ${items.length}`;
      updateNav();
      updateThumbs();
      image.onload = () => {
        image.classList.add("is-loaded");
        resetZoom();
      };
      if (image.complete) {
        image.classList.add("is-loaded");
      }
      resetZoom();
    };

    const setIndex = (nextIndex) => {
      if (!items.length) return;
      index = (nextIndex + items.length) % items.length;
      updateView();
    };

    const openViewer = (startIndex) => {
      items = collectImages();
      if (!items.length) return;
      index = clamp(startIndex, 0, items.length - 1);
      showSurface(viewer);
      document.body.classList.add("image-viewer-open");
      updateView();
    };

    const closeViewer = () => {
      hideSurface(viewer, () => {
        viewer.hidden = true;
        document.body.classList.remove("image-viewer-open");
      });
    };

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!target) return;
      const img = target.closest("img");
      if (!img) return;
      if (img.closest(".image-viewer")) return;
      if (!img.matches(".markdown-body img")) return;
      if (isEmojiImage(img)) return;
      const list = collectImages();
      const startIndex = list.indexOf(img);
      if (startIndex < 0) return;
      event.preventDefault();
      event.stopPropagation();
      openViewer(startIndex);
    });

    viewer.addEventListener("click", (event) => {
      if (Date.now() < suppressClickUntil) return;
      const target = event.target;
      if (!target) return;
      if (target.closest("[data-viewer-close]")) {
        closeViewer();
        return;
      }
      if (target.closest(".image-viewer-actions")) return;
      if (target.closest(".image-viewer-count")) return;
      if (target.closest(".image-viewer-nav")) return;
      if (target.closest(".image-viewer-img")) return;
      if (target.closest(".image-viewer-thumb")) return;
      if (target.closest(".image-viewer-thumbs")) return;
      closeViewer();
    });

    if (prevBtn) prevBtn.addEventListener("click", () => setIndex(index - 1));
    if (nextBtn) nextBtn.addEventListener("click", () => setIndex(index + 1));
    if (zoomIn) zoomIn.addEventListener("click", () => setScale(scale + 0.25));
    if (zoomOut) zoomOut.addEventListener("click", () => setScale(scale - 0.25));
    if (oneToOne) oneToOne.addEventListener("click", toggleOneToOne);
    if (rotateCw) rotateCw.addEventListener("click", () => rotateBy(90));
    if (rotateCcw) rotateCcw.addEventListener("click", () => rotateBy(-90));
    if (download) download.addEventListener("click", () => {
      const src = image?.currentSrc || image?.getAttribute("src");
      if (!src) return;
      const link = document.createElement("a");
      link.href = src;
      link.download = "";
      document.body.appendChild(link);
      link.click();
      link.remove();
    });

    viewer.addEventListener(
      "wheel",
      (event) => {
        if (viewer.hidden) return;
        event.preventDefault();
        const zoomFactor = Math.exp(-event.deltaY * 0.002);
        setScale(scale * zoomFactor);
      },
      {passive: false},
    );

    document.addEventListener("keydown", (event) => {
      if (viewer.hidden) return;
      const target = event.target;
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setScale(scale * 1.1);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setScale(scale * 0.9);
      }
    });

    window.addEventListener("resize", () => {
      if (viewer.hidden) return;
      if (oneToOneActive) {
        applyOneToOneScale();
      } else {
        scheduleNavPosition();
      }
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", () => {
        if (viewer.hidden) return;
        if (oneToOneActive) {
          applyOneToOneScale();
        } else {
          scheduleNavPosition();
        }
      });
    }

    const pointers = new Map();
    let isPinching = false;
    let pinchStartDistance = 0;
    let pinchStartScale = 1;
    let dragPointerId = null;

    const getPointerDistance = (a, b) =>
      Math.hypot(b.x - a.x, b.y - a.y);

    const canDrag = () => {
      if (!stage || !image) return false;
      const stageRect = stage.getBoundingClientRect();
      const imgRect = image.getBoundingClientRect();
      return (
        oneToOneActive ||
        scale > 1 ||
        imgRect.width > stageRect.width ||
        imgRect.height > stageRect.height
      );
    };

    const onPointerDown = (event) => {
      if (!stage || !image) return;
      const target = event.target;
      if (target && target.closest(".image-viewer-nav")) return;
      if (target && target.closest(".image-viewer-actions")) return;
      if (event.button !== undefined && event.button !== 0) return;
      pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
      if (stage.setPointerCapture) {
        stage.setPointerCapture(event.pointerId);
      }
      if (pointers.size === 2) {
        isPinching = true;
        isDragging = false;
        dragPointerId = null;
        const [p1, p2] = Array.from(pointers.values());
        pinchStartDistance = getPointerDistance(p1, p2);
        pinchStartScale = scale;
        event.preventDefault();
        return;
      }
      if (pointers.size === 1 && canDrag()) {
        isDragging = true;
        dragPointerId = event.pointerId;
        dragMoved = false;
        dragStartX = event.clientX;
        dragStartY = event.clientY;
        dragOriginX = translateX;
        dragOriginY = translateY;
        stage.classList.add("is-dragging");
        event.preventDefault();
      }
    };

    const onPointerMove = (event) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
      if (isPinching && pointers.size >= 2) {
        const [p1, p2] = Array.from(pointers.values());
        const distance = getPointerDistance(p1, p2);
        if (pinchStartDistance > 0) {
          setScale(pinchStartScale * (distance / pinchStartDistance));
        }
        event.preventDefault();
        return;
      }
      if (!isDragging || event.pointerId !== dragPointerId) return;
      const deltaX = event.clientX - dragStartX;
      const deltaY = event.clientY - dragStartY;
      if (!dragMoved && (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3)) {
        dragMoved = true;
      }
      translateX = dragOriginX + deltaX;
      translateY = dragOriginY + deltaY;
      clampTranslation();
      applyTransform();
    };

    const onPointerUp = (event) => {
      pointers.delete(event.pointerId);
      if (stage && stage.releasePointerCapture) {
        stage.releasePointerCapture(event.pointerId);
      }
      if (isPinching && pointers.size < 2) {
        isPinching = false;
        pinchStartDistance = 0;
        pinchStartScale = scale;
      }
      if (!isDragging || event.pointerId !== dragPointerId) return;
      isDragging = false;
      dragPointerId = null;
      if (stage) stage.classList.remove("is-dragging");
      if (dragMoved) {
        suppressClickUntil = Date.now() + 320;
      }
    };

    if (stage) {
      stage.addEventListener("pointerdown", onPointerDown);
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);

    document.addEventListener("keydown", (event) => {
      if (viewer.hidden) return;
      if (event.key === "Escape") {
        closeViewer();
      } else if (event.key === "ArrowLeft") {
        setIndex(index - 1);
      } else if (event.key === "ArrowRight") {
        setIndex(index + 1);
      } else if (event.key === "+" || event.key === "=") {
        setScale(scale + 0.25);
      } else if (event.key === "-" || event.key === "_") {
        setScale(scale - 0.25);
      }
    });
  };

  const scheduleMarkdownRetry = () => {
    if (markdownInitRetryTimer) return;
    if (markdownInitRetryCount >= markdownInitRetryLimit) return;
    markdownInitRetryCount += 1;
    markdownInitRetryTimer = window.setTimeout(() => {
      markdownInitRetryTimer = null;
      initMarkdown();
    }, 120);
  };

  const initMarkdown = () => {
    if (
      typeof window.markdownit !== "function" ||
      !window.markdownit.prototype ||
      typeof window.markdownit.prototype.render !== "function"
    ) {
      scheduleMarkdownRetry();
      return;
    }
    markdownInitRetryCount = 0;
    if (markdownInitRetryTimer) {
      clearTimeout(markdownInitRetryTimer);
      markdownInitRetryTimer = null;
    }

    const md = window.markdownit({
      html: true,
      linkify: true,
      typographer: true,
      breaks: true,
      highlight: (str, lang) => {
        const safeLang = (lang || "").toLowerCase();
        if (safeLang === "mermaid") {
          return "";
        }
        if (!window.hljs) return "";
        try {
          if (safeLang && window.hljs.getLanguage(safeLang)) {
            return window.hljs.highlight(str, {language: safeLang}).value;
          }
          return window.hljs.highlightAuto(str).value;
        } catch {
          return "";
        }
      },
    });

    const usePlugin = (plugin, options) => {
      if (typeof plugin !== "function") return;
      options ? md.use(plugin, options) : md.use(plugin);
    };

    const registerCalloutSupport = () => {
      const calloutPattern = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|INFO)\]\s*/i;
      const calloutClassMap = {
        note: "note",
        tip: "tip",
        important: "important",
        warning: "warning",
        caution: "caution",
        info: "info",
      };
      const calloutMetaMap = {
        note: {label: "Note", icon: "🖊️"},
        tip: {label: "Tip", icon: "💡"},
        important: {label: "Important", icon: "❗"},
        warning: {label: "Warning", icon: "⚠️"},
        caution: {label: "Caution", icon: "🚨"},
        info: {label: "Info", icon: "ℹ️"},
      };

      const splitTitleHtml = (html) => {
        const trimmed = String(html || "").trim();
        if (!trimmed) return {icon: "", label: ""};
        const match = trimmed.match(/^<img\b[^>]*>/i);
        if (match) {
          const icon = match[0];
          const label = trimmed.slice(icon.length).trim();
          return {icon, label};
        }
        return {icon: "", label: trimmed};
      };

      const buildTitleHtml = (titleRaw, meta) => {
        if (titleRaw) {
          const titleHtml = typeof md.renderInline === "function" ? md.renderInline(titleRaw) : titleRaw;
          const parts = splitTitleHtml(titleHtml);
          const iconHtml = parts.icon ? `<span class="md-alert__icon">${parts.icon}</span>` : "";
          const labelHtml = parts.label ? `<span class="md-alert__label">${parts.label}</span>` : "";
          return `<div class="md-alert__title">${iconHtml}${labelHtml}</div>\n`;
        }
        return (
          `<div class="md-alert__title"><span class="md-alert__icon">${meta.icon}</span>` +
          `<span class="md-alert__label">${meta.label}</span></div>\n`
        );
      };

      md.block.ruler.before("blockquote", "siyuan_callout_block", (state, startLine, endLine, silent) => {
        let pos = state.bMarks[startLine] + state.tShift[startLine];
        let max = state.eMarks[startLine];
        if (state.src[pos] !== ">") return false;
        let line = state.src.slice(pos + 1, max);
        if (line.startsWith(" ")) line = line.slice(1);
        if (!calloutPattern.test(line)) return false;
        if (silent) return true;

        let nextLine = startLine;
        let content = "";
        while (nextLine < endLine) {
          pos = state.bMarks[nextLine] + state.tShift[nextLine];
          max = state.eMarks[nextLine];
          if (state.src[pos] !== ">") break;
          let row = state.src.slice(pos + 1, max);
          if (row.startsWith(" ")) row = row.slice(1);
          if (nextLine !== startLine && calloutPattern.test(row)) {
            break;
          }
          content += row + "\n";
          nextLine += 1;
        }

        const lines = content.split(/\r?\n/);
        const firstLine = lines.shift() ?? "";
        const match = firstLine.match(calloutPattern);
        if (!match) return false;
        const typeKey = match[1].toLowerCase();
        const classKey = calloutClassMap[typeKey] || "note";
        const meta = calloutMetaMap[classKey] || calloutMetaMap.note;
        const titleRaw = firstLine.replace(calloutPattern, "").trim();
        const body = lines.join("\n");

        const open = state.push("html_block", "", 0);
        open.block = true;
        open.content = `<div class="md-alert md-alert--${classKey}">\n`;
        const titleToken = state.push("html_block", "", 0);
        titleToken.block = true;
        titleToken.content = buildTitleHtml(titleRaw, meta);
        if (body.trim()) {
          state.md.block.parse(body, state.md, state.env, state.tokens);
        }
        const close = state.push("html_block", "", 0);
        close.block = true;
        close.content = "</div>\n";
        state.line = nextLine;
        return true;
      });
    };

    const useKatex = () => {
      if (typeof window.markdownitKatex === "function") {
        md.use(window.markdownitKatex, {throwOnError: false, errorColor: "#cc0000"});
        return;
      }
      if (!window.katex || typeof window.katex.renderToString !== "function") return;

      const renderKatex = (source, displayMode) => {
        try {
          return window.katex.renderToString(String(source || ""), {
            displayMode,
            throwOnError: false,
            errorColor: "#cc0000",
          });
        } catch {
          return md.utils.escapeHtml(String(source || ""));
        }
      };

      md.inline.ruler.after("escape", "katex_inline", (state, silent) => {
        if (state.src[state.pos] !== "$") return false;
        if (state.src[state.pos + 1] === "$") return false;
        let start = state.pos + 1;
        let match = start;
        while ((match = state.src.indexOf("$", match)) !== -1) {
          if (state.src[match - 1] === "\\") {
            match += 1;
            continue;
          }
          // Skip $ inside braced groups (e.g. \text{...$...$...})
          let braceDepth = 0;
          for (let i = start; i < match; i++) {
            const ch = state.src[i];
            if (ch === "\\" && i + 1 < match) { i++; continue; }
            if (ch === "{") braceDepth++;
            else if (ch === "}") braceDepth--;
          }
          if (braceDepth !== 0) {
            match += 1;
            continue;
          }
          const content = state.src.slice(start, match);
          if (!content.trim()) {
            match += 1;
            continue;
          }
          if (!silent) {
            const token = state.push("katex_inline", "math", 0);
            token.content = content;
            token.markup = "$";
          }
          state.pos = match + 1;
          return true;
        }
        return false;
      });

      md.block.ruler.after("blockquote", "katex_block", (state, startLine, endLine, silent) => {
        let pos = state.bMarks[startLine] + state.tShift[startLine];
        let max = state.eMarks[startLine];
        if (state.src.slice(pos, pos + 2) !== "$$") return false;
        if (silent) return true;
        pos += 2;
        let firstLine = state.src.slice(pos, max);
        let nextLine = startLine;
        let content = "";
        if (firstLine.trim().endsWith("$$")) {
          const line = firstLine.trim();
          content = line.slice(0, -2).trim();
        } else {
          content = firstLine;
          for (nextLine = startLine + 1; nextLine < endLine; nextLine += 1) {
            pos = state.bMarks[nextLine] + state.tShift[nextLine];
            max = state.eMarks[nextLine];
            const line = state.src.slice(pos, max);
            if (line.trim() === "$$") {
              break;
            }
            content += `\n${line}`;
          }
          if (nextLine >= endLine) return false;
        }
        state.line = nextLine + 1;
        const token = state.push("katex_block", "math", 0);
        token.block = true;
        token.content = content.trim();
        token.map = [startLine, state.line];
        token.markup = "$$";
        return true;
      }, {alt: ["paragraph", "reference", "blockquote", "list"]});

      md.renderer.rules.katex_inline = (tokens, idx) =>
        renderKatex(tokens[idx].content, false);
      md.renderer.rules.katex_block = (tokens, idx) =>
        `<div class="katex-block">${renderKatex(tokens[idx].content, true)}</div>`;
    };

    useKatex();
    usePlugin(window.markdownitTaskLists, {enabled: true});
    usePlugin(window.markdownitEmoji);
    usePlugin(window.markdownitFootnote);
    usePlugin(window.markdownitDeflist);
    usePlugin(window.markdownitMark);
    usePlugin(window.markdownitSub);
    usePlugin(window.markdownitSup);
    usePlugin(window.markdownitAbbr);
    usePlugin(window.markdownitIns);
    usePlugin(window.markdownItAnchor || window.markdownitAnchor, {permalink: false});
    registerCalloutSupport();
    // SiYuan's table-cell IAL is plain text to Markdown-it; typographer may
    // turn the attribute's straight quotes into smart quotes during rendering.
    const applySiYuanTableCellAlignment = (root) => {
      const alignmentPrefix = /^[ \t]*\{:\s*style\s*=\s*(?:"\s*text-align\s*:\s*(left|center|right)\s*;?\s*"|“\s*text-align\s*:\s*(left|center|right)\s*;?\s*”|'\s*text-align\s*:\s*(left|center|right)\s*;?\s*'|‘\s*text-align\s*:\s*(left|center|right)\s*;?\s*’)\s*\}[ \t]*/i;
      root.querySelectorAll("table th, table td").forEach((cell) => {
        const first = cell.firstChild;
        if (!first || first.nodeType !== 3) return;
        const match = alignmentPrefix.exec(first.nodeValue || "");
        if (!match) return;
        first.nodeValue = first.nodeValue.slice(match[0].length);
        cell.style.textAlign = (match[1] || match[2] || match[3] || match[4]).toLowerCase();
      });
    };

    if (typeof window.markdownitContainer === "function") {
      const containers = ["info", "success", "warning", "danger", "tip", "note"];
      containers.forEach((type) => {
        md.use(window.markdownitContainer, type, {
          render: (tokens, idx) => {
            if (tokens[idx].nesting === 1) {
              return `<div class="md-alert md-alert--${type}">`;
            }
            return "</div>";
          },
        });
      });
    }

    let mermaidReady = false;
    let chartResizeBound = false;
    const chartInstances = [];
    let diagramIndex = 0;
    let vizInstance = null;

    let mermaidFontPromise = null;

    const nextDiagramId = (prefix) => {
      diagramIndex += 1;
      return `md-${prefix}-${diagramIndex}`;
    };

    const getLanguage = (code) => {
      if (!code) return "";
      const classes = Array.from(code.classList || []);
      for (const cls of classes) {
        if (cls.startsWith("language-")) {
          const lang = cls.slice(9).toLowerCase();
          if (["", "undefined", "text", "plain", "plaintext", "nohighlight"].includes(lang)) {
            continue;
          }
          return lang;
        }
        if (cls.startsWith("lang-")) {
          const lang = cls.slice(5).toLowerCase();
          if (["", "undefined", "text", "plain", "plaintext", "nohighlight"].includes(lang)) {
            continue;
          }
          return lang;
        }
      }
      if (classes.includes("mermaid")) return "mermaid";
      return "";
    };

    const getMermaidFontFamily = () => {
      if (typeof window.getComputedStyle !== "function") return "";
      const target = document.body || document.documentElement;
      if (!target) return "";
      const fontFamily = window.getComputedStyle(target).fontFamily;
      return fontFamily ? fontFamily.trim() : "";
    };

    const waitForMermaidFonts = (callback) => {
      if (!document.fonts || !document.fonts.ready || typeof document.fonts.ready.then !== "function") {
        callback();
        return;
      }
      if (!mermaidFontPromise) {
        mermaidFontPromise = document.fonts.ready.catch(() => null);
      }
      mermaidFontPromise.then(callback);
    };

    const getFirstMermaidLine = (text) => {
      const lines = String(text || "").split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("%%")) continue;
        return trimmed;
      }
      return "";
    };

    const looksLikeMermaid = (text) => {
      const first = getFirstMermaidLine(text);
      return /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|gitGraph|mindmap|timeline|pie|quadrantChart|requirementDiagram|c4Context|c4Container|c4Component|c4Dynamic|zenuml|xychart)\b/i.test(
        first,
      );
    };

    const isMermaidFlowchart = (text) => {
      const first = getFirstMermaidLine(text);
      return /^(graph|flowchart)\b/i.test(first);
    };

    const isMermaidMindmap = (text) => {
      const first = getFirstMermaidLine(text);
      return /^mindmap\b/i.test(first);
    };

    const replaceCodeBlock = (code, replacement) => {
      const wrapper = code.closest(".code-block");
      if (wrapper) {
        wrapper.replaceWith(replacement);
        return;
      }
      const pre = code.closest("pre");
      if (pre) {
        pre.replaceWith(replacement);
      } else {
        code.replaceWith(replacement);
      }
    };

    const buildMindmapSource = (source) => {
      const lines = String(source || "").split(/\r?\n/);
      const items = [];
      lines.forEach((line) => {
        const match = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
        if (!match) return;
        const indent = match[1].replace(/\t/g, "  ").length;
        const level = Math.max(0, Math.floor(indent / 2));
        let text = match[2].trim();
        text = text.replace(/^\[(?: |x|X)\]\s*/, "");
        if (text) items.push({level, text});
      });
      if (!items.length) return "";
      const output = ["mindmap", "  root"];
      items.forEach((item) => {
        const pad = "  ".repeat(item.level + 2);
        output.push(`${pad}${item.text}`);
      });
      return output.join("\n");
    };

    const renderMindmap = (container) => {
      container.querySelectorAll("pre code").forEach((code) => {
        const lang = getLanguage(code);
        if (lang !== "mindmap" && lang !== "mermaid") return;
        const source = code.textContent || "";
        if (lang === "mindmap" && isMermaidMindmap(source)) return;
        if (lang === "mermaid" && looksLikeMermaid(source)) return;
        const mermaidSource = buildMindmapSource(source);
        if (!mermaidSource) return;
        const block = document.createElement("div");
        block.className = "mermaid";
        block.textContent = mermaidSource;
        replaceCodeBlock(code, block);
      });
    };

    const bindChartResize = () => {
      if (chartResizeBound) return;
      chartResizeBound = true;
      window.addEventListener("resize", () => {
        chartInstances.forEach((chart) => {
          try {
            chart.resize();
          } catch {
            // ignore resize failures
          }
        });
      });
    };

    const renderEcharts = (container) => {
      if (!window.echarts || typeof window.echarts.init !== "function") return;
      container.querySelectorAll("pre code").forEach((code) => {
        const lang = getLanguage(code);
        if (lang !== "echarts") return;
        const source = code.textContent || "";
        let option = null;
        try {
          option = JSON.parse(source);
        } catch {
          return;
        }
        const wrapper = document.createElement("div");
        wrapper.className = "md-diagram md-diagram--echarts";
        wrapper.setAttribute("data-sps-echarts-source", encodeURIComponent(source));
        const chartEl = document.createElement("div");
        chartEl.className = "md-echarts";
        wrapper.appendChild(chartEl);
        replaceCodeBlock(code, wrapper);
        try {
          const chart = window.echarts.init(chartEl);
          chart.setOption(option, true);
          chartInstances.push(chart);
          bindChartResize();
          chartEl.setAttribute("data-sps-echarts-inited", "1");
        } catch {
          wrapper.textContent = "ECharts render failed.";
        }
      });
    };

    const rehydrateEcharts = (container) => {
      if (!window.echarts || typeof window.echarts.init !== "function") return;
      container.querySelectorAll(".md-diagram--echarts").forEach((wrapper) => {
        const chartEl = wrapper.querySelector(".md-echarts");
        if (!chartEl) return;
        if (chartEl.getAttribute("data-sps-echarts-inited") === "1") return;
        const encoded = wrapper.getAttribute("data-sps-echarts-source") || "";
        if (!encoded) return;
        let option = null;
        try {
          option = JSON.parse(decodeURIComponent(encoded));
        } catch {
          return;
        }
        try {
          chartEl.innerHTML = "";
          const chart = window.echarts.init(chartEl);
          chart.setOption(option, true);
          chartInstances.push(chart);
          bindChartResize();
          chartEl.setAttribute("data-sps-echarts-inited", "1");
        } catch {
          // ignore render failures
        }
      });
    };

    const renderAbc = (container) => {
      if (!window.ABCJS || typeof window.ABCJS.renderAbc !== "function") return;
      container.querySelectorAll("pre code").forEach((code) => {
        const lang = getLanguage(code);
        if (lang !== "abc") return;
        let source = code.textContent || "";
        let options = {};
        const lines = source.split(/\r?\n/);
        if (lines.length && lines[0].trim().startsWith("%%params")) {
          const raw = lines[0].trim().replace(/^%%params\s+/, "");
          try {
            options = JSON.parse(raw);
            source = lines.slice(1).join("\n");
          } catch {
            options = {};
          }
        }
        const wrapper = document.createElement("div");
        wrapper.className = "md-diagram md-diagram--abc";
        const target = document.createElement("div");
        const targetId = nextDiagramId("abc");
        target.id = targetId;
        wrapper.appendChild(target);
        replaceCodeBlock(code, wrapper);
        try {
          window.ABCJS.renderAbc(targetId, source, options);
        } catch {
          wrapper.textContent = "ABC render failed.";
        }
      });
    };

    const createVizInstance = () => {
      if (!window.Viz) return null;
      if (window.Module && window.render) {
        return new window.Viz({Module: window.Module, render: window.render});
      }
      return new window.Viz();
    };

    const renderGraphviz = (container) => {
      if (!window.Viz) return;
      container.querySelectorAll("pre code").forEach((code) => {
        const lang = getLanguage(code);
        if (lang !== "graphviz" && lang !== "dot") return;
        const source = code.textContent || "";
        const wrapper = document.createElement("div");
        wrapper.className = "md-diagram md-diagram--graphviz";
        const target = document.createElement("div");
        target.className = "md-graphviz";
        wrapper.appendChild(target);
        replaceCodeBlock(code, wrapper);
        if (!vizInstance) vizInstance = createVizInstance();
        if (!vizInstance || typeof vizInstance.renderSVGElement !== "function") {
          wrapper.textContent = "Graphviz render unavailable.";
          return;
        }
        vizInstance
          .renderSVGElement(source)
          .then((svg) => {
            target.innerHTML = "";
            target.appendChild(svg);
          })
          .catch(() => {
            vizInstance = createVizInstance();
            wrapper.textContent = "Graphviz render failed.";
          });
      });
    };

    const renderFlowchart = (container) => {
      if (!window.flowchart || typeof window.flowchart.parse !== "function") return;
      if (!window.Raphael) return;
      container.querySelectorAll("pre code").forEach((code) => {
        const lang = getLanguage(code);
        if (lang !== "flowchart") return;
        const source = code.textContent || "";
        if (isMermaidFlowchart(source)) return;
        let chart = null;
        try {
          chart = window.flowchart.parse(source);
        } catch {
          return;
        }
        const wrapper = document.createElement("div");
        wrapper.className = "md-diagram md-diagram--flowchart";
        const target = document.createElement("div");
        const targetId = nextDiagramId("flowchart");
        target.id = targetId;
        wrapper.appendChild(target);
        replaceCodeBlock(code, wrapper);
        try {
          chart.drawSVG(targetId, {
            "line-width": 2,
            "font-size": 14,
            "font-family": "inherit",
            "text-margin": 8,
            "yes-text": "yes",
            "no-text": "no",
            "arrow-end": "block",
          });
        } catch {
          wrapper.textContent = "Flowchart render failed.";
        }
      });
    };

    const showDiagramSource = (block, source, kind) => {
      const wrapper = document.createElement("div");
      wrapper.className = `md-diagram md-diagram--${kind}`;
      const message = document.createElement("p");
      message.className = "muted";
      message.textContent = "Diagram preview unavailable. Source is shown below and stays on this site.";
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = source;
      pre.append(code);
      wrapper.append(message, pre);
      block.replaceWith(wrapper);
    };

    const renderPlantUml = (container) => {
      container.querySelectorAll("pre code").forEach((code) => {
        if (!["plantuml", "puml", "uml"].includes(getLanguage(code))) return;
        showDiagramSource(code.closest("pre") || code, code.textContent || "", "plantuml");
      });
    };

    const renderMermaid = (container) => {
      const isMermaidCodeBlock = (lang, source) => {
        if (lang === "mermaid") return true;
        if (lang === "mindmap") return isMermaidMindmap(source);
        if (lang === "flowchart") return isMermaidFlowchart(source);
        if (lang === "" && looksLikeMermaid(source)) return true;
        return false;
      };

      const showMermaidSource = (block) => {
        const source = block.dataset.mermaidSource || block.textContent || "";
        showDiagramSource(block, source, "mermaid");
      };

      const isMermaidErrorSvg = (svg) => {
        const text = String(svg || "");
        return /syntax error|parse error|error in text/i.test(text);
      };

      const renderMermaidBlock = (block) => {
        const source = block.dataset.mermaidSource || block.textContent || "";
        if (!source.trim()) return;
        const targetId = nextDiagramId("mermaid");
        const applySvg = (svg, bindFunctions) => {
          if (isMermaidErrorSvg(svg)) {
            showMermaidSource(block);
            return;
          }
          block.innerHTML = svg;
          if (typeof bindFunctions === "function") {
            try {
              bindFunctions(block);
            } catch {
              // ignore bind errors
            }
          }
        };
        try {
          const result = window.mermaid.render(targetId, source);
          if (result && typeof result.then === "function") {
            result
              .then((res) => {
                if (!res || !res.svg) {
                  showMermaidSource(block);
                  return;
                }
                applySvg(res.svg, res.bindFunctions);
              })
              .catch(() => showMermaidSource(block));
            return;
          }
          if (typeof result === "string") {
            applySvg(result);
            return;
          }
          if (result && result.svg) {
            applySvg(result.svg, result.bindFunctions);
            return;
          }
          showMermaidSource(block);
        } catch {
          showMermaidSource(block);
        }
      };

      if (!window.mermaid) {
        const blocks = [];
        container.querySelectorAll("pre code").forEach((code) => {
          const lang = getLanguage(code);
          const source = code.textContent || "";
          if (!isMermaidCodeBlock(lang, source)) return;
          const pre = code.closest("pre");
          const block = document.createElement("div");
          block.className = "mermaid";
          block.dataset.mermaidSource = source;
          block.textContent = source;
          if (pre) {
            pre.replaceWith(block);
          } else {
            code.replaceWith(block);
          }
          blocks.push(block);
        });
        container.querySelectorAll("div.mermaid").forEach((block) => blocks.push(block));
        const uniqueBlocks = Array.from(new Set(blocks));
        uniqueBlocks.forEach((block) => showMermaidSource(block));
        return;
      }
      if (!mermaidReady) {
        try {
          const mermaidFontFamily = getMermaidFontFamily();
          const ganttWidth = Math.max(
            1200,
            document.documentElement ? document.documentElement.clientWidth : 1200,
          );
          window.mermaid.initialize({
            startOnLoad: false,
            theme: "default",
            securityLevel: "loose",
            htmlLabels: false,
            flowchart: {
              htmlLabels: false,
              useMaxWidth: true,
            },
            sequence: {
              useMaxWidth: true,
            },
            mindmap: {
              useMaxWidth: true,
            },
            gantt: {
              useMaxWidth: false,
              useWidth: ganttWidth,
              barHeight: 24,
              barGap: 8,
              topPadding: 50,
              leftPadding: 80,
              rightPadding: 40,
              fontSize: 16,
              sectionFontSize: 16,
            },
            themeVariables: {
              fontFamily: mermaidFontFamily || "Arial, sans-serif",
              fontSize: "16px",
            },
          });
        } catch {
          // ignore init errors
        }
        mermaidReady = true;
      }
      const blocks = [];
      container.querySelectorAll("pre code").forEach((code) => {
        const lang = getLanguage(code);
        const source = code.textContent || "";
        if (!isMermaidCodeBlock(lang, source)) return;
        const pre = code.closest("pre");
        const block = document.createElement("div");
        block.className = "mermaid";
        block.dataset.mermaidSource = source;
        block.textContent = source;
        if (pre) {
          pre.replaceWith(block);
        } else {
          code.replaceWith(block);
        }
        blocks.push(block);
      });
      container.querySelectorAll("div.mermaid").forEach((block) => blocks.push(block));
      const uniqueBlocks = Array.from(new Set(blocks)).filter(
        (block) => !block.hasAttribute("data-processed"),
      );
      if (!uniqueBlocks.length) return;
      uniqueBlocks.forEach((block) => {
        block.setAttribute("data-processed", "true");
        renderMermaidBlock(block);
      });
    };

    const renderMermaidWithFonts = (container) => {
      waitForMermaidFonts(() => renderMermaid(container));
    };

    const writeClipboardText = async (text) => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.setAttribute("readonly", "true");
      helper.style.position = "fixed";
      helper.style.top = "-9999px";
      helper.style.left = "-9999px";
      document.body.appendChild(helper);
      helper.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      helper.remove();
      return ok;
    };

    const buildLineNumbers = (raw) => {
      const trimmed = raw.replace(/\r?\n$/, "");
      const lines = trimmed ? trimmed.split("\n") : [""];
      return lines.map((_, idx) => String(idx + 1)).join("\n");
    };

    const decorateCodeBlocks = (container) => {
      container.querySelectorAll("pre > code").forEach((code) => {
        if (code.closest(".md-diagram")) return;
        const lang = getLanguage(code);
        if (["mermaid", "mindmap", "echarts", "abc", "graphviz", "dot", "flowchart"].includes(lang)) {
          return;
        }
        const pre = code.parentElement;
        if (!pre || pre.closest(".code-block")) return;
        const raw = code.textContent || "";
        const wrapper = document.createElement("div");
        wrapper.className = "code-block";
        const header = document.createElement("div");
        header.className = "code-header";
        const langLabel = document.createElement("span");
        langLabel.className = "code-lang";
        langLabel.textContent = lang || "text";
        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "code-copy";
        copyBtn.setAttribute("aria-label", "Copy");
        copyBtn.setAttribute("data-tooltip", "Copy");
        copyBtn.innerHTML =
          "<svg class=\"code-copy-icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\">" +
          "<rect x=\"9\" y=\"9\" width=\"10\" height=\"12\" rx=\"2\" ry=\"2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"></rect>" +
          "<path d=\"M5 15V5a2 2 0 0 1 2-2h10\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"></path>" +
          "</svg>";
        copyBtn.addEventListener("click", async () => {
          const success = await writeClipboardText(raw);
          if (success) {
            copyBtn.setAttribute("data-tooltip", "Copied");
            copyBtn.setAttribute("aria-label", "Copied");
            copyBtn.classList.add("is-copied");
            readerAnnounce("Code copied");
            setTimeout(() => {
              copyBtn.setAttribute("data-tooltip", "Copy");
              copyBtn.setAttribute("aria-label", "Copy");
              copyBtn.classList.remove("is-copied");
            }, 1500);
          } else {
            copyBtn.setAttribute("data-tooltip", "Copy failed. Select the code and copy it manually.");
            readerAnnounce("Copy failed. Select the code and copy it manually.");
          }
        });
        if (lang || langLabel.textContent) {
          header.appendChild(langLabel);
        } else {
          header.classList.add("is-no-lang");
        }
        header.appendChild(copyBtn);
        const body = document.createElement("div");
        body.className = "code-body";
        const linesPre = document.createElement("pre");
        linesPre.className = "code-lines";
        const linesCode = document.createElement("code");
        linesCode.textContent = buildLineNumbers(raw);
        linesPre.appendChild(linesCode);
        wrapper.appendChild(header);
        wrapper.appendChild(body);
        body.appendChild(linesPre);
        pre.replaceWith(wrapper);
        body.appendChild(pre);
      });
    };

    const wrapScrollableMedia = (container) => {
      const selector = "img, svg, canvas, iframe, embed, object, video";
      container.querySelectorAll(selector).forEach((el) => {
        if (el.closest(".md-diagram, .mermaid, .code-block, .media-scroll")) {
          return;
        }
        if (el.closest(".katex")) {
          return;
        }
        const tag = el.tagName.toLowerCase();
        if (tag === "img") return;
        if (tag === "iframe") return;
        if (tag === "video") return;
        if (tag === "svg" && el.ownerSVGElement) return;
        const wrapper = document.createElement("div");
        wrapper.className = "media-scroll";
        const parent = el.parentNode;
        if (!parent) return;
        parent.insertBefore(wrapper, el);
        wrapper.appendChild(el);
      });
    };

    const isMobileViewport = () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 900px)").matches;

    const ensureIframeWrapper = (iframe) => {
      if (!iframe) return null;
      const mediaWrapper = iframe.closest(".media-scroll");
      if (mediaWrapper && mediaWrapper.contains(iframe)) {
        mediaWrapper.replaceWith(iframe);
      }
      const existingShell = iframe.closest(".iframe-shell");
      if (existingShell) return existingShell;
      const existingFit = iframe.closest(".iframe-fit");
      if (existingFit) {
        existingFit.classList.add("iframe-shell");
        return existingFit;
      }
      const innerParent = iframe.closest(".iframe-fit__inner");
      if (innerParent && innerParent.parentElement?.classList.contains("iframe-fit")) {
        innerParent.parentElement.classList.add("iframe-shell");
        return innerParent.parentElement;
      }
      const wrapper = document.createElement("div");
      wrapper.className = "iframe-shell";
      const parent = iframe.parentNode;
      if (!parent) return null;
      parent.insertBefore(wrapper, iframe);
      wrapper.appendChild(iframe);
      return wrapper;
    };

    const getIframeRatio = (iframe) => {
      const attrW = parseFloat(iframe.getAttribute("width") || "");
      const attrH = parseFloat(iframe.getAttribute("height") || "");
      if (Number.isFinite(attrW) && Number.isFinite(attrH) && attrW > 0 && attrH > 0) {
        return (attrH / attrW) * 100;
      }
      return 56.25;
    };

    const applyIframeFit = (iframe, forceMobile) => {
      if (!iframe || iframe.closest(".md-diagram, .mermaid")) return;
      const isMobile = typeof forceMobile === "boolean" ? forceMobile : isMobileViewport();
      const wrapper = ensureIframeWrapper(iframe);
      if (!wrapper) return;
      if (!isMobile) {
        wrapper.classList.remove("iframe-fit");
        iframe.style.width = "";
        iframe.style.height = "";
        iframe.style.maxWidth = "";
        iframe.style.minHeight = "";
        iframe.style.maxHeight = "";
        iframe.style.aspectRatio = "";
        iframe.style.overflow = "";
        iframe.removeAttribute("scrolling");
        iframe.removeAttribute("data-sps-iframe-mobile");
        return;
      }

      wrapper.classList.add("iframe-fit");
      const ratio = getIframeRatio(iframe);
      wrapper.style.setProperty("--iframe-ratio", `${ratio}%`);
      iframe.style.maxWidth = "100%";
      iframe.style.minHeight = "0";
      iframe.style.maxHeight = "none";
      iframe.style.aspectRatio = "auto";
      iframe.style.width = "100%";
      iframe.style.height = "100%";
      iframe.style.overflow = "auto";
      iframe.removeAttribute("scrolling");
      iframe.setAttribute("data-sps-iframe-mobile", "1");
    };

    const fitMarkdownIframes = (container) => {
      const iframes = container.querySelectorAll("iframe");
      if (!iframes.length) return;
      const mobile = isMobileViewport();
      iframes.forEach((iframe) => applyIframeFit(iframe, mobile));
    };

    const iframeFullscreenWrappers = new Set();
    const iframeFullscreenButtonsBound = new WeakSet();
    let iframeFullscreenListenerBound = false;

    const handleIframeFullscreenChange = () => {
      iframeFullscreenWrappers.forEach((wrapper) => {
        if (!wrapper.isConnected) {
          iframeFullscreenWrappers.delete(wrapper);
          return;
        }
        const button = wrapper.querySelector(".iframe-fullscreen-toggle");
        if (!button) return;
        const isFullscreen =
          document.fullscreenElement === wrapper ||
          document.fullscreenElement === wrapper.querySelector("iframe");
        button.setAttribute("aria-label", isFullscreen ? "Exit fullscreen" : "Fullscreen");
        button.setAttribute("title", isFullscreen ? "Exit fullscreen" : "Fullscreen");
        wrapper.classList.toggle("is-fullscreen", isFullscreen);
      });
    };

    const initIframeFullscreen = (container) => {
      const iframes = container.querySelectorAll("iframe");
      if (!iframes.length) return;
      iframes.forEach((iframe) => {
        const wrapper = ensureIframeWrapper(iframe);
        if (!wrapper) return;
        if (!iframe.hasAttribute("allowfullscreen")) {
          iframe.setAttribute("allowfullscreen", "");
        }
        const allowValue = iframe.getAttribute("allow") || "";
        if (!allowValue.includes("fullscreen")) {
          const nextValue = allowValue ? `${allowValue}; fullscreen` : "fullscreen";
          iframe.setAttribute("allow", nextValue);
        }
        let button = wrapper.querySelector(".iframe-fullscreen-toggle");
        if (!button) {
          button = document.createElement("button");
          button.type = "button";
          button.className = "iframe-fullscreen-toggle";
          button.setAttribute("aria-label", "Fullscreen");
          button.setAttribute("title", "Fullscreen");
          button.innerHTML =
            "<svg width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" focusable=\"false\">" +
            "<path d=\"M3 7V5a2 2 0 0 1 2-2h2\" />" +
            "<path d=\"M17 3h2a2 2 0 0 1 2 2v2\" />" +
            "<path d=\"M7 21H5a2 2 0 0 1-2-2v-2\" />" +
            "<path d=\"M21 17v2a2 2 0 0 1-2 2h-2\" />" +
            "</svg>";
          wrapper.appendChild(button);
        }
        if (!iframeFullscreenButtonsBound.has(button)) {
          iframeFullscreenButtonsBound.add(button);
          button.addEventListener("click", () => {
            if (document.fullscreenElement) {
              document.exitFullscreen().catch(() => {});
              return;
            }
            const requestWrapperFullscreen = wrapper.requestFullscreen?.bind(wrapper);
            if (requestWrapperFullscreen) {
              requestWrapperFullscreen().catch(() => {});
              return;
            }
            iframe.requestFullscreen?.().catch(() => {});
          });
        }
        iframeFullscreenWrappers.add(wrapper);
        if (!iframeFullscreenListenerBound) {
          document.addEventListener("fullscreenchange", handleIframeFullscreenChange);
          iframeFullscreenListenerBound = true;
        }
        handleIframeFullscreenChange();
      });
    };

    const fitMarkdownVideos = (container) => {
      const mobile = isMobileViewport();
      container.querySelectorAll("video").forEach((video) => {
        if (!mobile) {
          if (video.dataset.spsVideoMobile === "1") {
            video.style.width = "";
            video.style.height = "";
            video.style.maxWidth = "";
            video.style.objectFit = "";
            video.style.display = "";
            video.removeAttribute("data-sps-video-mobile");
          }
          return;
        }
        if (video.dataset.spsVideoMobile === "1") return;
        video.dataset.spsVideoMobile = "1";
        video.style.width = "100%";
        video.style.height = "auto";
        video.style.maxWidth = "100%";
        video.style.objectFit = "contain";
        video.style.display = "block";
      });
    };

    document
      .querySelectorAll("textarea.markdown-source[data-md-id]")
      .forEach((source) => {
        const id = source.getAttribute("data-md-id");
        const target = document.querySelector(
          `.markdown-body[data-md-id="${id}"]`,
        );
        if (!target) return;
        const raw = source.value || "";
        if (renderedMarkdown.get(target) === raw) return;
        target.innerHTML = sanitizeShareHtml(md.render(raw));
        renderedMarkdown.set(target, raw);
        applySiYuanTableCellAlignment(target);
        const codes = Array.from(target.querySelectorAll("pre code"));
        const languages = new Set(codes.map(getLanguage));
        const wantsMermaid = target.querySelector("div.mermaid") ||
          ["mermaid", "mindmap"].some(lang => languages.has(lang)) ||
          codes.some(code => {
            const lang = getLanguage(code);
            return (lang === "" && looksLikeMermaid(code.textContent)) ||
              (lang === "flowchart" && isMermaidFlowchart(code.textContent));
          });
        const dependencies = [];
        if (wantsMermaid) dependencies.push(loadDiagramScript("mermaid.min.js", () => !!window.mermaid));
        if (languages.has("echarts") || target.querySelector(".md-diagram--echarts")) {
          dependencies.push(loadDiagramScript("echarts.min.js", () => !!window.echarts));
        }
        if (languages.has("abc")) dependencies.push(loadDiagramScript("abcjs-basic-min.js", () => !!window.ABCJS));
        if (languages.has("graphviz") || languages.has("dot")) {
          dependencies.push(loadDiagramScript("viz.js", () => !!window.Viz)
            .then(() => loadDiagramScript("full.render.js", () =>
              typeof window.Viz?.render === "function" || typeof window.render === "function")));
        }
        if (languages.has("flowchart") && !codes.every(code =>
          getLanguage(code) !== "flowchart" || isMermaidFlowchart(code.textContent))) {
          dependencies.push(loadDiagramScript("raphael.min.js", () => !!window.Raphael)
            .then(() => loadDiagramScript("flowchart.min.js", () => !!window.flowchart)));
        }
        const finish = () => {
          if (!target.isConnected || renderedMarkdown.get(target) !== raw) return;
          renderMindmap(target);
          renderEcharts(target);
          rehydrateEcharts(target);
          renderAbc(target);
          renderGraphviz(target);
          renderFlowchart(target);
          renderPlantUml(target);
          renderMermaidWithFonts(target);
          if (window.hljs) {
            target.querySelectorAll("pre code").forEach((block) => {
              if (block.closest(".md-diagram")) return;
              if (
                block.classList.contains("language-mermaid") ||
                block.classList.contains("lang-mermaid") ||
                block.classList.contains("mermaid")
              ) {
                return;
              }
              if (block.classList.contains("hljs")) {
                return;
              }
              window.hljs.highlightElement(block);
            });
          }
          decorateCodeBlocks(target);
          wrapScrollableMedia(target);
          fitMarkdownIframes(target);
          initIframeFullscreen(target);
          fitMarkdownVideos(target);
          target.setAttribute("data-sps-rendered", "1");
        };
        // Basic text and math are already visible. Diagram engines do not hold
        // up ordinary notes or cause a second whole-document Markdown render.
        if (dependencies.length) Promise.all(dependencies).then(finish).catch(error => {
          console.error(error);
          finish();
        });
        else finish();
      });
  };

  const initShareSearch = () => {
    const searchContainer = document.querySelector("[data-share-search]");
    if (!searchContainer) return;

    const input = searchContainer.querySelector("[data-share-search-input]");
    const clearBtn = searchContainer.querySelector("[data-share-search-clear]");
    const resultsEl = searchContainer.querySelector("[data-share-search-results]");
    if (!input || !resultsEl) return;

    const sidebar = searchContainer.closest("[data-share-sidebar]");
    const slug = sidebar?.dataset?.shareSlug || "";
    if (!slug) return;

    let debounceTimer = null;
    let abortController = null;
    let searchVersion = 0;
    let keyboardIndex = -1;
    resultsEl.setAttribute("aria-live", "polite");
    resultsEl.setAttribute("aria-label", "Search results");

    const getBasePath = () => {
      const pathMatch = window.location.pathname.match(/^(.*?)\/s\//);
      return pathMatch ? pathMatch[1] : "";
    };

    const escapeHtml = (str) => {
      const div = document.createElement("div");
      div.textContent = str;
      return div.innerHTML;
    };

    const highlightText = (text, query) => {
      if (!query) return escapeHtml(text);
      const escaped = escapeHtml(text);
      const words = query.split(/\s+/).filter(w => w.length > 0);
      if (!words.length) return escaped;
      const pattern = words.map(w => {
        const wEscaped = escapeHtml(w);
        return wEscaped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }).join("|");
      const regex = new RegExp("(" + pattern + ")", "gi");
      return escaped.replace(regex, '<mark class="kb-search-mark">$1</mark>');
    };

    const hideTabsAndPanels = (hide) => {
      const tabs = sidebar?.querySelector("[data-share-tabs]");
      const panels = sidebar?.querySelectorAll("[data-share-panel]");
      if (tabs) tabs.hidden = !!hide;
      if (panels) panels.forEach(p => { if (hide) p.hidden = true; });
      if (!hide) {
        if (tabs) tabs.hidden = false;
        const activeTab = tabs?.querySelector(".kb-side-tab.is-active");
        if (activeTab) activeTab.click();
      }
    };

    const doSearch = async (query, version = searchVersion) => {
      if (abortController) abortController.abort();
      if (!query || query.length < 1) {
        resultsEl.hidden = true;
        resultsEl.innerHTML = "";
        hideTabsAndPanels(false);
        return;
      }
      abortController = new AbortController();
      const busyTimer = setTimeout(() => {
        if (version !== searchVersion) return;
        resultsEl.textContent = "Searching…";
        resultsEl.hidden = false;
        hideTabsAndPanels(true);
      }, 200);
      const base = getBasePath();
      const url = base + "/s/" + encodeURIComponent(slug) + "/search?q=" + encodeURIComponent(query);
      try {
        const resp = await fetch(url, {
          credentials: "same-origin",
          signal: abortController.signal,
        });
        const payload = await resp.json().catch(() => null);
        if (version !== searchVersion) return;
        if (!payload || payload.code !== 0) {
          resultsEl.innerHTML = '<div class="kb-search-empty">Search failed</div>';
          resultsEl.hidden = false;
          hideTabsAndPanels(true);
          return;
        }
        const results = payload.data?.results || [];
        renderResults(results, query);
      } catch (err) {
        if (err?.name === "AbortError" || version !== searchVersion) return;
        resultsEl.innerHTML = '<div class="kb-search-empty">Search failed</div>';
        resultsEl.hidden = false;
        hideTabsAndPanels(true);
      } finally {
        clearTimeout(busyTimer);
      }
    };

    const renderResults = (results, query) => {
      keyboardIndex = -1;
      if (!results.length) {
        resultsEl.innerHTML = '<div class="kb-search-empty">No results found</div>';
        resultsEl.hidden = false;
        hideTabsAndPanels(true);
        return;
      }
      const base = getBasePath();
      let html = '<ul class="kb-search-list">';
      results.forEach((r) => {
        const titleHtml = highlightText(r.title, query);
        const snippet = String(r.snippet || "").replace(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g, "[formula]")
          .replace(/\${1,2}[^$]*$/g, "[formula]")
          .replace(/!\[[^\]]*\]\([^)]*\)/g, "[image]").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
          .replace(/(?:\*\*|__|`|^#{1,6}\s)/g, "");
        const snippetHtml = highlightText(snippet, query);
        const pathHtml = r.hpath ? escapeHtml(r.hpath) : '';
        const href = base + "/s/" + encodeURIComponent(slug) + "/" + encodeURIComponent(r.docId) + "?highlight=" + encodeURIComponent(query);
        html += '<li class="kb-search-item">';
        html += '<a class="kb-search-link" href="' + escapeHtml(href) + '" data-share-nav="doc">';
        html += '<div class="kb-search-title">' + titleHtml + '</div>';
        if (pathHtml) {
          html += '<div class="kb-search-path">' + pathHtml + '</div>';
        }
        html += '<div class="kb-search-snippet">' + snippetHtml + '</div>';
        html += '</a></li>';
      });
      html += '</ul>';
      resultsEl.innerHTML = html;
      resultsEl.hidden = false;
      hideTabsAndPanels(true);
    };

    const clearSearch = () => {
      searchVersion++;
      clearTimeout(debounceTimer);
      abortController?.abort();
      keyboardIndex = -1;
      input.value = "";
      if (clearBtn) clearBtn.hidden = true;
      resultsEl.hidden = true;
      resultsEl.innerHTML = "";
      hideTabsAndPanels(false);
    };

    input.addEventListener("input", () => {
      const version = ++searchVersion;
      abortController?.abort();
      const val = input.value.trim();
      if (clearBtn) clearBtn.hidden = val.length === 0;
      clearTimeout(debounceTimer);
      if (!val) { clearSearch(); return; }
      debounceTimer = setTimeout(() => doSearch(val, version), 300);
    });

    input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Escape" && input.value) {
        event.preventDefault(); event.stopPropagation(); clearSearch(); return;
      }
      if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
      const links = Array.from(resultsEl.querySelectorAll(".kb-search-link"));
      if (!links.length) return;
      event.preventDefault();
      if (event.key === "Enter") { links[Math.max(0, keyboardIndex)]?.click(); return; }
      keyboardIndex = (keyboardIndex + (event.key === "ArrowDown" ? 1 : -1) + links.length) % links.length;
      links.forEach((link, index) => link.classList.toggle("is-keyboard-active", index === keyboardIndex));
      links[keyboardIndex].scrollIntoView({block: "nearest", behavior: "auto"});
    });

    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        clearSearch();
        input.focus();
      });
    }
  };

  const initSearchHighlight = () => {
    let highlightedMarks = [];
    let markerBuildRaf = 0;
    let markerResizeObserver = null;
    let highlightBuildRaf = 0;
    let highlightRetryTimer = 0;
    let highlightAttempt = 0;
    let autoScrollKey = "";
    let autoScrollPending = false;
    let autoScrollLastTop = null;
    let autoScrollStableCount = 0;
    let autoScrollAdjustCount = 0;
    let autoScrollDeadline = 0;
    let autoScrollDebounceTimer = 0;
    let highlightDeferredUntilLoad = false;
    const highlightMaxAttempts = 8;
    const autoScrollMaxAdjustments = 6;
    const autoScrollTolerancePx = 6;

    const getHighlightQueryFromUrl = () => {
      const params = new URLSearchParams(window.location.search);
      return String(params.get("highlight") || "").trim();
    };

    // Disable browser scroll restoration when highlight is present,
    // so our scroll-to-mark logic is not overridden on refresh.
    if (getHighlightQueryFromUrl() && "scrollRestoration" in history) {
      history.scrollRestoration = "manual";
    }

    const clearScrollbarMarkers = () => {
      const existing = document.querySelector(".kb-search-scrollbar-track");
      if (existing) existing.remove();
    };

    const resetAutoScrollState = () => {
      autoScrollKey = "";
      autoScrollPending = false;
      autoScrollLastTop = null;
      autoScrollStableCount = 0;
      autoScrollAdjustCount = 0;
      autoScrollDeadline = 0;
      clearTimeout(autoScrollDebounceTimer);
    };

    const getScrollMetrics = () => {
      const scroller = document.scrollingElement || document.documentElement;
      const docHeight = Math.max(scroller?.scrollHeight || 0, 1);
      const viewHeight = Math.max(scroller?.clientHeight || window.innerHeight || 0, 1);
      const maxScroll = Math.max(docHeight - viewHeight, 0);
      const scrollbarWidth = Math.max(window.innerWidth - document.documentElement.clientWidth, 0);
      return {scroller, docHeight, viewHeight, maxScroll, scrollbarWidth};
    };

    const getViewportOffset = () => {
      const topbar = document.querySelector(".app-topbar");
      if (!topbar) return 20;
      return topbar.getBoundingClientRect().height + 16;
    };

    const getTargetScrollTop = (mark, metrics) => {
      if (!metrics) return null;
      if (!mark?.isConnected) return null;
      const rect = mark.getBoundingClientRect();
      const currentTop = metrics.scroller?.scrollTop ?? window.scrollY;
      const absTop = rect.top + currentTop;
      const rawMarginTop = window.getComputedStyle(mark).scrollMarginTop;
      const scrollMarginTop = Number.parseFloat(rawMarginTop) || 0;
      return Math.min(Math.max(absTop - scrollMarginTop, 0), metrics.maxScroll);
    };

    const wrapTextMatches = (root, query) => {
      const marks = [];
      const words = query.split(/\s+/).filter(w => w.length > 0);
      if (!words.length) return marks;
      const lowerWords = words.map(w => w.toLowerCase());
      const shouldSkipTextNode = (node) => {
        const parent = node?.parentElement;
        if (!parent) return true;
        if (parent.closest("script,style,textarea,template")) return true;
        if (parent.closest("[hidden],[aria-hidden='true'],details:not([open])")) return true;
        if (parent.closest(".code-lines,.code-header")) return true;
        return false;
      };
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          if (shouldSkipTextNode(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      const textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      if (!textNodes.length) return marks;

      // Concatenate all text nodes into one string so we can match across element boundaries
      let fullText = "";
      const nodeInfo = [];
      for (const node of textNodes) {
        const text = node.textContent || "";
        nodeInfo.push({ node, start: fullText.length, len: text.length });
        fullText += text;
      }
      const lowerFull = fullText.toLowerCase();

      // Find all match positions for each word in the concatenated text
      const matchRanges = [];
      for (const lw of lowerWords) {
        let pos = 0;
        while (true) {
          const idx = lowerFull.indexOf(lw, pos);
          if (idx < 0) break;
          matchRanges.push([idx, idx + lw.length]);
          pos = idx + lw.length;
        }
      }
      if (!matchRanges.length) return marks;

      // Sort and merge overlapping ranges
      matchRanges.sort((a, b) => a[0] - b[0]);
      const merged = [[matchRanges[0][0], matchRanges[0][1]]];
      for (let i = 1; i < matchRanges.length; i++) {
        const last = merged[merged.length - 1];
        if (matchRanges[i][0] <= last[1]) {
          last[1] = Math.max(last[1], matchRanges[i][1]);
        } else {
          merged.push([matchRanges[i][0], matchRanges[i][1]]);
        }
      }

      // Map match ranges back to individual text nodes, process in reverse to preserve offsets
      for (let ni = nodeInfo.length - 1; ni >= 0; ni--) {
        const info = nodeInfo[ni];
        const nStart = info.start;
        const nEnd = info.start + info.len;
        // Collect overlapping highlight ranges for this node (in local offsets)
        const overlaps = [];
        for (const [ms, me] of merged) {
          if (me <= nStart || ms >= nEnd) continue;
          overlaps.push([Math.max(ms, nStart) - nStart, Math.min(me, nEnd) - nStart]);
        }
        if (!overlaps.length) continue;
        const text = info.node.textContent || "";
        const frag = document.createDocumentFragment();
        let lastEnd = 0;
        for (const [os, oe] of overlaps) {
          if (os > lastEnd) {
            frag.appendChild(document.createTextNode(text.substring(lastEnd, os)));
          }
          const mark = document.createElement("mark");
          mark.className = "kb-search-hl";
          mark.textContent = text.substring(os, oe);
          marks.push(mark);
          frag.appendChild(mark);
          lastEnd = oe;
        }
        if (lastEnd < text.length) {
          frag.appendChild(document.createTextNode(text.substring(lastEnd)));
        }
        info.node.parentNode.replaceChild(frag, info.node);
      }
      // Marks were collected in reverse order, fix it
      marks.reverse();
      return marks;
    };

    const clearTextMatches = (root) => {
      if (!root) return;
      root.querySelectorAll("mark.kb-search-hl").forEach((mark) => {
        const textNode = document.createTextNode(mark.textContent || "");
        mark.replaceWith(textNode);
      });
      if (typeof root.normalize === "function") {
        root.normalize();
      }
    };

    const buildScrollbarMarkers = (marks) => {
      clearScrollbarMarkers();
      if (!marks.length) return;
      const metrics = getScrollMetrics();
      const {docHeight, viewHeight, maxScroll, scrollbarWidth} = metrics;
      if (maxScroll <= 0) return;
      const track = document.createElement("div");
      track.className = "kb-search-scrollbar-track";
      if (scrollbarWidth > 0) {
        track.style.right = "0";
        track.style.width = `${scrollbarWidth}px`;
      }
      const scrollbarInset = scrollbarWidth > 0 ? scrollbarWidth : 0;
      const trackLength = Math.max(viewHeight - scrollbarInset * 2, 1);
      const thumbSize = Math.min(
        trackLength,
        Math.max((viewHeight / docHeight) * trackLength, 8),
      );
      const thumbTravel = Math.max(trackLength - thumbSize, 0);
      marks.forEach((mark) => {
        const targetScrollTop = getTargetScrollTop(mark, metrics);
        if (targetScrollTop === null) return;
        // Align marker to native scrollbar thumb center trajectory.
        const progress = Math.min(Math.max(targetScrollTop / maxScroll, 0), 1);
        const thumbTop = scrollbarInset + progress * thumbTravel;
        const markerY = thumbTop + thumbSize / 2;
        const pct = Math.min((markerY / viewHeight) * 100, 100);
        const dot = document.createElement("div");
        dot.className = "kb-search-scrollbar-mark";
        if (scrollbarWidth > 0) {
          dot.style.left = "1px";
          dot.style.right = "1px";
          dot.style.width = "auto";
        }
        dot.style.top = pct + "%";
        dot.style.transform = "translateY(-50%)";
        dot.addEventListener("click", () => {
          const nextMetrics = getScrollMetrics();
          const nextTarget = getTargetScrollTop(mark, nextMetrics);
          if (nextTarget === null) return;
          const offset = getViewportOffset();
          window.scrollTo({ top: Math.max(nextTarget - offset, 0), behavior: scrollBehavior() });
        });
        track.appendChild(dot);
      });
      document.body.appendChild(track);
    };

    const scheduleMarkerBuild = () => {
      if (markerBuildRaf) return;
      markerBuildRaf = window.requestAnimationFrame(() => {
        markerBuildRaf = 0;
        buildScrollbarMarkers(highlightedMarks);
      });
    };

    const setupMarkerAutoRefresh = () => {
      window.addEventListener("resize", scheduleMarkerBuild, {passive: true});
      if (typeof window.ResizeObserver !== "function") return;
      markerResizeObserver = new window.ResizeObserver(() => {
        scheduleMarkerBuild();
        rearmAutoScrollIfNeeded();
        if (autoScrollPending) {
          clearTimeout(autoScrollDebounceTimer);
          autoScrollDebounceTimer = setTimeout(() => {
            applyAutoScrollCorrection();
          }, 150);
        }
      });
      if (document.documentElement) markerResizeObserver.observe(document.documentElement);
      if (document.body) markerResizeObserver.observe(document.body);
    };

    const applyAutoScrollCorrection = ({behavior = "auto"} = {}) => {
      if (!autoScrollPending) return;
      if (autoScrollDeadline > 0 && Date.now() > autoScrollDeadline) {
        autoScrollPending = false;
        return;
      }
      const firstMark = highlightedMarks[0];
      if (!firstMark?.isConnected) return;
      const metrics = getScrollMetrics();
      const nextTop = getTargetScrollTop(firstMark, metrics);
      if (nextTop === null) return;
      const offset = getViewportOffset();
      const scrollTarget = Math.max(nextTop - offset, 0);
      if (autoScrollLastTop === null || Math.abs(scrollTarget - autoScrollLastTop) > autoScrollTolerancePx) {
        window.scrollTo({top: scrollTarget, behavior});
        autoScrollLastTop = scrollTarget;
        autoScrollStableCount = 0;
        autoScrollAdjustCount += 1;
        if (autoScrollAdjustCount >= autoScrollMaxAdjustments) {
          autoScrollPending = false;
        }
        return;
      }
      autoScrollStableCount += 1;
      if (autoScrollStableCount >= 2) {
        autoScrollPending = false;
      }
    };

    const rearmAutoScrollIfNeeded = () => {
      if (autoScrollPending) return;
      if (!highlightedMarks.length) return;
      if (autoScrollDeadline <= 0 || Date.now() > autoScrollDeadline) return;
      const firstMark = highlightedMarks[0];
      if (!firstMark?.isConnected) return;
      const metrics = getScrollMetrics();
      const nextTop = getTargetScrollTop(firstMark, metrics);
      if (nextTop === null) return;
      const offset = getViewportOffset();
      const scrollTarget = Math.max(nextTop - offset, 0);
      const currentTop = metrics.scroller?.scrollTop ?? window.scrollY;
      if (Math.abs(scrollTarget - currentTop) <= autoScrollTolerancePx) return;
      autoScrollPending = true;
      autoScrollLastTop = null;
      autoScrollStableCount = 0;
      autoScrollAdjustCount = 0;
    };

    const scheduleHighlightAfterLayoutStable = () => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          scheduleHighlightRun();
        });
      });
    };

    const runHighlight = () => {
      if (highlightRetryTimer) {
        window.clearTimeout(highlightRetryTimer);
        highlightRetryTimer = 0;
      }
      const highlight = getHighlightQueryFromUrl();
      const allMarks = [];
      const title = document.querySelector("h1.kb-title, .share-header h1");
      const body = document.querySelector(".markdown-body");
      if (!body) {
        if (highlight && highlightAttempt < highlightMaxAttempts) {
          highlightAttempt += 1;
          const delay = Math.min(120 * highlightAttempt, 800);
          highlightRetryTimer = window.setTimeout(() => {
            scheduleHighlightRun();
          }, delay);
        }
        return;
      }
      const hasMarkdownSource = !!document.querySelector("textarea.markdown-source[data-md-id]");
      const markdownRendered = body.getAttribute("data-sps-rendered") === "1";
      if (highlight && hasMarkdownSource && !markdownRendered) {
        if (highlightAttempt < highlightMaxAttempts) {
          highlightAttempt += 1;
          const delay = Math.min(120 * highlightAttempt, 800);
          highlightRetryTimer = window.setTimeout(() => {
            scheduleHighlightRun();
          }, delay);
        }
        return;
      }
      clearTextMatches(title);
      clearTextMatches(body);
      if (!highlight) {
        highlightedMarks = [];
        resetAutoScrollState();
        scheduleMarkerBuild();
        return;
      }
      if (title) {
        const titleMarks = wrapTextMatches(title, highlight);
        allMarks.push(...titleMarks);
      }
      const bodyMarks = wrapTextMatches(body, highlight);
      allMarks.push(...bodyMarks);
      highlightedMarks = allMarks.filter((mark) => mark?.isConnected);
      if (highlightedMarks.length > 0) {
        highlightAttempt = 0;
        highlightedMarks[0].classList.add("kb-search-hl-first");
        const key = `${window.location.pathname}?${window.location.search}`;
        if (autoScrollKey !== key) {
          autoScrollKey = key;
          autoScrollPending = true;
          autoScrollLastTop = null;
          autoScrollStableCount = 0;
          autoScrollAdjustCount = 0;
          autoScrollDeadline = Date.now() + 10000;
        } else {
          rearmAutoScrollIfNeeded();
        }
        applyAutoScrollCorrection({behavior: "auto"});
      }
      scheduleMarkerBuild();
      if (!markerResizeObserver) setupMarkerAutoRefresh();
      if (!highlightedMarks.length && highlightAttempt < highlightMaxAttempts) {
        highlightAttempt += 1;
        const delay = Math.min(120 * highlightAttempt, 800);
        highlightRetryTimer = window.setTimeout(() => {
          scheduleHighlightRun();
        }, delay);
      }
    };

    const scheduleHighlightRun = () => {
      if (highlightBuildRaf) return;
      highlightBuildRaf = window.requestAnimationFrame(() => {
        highlightBuildRaf = 0;
        runHighlight();
      });
    };

    const triggerHighlight = () => {
      highlightAttempt = 0;
      const highlight = getHighlightQueryFromUrl();
      if (highlight && document.readyState !== "complete") {
        if (!highlightDeferredUntilLoad) {
          highlightDeferredUntilLoad = true;
          window.addEventListener("load", () => {
            highlightDeferredUntilLoad = false;
            scheduleHighlightAfterLayoutStable();
          }, {once: true});
        }
        return;
      }
      scheduleHighlightAfterLayoutStable();
    };

    window.addEventListener("sps:share-dynamic-ready", triggerHighlight);
  };

  const refreshShareDynamicContent = () => {
    clearFootnoteWindows();
    initShareMarkdownToggle();


    initDocTreeScroll();
    const token = ++shareDynamicToken;
    scheduleIdle(() => {
      if (token !== shareDynamicToken) return;
      try {
        initMarkdown();
      } catch (err) {
        console.error(err);
      }
      try {
        initShareToc();
      } catch (err) {
        console.error(err);
      }
      try {
        initShareFootnotePreview();
      } catch (err) {
        console.error(err);
      }
      try {
        window.dispatchEvent(new Event("sps:share-dynamic-ready"));
      } catch (err) {
        console.error(err);
      }
    });
  };

  window.addEventListener(
    "sps:markdown-ready",
    () => {
      refreshShareDynamicContent();
    },
    {once: true},
  );


  initKnowledgeTree();
  initActionTableOverflowState();

  window.SPSControls?.mount();
  if (document.querySelector("form[data-confirm-message]")) initFormConfirm();

  initFlashToast();

  initShareSearch();
  initSearchHighlight();
  initShareSidebarTabs();
  initShareDrawer();
  initReaderBehavior();
  initShareDocNavigation();
  initImageViewer();
  initScrollTop();

  refreshShareDynamicContent();
})();
