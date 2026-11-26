(() => {
  "use strict";

  const dataNode = document.getElementById("sps-celebration-data");
  if (!dataNode) return;

  let config;
  try {
    config = JSON.parse(dataNode.textContent || "null");
  } catch (_) {
    return;
  }
  if (!config || typeof config !== "object" || !config.storageKey || !config.cookieName) return;

  const isPreview = Boolean(config.preview);
  const readCookie = (name) => {
    const raw = document.cookie || "";
    if (!raw) return "";
    const prefix = `${name}=`;
    const parts = raw.split("; ");
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(prefix)) {
        return parts[i].slice(prefix.length);
      }
    }
    return "";
  };

  const hasSeen = () => {
    if (isPreview) return false;
    try {
      if (window.localStorage?.getItem(config.storageKey) === "1") return true;
    } catch (_) {}
    return readCookie(config.cookieName) === "1";
  };

  const markSeen = () => {
    if (isPreview) return;
    try {
      window.localStorage?.setItem(config.storageKey, "1");
    } catch (_) {}
    const maxAge = Number.isFinite(Number(config.cookieMaxAge)) && Number(config.cookieMaxAge) > 0
      ? Math.floor(Number(config.cookieMaxAge))
      : 1209600;
    const secure = window.location?.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${config.cookieName}=1; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
  };

  if (hasSeen()) return;

  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const isCoarsePointer = Boolean(window.matchMedia?.("(pointer: coarse)")?.matches);

  const overlay = document.createElement("div");
  overlay.className = "sps-celebration-overlay has-backdrop";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "sps-celebration-title");
  overlay.setAttribute("data-sps-celebration", "1");

  const veil = document.createElement("div");
  veil.className = "sps-celebration-veil";
  veil.setAttribute("aria-hidden", "true");

  const canvas = document.createElement("canvas");
  canvas.className = "sps-celebration-canvas";
  canvas.setAttribute("aria-hidden", "true");

  // Phase 2: Announcement card (strictly English)
  const card = document.createElement("div");
  card.className = "sps-celebration-card";
  card.setAttribute("tabindex", "-1");
  card.hidden = true;
  card.innerHTML =
    '<div class="sps-celebration-badge">' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M12 3l1.9 5.8L20 10.7l-5.1 3.7 1.9 5.9L12 16.7l-4.8 3.6 1.9-5.9L4 10.7l6.1-1.9z"/>' +
      "</svg>" +
      "<span>Site Update</span>" +
    "</div>" +
    '<h2 class="sps-celebration-title" id="sps-celebration-title">Notes Site Updated</h2>' +
    '<p class="sps-celebration-desc">After a month of updates, the notes site is now complete. Welcome to explore.</p>' +
    '<div class="sps-celebration-actions">' +
      '<button type="button" class="sps-celebration-btn sps-celebration-btn--continue" data-celebration-continue>Continue (shown once)</button>' +
      '<button type="button" class="sps-celebration-btn sps-celebration-btn--changelog" data-celebration-changelog>View changelog</button>' +
    "</div>";

  // Phase 3: Bilingual Markdown changelog box + bottom-edge dismiss hint
  const changelogWrap = document.createElement("div");
  changelogWrap.className = "sps-celebration-changelog-wrap";
  changelogWrap.hidden = true;

  const changelogBox = document.createElement("div");
  changelogBox.className = "sps-celebration-changelog-box";

  const changelogHeader = document.createElement("div");
  changelogHeader.className = "sps-celebration-changelog-header";
  const changelogHeading = document.createElement("h2");
  changelogHeading.id = "sps-celebration-changelog-title";
  changelogHeading.textContent = "Changelog";
  const changelogRange = document.createElement("span");
  changelogRange.className = "sps-celebration-changelog-range";
  changelogRange.textContent = String(config.range || "2026-10-22 – 2026-11-26");
  changelogHeader.append(changelogHeading, changelogRange);

  const changelogBody = document.createElement("div");
  changelogBody.className = "sps-celebration-changelog-body";
  changelogBody.setAttribute("tabindex", "0");

  const zhSection = document.createElement("section");
  zhSection.className = "sps-celebration-md";
  zhSection.setAttribute("lang", "zh-CN");
  zhSection.innerHTML = String(config.changelogZhHtml || "");

  const langSep = document.createElement("div");
  langSep.className = "sps-celebration-lang-sep";
  langSep.setAttribute("role", "separator");
  const langLabel = document.createElement("span");
  langLabel.textContent = "English";
  langSep.append(langLabel);

  const enSection = document.createElement("section");
  enSection.className = "sps-celebration-md";
  enSection.setAttribute("lang", "en");
  enSection.innerHTML = String(config.changelogEnHtml || "");

  changelogBody.append(zhSection, langSep, enSection);
  changelogBox.append(changelogHeader, changelogBody);

  const dismissHint = document.createElement("div");
  dismissHint.className = "sps-celebration-dismiss-hint";
  dismissHint.setAttribute("data-celebration-dismiss-hint", "1");
  dismissHint.textContent = isCoarsePointer
    ? "Tap anywhere outside to continue"
    : "Click anywhere outside to continue";

  changelogWrap.append(changelogBox, dismissHint);
  overlay.append(veil, canvas, card, changelogWrap);

  const btnContinue = card.querySelector("[data-celebration-continue]");
  const btnChangelog = card.querySelector("[data-celebration-changelog]");

  // Background isolation & focus management
  const previousFocus = document.activeElement;
  const isolated = [...document.body.children]
    .filter((node) => node !== overlay && !["SCRIPT", "STYLE", "LINK"].includes(node.tagName))
    .map((node) => [node, Boolean(node.inert)]);
  isolated.forEach(([node]) => {
    node.inert = true;
  });

  document.documentElement.classList.add("sps-celebration-open");
  document.body.append(overlay);

  // Restrained 3-Hue Celestial Palette
  const C_WHITE = [244, 248, 255];
  const C_BLUE_ICE = [136, 192, 255];
  const C_BLUE_SOFT = [192, 222, 255];
  const C_GOLD = [245, 208, 126];
  const C_IVORY = [253, 236, 188];
  const BG_STAR_COLORS = [C_WHITE, C_BLUE_SOFT, C_IVORY];

  let ctx = null;
  try {
    ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
  } catch (_) {
    ctx = null;
  }

  let phase = "idle"; // celebrating | prompt | changelog | dismissed
  let rafId = 0;
  let timers = [];
  let hasPointerDown = false;
  let pointerDownOutside = false;
  let stageW = 0;
  let stageH = 0;
  let isMobile = false;
  let animStartTime = 0;
  let lastFrameTime = 0;
  let canvasFading = false;

  let bgStars = [];
  let flares = [];
  let coreBlooms = [];
  let rings = [];
  let sparks = [];
  let embers = [];
  let shootingStar = null;

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

  const scheduleTimer = (fn, ms) => {
    const id = window.setTimeout(fn, ms);
    timers.push(id);
    return id;
  };

  const clearTimers = () => {
    for (let i = 0; i < timers.length; i++) {
      window.clearTimeout(timers[i]);
    }
    timers = [];
  };

  const stopCanvas = () => {
    if (rafId) {
      window.cancelAnimationFrame?.(rafId);
      rafId = 0;
    }
    canvasFading = false;
    bgStars = [];
    flares = [];
    coreBlooms = [];
    rings = [];
    sparks = [];
    embers = [];
    shootingStar = null;
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    canvas.width = 0;
    canvas.height = 0;
  };

  const resizeCanvas = () => {
    const w = Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0, 320);
    const h = Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0, 320);
    stageW = w;
    stageH = h;
    isMobile = w <= 640;
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const spawnWillowShell = (cx, cy, count, speedMin, speedMax, paletteColors, isInnerShell) => {
    const mobileScale = isMobile ? 0.76 : 1;
    const distanceBoost = clamp(Math.min(stageW, stageH) / 560, 0.9, 1.38);
    for (let i = 0; i < count; i++) {
      const baseAngle = (Math.PI * 2 * i) / count;
      const angle = baseAngle + (Math.random() - 0.5) * 0.22;
      const speed = (speedMin + Math.random() * (speedMax - speedMin)) * mobileScale * distanceBoost;
      const rgb = paletteColors[Math.floor(Math.random() * paletteColors.length)];
      const hasCross = isInnerShell ? true : Math.random() < 0.35;
      sparks.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - (isInnerShell ? 0.15 : 0.25),
        trail: [[cx, cy]],
        rgb,
        maxAlpha: isInnerShell ? 0.72 + Math.random() * 0.06 : 0.64 + Math.random() * 0.14,
        width: isInnerShell ? 1.2 : 1.08 + Math.random() * 0.45,
        drag: isInnerShell ? 0.948 : 0.956,
        gravity: isInnerShell ? 0.032 : 0.044,
        life: 0,
        maxLife: isInnerShell ? 1150 + Math.random() * 320 : 1280 + Math.random() * 360,
        hasCross,
        crossArm: isInnerShell ? (isMobile ? 5.2 : 6.4) : (isMobile ? 4.4 : 5.5),
        twinklePhase: Math.random() * Math.PI * 2,
      });
    }
  };

  const triggerBloom = (flare) => {
    const cx = flare.endX * stageW;
    const cy = flare.endY * stageH;
    const mobileCountFactor = isMobile ? 0.68 : 1;

    if (flare.kind === "left-blue") {
      coreBlooms.push({ x: cx, y: cy, maxR: isMobile ? 44 : 62, rgb: C_BLUE_ICE, alpha: 0.25, life: 0, duration: 280 });
      rings.push({ x: cx, y: cy, maxR: isMobile ? 66 : 96, rgb: C_BLUE_SOFT, alpha: 0.36, life: 0, duration: 420 });
      spawnWillowShell(cx, cy, isMobile ? 18 : 26, 2.4, 4.2, [C_BLUE_ICE, C_BLUE_SOFT, C_WHITE], false);
    } else if (flare.kind === "right-gold") {
      coreBlooms.push({ x: cx, y: cy, maxR: isMobile ? 44 : 62, rgb: C_GOLD, alpha: 0.24, life: 0, duration: 280 });
      rings.push({ x: cx, y: cy, maxR: isMobile ? 66 : 96, rgb: C_IVORY, alpha: 0.35, life: 0, duration: 420 });
      spawnWillowShell(cx, cy, isMobile ? 18 : 26, 2.4, 4.2, [C_GOLD, C_IVORY, C_WHITE], false);
    } else if (flare.kind === "center-grand") {
      coreBlooms.push({ x: cx, y: cy, maxR: isMobile ? 58 : 84, rgb: C_BLUE_SOFT, alpha: 0.26, life: 0, duration: 300 });
      rings.push({ x: cx, y: cy, maxR: isMobile ? 88 : 132, rgb: C_WHITE, alpha: 0.38, life: 0, duration: 440 });
      spawnWillowShell(cx, cy, Math.round(34 * mobileCountFactor) || 24, 3.2, 5.2, [C_BLUE_ICE, C_BLUE_SOFT, C_WHITE], false);
      spawnWillowShell(cx, cy, isMobile ? 12 : 18, 1.3, 2.6, [C_GOLD, C_IVORY], true);
    }
  };

  const initScene = () => {
    const cols = isMobile ? 9 : 10;
    const rows = isMobile ? 4 : 6;
    const cells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        cells.push([c, r]);
      }
    }
    if (!isMobile && cells.length > 58) {
      cells.splice(59, 1);
      cells.splice(50, 1);
    }

    bgStars = cells.map(([c, r]) => ({
      nx: (c + 0.14 + Math.random() * 0.72) / cols,
      ny: (r + 0.12 + Math.random() * 0.76) / rows,
      radius: 0.55 + Math.random() * 0.85,
      rgb: BG_STAR_COLORS[Math.floor(Math.random() * BG_STAR_COLORS.length)],
      baseAlpha: 0.28 + Math.random() * 0.42,
      phase: Math.random() * Math.PI * 2,
      delay: Math.random() * 320,
      fadeDuration: 240 + Math.random() * 180,
      driftSpeed: 0.012 / Math.max(stageH, 320),
    }));

    flares = [
      {
        kind: "left-blue",
        start: 40,
        duration: 480,
        startX: 0.22, startY: 0.98,
        ctrlX: 0.23, ctrlY: 0.62,
        endX: 0.27, endY: 0.34,
        rgb: C_BLUE_ICE,
        trail: [],
        bloomed: false,
        nextEmberT: 0.22,
      },
      {
        kind: "right-gold",
        start: 300,
        duration: 480,
        startX: 0.78, startY: 0.98,
        ctrlX: 0.77, ctrlY: 0.58,
        endX: 0.73, endY: 0.31,
        rgb: C_GOLD,
        trail: [],
        bloomed: false,
        nextEmberT: 0.22,
      },
      {
        kind: "center-grand",
        start: 540,
        duration: 520,
        startX: 0.50, startY: 0.99,
        ctrlX: 0.494, ctrlY: 0.58,
        endX: 0.50, endY: 0.28,
        rgb: C_BLUE_SOFT,
        trail: [],
        bloomed: false,
        nextEmberT: 0.20,
      },
    ];

    coreBlooms = [];
    rings = [];
    sparks = [];
    embers = [];

    shootingStar = {
      start: 1480,
      duration: 680,
      startX: 0.84, startY: 0.12,
      endX: 0.56, endY: 0.25,
      peakAlpha: 0.52,
      width: 1.25,
      tailRatio: 0.26,
    };
  };

  const drawCrossGleam = (x, y, arm, rgb, alpha) => {
    if (alpha <= 0.01 || arm <= 0.5) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha.toFixed(4)})`;
    const w = 0.68;
    ctx.beginPath();
    ctx.moveTo(0, -arm);
    ctx.quadraticCurveTo(w * 0.4, -w * 0.4, arm, 0);
    ctx.quadraticCurveTo(w * 0.4, w * 0.4, 0, arm);
    ctx.quadraticCurveTo(-w * 0.4, w * 0.4, -arm, 0);
    ctx.quadraticCurveTo(-w * 0.4, -w * 0.4, 0, -arm);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  const evalQuadBezier = (p0, p1, p2, t) => {
    const mt = 1 - t;
    return mt * mt * p0 + 2 * mt * t * p1 + t * t * p2;
  };

  const tick = (now) => {
    if (!ctx) return;
    if (!lastFrameTime) lastFrameTime = now;
    const dtMs = clamp(now - lastFrameTime, 3, 40);
    const dtRatio = dtMs / 16.6667;
    lastFrameTime = now;
    const elapsed = now - animStartTime;

    ctx.clearRect(0, 0, stageW, stageH);

    // Layer A — Quiet Distant Starfield
    for (let i = 0; i < bgStars.length; i++) {
      const s = bgStars[i];
      s.ny -= s.driftSpeed * dtRatio;
      if (s.ny < -0.02) s.ny = 1.02;

      const appear = easeOutCubic((elapsed - s.delay) / s.fadeDuration);
      if (appear <= 0.005) continue;

      const breathe = 0.72 + 0.28 * Math.sin(s.phase + elapsed * 0.0024);
      const alpha = s.baseAlpha * appear * breathe;
      const [r, g, b] = s.rgb;
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(4)})`;
      ctx.beginPath();
      ctx.arc(s.nx * stageW, s.ny * stageH, s.radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // Layer B — Rising Starlight Launch Trails
    for (let i = 0; i < flares.length; i++) {
      const f = flares[i];
      if (elapsed < f.start) continue;
      const rawT = (elapsed - f.start) / f.duration;
      if (rawT >= 1) {
        if (!f.bloomed) {
          f.bloomed = true;
          triggerBloom(f);
        }
        continue;
      }

      const easedT = easeOutCubic(rawT);
      const fx = evalQuadBezier(f.startX * stageW, f.ctrlX * stageW, f.endX * stageW, easedT);
      const fy = evalQuadBezier(f.startY * stageH, f.ctrlY * stageH, f.endY * stageH, easedT);
      f.trail.push([fx, fy]);
      if (f.trail.length > 10) f.trail.shift();

      if (easedT >= f.nextEmberT && easedT < 0.94) {
        f.nextEmberT += 0.14;
        embers.push({
          x: fx + (Math.random() - 0.5) * 3,
          y: fy + (Math.random() - 0.5) * 3,
          vx: (Math.random() - 0.5) * 0.25,
          vy: 0.12 + Math.random() * 0.18,
          r: 0.65 + Math.random() * 0.45,
          rgb: f.rgb,
          alpha: 0.48,
          life: 0,
          maxLife: 420 + Math.random() * 200,
        });
      }

      const [r, g, b] = f.rgb;
      if (f.trail.length >= 2) {
        const first = f.trail[0];
        const grad = ctx.createLinearGradient(first[0], first[1], fx, fy);
        grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0)`);
        grad.addColorStop(1, "rgba(244, 248, 255, 0.78)");
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.5;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(first[0], first[1]);
        for (let j = 1; j < f.trail.length; j++) {
          ctx.lineTo(f.trail[j][0], f.trail[j][1]);
        }
        ctx.stroke();
      }

      const tipGlow = ctx.createRadialGradient(fx, fy, 0, fx, fy, 7);
      tipGlow.addColorStop(0, "rgba(244, 248, 255, 0.85)");
      tipGlow.addColorStop(0.45, `rgba(${r}, ${g}, ${b}, 0.35)`);
      tipGlow.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      ctx.fillStyle = tipGlow;
      ctx.beginPath();
      ctx.arc(fx, fy, 7, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = embers.length - 1; i >= 0; i--) {
      const e = embers[i];
      e.life += dtMs;
      if (e.life >= e.maxLife) {
        embers.splice(i, 1);
        continue;
      }
      e.x += e.vx * dtRatio;
      e.y += e.vy * dtRatio;
      const fade = 1 - e.life / e.maxLife;
      const [r, g, b] = e.rgb;
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${(e.alpha * fade).toFixed(4)})`;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = coreBlooms.length - 1; i >= 0; i--) {
      const b = coreBlooms[i];
      b.life += dtMs;
      const p = b.life / b.duration;
      if (p >= 1) {
        coreBlooms.splice(i, 1);
        continue;
      }
      const radius = b.maxR * (0.35 + 0.65 * easeOutCubic(p));
      const alpha = b.alpha * (1 - p);
      const [cr, cg, cb] = b.rgb;
      const grad = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, radius);
      grad.addColorStop(0, `rgba(244, 248, 255, ${(alpha * 0.9).toFixed(4)})`);
      grad.addColorStop(0.4, `rgba(${cr}, ${cg}, ${cb}, ${(alpha * 0.45).toFixed(4)})`);
      grad.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(b.x, b.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = rings.length - 1; i >= 0; i--) {
      const ring = rings[i];
      ring.life += dtMs;
      const p = ring.life / ring.duration;
      if (p >= 1) {
        rings.splice(i, 1);
        continue;
      }
      const radius = 6 + (ring.maxR - 6) * easeOutCubic(p);
      const alpha = ring.alpha * (1 - p);
      const [rr, rg, rb] = ring.rgb;
      ctx.strokeStyle = `rgba(${rr}, ${rg}, ${rb}, ${alpha.toFixed(4)})`;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Layer C — Celestial Willow Star-Rain Filaments
    for (let i = sparks.length - 1; i >= 0; i--) {
      const sp = sparks[i];
      sp.life += dtMs;
      if (sp.life >= sp.maxLife) {
        sparks.splice(i, 1);
        continue;
      }
      const dragPow = Math.pow(sp.drag, dtRatio);
      sp.vx *= dragPow;
      sp.vy = sp.vy * dragPow + sp.gravity * dtRatio;
      sp.x += sp.vx * dtRatio;
      sp.y += sp.vy * dtRatio;

      sp.trail.push([sp.x, sp.y]);
      if (sp.trail.length > 8) sp.trail.shift();

      const lifeP = sp.life / sp.maxLife;
      const fadeOut = lifeP < 0.25 ? 1 : Math.max(0, 1 - (lifeP - 0.25) / 0.75);
      const twinkle = lifeP > 0.3 ? (0.55 + 0.45 * Math.sin(sp.twinklePhase + elapsed * 0.015)) : 1;
      const alpha = sp.maxAlpha * fadeOut * twinkle;
      if (alpha <= 0.01) continue;

      const [r, g, b] = sp.rgb;
      if (sp.trail.length >= 2) {
        const first = sp.trail[0];
        const grad = ctx.createLinearGradient(first[0], first[1], sp.x, sp.y);
        grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0)`);
        grad.addColorStop(0.65, `rgba(${r}, ${g}, ${b}, ${(alpha * 0.48).toFixed(4)})`);
        grad.addColorStop(1, `rgba(244, 248, 255, ${(alpha * 0.92).toFixed(4)})`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = sp.width;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(first[0], first[1]);
        for (let j = 1; j < sp.trail.length; j++) {
          ctx.lineTo(sp.trail[j][0], sp.trail[j][1]);
        }
        ctx.stroke();
      }

      ctx.fillStyle = `rgba(244, 248, 255, ${(alpha * 0.95).toFixed(4)})`;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, sp.width * 0.95, 0, Math.PI * 2);
      ctx.fill();

      if (sp.hasCross && lifeP > 0.12) {
        const crossAlpha = alpha * 0.68 * Math.min(1, (lifeP - 0.12) / 0.15);
        drawCrossGleam(sp.x, sp.y, sp.crossArm * (0.65 + 0.35 * twinkle), sp.rgb, crossAlpha);
      }
    }

    // Layer D — Single Subtle Distant Shooting Star
    if (shootingStar) {
      const m = shootingStar;
      const localT = (elapsed - m.start) / m.duration;
      if (localT >= 0 && localT <= 1) {
        const headP = easeOutCubic(localT);
        const tailP = easeOutCubic(Math.max(0, localT - m.tailRatio));
        const env = Math.sin(clamp(localT, 0, 1) * Math.PI);

        const sx = m.startX * stageW;
        const sy = m.startY * stageH;
        const ex = m.endX * stageW;
        const ey = m.endY * stageH;
        const hx = sx + (ex - sx) * headP;
        const hy = sy + (ey - sy) * headP;
        const tx = sx + (ex - sx) * tailP;
        const ty = sy + (ey - sy) * tailP;

        const grad = ctx.createLinearGradient(tx, ty, hx, hy);
        grad.addColorStop(0, "rgba(192, 222, 255, 0)");
        grad.addColorStop(0.55, `rgba(192, 222, 255, ${(0.35 * m.peakAlpha * env).toFixed(4)})`);
        grad.addColorStop(1, `rgba(244, 248, 255, ${(m.peakAlpha * env).toFixed(4)})`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = m.width;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(hx, hy);
        ctx.stroke();

        ctx.fillStyle = `rgba(244, 248, 255, ${(m.peakAlpha * env).toFixed(4)})`;
        ctx.beginPath();
        ctx.arc(hx, hy, 1.25, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();

    if (phase === "celebrating" || canvasFading) {
      rafId = window.requestAnimationFrame(tick);
    } else {
      rafId = 0;
    }
  };

  const enterPromptPhase = (instant = false) => {
    clearTimers();
    phase = "prompt";
    overlay.setAttribute("aria-labelledby", "sps-celebration-title");
    overlay.classList.remove("is-starfield");
    changelogWrap.hidden = true;
    changelogWrap.classList.remove("is-visible");
    card.hidden = false;
    if (instant || reduceMotion?.matches || !ctx) {
      stopCanvas();
      canvas.classList.add("is-fading");
      card.classList.add("is-visible");
      card.focus?.({ preventScroll: true });
    } else {
      canvasFading = true;
      canvas.classList.add("is-fading");
      window.requestAnimationFrame?.(() => {
        card.classList.add("is-visible");
        card.focus?.({ preventScroll: true });
      });
      scheduleTimer(() => stopCanvas(), 750);
    }
  };

  const enterChangelogPhase = () => {
    markSeen();
    clearTimers();
    stopCanvas();
    phase = "changelog";
    hasPointerDown = false;
    pointerDownOutside = false;
    overlay.setAttribute("aria-labelledby", "sps-celebration-changelog-title");
    overlay.classList.remove("is-starfield");
    canvas.classList.add("is-fading");
    card.hidden = true;
    card.classList.remove("is-visible");
    changelogWrap.hidden = false;
    changelogBody.scrollTop = 0;
    const focusBody = () => {
      changelogWrap.classList.add("is-visible");
      changelogBody.focus?.({ preventScroll: true });
    };
    if (reduceMotion?.matches || typeof window.requestAnimationFrame !== "function") {
      focusBody();
    } else {
      window.requestAnimationFrame(focusBody);
    }
  };

  const onResize = () => resizeCanvas();

  const onKeyDown = (event) => {
    if (event.key === "Escape" && (phase === "prompt" || phase === "changelog")) {
      event.preventDefault();
      event.stopPropagation();
      dismissOverlay();
    }
  };

  const cleanup = () => {
    clearTimers();
    stopCanvas();
    window.removeEventListener("resize", onResize);
    document.removeEventListener("keydown", onKeyDown, true);
    isolated.forEach(([node, prevInert]) => {
      node.inert = prevInert;
    });
    document.documentElement.classList.remove("sps-celebration-open");
    overlay.remove();
    if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === "function") {
      previousFocus.focus({ preventScroll: true });
    }
  };

  const dismissOverlay = () => {
    if (phase === "dismissed") return;
    markSeen();
    clearTimers();
    stopCanvas();
    phase = "dismissed";
    overlay.classList.remove("is-starfield");
    overlay.classList.add("is-dismissing");
    if (reduceMotion?.matches) {
      cleanup();
    } else {
      scheduleTimer(cleanup, 240);
    }
  };

  btnContinue?.addEventListener("click", (event) => {
    event.stopPropagation();
    dismissOverlay();
  });
  btnChangelog?.addEventListener("click", (event) => {
    event.stopPropagation();
    enterChangelogPhase();
  });

  overlay.addEventListener("pointerdown", (event) => {
    if (phase === "changelog") {
      hasPointerDown = true;
      pointerDownOutside = !changelogBox.contains(event.target);
    } else {
      hasPointerDown = false;
      pointerDownOutside = false;
    }
  });

  overlay.addEventListener("click", (event) => {
    if (phase === "celebrating") {
      enterPromptPhase(false);
      return;
    }
    if (phase === "changelog" && !card.contains(event.target)) {
      const clickedOutside = !changelogBox.contains(event.target);
      const allowDismiss = !hasPointerDown || pointerDownOutside;
      hasPointerDown = false;
      pointerDownOutside = false;
      if (clickedOutside && allowDismiss) {
        dismissOverlay();
      }
    }
  });

  window.addEventListener("resize", onResize);
  document.addEventListener("keydown", onKeyDown, true);

  // Boot
  const canAnimateCanvas = !reduceMotion?.matches && typeof window.requestAnimationFrame === "function" && Boolean(ctx);
  if (!canAnimateCanvas) {
    enterPromptPhase(true);
  } else {
    phase = "celebrating";
    canvasFading = false;
    resizeCanvas();
    initScene();
    window.requestAnimationFrame(() => overlay.classList.add("is-starfield"));
    animStartTime = window.performance?.now ? window.performance.now() : Date.now();
    lastFrameTime = animStartTime;
    rafId = window.requestAnimationFrame(tick);
    scheduleTimer(() => {
      if (phase === "celebrating") {
        enterPromptPhase(false);
      }
    }, 2500);
  }
})();
