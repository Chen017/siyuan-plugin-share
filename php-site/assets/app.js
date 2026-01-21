(() => {
  "use strict";

  const refreshCaptcha = (img) => {
    const base = img.getAttribute("data-src") || img.getAttribute("src") || "";
    const clean = base.split("?")[0];
    img.setAttribute("data-src", clean);
    img.src = `${clean}?ts=${Date.now()}`;
  };

  document.querySelectorAll("img[data-captcha]").forEach((img) => {
    img.addEventListener("click", () => refreshCaptcha(img));
  });

  const initAnnouncementModal = () => {
    const modal = document.querySelector("[data-announcement-modal]");
    if (!modal) return;
    const hideCheckbox = modal.querySelector("[data-announcement-hide]");
    const closeModal = () => {
      if (hideCheckbox && hideCheckbox.checked) {
        const now = new Date();
        const pad = (num) => String(num).padStart(2, "0");
        const today = [
          now.getFullYear(),
          pad(now.getMonth() + 1),
          pad(now.getDate()),
        ].join("-");
        document.cookie = `announcement_hide_date=${today}; path=/; max-age=86400`;
      }
      modal.remove();
    };
    modal.addEventListener("click", (event) => {
      const target = event.target;
      if (!target) return;
      if (
        target.closest("[data-modal-close]") ||
        target.classList.contains("modal-backdrop")
      ) {
        closeModal();
      }
    });
  };

  const initNav = () => {
    const navItems = Array.from(document.querySelectorAll(".app-nav .nav-item"));
    if (!navItems.length) return;
    const currentPath = window.location.pathname.replace(/\/+$/, "");

    const setActive = (target) => {
      navItems.forEach((item) => item.classList.remove("is-active"));
      if (target) target.classList.add("is-active");
    };

    const findItem = (hash) =>
      navItems.find((item) => {
        const itemPath = (item.dataset.navPath || "").replace(/\/+$/, "");
        const itemHash = item.dataset.navHash || "";
        if (itemPath && itemPath !== currentPath) return false;
        if (hash) return itemHash === hash;
        return !itemHash;
      });

    const updateByHash = () => {
      const hash = window.location.hash.replace(/^#/, "");
      const item = findItem(hash) || findItem("");
      setActive(item);
    };

    navItems.forEach((item) => {
      item.addEventListener("click", (event) => {
        if (
          event.defaultPrevented ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        const hash = item.dataset.navHash || "";
        const itemPath = (item.dataset.navPath || "").replace(/\/+$/, "");
        if (hash && itemPath === currentPath) {
          const target = document.getElementById(hash);
          if (target) {
            event.preventDefault();
            target.scrollIntoView({behavior: "smooth", block: "start"});
            history.replaceState(null, "", `#${hash}`);
            setActive(item);
          }
        }
      });
    });

    if ("IntersectionObserver" in window) {
      const hashTargets = navItems
        .map((item) => item.dataset.navHash || "")
        .filter(Boolean)
        .map((hash) => document.getElementById(hash))
        .filter(Boolean);
      if (hashTargets.length) {
        const observer = new IntersectionObserver(
          (entries) => {
            const visible = entries
              .filter((entry) => entry.isIntersecting)
              .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
            if (!visible) return;
            const item = findItem(visible.target.id);
            setActive(item);
          },
          {rootMargin: "-20% 0px -70% 0px", threshold: [0, 0.5, 1]},
        );
        hashTargets.forEach((el) => observer.observe(el));
      }
    }

    window.addEventListener("hashchange", updateByHash);
    updateByHash();
  };

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
    const toggleNode = (node, nextOpen) => {
      node.classList.toggle("is-open", nextOpen);
      node.classList.toggle("is-collapsed", !nextOpen);
      const btn = node.querySelector(".kb-tree-toggle");
      if (btn) btn.setAttribute("aria-expanded", String(nextOpen));
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
        toggleNode(node, nextOpen);
        syncState();
      });
    });
    document.querySelectorAll(".kb-tree-folder").forEach((label) => {
      label.addEventListener("click", () => {
        const node = label.closest(".kb-tree-node");
        if (!node || !node.querySelector(".kb-tree-toggle")) return;
        const nextOpen = !node.classList.contains("is-open");
        toggleNode(node, nextOpen);
        syncState();
      });
    });
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
    sidebar.scrollTo({top: sidebar.scrollTop + offset, behavior: "smooth"});
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

    const buildTree = (headings) => {
      const root = {level: 0, children: []};
      const stack = [root];
      headings.forEach((heading, index) => {
        const level = Number(String(heading.tagName || "H2").slice(1)) || 2;
        const node = {
          heading,
          level,
          id: ensureHeadingId(heading, index),
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

    const renderTree = (nodes, level = 0) => {
      const list = document.createElement("ul");
      list.className = "share-toc-list";
      list.dataset.level = String(level);
      if (level > 0) list.classList.add("share-toc-children");
      nodes.forEach((node) => {
        const item = document.createElement("li");
        item.className = "share-toc-node";
        const hasChildren = node.children.length > 0;

        const row = document.createElement("div");
        row.className = "share-toc-row";
        const spacer = document.createElement("span");
        spacer.className = "share-toc-spacer";
        row.appendChild(spacer);

        const link = document.createElement("a");
        link.className = "share-toc-link";
        link.href = `#${node.id}`;
        link.textContent = node.heading.textContent || "未命名";
        row.appendChild(link);
        item.appendChild(row);

        if (hasChildren) {
          item.appendChild(renderTree(node.children, level + 1));
        }
        list.appendChild(item);
      });
      return list;
    };

    containers.forEach((container) => {
      const targetId = container.getAttribute("data-share-toc") || "";
      const target = document.querySelector(
        `.markdown-body[data-md-id="${targetId}"]`,
      );
      const body =
        container.querySelector(".share-toc-body") || container;
      const scrollBox = body;
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
          behavior: "smooth",
        });
      };
      body.innerHTML = "";
      if (!target) return;

      const headings = Array.from(
        target.querySelectorAll("h1, h2, h3, h4, h5, h6"),
      );
      if (!headings.length) {
        const empty = document.createElement("div");
        empty.className = "share-toc-empty";
        empty.textContent = "暂无目录";
        body.appendChild(empty);
        return;
      }

      const nodes = buildTree(headings);
      const list = renderTree(nodes, 0);
      body.appendChild(list);

      const linkMap = new Map();
      body.querySelectorAll(".share-toc-link").forEach((link) => {
        const href = link.getAttribute("href") || "";
        if (href.startsWith("#")) {
          linkMap.set(href.slice(1), link);
        }
      });
      body.querySelectorAll(".share-toc-link").forEach((link) => {
        link.addEventListener("click", (event) => {
          const href = link.getAttribute("href") || "";
          if (!href.startsWith("#")) return;
          const target = document.getElementById(href.slice(1));
          if (!target) return;
          event.preventDefault();
          target.scrollIntoView({behavior: "smooth", block: "start"});
          history.replaceState(null, "", href);
          linkMap.forEach((item) => item.classList.remove("is-active"));
          link.classList.add("is-active");
          ensureVisible(link);
        });
      });

      if ("IntersectionObserver" in window && linkMap.size) {
        const observer = new IntersectionObserver(
          (entries) => {
            const visible = entries
              .filter((entry) => entry.isIntersecting)
              .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
            if (!visible) return;
            const link = linkMap.get(visible.target.id);
            if (!link) return;
            linkMap.forEach((item) => item.classList.remove("is-active"));
            link.classList.add("is-active");
            ensureVisible(link);
          },
          {rootMargin: "-20% 0px -70% 0px", threshold: [0, 0.5, 1]},
        );
        headings.forEach((heading) => observer.observe(heading));
      }
    });
  };

  const initShareSidebarTabs = () => {
    const tabs = document.querySelector("[data-share-tabs]");
    if (!tabs) return;
    const buttons = Array.from(tabs.querySelectorAll("[data-share-tab]"));
    if (!buttons.length) return;
    const container = tabs.closest("[data-share-sidebar]") || document;
    const panels = Array.from(container.querySelectorAll("[data-share-panel]"));
    if (!panels.length) return;
    const defaultTab =
      tabs.getAttribute("data-share-default") ||
      buttons[0]?.dataset.shareTab ||
      "tree";
    const setActive = (tab) => {
      buttons.forEach((btn) => {
        const isActive = (btn.dataset.shareTab || "") === tab;
        btn.classList.toggle("is-active", isActive);
        btn.setAttribute("aria-selected", isActive ? "true" : "false");
      });
      panels.forEach((panel) => {
        panel.hidden = (panel.dataset.sharePanel || "") !== tab;
      });
    };
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.shareTab || "";
        if (!tab) return;
        setActive(tab);
      });
    });
    setActive(defaultTab);
  };

  const initShareDrawer = () => {
    const openBtn = document.querySelector("[data-share-drawer-open]");
    const backdrop = document.querySelector("[data-share-drawer-close]");
    const sidebar = document.querySelector(".kb-sidebar, .share-toc");
    if (openBtn && !sidebar) {
      openBtn.hidden = true;
    }
    if (!openBtn && !backdrop) return;
    const setOpen = (open) => {
      document.body.classList.toggle("share-side-open", open);
    };
    if (openBtn) {
      openBtn.addEventListener("click", () => setOpen(true));
    }
    if (backdrop) {
      backdrop.addEventListener("click", () => setOpen(false));
    }
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setOpen(false);
    });
    document.querySelectorAll(".kb-sidebar a, .share-toc a").forEach((link) => {
      link.addEventListener("click", () => setOpen(false));
    });
    if (openBtn && sidebar) {
      const mq = window.matchMedia("(max-width: 960px)");
      const updateTrigger = () => {
        const pos = window.getComputedStyle(sidebar).position;
        const shouldShow = mq.matches || pos === "fixed";
        openBtn.hidden = !shouldShow;
        openBtn.style.display = shouldShow ? "inline-flex" : "none";
      };
      if (typeof mq.addEventListener === "function") {
        mq.addEventListener("change", updateTrigger);
      } else if (typeof mq.addListener === "function") {
        mq.addListener(updateTrigger);
      }
      window.addEventListener("resize", updateTrigger, {passive: true});
      window.addEventListener("orientationchange", updateTrigger, {passive: true});
      requestAnimationFrame(updateTrigger);
      setTimeout(updateTrigger, 300);
    }
  };

  const initShareMarkdownToggle = () => {
    if (!document.body.classList.contains("layout-share")) return;
    document.querySelectorAll("[data-share-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const container = btn.closest(".share-article");
        if (!container) return;
        const isMarkdown = container.classList.toggle("is-markdown");
        container.setAttribute("data-share-view", isMarkdown ? "markdown" : "preview");
        btn.textContent = isMarkdown ? "预览" : "源码";
        btn.setAttribute("aria-pressed", isMarkdown ? "true" : "false");
      });
    });
  };

  const initAppDrawer = () => {
    const openBtn = document.querySelector("[data-app-drawer-open]");
    const backdrop = document.querySelector("[data-app-drawer-close]");
    const sidebar = document.querySelector(".app-sidebar");
    if (!sidebar) return;
    const setOpen = (open) => {
      document.body.classList.toggle("app-side-open", open);
    };
    if (openBtn) {
      openBtn.addEventListener("click", () => setOpen(true));
    }
    if (backdrop) {
      backdrop.addEventListener("click", () => setOpen(false));
    }
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setOpen(false);
    });
    document.querySelectorAll(".app-sidebar a").forEach((link) => {
      link.addEventListener("click", () => setOpen(false));
    });
    const mq = window.matchMedia("(max-width: 960px)");
    const updateTrigger = () => {
      const shouldShow = mq.matches;
      if (openBtn) {
        openBtn.hidden = !shouldShow;
        openBtn.style.display = shouldShow ? "inline-flex" : "none";
      }
      if (!shouldShow) {
        setOpen(false);
      }
    };
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", updateTrigger);
    } else if (typeof mq.addListener === "function") {
      mq.addListener(updateTrigger);
    }
    window.addEventListener("resize", updateTrigger, {passive: true});
    window.addEventListener("orientationchange", updateTrigger, {passive: true});
    requestAnimationFrame(updateTrigger);
  };

  const initScrollTop = () => {
    const btn = document.querySelector("[data-scroll-top]");
    if (!btn) return;
    const toggle = () => {
      btn.classList.toggle("is-visible", window.scrollY > 320);
    };
    btn.addEventListener("click", () => {
      window.scrollTo({top: 0, behavior: "smooth"});
    });
    window.addEventListener("scroll", toggle, {passive: true});
    toggle();
  };

  const initLoginTabs = () => {
    const tabs = document.querySelector("[data-login-tabs]");
    if (!tabs) return;
    const buttons = Array.from(tabs.querySelectorAll("[data-login-tab]"));
    const panels = Array.from(document.querySelectorAll("[data-login-panel]"));
    if (!buttons.length || !panels.length) return;
    const defaultTab = tabs.getAttribute("data-login-default") || buttons[0].dataset.loginTab || "password";
    const setActive = (tab) => {
      buttons.forEach((btn) => {
        const isActive = (btn.dataset.loginTab || "") === tab;
        btn.classList.toggle("is-active", isActive);
        btn.setAttribute("aria-selected", isActive ? "true" : "false");
      });
      panels.forEach((panel) => {
        panel.hidden = (panel.dataset.loginPanel || "") !== tab;
      });
    };
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.loginTab || "";
        if (!tab) return;
        setActive(tab);
      });
    });
    setActive(defaultTab);
  };

  const initCountdownButtons = () => {
    const buttons = Array.from(document.querySelectorAll("[data-countdown-until]"));
    if (!buttons.length) return;
    buttons.forEach((btn) => {
      const until = Number(btn.dataset.countdownUntil || 0);
      if (!Number.isFinite(until)) return;
      const baseText = btn.dataset.countdownText || btn.textContent || "";
      const tick = () => {
        const remaining = Math.max(0, until - Date.now());
        if (remaining <= 0) {
          btn.disabled = false;
          btn.textContent = baseText;
          return;
        }
        const seconds = Math.ceil(remaining / 1000);
        btn.disabled = true;
        btn.textContent = `${baseText} (${seconds}s)`;
        window.setTimeout(tick, 1000);
      };
      tick();
    });
  };

  const initBatchSelection = () => {
    const groups = new Map();
    document.querySelectorAll("[data-check-item]").forEach((item) => {
      const group = item.dataset.checkItem || "";
      if (!group) return;
      if (!groups.has(group)) groups.set(group, {items: [], toggles: []});
      groups.get(group).items.push(item);
    });
    document.querySelectorAll("[data-check-all]").forEach((toggle) => {
      const group = toggle.dataset.checkAll || "";
      if (!group) return;
      if (!groups.has(group)) groups.set(group, {items: [], toggles: []});
      groups.get(group).toggles.push(toggle);
    });

    groups.forEach(({items, toggles}) => {
      if (!items.length || !toggles.length) return;
      const sync = () => {
        const selectable = items.filter((item) => !item.disabled);
        const allChecked = selectable.length
          ? selectable.every((item) => item.checked)
          : false;
        toggles.forEach((toggle) => {
          toggle.checked = allChecked;
        });
      };
      toggles.forEach((toggle) => {
        toggle.addEventListener("change", () => {
          items.forEach((item) => {
            if (!item.disabled) item.checked = toggle.checked;
          });
          sync();
        });
      });
      items.forEach((item) => item.addEventListener("change", sync));
      sync();
    });
  };

  const initUserModal = () => {
    const modal = document.querySelector("[data-user-modal]");
    if (!modal) return;
    const close = () => {
      modal.hidden = true;
    };
    modal.addEventListener("click", (event) => {
      const target = event.target;
      if (
        target &&
        (target.matches("[data-modal-close]") ||
          target.classList.contains("modal-backdrop"))
      ) {
        close();
      }
    });
    document.querySelectorAll("[data-user-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        modal.hidden = false;
        const dataset = btn.dataset;
        modal.querySelector("[data-user-field='id']").value =
          dataset.userId || "";
        modal.querySelector("[data-user-field='username']").value =
          dataset.userName || "";
        modal.querySelector("[data-user-field='email']").value =
          dataset.userEmail || "";
        modal.querySelector("[data-user-field='role']").value =
          dataset.userRole || "user";
        modal.querySelector("[data-user-field='disabled']").value =
          dataset.userDisabled || "0";
        modal.querySelector("[data-user-field='limit']").value =
          dataset.userLimit || "0";
      });
    });
  };

  const initRangeSwitch = () => {
    const switches = document.querySelectorAll("[data-range-switch]");
    if (!switches.length) return;
    switches.forEach((card) => {
      const buttons = Array.from(card.querySelectorAll("[data-range-value]"));
      const panels = Array.from(card.querySelectorAll("[data-range-panel]"));
      const label = card.querySelector("[data-range-label]");
      if (!buttons.length || !panels.length) return;
      const setRange = (value) => {
        const target = String(value || "");
        buttons.forEach((btn) => {
          btn.classList.toggle(
            "is-active",
            btn.dataset.rangeValue === target,
          );
        });
        panels.forEach((panel) => {
          panel.hidden = panel.dataset.rangePanel !== target;
        });
        if (label) {
          label.textContent = target === "30" ? "近30天" : "近7天";
        }
      };
      buttons.forEach((btn) => {
        btn.addEventListener("click", () => {
          setRange(btn.dataset.rangeValue || "");
        });
      });
      setRange(card.dataset.rangeDefault || "7");
    });
  };

  const initUserCreateModal = () => {
    const modal = document.querySelector("[data-user-create-modal]");
    if (!modal) return;
    const openButtons = document.querySelectorAll("[data-user-create-open]");
    if (!openButtons.length) return;
    const form = modal.querySelector("form");
    const close = () => {
      modal.hidden = true;
    };
    modal.addEventListener("click", (event) => {
      const target = event.target;
      if (
        target &&
        (target.matches("[data-modal-close]") ||
          target.classList.contains("modal-backdrop"))
      ) {
        close();
      }
    });
    openButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        if (form) form.reset();
        modal.hidden = false;
      });
    });
  };

  const initBatchConfirm = () => {
    document.querySelectorAll("form[data-batch-form]").forEach((form) => {
      form.addEventListener("submit", (event) => {
        const action = form.querySelector("select[name='action']")?.value || "";
        const type = form.getAttribute("data-batch-form") || "";
        if (type === "share" && action === "hard_delete") {
          const ok = window.confirm("确定要批量彻底删除所选分享吗？该操作不可恢复。");
          if (!ok) event.preventDefault();
        }
        if (type === "user" && action === "delete") {
          const ok = window.confirm("确定要批量删除所选用户及其所有分享吗？该操作不可恢复。");
          if (!ok) event.preventDefault();
        }
      });
    });
  };

  const initReportModal = () => {
    const openButtons = document.querySelectorAll("[data-report-open]");
    if (!openButtons.length) return;
    const open = (modal) => {
      if (modal) modal.hidden = false;
    };
    const close = (modal) => {
      if (modal) modal.hidden = true;
    };
    openButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const targetId = btn.dataset.reportTarget || "";
        const modal = targetId
          ? document.getElementById(targetId)
          : document.querySelector("[data-report-modal]");
        open(modal);
      });
    });
    document.querySelectorAll("[data-report-modal]").forEach((modal) => {
      modal.addEventListener("click", (event) => {
        const target = event.target;
        if (
          target &&
          (target.closest("[data-modal-close]") ||
            target.classList.contains("modal-backdrop"))
        ) {
          close(modal);
        }
      });
    });
  };

  const initToggleSubmit = () => {
    document
      .querySelectorAll("input[data-toggle-input]")
      .forEach((input) => {
        input.addEventListener("change", () => {
          const form = input.closest("form");
          if (!form) return;
          const actionInput = form.querySelector("[data-toggle-action]");
          if (actionInput) {
            actionInput.value = input.checked ? "enable" : "disable";
          }
          form.submit();
        });
      });
  };

  const ensureToastStack = () => {
    let stack = document.querySelector(".toast-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "toast-stack";
      document.body.appendChild(stack);
    }
    return stack;
  };

  const showToast = (message, variant = "") => {
    if (!message) return;
    const stack = ensureToastStack();
    const toast = document.createElement("div");
    toast.className = "toast";
    if (variant) toast.classList.add(variant);
    toast.textContent = message;
    stack.appendChild(toast);
    setTimeout(() => {
      toast.classList.add("is-hidden");
      toast.addEventListener("transitionend", () => toast.remove(), {
        once: true,
      });
    }, 4200);
  };

  const initCommentEditors = () => {
    const editors = Array.from(document.querySelectorAll("[data-comment-editor]"));
    if (!editors.length) return;
    const insertAtCursor = (textarea, text) => {
      if (!textarea) return;
      const start = textarea.selectionStart || 0;
      const end = textarea.selectionEnd || 0;
      const value = textarea.value || "";
      textarea.value = value.slice(0, start) + text + value.slice(end);
      const pos = start + text.length;
      textarea.setSelectionRange(pos, pos);
      textarea.focus();
    };
    const closePanels = (except) => {
      editors.forEach((editor) => {
        const panel = editor.querySelector("[data-emoji-panel]");
        if (panel && panel !== except) panel.hidden = true;
      });
    };
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (target && target.closest("[data-comment-editor]")) return;
      closePanels();
    });
    editors.forEach((editor) => {
      const textarea = editor.querySelector("textarea");
      const emojiToggle = editor.querySelector("[data-emoji-toggle]");
      const emojiPanel = editor.querySelector("[data-emoji-panel]");
      const imageBtn = editor.querySelector("[data-image-insert]");
      const imageInput = editor.querySelector("[data-image-input]");
      const form = editor.closest("form");
      const uploadUrl =
        editor.closest("[data-comment-upload]")?.dataset.commentUpload || "";
      if (emojiToggle && emojiPanel) {
        emojiToggle.addEventListener("click", (event) => {
          event.preventDefault();
          const next = emojiPanel.hidden;
          closePanels(emojiPanel);
          emojiPanel.hidden = !next;
        });
      }
      if (emojiPanel) {
        emojiPanel.addEventListener("click", (event) => {
          const btn = event.target.closest("[data-emoji]");
          if (!btn) return;
          insertAtCursor(textarea, btn.dataset.emoji || "");
          emojiPanel.hidden = true;
        });
      }
      const uploadImage = async (file) => {
        if (!file) return;
        if (!uploadUrl) {
          showToast("无法上传图片", "error");
          return;
        }
        const csrf = form?.querySelector("input[name='csrf']")?.value || "";
        const body = new FormData();
        if (csrf) body.append("csrf", csrf);
        body.append("image", file);
        if (imageBtn) imageBtn.disabled = true;
        try {
          const resp = await fetch(uploadUrl, {method: "POST", body});
          const json = await resp.json().catch(() => null);
          if (!resp.ok || !json || json.code !== 0) {
            throw new Error(json?.msg || "图片上传失败");
          }
          const url = json?.data?.url || "";
          if (!url) {
            throw new Error("图片上传失败");
          }
          insertAtCursor(textarea, `![](${url})`);
        } catch (err) {
          showToast(err?.message || "图片上传失败", "error");
        } finally {
          if (imageBtn) imageBtn.disabled = false;
          if (imageInput) imageInput.value = "";
        }
      };
      if (imageBtn && imageInput) {
        imageBtn.addEventListener("click", () => {
          imageInput.click();
        });
        imageInput.addEventListener("change", () => {
          const file = imageInput.files?.[0];
          uploadImage(file);
        });
      }
    });
  };

  const initCommentModal = () => {
    const modal = document.querySelector("[data-comment-modal]");
    if (!modal) return;
    const form = modal.querySelector("[data-comment-form]");
    if (!form) return;
    const titleEl = modal.querySelector("[data-comment-modal-title]");
    const noteEl = modal.querySelector("[data-comment-modal-note]");
    const submitBtn = modal.querySelector("[data-comment-submit]");
    const emailInput = form.querySelector("input[name='email']");
    const captchaInput = form.querySelector("input[name='captcha']");
    const contentInput = form.querySelector("textarea[name='content']");
    const commentIdInput = form.querySelector("[data-comment-id]");
    const parentIdInput = form.querySelector("[data-comment-parent]");
    const verifyBlock = form.querySelector("[data-comment-verify]");
    const editorBlock = form.querySelector("[data-comment-editor-wrapper]");
    const actionBase = modal.dataset.commentActionBase || "";
    const docId = modal.dataset.commentDocId || "";
    const ownerDelete = modal.dataset.commentOwner === "1";
    const defaultEmail = modal.dataset.commentDefaultEmail || "";
    const refreshModalCaptcha = () => {
      const img = modal.querySelector("img[data-captcha]");
      if (img) refreshCaptcha(img);
    };
    const setRequired = (field, required) => {
      if (!field) return;
      if (required) {
        field.setAttribute("required", "");
      } else {
        field.removeAttribute("required");
      }
    };
    const open = (mode, dataset) => {
      if (!actionBase) return;
      modal.hidden = false;
      refreshModalCaptcha();
      const maskedEmail = dataset.commentEmail || "";
      if (mode === "reply") {
        if (titleEl) titleEl.textContent = "回复评论";
        if (noteEl)
          noteEl.textContent = maskedEmail ? `回复 ${maskedEmail}` : "回复评论";
        if (submitBtn) submitBtn.textContent = "发布回复";
        form.action = `${actionBase}/comment`;
        if (commentIdInput) commentIdInput.value = "";
        if (parentIdInput) parentIdInput.value = dataset.commentParentId || "";
        if (emailInput) emailInput.value = defaultEmail;
        if (captchaInput) captchaInput.value = "";
        if (contentInput) contentInput.value = "";
        if (verifyBlock) verifyBlock.hidden = false;
        if (editorBlock) editorBlock.hidden = false;
        setRequired(contentInput, true);
        setRequired(emailInput, true);
        setRequired(captchaInput, true);
      } else if (mode === "edit") {
        if (titleEl) titleEl.textContent = "编辑评论";
        if (noteEl)
          noteEl.textContent = maskedEmail
            ? `邮箱验证：${maskedEmail}`
            : "邮箱验证";
        if (submitBtn) submitBtn.textContent = "保存修改";
        form.action = `${actionBase}/comment/edit`;
        if (commentIdInput) commentIdInput.value = dataset.commentId || "";
        if (parentIdInput) parentIdInput.value = "";
        if (emailInput) emailInput.value = "";
        if (captchaInput) captchaInput.value = "";
        if (contentInput) contentInput.value = dataset.commentContent || "";
        if (verifyBlock) verifyBlock.hidden = false;
        if (editorBlock) editorBlock.hidden = false;
        setRequired(contentInput, true);
        setRequired(emailInput, true);
        setRequired(captchaInput, true);
      } else if (mode === "delete") {
        if (titleEl) titleEl.textContent = "删除评论";
        if (noteEl)
          noteEl.textContent = maskedEmail
            ? `确认删除该评论（${maskedEmail}）？`
            : "确认删除该评论？";
        if (submitBtn) submitBtn.textContent = "确认删除";
        form.action = `${actionBase}/comment/delete`;
        if (commentIdInput) commentIdInput.value = dataset.commentId || "";
        if (parentIdInput) parentIdInput.value = "";
        if (contentInput) contentInput.value = "";
        const skipVerify = ownerDelete || dataset.commentOwner === "1";
        if (verifyBlock) verifyBlock.hidden = skipVerify;
        if (editorBlock) editorBlock.hidden = true;
        setRequired(contentInput, false);
        setRequired(emailInput, !skipVerify);
        setRequired(captchaInput, !skipVerify);
      }
      if (noteEl) {
        noteEl.hidden = !noteEl.textContent;
      }
      if (docId) {
        const docInput = form.querySelector("[data-comment-doc]");
        if (docInput) docInput.value = docId;
      }
    };
    const close = () => {
      modal.hidden = true;
    };
    modal.addEventListener("click", (event) => {
      const target = event.target;
      if (
        target &&
        (target.closest("[data-modal-close]") ||
          target.classList.contains("modal-backdrop"))
      ) {
        close();
      }
    });
    document.querySelectorAll("[data-comment-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.commentAction || "";
        if (!mode) return;
        const details = btn.closest("details");
        if (details) details.open = false;
        open(mode, btn.dataset);
      });
    });
    if (modal.dataset.commentReopen === "1") {
      const mode = modal.dataset.commentReopenMode || "reply";
      const dataset = {
        commentParentId: modal.dataset.commentReopenParent || "",
        commentEmail: modal.dataset.commentReopenNote || "",
      };
      open(mode, dataset);
      const reopenEmail = modal.dataset.commentReopenEmail || "";
      const reopenContent = modal.dataset.commentReopenContent || "";
      if (emailInput && reopenEmail) emailInput.value = reopenEmail;
      if (contentInput && reopenContent) contentInput.value = reopenContent;
    }
  };

  const initAdminCommentModal = () => {
    const modal = document.querySelector("[data-admin-comment-modal]");
    if (!modal) return;
    const form = modal.querySelector("[data-admin-comment-form]");
    if (!form) return;
    const idInput = form.querySelector("[data-admin-comment-id]");
    const contentInput = form.querySelector("[data-admin-comment-content]");
    const noteEl = modal.querySelector("[data-admin-comment-note]");
    const close = () => {
      modal.hidden = true;
    };
    const open = (dataset) => {
      modal.hidden = false;
      if (idInput) idInput.value = dataset.adminCommentId || "";
      if (contentInput) contentInput.value = dataset.adminCommentContent || "";
      const noteParts = [];
      const share = dataset.adminCommentShare || "";
      const email = dataset.adminCommentEmail || "";
      const created = dataset.adminCommentCreated || "";
      if (share) noteParts.push(`分享：${share}`);
      if (email) noteParts.push(`邮箱：${email}`);
      if (created) noteParts.push(`时间：${created}`);
      if (noteEl) {
        noteEl.textContent = noteParts.join(" / ");
        noteEl.hidden = !noteEl.textContent;
      }
      if (contentInput) contentInput.focus();
    };
    modal.addEventListener("click", (event) => {
      const target = event.target;
      if (
        target &&
        (target.closest("[data-modal-close]") ||
          target.classList.contains("modal-backdrop"))
      ) {
        close();
      }
    });
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!target) return;
      const trigger = target.closest("[data-admin-comment-edit]");
      if (!trigger) return;
      event.preventDefault();
      open(trigger.dataset);
    });
  };

  const initFormConfirm = () => {
    document.querySelectorAll("form[data-confirm-message]").forEach((form) => {
      form.addEventListener("submit", (event) => {
        const message = form.getAttribute("data-confirm-message");
        if (message && !window.confirm(message)) {
          event.preventDefault();
        }
      });
    });
  };

  const initPaginationAutoSubmit = () => {
    document.querySelectorAll(".pagination-form select").forEach((select) => {
      select.addEventListener("change", () => {
        const form = select.closest("form");
        if (form) form.submit();
      });
    });
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
      toast.classList.remove("report-flash");
      toast.classList.remove("comment-flash");
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

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const getImageSrc = (img) =>
      img.getAttribute("data-src") || img.currentSrc || img.src || "";

    const collectImages = () =>
      Array.from(
        document.querySelectorAll(".markdown-body img, .comment-content img"),
      ).filter((img) => !img.closest(".image-viewer"));

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
            <button class="image-viewer-btn" type="button" data-viewer-zoom-out aria-label="缩小">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 12h12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
            <span class="image-viewer-zoom" data-viewer-zoom>100%</span>
            <button class="image-viewer-btn" type="button" data-viewer-zoom-in aria-label="放大">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 6v12M6 12h12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
            <a class="image-viewer-btn" data-viewer-download download>下载</a>
            <button class="image-viewer-btn" type="button" data-viewer-close>关闭</button>
          </div>
          <div class="image-viewer-stage" data-viewer-stage>
            <img class="image-viewer-img" data-viewer-img alt="">
            <button class="image-viewer-nav prev" type="button" data-viewer-prev aria-label="上一张">‹</button>
            <button class="image-viewer-nav next" type="button" data-viewer-next aria-label="下一张">›</button>
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
    const download = viewer.querySelector("[data-viewer-download]");
    const prevBtn = viewer.querySelector("[data-viewer-prev]");
    const nextBtn = viewer.querySelector("[data-viewer-next]");
    const thumbs = viewer.querySelector("[data-viewer-thumbs]");
    const count = viewer.querySelector("[data-viewer-count]");

    if (image) {
      image.setAttribute("draggable", "false");
    }
    if (thumbs) {
      thumbs.addEventListener("click", (event) => event.stopPropagation());
      thumbs.addEventListener("pointerdown", (event) => event.stopPropagation());
    }

    let items = [];
    let index = 0;
    let scale = 1;
    let translateX = 0;
    let translateY = 0;
    let isDragging = false;
    let dragMoved = false;
    let suppressClickUntil = 0;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragOriginX = 0;
    let dragOriginY = 0;

    const updateZoomLabel = () => {
      if (zoomLabel) zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    };

    const applyTransform = () => {
      if (!image) return;
      image.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
      updateZoomLabel();
    };

    const clampTranslation = () => {
      if (!stage || !image) return;
      const stageRect = stage.getBoundingClientRect();
      const imgRect = image.getBoundingClientRect();
      const baseWidth = imgRect.width / Math.max(scale, 0.01);
      const baseHeight = imgRect.height / Math.max(scale, 0.01);
      const scaledWidth = baseWidth * scale;
      const scaledHeight = baseHeight * scale;
      const maxX = Math.max(0, (scaledWidth - stageRect.width) / 2);
      const maxY = Math.max(0, (scaledHeight - stageRect.height) / 2);
      translateX = clamp(translateX, -maxX, maxX);
      translateY = clamp(translateY, -maxY, maxY);
    };

    const setScale = (nextScale) => {
      scale = clamp(nextScale, 0.5, 3);
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
      applyTransform();
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
      image.src = src;
      image.alt = item.alt || "";
      if (download) download.href = src;
      if (count) count.textContent = `${index + 1} / ${items.length}`;
      updateNav();
      updateThumbs();
      image.onload = () => {
        resetZoom();
      };
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
      viewer.hidden = false;
      document.body.classList.add("image-viewer-open");
      updateView();
    };

    const closeViewer = () => {
      viewer.hidden = true;
      document.body.classList.remove("image-viewer-open");
    };

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!target) return;
      const img = target.closest("img");
      if (!img) return;
      if (img.closest(".image-viewer")) return;
      if (!img.matches(".markdown-body img, .comment-content img")) return;
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

    const startDrag = (event) => {
      if (!stage || scale <= 1) return;
      const target = event.target;
      if (target && target.closest(".image-viewer-nav")) return;
      if (target && target.closest(".image-viewer-actions")) return;
      if (event.button !== undefined && event.button !== 0) return;
      isDragging = true;
      dragMoved = false;
      dragStartX = event.clientX;
      dragStartY = event.clientY;
      dragOriginX = translateX;
      dragOriginY = translateY;
      stage.classList.add("is-dragging");
      if (stage.setPointerCapture) {
        stage.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
    };

    const onDrag = (event) => {
      if (!isDragging) return;
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

    const endDrag = (event) => {
      if (!isDragging) return;
      isDragging = false;
      if (stage) stage.classList.remove("is-dragging");
      if (stage && stage.releasePointerCapture) {
        stage.releasePointerCapture(event.pointerId);
      }
      if (dragMoved) {
        suppressClickUntil = Date.now() + 320;
      }
    };

    if (stage) {
      stage.addEventListener("pointerdown", startDrag);
    }
    window.addEventListener("pointermove", onDrag);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);

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

  const initScanProgress = () => {
    const form = document.querySelector("[data-scan-form]");
    const wrapper = document.querySelector("[data-scan-progress]");
    if (!form || !wrapper) return;
    const bar = wrapper.querySelector("[data-scan-bar]");
    const status = wrapper.querySelector("[data-scan-status]");
    const log = wrapper.querySelector("[data-scan-log]");
    const submitBtn = form.querySelector("button[type='submit']");
    const csrf = form.querySelector("input[name='csrf']")?.value || "";
    const logQueue = [];
    let logTimer = null;
    let doneMessage = "";
    let autoRefreshTimer = null;
    const post = async (url, payload) => {
      const body = new URLSearchParams(payload).toString();
      const resp = await fetch(url, {
        method: "POST",
        headers: {"Content-Type": "application/x-www-form-urlencoded"},
        body,
      });
      const json = await resp.json().catch(() => null);
      if (!resp.ok || !json || json.code !== 0) {
        throw new Error(json?.msg || "扫描请求失败");
      }
      return json.data || {};
    };

    const finalizeScan = () => {
      if (!doneMessage || logQueue.length || logTimer || autoRefreshTimer) return;
      if (status) status.textContent = doneMessage;
      doneMessage = "";
      autoRefreshTimer = setTimeout(() => {
        const url = new URL(window.location.href);
        url.searchParams.set("scan_keep", "1");
        url.hash = "scan";
        window.location.href = url.toString();
      }, 800);
    };

    const stripScanKeep = () => {
      const url = new URL(window.location.href);
      if (!url.searchParams.has("scan_keep")) return;
      url.searchParams.delete("scan_keep");
      const qs = url.searchParams.toString();
      const next = url.pathname + (qs ? `?${qs}` : "") + url.hash;
      window.history.replaceState(null, "", next);
    };

    const appendLogs = (logs) => {
      if (!log || !Array.isArray(logs) || !logs.length) return;
      logQueue.push(...logs);
      if (logTimer) return;
      const flush = () => {
        if (!logQueue.length || !log) {
          logTimer = null;
          finalizeScan();
          return;
        }
        const msg = logQueue.shift();
        const row = document.createElement("div");
        row.innerHTML = msg;
        log.appendChild(row);
        log.scrollTop = log.scrollHeight;
        logTimer = setTimeout(flush, 40);
      };
      flush();
    };

    stripScanKeep();

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      wrapper.hidden = false;
      if (log) log.innerHTML = "";
      logQueue.length = 0;
      if (logTimer) {
        clearTimeout(logTimer);
        logTimer = null;
      }
      if (status) status.textContent = "初始化扫描...";
      if (bar) bar.style.width = "0%";
      if (submitBtn) submitBtn.disabled = true;
      doneMessage = "";
      if (autoRefreshTimer) {
        clearTimeout(autoRefreshTimer);
        autoRefreshTimer = null;
      }

      try {
        const start = await post(form.action.replace(/\/scan$/, "/scan/start"), {
          csrf,
        });
        let offset = 0;
        const total = Number(start.total || 0);
        const limit = 50;
        while (true) {
          const step = await post(
            form.action.replace(/\/scan$/, "/scan/step"),
            {csrf, offset, limit},
          );
          offset = Number(step.nextOffset || offset);
          const progress = total > 0 ? Math.min(100, Math.round((offset / total) * 100)) : 100;
          if (bar) bar.style.width = `${progress}%`;
          if (status) {
            status.textContent = `扫描中：${offset}/${total || "-"} (${progress}%)`;
          }
          if (step.done) {
            doneMessage = `扫描完成，共命中 ${step.hitCount || 0} 条记录`;
          }
          appendLogs(step.logs || []);
          if (step.done) break;
        }
        finalizeScan();
      } catch (err) {
        if (status) status.textContent = err?.message || "扫描失败";
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  };

  const initMarkdown = () => {
    if (
      typeof window.markdownit !== "function" ||
      !window.markdownit.prototype ||
      typeof window.markdownit.prototype.render !== "function"
    ) {
      return;
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

      md.core.ruler.after("block", "siyuan_callout", (state) => {
        const tokens = state.tokens;
        tokens.forEach((token, index) => {
          if (token.type !== "blockquote_open") return;
          let inline = null;
          for (let i = index + 1; i < tokens.length; i += 1) {
            if (tokens[i].type === "inline") {
              inline = tokens[i];
              break;
            }
            if (tokens[i].type === "blockquote_close") break;
          }
          if (!inline) return;
          const match = String(inline.content || "").match(calloutPattern);
          if (!match) return;
          const typeKey = match[1].toLowerCase();
          const classKey = calloutClassMap[typeKey] || "note";
          const meta = calloutMetaMap[classKey] || calloutMetaMap.note;
          token.attrJoin("class", "md-alert");
          token.attrJoin("class", `md-alert--${classKey}`);
          inline.content = inline.content.replace(calloutPattern, "");
          if (Array.isArray(inline.children)) {
            let removed = false;
            inline.children.forEach((child) => {
              if (removed || child.type !== "text") return;
              const next = child.content.replace(calloutPattern, "");
              child.content = next;
              removed = true;
            });
          }
          const TitleToken = state.Token || md.Token;
          if (TitleToken) {
            const titleToken = new TitleToken("html_block", "", 0);
            titleToken.content =
              `<div class="md-alert__title"><span class="md-alert__icon">${meta.icon}</span>` +
              `<span class="md-alert__label">${meta.label}</span></div>\n`;
            tokens.splice(index + 1, 0, titleToken);
          }
        });
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
    usePlugin(window.markdownitMultimdTable);
    usePlugin(window.markdownItAnchor || window.markdownitAnchor, {permalink: false});
    registerCalloutSupport();

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
    const PLANTUML_SERVER = "https://plantuml.com/plantuml";
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
        const chartEl = document.createElement("div");
        chartEl.className = "md-echarts";
        wrapper.appendChild(chartEl);
        replaceCodeBlock(code, wrapper);
        try {
          const chart = window.echarts.init(chartEl);
          chart.setOption(option, true);
          chartInstances.push(chart);
          bindChartResize();
        } catch {
          wrapper.textContent = "ECharts render failed.";
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

    const encodePlantUmlData = (deflated) => {
      if (!deflated || !deflated.length) return "";
      const encode6bit = (b) => {
        if (b < 10) return String.fromCharCode(48 + b);
        b -= 10;
        if (b < 26) return String.fromCharCode(65 + b);
        b -= 26;
        if (b < 26) return String.fromCharCode(97 + b);
        b -= 26;
        if (b === 0) return "-";
        if (b === 1) return "_";
        return "?";
      };
      const append3bytes = (b1, b2, b3) => {
        const c1 = b1 >> 2;
        const c2 = ((b1 & 0x3) << 4) | (b2 >> 4);
        const c3 = ((b2 & 0xf) << 2) | (b3 >> 6);
        const c4 = b3 & 0x3f;
        return (
          encode6bit(c1 & 0x3f) +
          encode6bit(c2 & 0x3f) +
          encode6bit(c3 & 0x3f) +
          encode6bit(c4 & 0x3f)
        );
      };
      let result = "";
      for (let i = 0; i < deflated.length; i += 3) {
        if (i + 2 === deflated.length) {
          result += append3bytes(deflated[i], deflated[i + 1], 0);
        } else if (i + 1 === deflated.length) {
          result += append3bytes(deflated[i], 0, 0);
        } else {
          result += append3bytes(deflated[i], deflated[i + 1], deflated[i + 2]);
        }
      }
      return result;
    };

    const toUtf8Bytes = (input) => {
      if (typeof TextEncoder !== "undefined") {
        return new TextEncoder().encode(input);
      }
      const encoded = unescape(encodeURIComponent(input));
      const bytes = new Uint8Array(encoded.length);
      for (let i = 0; i < encoded.length; i += 1) {
        bytes[i] = encoded.charCodeAt(i);
      }
      return bytes;
    };

    const deflateWithPako = (bytes) => {
      if (!window.pako || typeof window.pako.deflate !== "function") return null;
      try {
        return window.pako.deflate(bytes, {level: 9});
      } catch {
        return null;
      }
    };

    const encodePlantUmlHex = (source) => {
      const input = String(source || "");
      if (!input.trim()) return "";
      const bytes = toUtf8Bytes(input);
      let hex = "";
      bytes.forEach((b) => {
        hex += b.toString(16).padStart(2, "0");
      });
      return `~h${hex}`;
    };

    const deflateWithStream = async (bytes) => {
      if (typeof CompressionStream !== "function") return null;
      try {
        const stream = new CompressionStream("deflate");
        const writer = stream.writable.getWriter();
        await writer.write(bytes);
        await writer.close();
        const buffer = await new Response(stream.readable).arrayBuffer();
        return new Uint8Array(buffer);
      } catch {
        return null;
      }
    };

    const encodePlantUmlSync = (source) => {
      const input = String(source || "");
      if (!input.trim()) return "";
      const bytes = toUtf8Bytes(input);
      const deflated = deflateWithPako(bytes);
      if (!deflated) return "";
      return encodePlantUmlData(deflated);
    };

    const encodePlantUmlAsync = async (source) => {
      const input = String(source || "");
      if (!input.trim()) return "";
      const bytes = toUtf8Bytes(input);
      let deflated = deflateWithPako(bytes);
      if (!deflated) {
        deflated = await deflateWithStream(bytes);
      }
      if (!deflated) return "";
      return encodePlantUmlData(deflated);
    };

    const renderPlantUml = (container) => {
      container.querySelectorAll("pre code").forEach((code) => {
        const lang = getLanguage(code);
        if (!["plantuml", "puml", "uml"].includes(lang)) return;
        const source = code.textContent || "";
        const hexFallback = encodePlantUmlHex(source);
        if (!hexFallback) return;
        if (!code.isConnected) return;
        const wrapper = document.createElement("div");
        wrapper.className = "md-diagram md-diagram--plantuml";
        const img = document.createElement("img");
        img.loading = "lazy";
        img.alt = "PlantUML diagram";
        img.src = `${PLANTUML_SERVER}/svg/${hexFallback}`;
        wrapper.appendChild(img);
        replaceCodeBlock(code, wrapper);

        const encodedSync = encodePlantUmlSync(source);
        if (encodedSync) {
          img.src = `${PLANTUML_SERVER}/svg/${encodedSync}`;
          return;
        }
        encodePlantUmlAsync(source).then((encodedAsync) => {
          if (encodedAsync) {
            img.src = `${PLANTUML_SERVER}/svg/${encodedAsync}`;
          }
        });
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

      const fallbackMermaidImage = (block) => {
        const source = block.dataset.mermaidSource || block.textContent || "";
        if (!source.trim()) return;
        let encoded = "";
        try {
          encoded = btoa(unescape(encodeURIComponent(source)));
        } catch {
          return;
        }
        const wrapper = document.createElement("div");
        wrapper.className = "md-diagram md-diagram--mermaid";
        const img = document.createElement("img");
        img.loading = "lazy";
        img.alt = "Mermaid diagram";
        img.src = `https://mermaid.ink/svg/${encoded}`;
        wrapper.appendChild(img);
        block.replaceWith(wrapper);
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
            fallbackMermaidImage(block);
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
                  fallbackMermaidImage(block);
                  return;
                }
                applySvg(res.svg, res.bindFunctions);
              })
              .catch(() => fallbackMermaidImage(block));
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
          fallbackMermaidImage(block);
        } catch {
          fallbackMermaidImage(block);
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
        uniqueBlocks.forEach((block) => fallbackMermaidImage(block));
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
        copyBtn.setAttribute("aria-label", "复制");
        copyBtn.setAttribute("data-tooltip", "复制");
        copyBtn.innerHTML =
          "<svg class=\"code-copy-icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\">" +
          "<rect x=\"9\" y=\"9\" width=\"10\" height=\"12\" rx=\"2\" ry=\"2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"></rect>" +
          "<path d=\"M5 15V5a2 2 0 0 1 2-2h10\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"></path>" +
          "</svg>";
        copyBtn.addEventListener("click", async () => {
          const success = await writeClipboardText(raw);
          if (success) {
            copyBtn.setAttribute("data-tooltip", "已复制");
            copyBtn.classList.add("is-copied");
            setTimeout(() => {
              copyBtn.setAttribute("data-tooltip", "复制");
              copyBtn.classList.remove("is-copied");
            }, 1500);
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
        if (el.tagName.toLowerCase() === "svg" && el.ownerSVGElement) return;
        const wrapper = document.createElement("div");
        wrapper.className = "media-scroll";
        const parent = el.parentNode;
        if (!parent) return;
        parent.insertBefore(wrapper, el);
        wrapper.appendChild(el);
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
        target.innerHTML = md.render(raw);
        renderMindmap(target);
        renderEcharts(target);
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
      });
  };

  initAnnouncementModal();
  initNav();
  initRangeSwitch();
  initKnowledgeTree();
  initDocTreeScroll();
  initBatchSelection();
  initUserModal();
  initUserCreateModal();
  initBatchConfirm();
  initReportModal();
  initToggleSubmit();
  initFormConfirm();
  initPaginationAutoSubmit();
  initFlashToast();
  initCommentEditors();
  initCommentModal();
  initAdminCommentModal();
  initScanProgress();
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
  initImageViewer();
  initShareSidebarTabs();
  initShareDrawer();
  initShareMarkdownToggle();
  initAppDrawer();
  initScrollTop();
  initLoginTabs();
  initCountdownButtons();
})();
