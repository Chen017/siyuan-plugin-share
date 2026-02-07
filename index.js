/* SiYuan Share - SiYuan plugin (no-build single file) */
/* eslint-disable no-console */

const {
  Plugin,
  fetchSyncPost,
  showMessage,
  getAllEditor,
  confirm,
  Setting,
  Dialog,
} = require("siyuan");

let fs;
let path;
try {
  fs = require("fs");
  path = require("path");
} catch (err) {
  // Browser / mobile frontend won't have Node.js builtins.
}

const STORAGE_SETTINGS = "settings";
const STORAGE_SHARES = "shares";
const STORAGE_SITE_SHARES = "sharesBySite";
const STORAGE_SHARE_OPTIONS = "shareOptions";
const DOCK_TYPE = "siyuan-plugin-share-dock";
const MB = 1024 * 1024;
const UPLOAD_CHUNK_MIN_SIZE = 256 * 1024;
const UPLOAD_CHUNK_MAX_SIZE = 8 * MB;
const UPLOAD_CHUNK_HARD_MAX_SIZE = 10 * MB;
const UPLOAD_TARGET_CHUNK_MS = 1800;
const UPLOAD_DEFAULT_SPEED_BPS = 2 * MB;
const DEFAULT_UPLOAD_ASSET_CONCURRENCY = 8;
const DEFAULT_UPLOAD_CHUNK_CONCURRENCY = 4;
const DEFAULT_DOC_EXPORT_CONCURRENCY = 4;
const DEFAULT_MARKDOWN_ASSET_PREPARE_CONCURRENCY = 3;
const UPLOAD_RETRY_LIMIT = 5;
const UPLOAD_RETRY_BASE_DELAY = 400;
const UPLOAD_RETRY_MAX_DELAY = 2000;
const UPLOAD_MISSING_CHUNK_RETRY_LIMIT = 3;

const REMOTE_API = {
  verify: "/api/v1/auth/verify",
  shares: "/api/v1/shares",
  shareSnapshot: "/api/v1/shares/snapshot",
  shareDocInit: "/api/v1/shares/doc/init",
  shareDoc: "/api/v1/shares/doc",
  shareNotebookInit: "/api/v1/shares/notebook/init",
  shareNotebook: "/api/v1/shares/notebook",
  shareAssetChunk: "/api/v1/shares/asset/chunk",
  shareUploadComplete: "/api/v1/shares/upload/complete",
  shareUploadCancel: "/api/v1/shares/upload/cancel",
  shareAccessUpdate: "/api/v1/shares/access/update",
  deleteShare: "/api/v1/shares/delete",
};

const SHARE_TYPES = {
  DOC: "doc",
  NOTEBOOK: "notebook",
};
const DEFAULT_DOC_ICON_LEAF = "📄";
const DEFAULT_DOC_ICON_PARENT = "📑";
const BLOCK_REF_ID_PATTERN = "[0-9]{14}-[0-9a-z]{7,}";
const BLOCK_REF_RE = new RegExp(
  `\\(\\(${BLOCK_REF_ID_PATTERN}(?:\\s+\\"[^\\"]*\\")?\\)\\)`,
  "i",
);
const BLOCK_REF_LINK_RE = new RegExp(`siyuan://blocks/${BLOCK_REF_ID_PATTERN}`, "i");

const TREE_SHARE_CLASS = "sps-tree-share";
const TREE_SHARED_CLASS = "sps-tree-item--shared";
const TREE_SHARE_ICON_ID = "iconSiyuanShare";
const HASH_HEX_RE = /^[a-f0-9]{64}$/i;

let globalI18nProvider = null;

function setGlobalI18nProvider(provider) {
  globalI18nProvider = typeof provider === "function" ? provider : null;
}

function tGlobal(key, vars) {
  if (globalI18nProvider) return globalI18nProvider(key, vars);
  if (!vars) return key;
  return key.replace(/\{(\w+)\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return match;
    const value = vars[name];
    return value == null ? "" : String(value);
  });
}

function getAPIToken() {
  try {
    const token = globalThis?.siyuan?.config?.api?.token;
    return typeof token === "string" ? token : "";
  } catch {
    return "";
  }
}

function getAuthHeaders() {
  const token = getAPIToken();
  if (!token) return {};
  return {Authorization: `Token ${token}`};
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function normalizeHashHex(value) {
  const raw = String(value || "").trim().toLowerCase();
  return HASH_HEX_RE.test(raw) ? raw : "";
}

function encodeUtf8Bytes(input) {
  const text = String(input || "");
  if (globalThis.TextEncoder) {
    return new TextEncoder().encode(text);
  }
  if (typeof Buffer !== "undefined") {
    return Uint8Array.from(Buffer.from(text, "utf8"));
  }
  const encoded = unescape(encodeURIComponent(text));
  const bytes = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i += 1) {
    bytes[i] = encoded.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function fallbackHashBytes(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let h3 = 0x9e3779b9;
  let h4 = 0x85ebca6b;
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    h1 ^= v;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= (v << (i % 8));
    h2 = Math.imul(h2, 0x85ebca6b);
    h3 ^= (v + i) & 0xff;
    h3 = Math.imul(h3, 0xc2b2ae35);
    h4 ^= (v * 131) & 0xff;
    h4 = Math.imul(h4, 0x27d4eb2f);
  }
  const words = [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0, (h1 ^ h3) >>> 0, (h2 ^ h4) >>> 0, (h1 ^ h2) >>> 0, (h3 ^ h4) >>> 0];
  return words.map((n) => n.toString(16).padStart(8, "0")).join("");
}

async function hashTextSha256(text) {
  const source = String(text || "");
  try {
    if (globalThis?.crypto?.subtle && globalThis.TextEncoder) {
      const buf = encodeUtf8Bytes(source);
      const digest = await globalThis.crypto.subtle.digest("SHA-256", buf);
      return Array.from(new Uint8Array(digest))
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("");
    }
  } catch {
    // fallback below
  }
  return fallbackHashBytes(encodeUtf8Bytes(source));
}

async function hashBlobSha256(blob) {
  if (!blob) return "";
  try {
    const buf = await blob.arrayBuffer();
    try {
      if (globalThis?.crypto?.subtle) {
        const digest = await globalThis.crypto.subtle.digest("SHA-256", buf);
        return Array.from(new Uint8Array(digest))
          .map((n) => n.toString(16).padStart(2, "0"))
          .join("");
      }
    } catch {
      // fallback below
    }
    return fallbackHashBytes(new Uint8Array(buf));
  } catch {
    return "";
  }
}

function normalizeSortIndexForHash(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const rounded = Math.round(num * 1000000) / 1000000;
  return Number.isFinite(rounded) ? rounded : 0;
}

function buildDocMetaHashInput(doc) {
  const meta = {
    title: String(doc?.title || ""),
    hPath: String(doc?.hPath || doc?.hpath || ""),
    parentId: String(doc?.parentId || doc?.parent_id || ""),
    sortIndex: normalizeSortIndexForHash(doc?.sortIndex ?? doc?.sort_index ?? 0),
    sortOrder: Math.max(0, Math.floor(Number(doc?.sortOrder ?? doc?.sort_order ?? 0) || 0)),
    icon: normalizeDocIconValue(doc?.icon || ""),
  };
  return JSON.stringify(meta);
}

async function runTasksWithConcurrency(tasks, concurrency) {
  if (!Array.isArray(tasks) || tasks.length === 0) return;
  const limit = Math.max(1, Math.floor(concurrency || 1));
  let nextIndex = 0;
  const workers = new Array(Math.min(limit, tasks.length)).fill(null).map(async () => {
    while (nextIndex < tasks.length) {
      const current = nextIndex;
      nextIndex += 1;
      await tasks[current]();
    }
  });
  await Promise.all(workers);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAbortError(message = tGlobal("siyuanShare.message.cancelled")) {
  const err = new Error(message || tGlobal("siyuanShare.message.cancelled"));
  err.name = "AbortError";
  err.isAbortError = true;
  return err;
}

function isAbortError(err) {
  if (!err) return false;
  if (err?.name === "AbortError" || err?.isAbortError) return true;
  const code = String(err?.code || "").toUpperCase();
  if (code === "ABORT_ERR" || code === "ERR_CANCELED" || code === "ECONNABORTED") return true;
  const message = String(err?.message || "").trim();
  if (!message) return false;
  // Avoid treating common filesystem errors as abort/cancel because file paths
  // may contain words like "取消", which can cause false positives.
  if (/^(ENOENT|EACCES|EPERM|ENOTDIR|EISDIR)\b/i.test(message)) return false;
  if (/\b(canceled|cancelled|aborted|abort)\b/i.test(message)) return true;
  return /^(已取消|用户取消|操作已取消|请求已取消)$/i.test(message);
}

function getMissingChunksFromError(err) {
  const data = err?.data;
  if (!data || !Array.isArray(data.missingChunks)) return null;
  const missing = data.missingChunks
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.floor(value));
  return missing.length ? missing : null;
}

async function withRetry(task, {retries = 0, baseDelay = 0, maxDelay = 0, controller = null, onRetry = null} = {}) {
  let attempt = 0;
  while (true) {
    if (controller?.signal?.aborted) {
      throw createAbortError(tGlobal("siyuanShare.message.cancelled"));
    }
    try {
      return await task();
    } catch (err) {
      if (err?.noRetry || isAbortError(err) || attempt >= retries) {
        throw err;
      }
      attempt += 1;
      if (onRetry) {
        try {
          onRetry(attempt, err);
        } catch {
          // ignore
        }
      }
      const delay = Math.min(maxDelay || baseDelay, baseDelay * Math.pow(2, attempt - 1));
      const jitter = delay ? Math.floor(delay * (0.2 * Math.random())) : 0;
      if (delay + jitter > 0) {
        await sleep(delay + jitter);
      }
    }
  }
}

function nowTs() {
  return Date.now();
}

function normalizeTimestampMs(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return num < 1e12 ? num * 1000 : num;
}

function toDateTimeLocalInput(value) {
  const ts = normalizeTimestampMs(value);
  if (!ts) return "";
  const date = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
  ].join("");
}

function parseDateTimeLocalInput(value) {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) {
    return tGlobal("siyuanShare.format.sizeKb", {value: "0"});
  }
  const kb = value / 1024;
  if (kb < 1024) {
    const display = kb < 10 ? kb.toFixed(1) : kb.toFixed(0);
    return tGlobal("siyuanShare.format.sizeKb", {value: display});
  }
  const mb = kb / 1024;
  const display = mb < 10 ? mb.toFixed(1) : mb.toFixed(0);
  return tGlobal("siyuanShare.format.sizeMb", {value: display});
}

function getUrlHost(raw) {
  try {
    return new URL(String(raw || "")).host || "";
  } catch {
    return "";
  }
}

function tryDecodeAssetPath(value) {
  const raw = String(value || "");
  if (!/%[0-9a-fA-F]{2}/.test(raw)) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

function replaceAllText(input, search, replacement) {
  if (!search) return input;
  return String(input || "").split(search).join(replacement);
}

function appendAssetSuffix(path, index) {
  const raw = String(path || "");
  const slash = raw.lastIndexOf("/");
  const dir = slash >= 0 ? raw.slice(0, slash + 1) : "";
  const name = slash >= 0 ? raw.slice(slash + 1) : raw;
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    return `${dir}${name.slice(0, dot)}-${index}${name.slice(dot)}`;
  }
  return `${dir}${name}-${index}`;
}

function ensureUniqueAssetPath(path, used) {
  if (!path) return "";
  const taken = used || new Set();
  let candidate = path;
  let index = 1;
  while (taken.has(candidate)) {
    candidate = appendAssetSuffix(path, index);
    index += 1;
  }
  taken.add(candidate);
  return candidate;
}

function sanitizeAssetUploadPath(path, used) {
  const decoded = tryDecodeAssetPath(path) || "";
  const raw = decoded || String(path || "");
  const stripped = raw.replace(/\s+/g, "");
  const normalized = normalizeAssetPath(stripped);
  if (!normalized) return "";
  return ensureUniqueAssetPath(normalized, used);
}

function throwIfAborted(controller, message) {
  if (controller?.signal?.aborted) {
    throw createAbortError(message || tGlobal("siyuanShare.message.cancelled"));
  }
}

function randomSlug(len = 6) {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const pick = (bytes) => {
    let out = "";
    for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  };

  try {
    if (globalThis.crypto?.getRandomValues) {
      const bytes = new Uint8Array(len);
      globalThis.crypto.getRandomValues(bytes);
      return pick(bytes);
    }
  } catch {
    // ignore
  }

  try {
    // Desktop (Node.js)
    const crypto = require("crypto");
    const bytes = crypto.randomBytes(len);
    return pick(bytes);
  } catch {
    // ignore
  }

  let out = "";
  while (out.length < len) out += Math.random().toString(36).slice(2);
  return out.slice(0, len);
}

function isValidDocId(id) {
  return typeof id === "string" && /^\d{14}-[a-z0-9]{7}$/i.test(id.trim());
}

function isValidNotebookId(id) {
  return isValidDocId(id);
}

function findAttrId(el) {
  if (!el || typeof el.getAttribute !== "function") return "";
  const attrs = [
    "data-node-id",
    "data-id",
    "data-doc-id",
    "data-root-id",
    "data-box",
    "data-url",
    "data-notebook-id",
    "data-notebook",
    "data-box-id",
    "data-boxid",
  ];
  for (const attr of attrs) {
    const v = el.getAttribute(attr);
    if (isValidDocId(v)) return v.trim();
  }
  if (el.dataset) {
    for (const v of Object.values(el.dataset)) {
      if (isValidDocId(v)) return String(v).trim();
    }
  }
  if (isValidDocId(el.id)) return el.id.trim();
  return "";
}

function findTitleFromTree(el) {
  if (!el) return "";
  const textEl =
    el.querySelector(".b3-list-item__text") ||
    el.querySelector(".b3-list-item__title") ||
    el.querySelector(".b3-list-item__name") ||
    el.querySelector(".b3-list-item__label") ||
    el.querySelector(".b3-list-item__content");
  const title = textEl?.textContent?.trim();
  if (title) return title;
  return el.textContent?.trim() || "";
}

function resolveTreeItemInfo(item) {
  if (!item) return {id: "", isNotebook: false};
  const dataType = item.getAttribute?.("data-type") || item.dataset?.type || "";
  const typeLower = String(dataType).toLowerCase();
  const notebookTypes = new Set(["notebook", "navigation-root"]);
  const docTypes = new Set(["navigation-file", "navigation-doc", "navigation-folder", "doc", "file"]);
  let isNotebook = notebookTypes.has(typeLower);
  const isDocType = docTypes.has(typeLower);
  const nextSibling = item.nextElementSibling;
  const parentList =
    item.closest?.(
      "ul[data-url], ul[data-box], ul[data-box-id], ul[data-boxid], ul[data-notebook-id], ul[data-notebook]",
    ) || item.parentElement?.closest?.(
      "ul[data-url], ul[data-box], ul[data-box-id], ul[data-boxid], ul[data-notebook-id], ul[data-notebook]",
    );
  const urlFromSelf = item.getAttribute?.("data-url") || item.dataset?.url;
  const urlFromNext = nextSibling?.getAttribute?.("data-url") || nextSibling?.dataset?.url;
  const urlFromParent = parentList?.getAttribute?.("data-url") || parentList?.dataset?.url;
  const docAttrs = ["data-node-id", "data-id", "data-doc-id", "data-root-id"];
  let docAttrValue = "";
  for (const attr of docAttrs) {
    const value = item.getAttribute?.(attr);
    if (isValidDocId(value)) {
      docAttrValue = value;
      break;
    }
  }
  if (!docAttrValue) {
    const docChild = item.querySelector?.("[data-node-id], [data-id], [data-doc-id], [data-root-id]");
    const childId = findAttrId(docChild);
    if (isValidDocId(childId)) docAttrValue = childId;
  }
  const hasDocAttr = isValidDocId(docAttrValue);
  const notebookAttrs = ["data-box", "data-box-id", "data-boxid", "data-notebook-id", "data-notebook"];
  let notebookAttrValue = "";
  for (const attr of notebookAttrs) {
    const value = item.getAttribute?.(attr);
    if (isValidDocId(value)) {
      notebookAttrValue = value;
      break;
    }
  }
  if (!notebookAttrValue) {
    const parentValues = [
      urlFromParent,
      parentList?.getAttribute?.("data-box"),
      parentList?.getAttribute?.("data-box-id"),
      parentList?.getAttribute?.("data-boxid"),
      parentList?.getAttribute?.("data-notebook-id"),
      parentList?.getAttribute?.("data-notebook"),
    ];
    for (const value of parentValues) {
      if (isValidDocId(value)) {
        notebookAttrValue = value;
        break;
      }
    }
  }
  if (isValidDocId(notebookAttrValue)) {
    isNotebook = true;
  }
  if (
    !isNotebook &&
    !isDocType &&
    !hasDocAttr &&
    (isValidDocId(urlFromSelf) || isValidDocId(urlFromNext) || isValidDocId(urlFromParent))
  ) {
    isNotebook = true;
  }
  if (isDocType || hasDocAttr) isNotebook = false;

  let id = "";
  if (isNotebook) {
    if (isValidDocId(notebookAttrValue)) id = notebookAttrValue.trim();
    else if (isValidDocId(urlFromSelf)) id = urlFromSelf.trim();
    else if (isValidDocId(urlFromNext)) id = urlFromNext.trim();
    else if (isValidDocId(urlFromParent)) id = urlFromParent.trim();
    else if (isValidDocId(docAttrValue)) id = docAttrValue.trim();
  } else if (isValidDocId(docAttrValue)) {
    id = docAttrValue.trim();
  }
  if (!id) id = findAttrId(item);

  return {id, isNotebook};
}

function pickDocTreeContainer() {
  const navItem = document.querySelector(
    ".b3-list-item[data-type^='navigation'], .b3-list-item[data-type*='navigation'], .b3-list-item[data-type='notebook']",
  );
  if (navItem) {
    return (
      navItem.closest(".file-tree") ||
      navItem.closest(".b3-list") ||
      navItem.closest(".b3-list--tree") ||
      navItem.parentElement
    );
  }
  const anyItem = document.querySelector(
    ".b3-list-item[data-node-id], .b3-list-item[data-id], .b3-list-item[data-doc-id], .b3-list-item[data-notebook-id], .b3-list-item[data-url]",
  );
  if (anyItem) {
    return anyItem.closest(".b3-list") || anyItem.parentElement;
  }
  const selectors = [
    "#dockFileTree",
    "#file-tree",
    "#fileTree",
    ".file-tree",
    ".file-tree__list",
    ".b3-list--tree",
    ".b3-list--background",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function isProbablyDocTreeItem(item) {
  if (!item) return false;
  if (item.closest?.("[data-sps-share-tree='1']")) return true;
  const dataType = item.getAttribute?.("data-type") || item.dataset?.type || "";
  if (String(dataType).toLowerCase().includes("navigation")) return true;
  const container = item.closest(
    "#dockFileTree, #file-tree, #fileTree, .file-tree, .file-tree__list, .b3-list--tree, .b3-list--background, .b3-list",
  );
  return Boolean(container);
}

function resolveDetailId(detail) {
  const candidates = [
    detail?.id,
    detail?.box,
    detail?.boxId,
    detail?.notebookId,
    detail?.data?.id,
    detail?.data?.box,
    detail?.data?.boxId,
  ];
  for (const value of candidates) {
    if (isValidDocId(value)) return String(value).trim();
  }
  return "";
}

function isElementVisiblySized(el) {
  try {
    if (!el || typeof el.getBoundingClientRect !== "function") return false;
    const r = el.getBoundingClientRect();
    return r.width > 20 && r.height > 20;
  } catch {
    return false;
  }
}

function normalizeUrlBase(url) {
  if (typeof url !== "string") return "";
  return url.trim().replace(/\s+/g, "").replace(/\/$/, "");
}

function sanitizeSlug(name) {
  const raw = String(name || "").trim();
  if (!raw) return "";
  const cleaned = raw
    .replace(/[^a-z0-9_-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+/g, "")
    .replace(/[.-]+$/g, "");
  return cleaned.slice(0, 64);
}

function normalizeAssetPath(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const cleaned = raw.replace(/^[\\/]+/, "").split(/[?#]/)[0];
  if (!cleaned || cleaned.endsWith("/")) return "";
  return cleaned;
}

function extractAssetPaths(markdown) {
  if (typeof markdown !== "string" || !markdown) return [];
  const out = new Set();
  const patterns = [
    /\((\/?(?:assets|emojis)\/[^)\s]+)(?:\s+[^)]*)?\)/g,
    /src=["'](\/?(?:assets|emojis)\/[^"']+)["']/g,
    /href=["'](\/?(?:assets|emojis)\/[^"']+)["']/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(markdown))) {
      const normalized = normalizeAssetPath(match[1]);
      if (normalized) out.add(normalized);
    }
  }
  return Array.from(out);
}

function rewriteAssetLinks(markdown) {
  if (typeof markdown !== "string" || !markdown) return "";
  return markdown
    .replace(/\]\(\/assets\//g, "](assets/")
    .replace(/\]\(\.\/assets\//g, "](assets/")
    .replace(/src="\/assets\//g, 'src="assets/')
    .replace(/src="\.\/assets\//g, 'src="assets/')
    .replace(/href="\/assets\//g, 'href="assets/')
    .replace(/href="\.\/assets\//g, 'href="assets/')
    .replace(/\]\(\/emojis\//g, "](emojis/")
    .replace(/\]\(\.\/emojis\//g, "](emojis/")
    .replace(/src="\/emojis\//g, 'src="emojis/')
    .replace(/src="\.\/emojis\//g, 'src="emojis/')
    .replace(/href="\/emojis\//g, 'href="emojis/')
    .replace(/href="\.\/emojis\//g, 'href="emojis/');
}

function makeResourcePathsRelative(html) {
  if (typeof html !== "string") return "";
  return html
    .replace(/(src|href)="\/(assets|stage|appearance|emojis)\//g, '$1="$2/')
    .replace(/(src)="\/(emojis)/g, '$1="$2');
}

function safeJsonForHtmlScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function getSnippetCSSHtml() {
  let out = "";
  try {
    document.querySelectorAll("style").forEach((item) => {
      if (item?.id?.startsWith("snippetCSS")) out += item.outerHTML;
    });
  } catch {
    // ignore
  }
  return out;
}

function getSnippetJSHtml() {
  let out = "";
  try {
    document.querySelectorAll("script").forEach((item) => {
      if (item?.id?.startsWith("snippetJS")) out += item.outerHTML;
    });
  } catch {
    // ignore
  }
  return out;
}

function getExportIconScriptHtml() {
  const iconName = globalThis?.siyuan?.config?.appearance?.icon || "";
  if (!iconName) return "";
  const escaped = escapeAttr(iconName);
  const isBuiltInIcon = ["ant", "material"].includes(iconName);
  const fallback = isBuiltInIcon ? "" : `<script src="appearance/icons/material/icon.js"></script>`;
  return `${fallback}<script src="appearance/icons/${escaped}/icon.js"></script>`;
}

function buildExportIndexHtml({title, content, exportMode}) {
  const cfg = globalThis?.siyuan?.config || {};
  const appearance = cfg.appearance || {};
  const editor = cfg.editor || {};
  const lang = appearance.lang || "zh_CN";

  let themeName = appearance.themeLight || "daylight";
  let mode = 0;
  if (appearance.mode === 1) {
    themeName = appearance.themeDark || themeName;
    mode = 1;
  }
  const themeMode = mode === 1 ? "dark" : "light";

  const previewClass =
    exportMode === "htmlmd"
      ? "b3-typography"
      : `protyle-wysiwyg${editor.displayBookmarkIcon ? " protyle-wysiwyg--attr" : ""}`;

  const winSiyuan = {
    config: {
      appearance: {
        mode,
        codeBlockThemeDark: appearance.codeBlockThemeDark || "",
        codeBlockThemeLight: appearance.codeBlockThemeLight || "",
      },
      editor: {
        codeLineWrap: true,
        fontSize: Number(editor.fontSize) || 16,
        codeLigatures: !!editor.codeLigatures,
        plantUMLServePath: editor.plantUMLServePath || "",
        codeSyntaxHighlightLineNum: !!editor.codeSyntaxHighlightLineNum,
        katexMacros: editor.katexMacros || "",
      },
    },
    languages: {
      copy: globalThis?.siyuan?.languages?.copy || "Copy",
    },
  };

  const snippetCSS = getSnippetCSSHtml();
  const snippetJS = getSnippetJSHtml();
  const iconScript = getExportIconScriptHtml();
  const winSiyuanJson = safeJsonForHtmlScript(winSiyuan);

  return `<!DOCTYPE html>
<html lang="${escapeAttr(lang)}" data-theme-mode="${escapeAttr(themeMode)}" data-light-theme="${escapeAttr(
    appearance.themeLight || "",
  )}" data-dark-theme="${escapeAttr(appearance.themeDark || "")}">
<head>
    <base href="">
    <meta charset="utf-8">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0"/>
    <meta name="mobile-web-app-capable" content="yes"/>
    <meta name="apple-mobile-web-app-status-bar-style" content="black">
    <link rel="stylesheet" type="text/css" id="baseStyle" href="stage/build/export/base.css"/>
    <link rel="stylesheet" type="text/css" id="themeDefaultStyle" href="appearance/themes/${escapeAttr(themeName)}/theme.css"/>
    <script src="stage/protyle/js/protyle-html.js"></script>
    <title>${escapeHtml(title || "")}</title>
    <style>
        body {font-family: var(--b3-font-family);background-color: var(--b3-theme-background);color: var(--b3-theme-on-background)}
    </style>
    ${snippetCSS}
</head>
<body>
<div class="${previewClass}" style="max-width: 800px;margin: 0 auto;" id="preview">${content || ""}</div>
${iconScript}
<script src="stage/build/export/protyle-method.js"></script>
<script src="stage/protyle/js/lute/lute.min.js"></script>  
<script>
    window.siyuan = ${winSiyuanJson};
    const previewElement = document.getElementById('preview');
    Protyle.highlightRender(previewElement, "stage/protyle");
    Protyle.mathRender(previewElement, "stage/protyle", false);
    Protyle.mermaidRender(previewElement, "stage/protyle");
    Protyle.flowchartRender(previewElement, "stage/protyle");
    Protyle.graphvizRender(previewElement, "stage/protyle");
    Protyle.chartRender(previewElement, "stage/protyle");
    Protyle.mindmapRender(previewElement, "stage/protyle");
    Protyle.abcRender(previewElement, "stage/protyle");
    Protyle.htmlRender(previewElement);
    Protyle.plantumlRender(previewElement, "stage/protyle");
    document.querySelectorAll(".protyle-action__copy").forEach((item) => {
      item.addEventListener("click", (event) => {
            let text = item.parentElement.nextElementSibling.textContent.trimEnd();
            text = text.replace(/\\u00A0/g, " ");
            navigator.clipboard.writeText(text);
            event.preventDefault();
            event.stopPropagation();
      })
    });
</script>
${snippetJS}
</body></html>`;
}

function joinWorkspaceRelPath(...parts) {
  const cleaned = parts
    .flatMap((p) => (p == null ? [] : [String(p)]))
    .map((p) => p.replace(/^[\\/]+/, "").replace(/[\\/]+$/, ""))
    .filter(Boolean);
  return `/${cleaned.join("/")}`;
}

function normalizeWorkspaceRelPath(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/\\/g, "/");
  return normalized.startsWith("/") ? normalized.replace(/\/+$/, "") : `/${normalized.replace(/\/+$/, "")}`;
}

function joinFsPath(base, ...parts) {
  const baseStr = String(base || "");
  const sep = baseStr.includes("\\") ? "\\" : "/";
  const baseTrimmed = baseStr.replace(/[\\/]+$/, "");
  const cleaned = parts
    .flatMap((p) => (p == null ? [] : [String(p)]))
    .map((p) => p.replace(/^[\\/]+/, "").replace(/[\\/]+$/, ""))
    .filter(Boolean);
  return [baseTrimmed, ...cleaned].join(sep);
}

async function resolveWorkspaceRoot(publishRootInput) {
  const wsInfo = await fetchSyncPost("/api/system/getWorkspaceInfo", {});
  if (!wsInfo || wsInfo.code !== 0) {
    throw new Error(wsInfo?.msg || tGlobal("siyuanShare.error.workspaceInfoFailed"));
  }
  const workspaceDir = wsInfo?.data?.workspaceDir;
  if (!workspaceDir) throw new Error(tGlobal("siyuanShare.error.workspacePathFailed"));

  const inputRaw = String(publishRootInput || "").trim();
  if (!inputRaw) throw new Error(tGlobal("siyuanShare.error.publishDirRequired"));
  const inputNorm = inputRaw.replace(/\\/g, "/").replace(/\/+$/, "");

  const wsNorm = String(workspaceDir).replace(/\\/g, "/").replace(/\/+$/, "");
  const isWindows = /^[a-zA-Z]:\//.test(wsNorm) || wsNorm.startsWith("//");

  // Windows absolute path or UNC path.
  const isWinAbs = /^[a-zA-Z]:\//.test(inputNorm) || inputNorm.startsWith("//");
  if (isWinAbs) {
    const wsCmp = isWindows ? wsNorm.toLowerCase() : wsNorm;
    const inputCmp = isWindows ? inputNorm.toLowerCase() : inputNorm;
    if (inputCmp === wsCmp) {
      return {workspaceDir, rootRel: "/"};
    }
    if (inputCmp.startsWith(`${wsCmp}/`)) {
      const rel = inputNorm.slice(wsNorm.length) || "/";
      return {workspaceDir, rootRel: rel.startsWith("/") ? rel : `/${rel}`};
    }
    throw new Error(
      tGlobal("siyuanShare.error.publishDirOutsideWorkspace", {workspace: workspaceDir}),
    );
  }

  const rel = normalizeWorkspaceRelPath(inputNorm);
  if (rel.includes("..")) throw new Error(tGlobal("siyuanShare.error.publishDirInvalid"));
  return {workspaceDir, rootRel: rel};
}

async function putWorkspaceFile(workspacePath, content, filename = "index.html", mime = "text/html") {
  const form = new FormData();
  form.append("path", workspacePath);
  form.append("isDir", "false");
  form.append("modTime", String(Date.now()));
  const blob = content instanceof Blob ? content : new Blob([String(content)], {type: mime});
  form.append("file", blob, filename);

  const resp = await fetch("/api/file/putFile", {
    method: "POST",
    body: form,
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
    },
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(
      json?.msg || tGlobal("siyuanShare.error.writeFileFailedStatus", {status: resp.status}),
    );
  }
  if (json?.code !== 0) {
    throw new Error(json?.msg || tGlobal("siyuanShare.error.writeFileFailed"));
  }
}

async function safeRm(dirPath) {
  if (!fs) throw new Error(tGlobal("siyuanShare.error.nodeFsUnavailable"));
  const fsp = fs.promises;
  if (fsp.rm) {
    await fsp.rm(dirPath, {recursive: true, force: true});
    return;
  }
  // Node <14 fallback
  await fsp.rmdir(dirPath, {recursive: true});
}
function pickActiveProtyle() {
  const protyles = getAllEditor();
  if (!Array.isArray(protyles) || protyles.length === 0) return null;

  const visibles = protyles.filter((p) => isElementVisiblySized(p?.element));
  if (visibles.length === 0) return null;
  if (visibles.length === 1) return visibles[0];

  const activeWnd =
    document.querySelector(".layout__wnd--active") ||
    document.querySelector(".layout__wnd--focus") ||
    document.querySelector(".layout__wnd--current");
  if (activeWnd) {
    const hit = visibles.find((p) => p?.element && activeWnd.contains(p.element));
    if (hit) return hit;
  }

  const active = document.activeElement;
  if (active) {
    const hit = visibles.find((p) => p?.element && p.element.contains(active));
    if (hit) return hit;
  }
  return visibles[0];
}

function extractDocIdsFromDoctreeElements(elements) {
  if (!elements) return [];
  const els = Array.from(elements);
  const ids = [];
  for (const el of els) {
    if (!el || typeof el.getAttribute !== "function") continue;
    let found = "";
    const directAttrs = [
      "data-node-id",
      "data-id",
      "data-doc-id",
      "data-root-id",
      "data-block-id",
    ];
    for (const attr of directAttrs) {
      const v = el.getAttribute(attr);
      if (isValidDocId(v)) {
        found = v.trim();
        break;
      }
    }
    if (!found && el.dataset) {
      for (const v of Object.values(el.dataset)) {
        if (isValidDocId(v)) {
          found = v.trim();
          break;
        }
      }
    }
    if (!found && isValidDocId(el.id)) found = el.id.trim();
    if (found) ids.push(found);
  }
  return Array.from(new Set(ids));
}

function extractDocTreeNodes(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.tree)) return data.tree;
  if (Array.isArray(data.root?.children)) return data.root.children;
  if (Array.isArray(data.files)) return data.files;
  if (Array.isArray(data.children)) return data.children;
  return [];
}

function normalizeDocIconValue(raw) {
  if (raw == null) return "";
  if (typeof raw === "string") {
    let trimmed = raw.trim();
    if (!trimmed) return "";
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(trimmed);
        return normalizeDocIconValue(parsed);
      } catch {
        // ignore
      }
    }
    const normalizedHex = trimmed.replace(/^u\+/i, "").replace(/\s+/g, "");
    if (/^(?:0x)?[0-9a-f]{4,6}(?:-(?:0x)?[0-9a-f]{4,6})*$/i.test(normalizedHex)) {
      const parts = normalizedHex.split("-").map((part) => part.replace(/^0x/i, ""));
      try {
        const codepoints = parts.map((part) => parseInt(part, 16)).filter((n) => Number.isFinite(n));
        if (codepoints.length) {
          return String.fromCodePoint(...codepoints);
        }
      } catch {
        // ignore
      }
    }
    return trimmed;
  }
  if (typeof raw === "number") return String(raw);
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const value = normalizeDocIconValue(item);
      if (value) return value;
    }
    return "";
  }
  if (typeof raw === "object") {
    const candidates = [
      raw.icon,
      raw.value,
      raw.emoji,
      raw.iconEmoji,
      raw.iconValue,
      raw.path,
      raw.file,
      raw.asset,
      raw.assetPath,
      raw.src,
      raw.url,
    ];
    for (const candidate of candidates) {
      const value = normalizeDocIconValue(candidate);
      if (value) return value;
    }
  }
  return "";
}

function extractDocTreeNodeIcon(node) {
  if (!node) return "";
  const candidates = [
    node.icon,
    node.iconEmoji,
    node.emoji,
    node.emojiIcon,
    node.iconValue,
    node.iconPath,
    node.iconSrc,
    node.data?.icon,
    node.data?.iconEmoji,
    node.data?.emoji,
    node.data?.iconValue,
    node.attrs?.icon,
    node.attrs?.iconEmoji,
    node.attrs?.emoji,
  ];
  for (const candidate of candidates) {
    const value = normalizeDocIconValue(candidate);
    if (value) return value;
  }
  return "";
}

function extractDocIconFromAttrs(attrs) {
  if (!attrs || typeof attrs !== "object") return "";
  const candidates = [
    attrs.icon,
    attrs.emoji,
    attrs.iconEmoji,
    attrs.iconValue,
    attrs.iconPath,
  ];
  for (const candidate of candidates) {
    const value = normalizeDocIconValue(candidate);
    if (value) return value;
  }
  return "";
}

const DOC_ICON_IMAGE_EXT_RE = /\.(svg|png|jpe?g|gif|webp|bmp)$/i;
const EMOJI_IMAGE_EXTENSIONS = ["svg", "png", "jpg", "jpeg", "gif", "webp", "bmp"];

function stripEmojiColons(value) {
  if (!value) return "";
  const trimmed = String(value || "").trim();
  if (!trimmed.startsWith(":")) return "";
  const withoutStart = trimmed.slice(1);
  if (!withoutStart) return "";
  const withoutEnd = withoutStart.endsWith(":") ? withoutStart.slice(0, -1) : withoutStart;
  return withoutEnd.trim();
}

function normalizeEmojiAssetPath(pathValue, fromEmojiToken) {
  if (!pathValue) return "";
  const lower = pathValue.toLowerCase();
  if (
    lower.startsWith("emojis/") ||
    lower.startsWith("assets/") ||
    lower.startsWith("data/") ||
    lower.startsWith("appearance/") ||
    lower.startsWith("stage/")
  ) {
    return pathValue;
  }
  if (fromEmojiToken || /[\\/]/.test(pathValue) || DOC_ICON_IMAGE_EXT_RE.test(pathValue)) {
    return `emojis/${pathValue}`;
  }
  return pathValue;
}

function isEmojiTokenName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "";
  if (raw.length > 200) return "";
  if (/[\r\n]/.test(raw)) return "";
  if (raw.includes(":")) return "";
  return raw;
}

function getEmojiTokenNameAt(text, index) {
  if (!text || index < 0 || index >= text.length) return "";
  if (text[index] !== ":") return "";
  const end = text.indexOf(":", index + 1);
  if (end <= index + 1) return "";
  const token = text.slice(index, end + 1);
  return isEmojiTokenName(stripEmojiColons(token));
}

function getFenceMarkerAt(text, index) {
  const ch = text[index];
  if (ch !== "`" && ch !== "~") return "";
  const marker = text.slice(index, index + 3);
  if (marker !== "```" && marker !== "~~~") return "";
  let i = index - 1;
  while (i >= 0 && text[i] === " ") i -= 1;
  if (i >= 0 && text[i] !== "\n") return "";
  return marker;
}

function collectEmojiTokenNames(markdown) {
  const out = new Set();
  const source = String(markdown || "");
  if (!source) return out;
  let i = 0;
  let inFence = false;
  let fenceMarker = "";
  let inInline = false;
  while (i < source.length) {
    const fence = getFenceMarkerAt(source, i);
    if (!inFence && fence) {
      inFence = true;
      fenceMarker = fence;
      i += fence.length;
      continue;
    }
    if (inFence && fence && fence === fenceMarker) {
      inFence = false;
      fenceMarker = "";
      i += fence.length;
      continue;
    }
    const ch = source[i];
    if (!inFence) {
      if (ch === "`") {
        inInline = !inInline;
        i += 1;
        continue;
      }
      if (ch === "\n") {
        inInline = false;
        i += 1;
        continue;
      }
      if (!inInline && ch === ":") {
        const end = source.indexOf(":", i + 1);
        if (end > i + 1) {
          const token = source.slice(i, end + 1);
          const name = isEmojiTokenName(stripEmojiColons(token));
          if (name) out.add(name);
          i = end + 1;
          continue;
        }
      }
    }
    i += 1;
  }
  if (source.includes(":")) {
    const re = /:([^:\r\n]{1,200}):/g;
    let match;
    while ((match = re.exec(source))) {
      const name = isEmojiTokenName(match[1]);
      if (name) out.add(name);
    }
  }
  return out;
}

function replaceCustomEmojiTokens(markdown, tokenMap) {
  if (!markdown || !tokenMap || tokenMap.size === 0) return markdown;
  const source = String(markdown || "");
  let out = "";
  let i = 0;
  let inFence = false;
  let fenceMarker = "";
  let inInline = false;
  while (i < source.length) {
    const fence = getFenceMarkerAt(source, i);
    if (!inFence && fence) {
      inFence = true;
      fenceMarker = fence;
      out += fence;
      i += fence.length;
      continue;
    }
    if (inFence && fence && fence === fenceMarker) {
      inFence = false;
      fenceMarker = "";
      out += fence;
      i += fence.length;
      continue;
    }
    const ch = source[i];
    if (!inFence) {
      if (ch === "`") {
        inInline = !inInline;
        out += ch;
        i += 1;
        continue;
      }
      if (ch === "\n") {
        inInline = false;
        out += ch;
        i += 1;
        continue;
      }
      if (!inInline && ch === ":") {
        const end = source.indexOf(":", i + 1);
        if (end > i + 1) {
          const token = source.slice(i, end + 1);
          const name = isEmojiTokenName(stripEmojiColons(token));
          if (name && tokenMap.has(name)) {
            out += tokenMap.get(name);
            const nextName = getEmojiTokenNameAt(source, end + 1);
            if (nextName && tokenMap.has(nextName)) {
              out += " ";
            }
          } else {
            out += token;
          }
          i = end + 1;
          continue;
        }
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

function insertAdjacentEmojiImageSpacing(markdown) {
  const source = String(markdown || "");
  if (!source) return source;
  return source.replace(
    /(!\[[^\]]*]\((?:<)?[^)\s]*emojis\/[^)\s>]+(?:>)?\))(?=!\[[^\]]*]\((?:<)?[^)\s]*emojis\/)/g,
    "$1 ",
  );
}

function getDocIconKind(iconValue) {
  const icon = normalizeDocIconValue(iconValue);
  if (!icon) return "empty";
  if (/^data:image\//i.test(icon)) return "data";
  if (/^https?:\/\//i.test(icon)) return "url";
  const emojiToken = stripEmojiColons(icon);
  const candidate = emojiToken || icon;
  if (/[\\/]/.test(candidate) || DOC_ICON_IMAGE_EXT_RE.test(candidate)) {
    return "asset";
  }
  return "emoji";
}

function normalizeDocIconAssetPath(iconValue) {
  const icon = normalizeDocIconValue(iconValue);
  if (!icon) return "";
  if (/^data:image\//i.test(icon) || /^https?:\/\//i.test(icon)) {
    return icon;
  }
  const emojiToken = stripEmojiColons(icon);
  let cleaned = (emojiToken || icon).replace(/^file:\/+/i, "");
  cleaned = cleaned.replace(/^[\\/]+/, "");
  const decoded = tryDecodeAssetPath(cleaned) || "";
  const normalized = normalizeAssetPath(decoded || cleaned);
  if (!normalized) return "";
  return normalizeEmojiAssetPath(normalized, Boolean(emojiToken));
}

function normalizeApiIconUrl(iconValue) {
  if (typeof iconValue !== "string") return "";
  const raw = iconValue.trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return "";
  if (raw.startsWith("//")) return `${location.protocol}${raw}`;
  if (raw.startsWith("/api/")) return `${location.origin}${raw}`;
  if (raw.startsWith("api/")) return `${location.origin}/${raw}`;
  return "";
}

function guessImageExtension(contentType = "", url = "") {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("svg")) return "svg";
  if (type.includes("png")) return "png";
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("gif")) return "gif";
  if (type.includes("webp")) return "webp";
  if (type.includes("bmp")) return "bmp";
  const match = String(url || "").match(/\.(svg|png|jpe?g|gif|webp|bmp)(?:\?|#|$)/i);
  if (match) return match[1].toLowerCase().replace("jpeg", "jpg");
  return "png";
}

function applyDefaultDocIcons(docs) {
  if (!Array.isArray(docs) || docs.length === 0) return;
  const hasChildren = new Set();
  docs.forEach((doc) => {
    const parentId = String(doc?.parentId || "").trim();
    if (isValidDocId(parentId)) hasChildren.add(parentId);
  });
  docs.forEach((doc) => {
    const docId = String(doc?.docId || "").trim();
    if (!isValidDocId(docId)) return;
    const current = normalizeDocIconValue(doc?.icon);
    if (current) return;
    doc.icon = hasChildren.has(docId) ? DEFAULT_DOC_ICON_PARENT : DEFAULT_DOC_ICON_LEAF;
  });
}

function getDocTreeChildren(node) {
  if (!node) return [];
  const children = node.children || node.child || node.files || node.nodes;
  return Array.isArray(children) ? children : [];
}

function extractDocIdFromValue(value) {
  if (!value) return "";
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (isValidDocId(raw)) return raw;
  const matches = raw.match(/\d{14}-[a-z0-9]{7}/gi);
  if (!matches || matches.length === 0) return "";
  const candidate = matches[matches.length - 1];
  return isValidDocId(candidate) ? candidate : "";
}

function deriveParentIdFromPath(pathValue, selfId = "") {
  if (!pathValue) return "";
  const parts = String(pathValue || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return "";
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    const parentId = extractDocIdFromValue(parts[i]);
    if (parentId && parentId !== selfId) return parentId;
  }
  return "";
}

function getDocTreeNodeId(node) {
  if (!node) return "";
  const candidates = [
    node?.id,
    node?.docId,
    node?.docID,
    node?.nodeId,
    node?.nodeID,
    node?.rootId,
    node?.rootID,
    node?.blockId,
    node?.blockID,
    node?.path,
    node?.data?.id,
    node?.data?.docId,
    node?.data?.nodeId,
    node?.data?.rootId,
  ];
  for (const candidate of candidates) {
    const extracted = extractDocIdFromValue(candidate);
    if (extracted) return extracted;
  }
  return "";
}

function getDocTreeNodeParentId(node) {
  if (!node) return "";
  const candidates = [
    node?.parentId,
    node?.parentID,
    node?.parent_id,
    node?.parent,
    node?.data?.parentId,
    node?.data?.parentID,
    node?.data?.parent_id,
  ];
  for (const candidate of candidates) {
    const extracted = extractDocIdFromValue(candidate);
    if (extracted) return extracted;
  }
  return "";
}

function getDocTreeNodePath(node) {
  if (!node) return "";
  const candidates = [node?.path, node?.data?.path, node?.data?.filePath];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const value = String(candidate || "").trim();
    if (value && value.includes(".sy")) {
      return value.startsWith("/") ? value : `/${value}`;
    }
  }
  return "";
}

function normalizeDocTitle(rawTitle) {
  const text = String(rawTitle || "").trim();
  if (!text) return "";
  return text.endsWith(".sy") ? text.slice(0, -3) : text;
}

function buildDocPath(parentPath, docId) {
  const safeId = extractDocIdFromValue(docId);
  if (!safeId) {
    return String(parentPath || "").trim();
  }
  const base = String(parentPath || "").trim();
  const segment = `${safeId}.sy`;
  if (!base || base === "/") {
    return `/${segment}`;
  }
  return `${base.replace(/\/$/, "")}/${segment}`;
}

function getShareSignature(shares) {
  if (!Array.isArray(shares) || shares.length === 0) return "";
  const rows = shares
    .map((share) => ({
      id: String(share?.id || ""),
      type: String(share?.type || ""),
      slug: String(share?.slug || ""),
      docId: String(share?.docId || ""),
      notebookId: String(share?.notebookId || ""),
      updatedAt: String(share?.updatedAt || ""),
      expiresAt: String(share?.expiresAt || ""),
      visitorLimit: String(share?.visitorLimit || ""),
      title: String(share?.title || ""),
    }))
    .filter((row) => row.id);
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows.map((row) => Object.values(row).join("|")).join(";");
}

function findDocTreeNode(nodes, docId) {
  if (!Array.isArray(nodes) || !isValidDocId(docId)) return null;
  const stack = [...nodes];
  while (stack.length) {
    const node = stack.pop();
    const nodeId = getDocTreeNodeId(node);
    if (nodeId && nodeId === docId) return node;
    const children = getDocTreeChildren(node);
    if (children.length) stack.push(...children);
  }
  return null;
}

function getDocTreeSortValue(node) {
  if (!node) return null;
  const candidates = [
    node.sort,
    node.sortOrder,
    node.sortIndex,
    node.sortId,
    node.sortID,
    node.sort_id,
    node.order,
    node.orderIndex,
    node.index,
  ];
  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function sortDocTreeNodes(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((node, idx) => ({node, idx, sort: getDocTreeSortValue(node)}))
    .sort((a, b) => {
      const aSort = Number.isFinite(a.sort) ? a.sort : a.idx;
      const bSort = Number.isFinite(b.sort) ? b.sort : b.idx;
      if (aSort === bSort) return a.idx - b.idx;
      return aSort - bSort;
    })
    .map((entry) => entry.node);
}

function flattenDocTree(nodes, out = [], parentId = "") {
  if (!Array.isArray(nodes)) return out;
  const ordered = sortDocTreeNodes(nodes);
  ordered.forEach((node, index) => {
    const id = getDocTreeNodeId(node);
    const title = String(node?.name || node?.title || node?.content || node?.label || "");
    const nodeParent = getDocTreeNodeParentId(node) || "";
    const validId = isValidDocId(id);
    const sortValue = getDocTreeSortValue(node);
    const sortIndex = Number.isFinite(sortValue) ? sortValue : index;
    if (validId) {
      out.push({
        docId: id,
        title,
        parentId: nodeParent || parentId || "",
        sortIndex,
      });
    }
    const children = getDocTreeChildren(node);
    if (children.length) {
      const nextParent = validId ? id : parentId;
      flattenDocTree(children, out, nextParent);
    }
  });
  return out;
}

class SiYuanSharePlugin extends Plugin {
  constructor(options) {
    super(options);
    this.settings = {
      siteUrl: "",
      apiKey: "",
      uploadAssetConcurrency: DEFAULT_UPLOAD_ASSET_CONCURRENCY,
      uploadChunkConcurrency: DEFAULT_UPLOAD_CHUNK_CONCURRENCY,
      sites: [],
      activeSiteId: "",
      refWarningDisabled: false,
    };
    this.remoteUploadLimits = null;
    this.remoteFeatures = null;
    this.uploadTuner = {avgSpeed: 0, samples: 0};
    this.shares = [];
    this.siteShares = {};
    this.shareOptions = {};
    this.dockElement = null;
    this.workspaceDir = "";
    this.hasNodeFs = !!(fs && path);
    this.currentDoc = {id: "", title: ""};
    this.remoteUser = null;
    this.remoteVerifiedAt = 0;
    this.notebooks = [];
    this.docIconCache = new Map();
    this.docTreeContainer = null;
    this.docTreeObserver = null;
    this.docTreeBindTimer = null;
    this.docTreeRefreshTimer = null;
    this.backgroundSyncTimer = null;
    this.backgroundSyncing = false;
    this.backgroundSyncDelayMs = 3 * 60 * 1000;
    this.backgroundSyncMinDelayMs = 3 * 60 * 1000;
    this.backgroundSyncMaxDelayMs = 3 * 60 * 60 * 1000;
    this.backgroundSyncHiddenMinDelayMs = 10 * 60 * 1000;
    this.backgroundSyncHiddenMaxDelayMs = 3 * 60 * 60 * 1000;
    this.progressDialog = null;
    this.settingVisible = false;
    this.settingEls = {
      siteInput: null,
      apiKeyInput: null,
      siteSelect: null,
      siteNameInput: null,
      currentWrap: null,
      sharesWrap: null,
      envHint: null,
    };
    this.settingLayoutObserver = null;
  }

  t(key, vars) {
    const text = this.i18n?.[key] ?? key;
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (match, name) => {
      if (!Object.prototype.hasOwnProperty.call(vars, name)) return match;
      const value = vars[name];
      return value == null ? "" : String(value);
    });
  }

  notify(message, ...rest) {
    const prefix = this.displayName || this.name || "SiYuan Share";
    const text = prefix ? `${prefix}: ${message}` : message;
    showMessage(text, ...rest);
  }

  onload() {
    setGlobalI18nProvider(this.t.bind(this));
    this.loadState().catch((err) => {
      console.error(err);
      this.notify(this.t("siyuanShare.message.pluginInitFailed", {error: err.message || err}));
    });

    this.addIcons(`<symbol id="iconSiyuanShare" viewBox="0 0 24 24">
  <path fill="currentColor" d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.03-.47-.09-.7l7.02-4.11c.53.5 1.23.81 2.06.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.03.47.09.7L8.91 9.81C8.38 9.31 7.68 9 6.84 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.84 0 1.54-.31 2.07-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.52 1.23 2.75 2.75 2.75S21 23.52 21 22s-1.34-2.75-3-2.75z"/>
</symbol>`);

    this.initSettingPanel();
    this.addCommand({
      langKey: "siyuanShare.openDock",
      hotkey: "",
      callback: () => this.openShareDock(),
    });

    this.eventBus.on("click-editortitleicon", this.onEditorTitleMenu);
    this.eventBus.on("open-menu-doctree", this.onDocTreeMenu);
    this.eventBus.on("switch-protyle", this.onSwitchProtyle);
    this.eventBus.on("loaded-protyle-static", this.onLoadedProtyle);
    this.eventBus.on("loaded-protyle-dynamic", this.onLoadedProtyle);

    this.bindDocTreeLater();
    void this.refreshCurrentDocContext();
  }

  onunload() {
    setGlobalI18nProvider(null);
    if (this.dockElement) {
      this.dockElement.removeEventListener("click", this.onDockClick);
      this.dockElement.removeEventListener("change", this.onDockChange);
    }
    this.eventBus.off("click-editortitleicon", this.onEditorTitleMenu);
    this.eventBus.off("open-menu-doctree", this.onDocTreeMenu);
    this.eventBus.off("switch-protyle", this.onSwitchProtyle);
    this.eventBus.off("loaded-protyle-static", this.onLoadedProtyle);
    this.eventBus.off("loaded-protyle-dynamic", this.onLoadedProtyle);
    if (this.docTreeBindTimer) {
      clearInterval(this.docTreeBindTimer);
      this.docTreeBindTimer = null;
    }
    if (this.docTreeRefreshTimer) {
      clearTimeout(this.docTreeRefreshTimer);
      this.docTreeRefreshTimer = null;
    }
    this.detachDocTree();
    this.clearDocTreeMarks();
    if (this.settingEls.sharesWrap) {
      this.settingEls.sharesWrap.removeEventListener("click", this.onSettingSharesClick);
    }
    if (this.settingEls.currentWrap) {
      this.settingEls.currentWrap.removeEventListener("click", this.onSettingCurrentClick);
    }
    if (this.settingLayoutObserver) {
      try {
        this.settingLayoutObserver.disconnect();
      } catch {
        // ignore
      }
      this.settingLayoutObserver = null;
    }
    if (this.progressDialog) {
      try {
        this.progressDialog.destroy();
      } catch {
        // ignore
      }
      this.progressDialog = null;
    }
    this.stopBackgroundSync();
  }

  async uninstall() {
    await this.removeData(STORAGE_SETTINGS);
    await this.removeData(STORAGE_SHARES);
    await this.removeData(STORAGE_SITE_SHARES);
  }

  onSwitchProtyle = ({detail}) => {
    void this.refreshCurrentDocContext(detail?.protyle);
  };

  onLoadedProtyle = ({detail}) => {
    void this.refreshCurrentDocContext(detail?.protyle);
  };

  bindDocTreeLater() {
    if (this.docTreeBindTimer) clearInterval(this.docTreeBindTimer);
    this.docTreeBindTimer = setInterval(() => {
      const attached = this.attachDocTree();
      if (attached) {
        clearInterval(this.docTreeBindTimer);
        this.docTreeBindTimer = null;
      }
      this.refreshDocTreeMarks();
    }, 800);
  }

  attachDocTree({skipRefresh = false} = {}) {
    const container = pickDocTreeContainer();
    if (!container) return false;
    if (container === this.docTreeContainer && this.docTreeContainer?.isConnected) return false;
    this.detachDocTree();
    this.docTreeContainer = container;
    this.docTreeContainer.setAttribute("data-sps-share-tree", "1");
    this.docTreeContainer.addEventListener("click", this.onDocTreeClick, true);
    this.docTreeObserver = new MutationObserver(() => this.scheduleDocTreeRefresh());
    this.docTreeObserver.observe(this.docTreeContainer, {childList: true, subtree: true});
    if (!skipRefresh) {
      this.refreshDocTreeMarks();
    }
    return true;
  }

  detachDocTree() {
    if (this.docTreeContainer) {
      this.docTreeContainer.removeAttribute("data-sps-share-tree");
      this.docTreeContainer.removeEventListener("click", this.onDocTreeClick, true);
    }
    if (this.docTreeObserver) {
      this.docTreeObserver.disconnect();
      this.docTreeObserver = null;
    }
    this.docTreeContainer = null;
  }

  scheduleDocTreeRefresh() {
    if (this.docTreeRefreshTimer) return;
    this.docTreeRefreshTimer = setTimeout(() => {
      this.docTreeRefreshTimer = null;
      this.refreshDocTreeMarks();
    }, 80);
  }

  refreshDocTreeMarksLater() {
    this.attachDocTree({skipRefresh: true});
    this.refreshDocTreeMarks();
    this.scheduleDocTreeRefresh();
    this.bindDocTreeLater();
    setTimeout(() => this.scheduleDocTreeRefresh(), 300);
    setTimeout(() => this.scheduleDocTreeRefresh(), 800);
  }

  clearDocTreeMarks() {
    const clearScope = (scope) => {
      scope.querySelectorAll(`.${TREE_SHARE_CLASS}`).forEach((el) => el.remove());
      scope.querySelectorAll(`.${TREE_SHARED_CLASS}`).forEach((el) => {
        el.classList.remove(TREE_SHARED_CLASS);
      });
    };
    const hasTreeRoot = this.docTreeContainer && this.docTreeContainer.isConnected;
    if (hasTreeRoot) {
      clearScope(this.docTreeContainer);
      clearScope(document);
      return;
    }
    clearScope(document);
  }

  refreshDocTreeMarks() {
    if (this.docTreeContainer && !this.docTreeContainer.isConnected) {
      this.detachDocTree();
      this.bindDocTreeLater();
    }
    if (!this.docTreeContainer || !isElementVisiblySized(this.docTreeContainer)) {
      this.attachDocTree({skipRefresh: true});
    }
    const hasTreeRoot = this.docTreeContainer && this.docTreeContainer.isConnected;
    const applyMarks = (scope, requireFilter) => {
      let items = scope.querySelectorAll(".b3-list-item");
      if (!items.length) {
        items = scope.querySelectorAll("[data-type^='navigation'], [data-type*='navigation'], [data-type='notebook']");
      }
      items.forEach((rawItem) => {
        const item =
          rawItem.classList?.contains("b3-list-item") ? rawItem : rawItem.closest?.(".b3-list-item") || rawItem;
        if (requireFilter && !isProbablyDocTreeItem(item)) return;
        const info = resolveTreeItemInfo(item);
        if (!info?.id) return;
        const share = info.isNotebook ? this.getShareByNotebookId(info.id) : this.getShareByDocId(info.id);
        const titleEl =
          item.querySelector(".b3-list-item__text") ||
          item.querySelector(".b3-list-item__title") ||
          item.querySelector(".b3-list-item__name") ||
          item.querySelector(".b3-list-item__label") ||
          item.querySelector(".b3-list-item__content") ||
          item;
        const existing = titleEl.querySelector(`.${TREE_SHARE_CLASS}`);
        if (share) {
          item.classList.add(TREE_SHARED_CLASS);
          let icon = existing;
          if (!icon) {
            icon = document.createElement("span");
            icon.className = TREE_SHARE_CLASS;
            titleEl.appendChild(icon);
          }
          icon.setAttribute("data-share-type", share.type);
          icon.setAttribute("data-share-id", info.id);
          icon.innerHTML = `<svg><use xlink:href="#${TREE_SHARE_ICON_ID}"></use></svg>`;
        } else {
          item.classList.remove(TREE_SHARED_CLASS);
          if (existing) existing.remove();
        }
      });
    };
    if (hasTreeRoot) {
      applyMarks(this.docTreeContainer, false);
      applyMarks(document, true);
      return;
    }
    applyMarks(document, true);
  }

  onDocTreeClick = (event) => {
    const icon = event.target?.closest?.(`.${TREE_SHARE_CLASS}`);
    if (!icon) return;
    const type = icon.getAttribute("data-share-type");
    const id = icon.getAttribute("data-share-id");
    if (!type || !id) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const item = icon.closest(".b3-list-item") || icon.parentElement;
    const title = findTitleFromTree(item) || id;
    void this.openShareDialogFor({type, id, title});
  };

  getDocIdFromProtyle(protyle) {
    const pid = protyle?.id;
    if (isValidDocId(pid)) return pid.trim();
    const rootID = protyle?.block?.rootID;
    if (isValidDocId(rootID)) return rootID.trim();
    const id = protyle?.block?.id;
    if (isValidDocId(id)) return id.trim();
    return "";
  }

  async fetchBlockRow(blockId) {
    if (!isValidDocId(blockId)) return null;
    try {
      const resp = await fetchSyncPost("/api/query/sql", {
        stmt: `SELECT id, root_id AS rootId, content AS content, type AS type, box AS box, path AS path FROM blocks WHERE id='${blockId}' LIMIT 1`,
      });
      if (resp && resp.code === 0 && Array.isArray(resp.data) && resp.data.length > 0) {
        return resp.data[0] || null;
      }
    } catch (err) {
      console.error(err);
    }
    return null;
  }

  async fetchBlockAttrs(blockId) {
    if (!isValidDocId(blockId)) return null;
    try {
      const resp = await fetchSyncPost("/api/attr/getBlockAttrs", {id: blockId});
      if (resp && resp.code === 0 && resp.data && typeof resp.data === "object") {
        return resp.data;
      }
    } catch (err) {
      // ignore
    }
    return null;
  }

  async fetchDocIconsBySQL(docIds) {
    const out = new Map();
    if (!Array.isArray(docIds) || docIds.length === 0) return out;
    const ids = Array.from(
      new Set(docIds.map((id) => String(id || "").trim()).filter((id) => isValidDocId(id))),
    );
    if (!ids.length) return out;
    const quoted = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
    const candidates = [
      `SELECT block_id AS blockId, name, value FROM attributes WHERE block_id IN (${quoted}) AND name IN ('icon','emoji','iconEmoji')`,
      `SELECT block_id AS blockId, name, value FROM attrs WHERE block_id IN (${quoted}) AND name IN ('icon','emoji','iconEmoji')`,
      `SELECT block_id AS blockId, name, value FROM block_attributes WHERE block_id IN (${quoted}) AND name IN ('icon','emoji','iconEmoji')`,
      `SELECT id AS blockId, icon AS value FROM blocks WHERE id IN (${quoted})`,
    ];
    for (const stmt of candidates) {
      let resp = null;
      try {
        resp = await fetchSyncPost("/api/query/sql", {stmt});
      } catch {
        resp = null;
      }
      if (!resp || resp.code !== 0 || !Array.isArray(resp.data)) {
        continue;
      }
      for (const row of resp.data) {
        const blockId = String(row?.blockId || row?.block_id || row?.id || "").trim();
        if (!isValidDocId(blockId)) continue;
        let rawValue = row?.value;
        if (rawValue == null && typeof row?.icon !== "undefined") rawValue = row.icon;
        const icon = normalizeDocIconValue(rawValue);
        if (!icon) continue;
        if (!out.has(blockId)) out.set(blockId, icon);
      }
      break;
    }
    return out;
  }

  async fillDocIcons(docs) {
    if (!Array.isArray(docs) || docs.length === 0) return;
    if (!this.docIconCache) this.docIconCache = new Map();
    const pending = [];
    docs.forEach((doc) => {
      const docId = String(doc?.docId || "").trim();
      if (!isValidDocId(docId)) return;
      const provided = normalizeDocIconValue(doc?.icon);
      if (provided) {
        this.docIconCache.set(docId, provided);
        doc.icon = provided;
        return;
      }
      if (this.docIconCache.has(docId)) {
        const cached = this.docIconCache.get(docId) || "";
        if (cached) {
          doc.icon = cached;
          return;
        }
      }
      pending.push(docId);
    });
    const missing = Array.from(new Set(pending));
    if (!missing.length) return;
    const sqlMap = await this.fetchDocIconsBySQL(missing);
    sqlMap.forEach((icon, id) => this.docIconCache.set(id, icon));
    const still = missing.filter((id) => !this.docIconCache.has(id) || !this.docIconCache.get(id));
    if (still.length) {
      const tasks = still.map((id) => async () => {
        const attrs = await this.fetchBlockAttrs(id);
        const icon = extractDocIconFromAttrs(attrs);
        if (icon) {
          this.docIconCache.set(id, icon);
        } else {
          this.docIconCache.set(id, "");
        }
      });
      await runTasksWithConcurrency(tasks, 6);
    }
    docs.forEach((doc) => {
      const docId = String(doc?.docId || "").trim();
      if (!isValidDocId(docId)) return;
      if (normalizeDocIconValue(doc?.icon)) return;
      const cached = this.docIconCache.get(docId) || "";
      if (cached) doc.icon = cached;
    });
  }

  async resolveDocIcon(docId) {
    const id = String(docId || "").trim();
    if (!isValidDocId(id)) return "";
    if (!this.docIconCache) this.docIconCache = new Map();
    if (this.docIconCache.has(id)) {
      const cached = this.docIconCache.get(id) || "";
      if (cached) return cached;
    }
    const sqlMap = await this.fetchDocIconsBySQL([id]);
    if (sqlMap.has(id)) {
      const icon = sqlMap.get(id) || "";
      this.docIconCache.set(id, icon);
      return icon;
    }
    const attrs = await this.fetchBlockAttrs(id);
    const icon = extractDocIconFromAttrs(attrs);
    this.docIconCache.set(id, icon || "");
    return icon || "";
  }

  async resolveIconUpload(
    iconValue,
    {docId = "", notebookId = "", usedUploadPaths = null, assetMap = null, iconUploadMap = null, controller} = {},
  ) {
    const icon = normalizeDocIconValue(iconValue);
    if (!icon) return "";
    const apiUrl = normalizeApiIconUrl(icon);
    if (apiUrl) {
      if (iconUploadMap && iconUploadMap.has(apiUrl)) {
        return iconUploadMap.get(apiUrl) || "";
      }
      try {
        const {blob, contentType} = await this.fetchIconUrlBlob(apiUrl, controller);
        const ext = guessImageExtension(contentType, apiUrl);
        const baseName = isValidDocId(docId) ? `doc-${docId}` : `icon-${randomSlug(8)}`;
        const rawPath = `assets/share-icons/${baseName}.${ext}`;
        const uploadPath = sanitizeAssetUploadPath(rawPath, usedUploadPaths) || normalizeAssetPath(rawPath);
        if (!uploadPath) return "";
        if (assetMap && !assetMap.has(uploadPath)) {
          assetMap.set(uploadPath, {asset: {path: uploadPath, blob}, docId});
        }
        if (usedUploadPaths) usedUploadPaths.add(uploadPath);
        if (iconUploadMap) iconUploadMap.set(apiUrl, uploadPath);
        return uploadPath;
      } catch (err) {
        if (isAbortError(err)) throw err;
        console.warn("Icon url download failed", {url: apiUrl, error: err});
        if (iconUploadMap) iconUploadMap.set(apiUrl, "");
        return "";
      }
    }
    const kind = getDocIconKind(icon);
    if (kind === "emoji" || kind === "url" || kind === "data") return icon;
    if (kind !== "asset") return icon;
      let assetPath = normalizeDocIconAssetPath(icon);
      if (!assetPath) return "";
      const cacheKey = assetPath;
      if (iconUploadMap && iconUploadMap.has(cacheKey)) {
        return iconUploadMap.get(cacheKey) || "";
      }
      let resolvedAsset = null;
      if (assetPath.toLowerCase().startsWith("emojis/") && !DOC_ICON_IMAGE_EXT_RE.test(assetPath)) {
        try {
          resolvedAsset = await this.fetchEmojiAssetBlob(assetPath, controller, notebookId);
          if (resolvedAsset?.path) assetPath = resolvedAsset.path;
        } catch (err) {
          if (isAbortError(err)) throw err;
          console.warn("Emoji icon lookup failed", {path: assetPath, error: err});
          if (iconUploadMap) iconUploadMap.set(cacheKey, "");
          return "";
        }
      }
      if (iconUploadMap && iconUploadMap.has(assetPath)) {
        return iconUploadMap.get(assetPath) || "";
      }
      if (usedUploadPaths && usedUploadPaths.has(assetPath)) {
        if (iconUploadMap) {
          iconUploadMap.set(cacheKey, assetPath);
          iconUploadMap.set(assetPath, assetPath);
        }
        return assetPath;
      }
      const uploadPath = sanitizeAssetUploadPath(assetPath, usedUploadPaths) || normalizeAssetPath(assetPath);
      if (!uploadPath) return "";
      try {
        const asset = resolvedAsset || (await this.fetchAssetBlob(assetPath, controller, notebookId));
        if (assetMap && !assetMap.has(uploadPath)) {
          assetMap.set(uploadPath, {asset: {path: uploadPath, blob: asset.blob}, docId});
        }
        if (usedUploadPaths) usedUploadPaths.add(uploadPath);
        if (iconUploadMap) {
          iconUploadMap.set(cacheKey, uploadPath);
          iconUploadMap.set(assetPath, uploadPath);
        }
        return uploadPath;
      } catch (err) {
        if (isAbortError(err)) throw err;
        console.warn("Icon asset download failed", {path: assetPath, error: err});
        return "";
    }
  }

  async resolveDocInfoFromAnyId(anyId) {
    if (!isValidDocId(anyId)) return {docId: "", title: ""};
    const row = await this.fetchBlockRow(anyId);
    if (!row) return {docId: "", title: ""};

    const type = row.type;
    if (type === "d") {
      return {docId: anyId, title: typeof row.content === "string" ? row.content : ""};
    }

    const rootId = row.rootId;
    if (!isValidDocId(rootId)) return {docId: "", title: ""};
    const rootRow = await this.fetchBlockRow(rootId);
    const title = rootRow && typeof rootRow.content === "string" ? rootRow.content : "";
    return {docId: rootId, title};
  }

  extractAnyBlockIdFromDOM() {
    const candidates = [];
    const pushFromEl = (el) => {
      if (!el || typeof el.getAttribute !== "function") return;
      const attrs = [
        "data-node-id",
        "data-id",
        "data-block-id",
        "data-root-id",
        "data-doc-id",
      ];
      for (const attr of attrs) {
        const v = el.getAttribute(attr);
        if (isValidDocId(v)) {
          candidates.push(v.trim());
          return;
        }
      }
      if (el.dataset) {
        for (const v of Object.values(el.dataset)) {
          if (isValidDocId(v)) {
            candidates.push(v.trim());
            return;
          }
        }
      }
      if (isValidDocId(el.id)) candidates.push(el.id.trim());
    };

    // 1) From active element upwards.
    let el = document.activeElement;
    if (el && typeof el.closest === "function" && el.closest(".protyle")) {
      for (let i = 0; el && i < 20; i++) {
        pushFromEl(el);
        el = el.parentElement;
      }
    }

    // 2) From focused protyle block.
    const protyleEls = Array.from(document.querySelectorAll(".protyle")).filter((p) => isElementVisiblySized(p));
    const bestProtyle = protyleEls.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    })[0];

    pushFromEl(bestProtyle);
    const blockInProtyle = bestProtyle?.querySelector?.("[data-node-id]");
    pushFromEl(blockInProtyle);

    return candidates.find(Boolean) || "";
  }

  async refreshCurrentDocContext(protyle) {
    const p = protyle || pickActiveProtyle() || globalThis?.siyuan?.mobile?.editor || globalThis?.siyuan?.mobile?.popEditor;
    let docId = this.getDocIdFromProtyle(p);
    let title = "";

    if (!docId) {
      // Fallback 1: use block id from protyle.block.id and resolve to root doc id.
      const isFromVisibleProtyle = !p?.element || isElementVisiblySized(p?.element);
      const anyId = isFromVisibleProtyle ? p?.block?.id : "";
      if (isValidDocId(anyId)) {
        const info = await this.resolveDocInfoFromAnyId(anyId);
        docId = info.docId;
        title = info.title;
      }
    }

    if (!docId) {
      // Fallback 2: try DOM (active block id) and resolve to root doc id.
      const anyId = this.extractAnyBlockIdFromDOM();
      if (isValidDocId(anyId)) {
        const info = await this.resolveDocInfoFromAnyId(anyId);
        docId = info.docId;
        title = info.title;
      }
    }

    if (!docId) {
      // Fallback 3: backStack (desktop).
      const hasVisibleProtyle = Array.from(document.querySelectorAll(".protyle")).some((el) => isElementVisiblySized(el));
      if (!hasVisibleProtyle) {
        // When no document is opened, backStack may still contain the last doc.
        // Avoid treating it as current.
      } else {
      try {
        const stack = globalThis?.siyuan?.backStack;
        if (Array.isArray(stack) && stack.length > 0) {
          for (let i = stack.length - 1; i >= 0; i--) {
            const item = stack[i];
            const id = item?.protyle?.block?.rootID || item?.id;
            if (isValidDocId(id)) {
              const info = await this.resolveDocInfoFromAnyId(id);
              docId = info.docId;
              title = info.title;
              break;
            }
          }
        }
      } catch {
        // ignore
      }
      }
    }

    if (!docId) {
      this.currentDoc = {id: "", title: ""};
      this.updateTopBarState();
      this.renderSettingCurrent?.();
      return;
    }

    if (this.currentDoc.id !== docId) {
      if (!title) {
        const info = await this.resolveDocInfoFromAnyId(docId);
        title = info.title;
      }
      this.currentDoc = {id: docId, title: title || ""};
    }

    this.updateTopBarState();
    this.renderSettingCurrent?.();
  }

  updateTopBarState() {
    this.refreshDocTreeMarks();
  }

  getShareById(shareId) {
    if (!shareId) return null;
    return this.shares.find((s) => String(s.id) === String(shareId)) || null;
  }

  getShareByDocId(docId) {
    if (!isValidDocId(docId)) return null;
    return this.shares.find((s) => s.type === SHARE_TYPES.DOC && s.docId === docId) || null;
  }

  getShareByNotebookId(notebookId) {
    if (!isValidNotebookId(notebookId)) return null;
    return (
      this.shares.find((s) => s.type === SHARE_TYPES.NOTEBOOK && s.notebookId === notebookId) || null
    );
  }

  getShareUrl(share) {
    if (!share) return "";
    const base = normalizeUrlBase(this.settings.siteUrl);
    if (share.url) return share.url;
    const path = share.path || (share.slug ? `/s/${encodeURIComponent(share.slug)}` : "");
    if (!base || !path) return "";
    return `${base}${path}`;
  }

  async openShareDialogFor({type = SHARE_TYPES.DOC, id = "", title = ""} = {}) {
    const t = this.t.bind(this);
    const itemType = type === SHARE_TYPES.NOTEBOOK ? SHARE_TYPES.NOTEBOOK : SHARE_TYPES.DOC;
    let itemId = String(id || "").trim();
    if (!itemId && itemType === SHARE_TYPES.DOC) {
      for (let i = 0; i < 5; i++) {
        await this.refreshCurrentDocContext();
        if (isValidDocId(this.currentDoc.id)) break;
        await new Promise((r) => setTimeout(r, 120));
      }
      itemId = this.currentDoc.id;
    }
    if (!itemId) {
      this.notify(t("siyuanShare.message.noCurrentDoc"));
      return;
    }

    let itemTitle = title || itemId;
    if (itemType === SHARE_TYPES.DOC) {
      if (!itemTitle || itemTitle === itemId) {
        const info = await this.resolveDocInfoFromAnyId(itemId);
        itemTitle = info?.title || itemTitle || t("siyuanShare.label.unknown");
      }
    } else {
      if (!this.notebooks.length) {
        await this.refreshNotebookOptions({silent: true});
      }
      const notebook = this.notebooks.find((n) => n.id === itemId);
      itemTitle = notebook?.name || itemTitle || t("siyuanShare.label.unknown");
    }

    const typeLabel =
      itemType === SHARE_TYPES.NOTEBOOK ? t("siyuanShare.label.notebook") : t("siyuanShare.label.document");
    const passwordKeepToken = "__KEEP__";
    const getShare = () =>
      itemType === SHARE_TYPES.NOTEBOOK ? this.getShareByNotebookId(itemId) : this.getShareByDocId(itemId);
    const buildViewState = () => {
      const share = getShare();
      const url = share ? this.getShareUrl(share) : "";
      const hasPassword = !!share?.hasPassword;
      const expiresAt = normalizeTimestampMs(share?.expiresAt || 0);
      const expiresInputValue = expiresAt ? toDateTimeLocalInput(expiresAt) : "";
      const visitorLimitValue = Number.isFinite(Number(share?.visitorLimit))
        ? Math.max(0, Math.floor(Number(share.visitorLimit)))
        : 0;
      const visitorInputValue = visitorLimitValue > 0 ? String(visitorLimitValue) : "";
      const currentPasswordLabel = hasPassword
        ? t("siyuanShare.label.passwordSet")
        : t("siyuanShare.label.passwordNotSet");
      const currentExpiresLabel = expiresAt ? this.formatTime(expiresAt) : t("siyuanShare.label.expiresNotSet");
      const currentVisitorLabel =
        visitorLimitValue > 0
          ? t("siyuanShare.label.visitorLimitCount", {count: visitorLimitValue})
          : t("siyuanShare.label.visitorLimitNotSet");
      const passwordInputValue = share && hasPassword ? passwordKeepToken : "";
      const passwordPlaceholder = share
        ? (hasPassword ? t("siyuanShare.hint.passwordKeep") : t("siyuanShare.label.passwordNotSet"))
        : t("siyuanShare.hint.passwordOptional");
      return {
        share,
        url,
        expiresInputValue,
        visitorLimitValue,
        visitorInputValue,
        currentPasswordLabel,
        currentExpiresLabel,
        currentVisitorLabel,
        passwordInputValue,
        passwordPlaceholder,
      };
    };

  const renderContent = () => {
      const state = buildViewState();
      const share = state.share;
      const url = state.url;
      const expiresInputValue = state.expiresInputValue;
      const visitorInputValue = state.visitorInputValue;
      const currentPasswordLabel = state.currentPasswordLabel;
      const currentExpiresLabel = state.currentExpiresLabel;
      const currentVisitorLabel = state.currentVisitorLabel;
      const passwordInputValue = state.passwordInputValue;
      const passwordPlaceholder = state.passwordPlaceholder;
      const optionKey = share?.id ? String(share.id) : "";
      const optionValue =
        optionKey && Object.prototype.hasOwnProperty.call(this.shareOptions || {}, optionKey)
          ? this.shareOptions[optionKey]
          : null;
      const includeChildrenDefault =
        typeof optionValue === "boolean"
          ? optionValue
          : typeof share?.includeChildren === "boolean"
            ? share.includeChildren
            : false;
      const showDocOptions = itemType === SHARE_TYPES.DOC;
      return `<div class="siyuan-plugin-share sps-dialog-body">
  <div class="siyuan-plugin-share__section">
    <div class="siyuan-plugin-share__title">${escapeHtml(typeLabel)}</div>
    <div>${escapeHtml(itemTitle)}</div>
    <div class="siyuan-plugin-share__muted siyuan-plugin-share__mono">${escapeHtml(
      t("siyuanShare.label.id"),
    )}: ${escapeHtml(itemId)}</div>
  </div>
  <div class="siyuan-plugin-share__section">
    <div class="siyuan-plugin-share__title">${escapeHtml(t("siyuanShare.section.accessSettings"))}</div>
    <div class="siyuan-plugin-share__grid">
      <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.label.accessPassword"))}</div>
      <input id="sps-share-password" type="password" class="b3-text-field" value="${escapeAttr(
        passwordInputValue,
      )}" placeholder="${escapeAttr(passwordPlaceholder)}" />
      <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.label.expiresAt"))}</div>
      <input id="sps-share-expires" type="datetime-local" step="60" class="b3-text-field" value="${escapeAttr(
        expiresInputValue,
      )}" />
      <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.label.visitorLimit"))}</div>
      <input id="sps-share-visitor-limit" type="number" min="0" step="1" class="b3-text-field" value="${escapeAttr(
        visitorInputValue,
      )}" placeholder="${escapeAttr(t("siyuanShare.hint.visitorLimit"))}" />
    </div>
    <div class="siyuan-plugin-share__muted">${escapeHtml(
      currentPasswordLabel,
    )} | ${escapeHtml(currentExpiresLabel)} | ${escapeHtml(currentVisitorLabel)}</div>
  </div>
  ${
    showDocOptions
      ? `<div class="siyuan-plugin-share__section">
    <div class="siyuan-plugin-share__title">${escapeHtml(t("siyuanShare.section.shareOptions"))}</div>
    <label class="sps-checkbox">
      <input id="sps-share-include-children" type="checkbox"${includeChildrenDefault ? " checked" : ""} />
      <span>${escapeHtml(t("siyuanShare.label.includeChildren"))}</span>
    </label>
    <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.hint.includeChildren"))}</div>
  </div>`
      : ""
  }
  <div class="siyuan-plugin-share__section">
    <div class="siyuan-plugin-share__title">${escapeHtml(t("siyuanShare.section.shareLink"))}</div>
    ${
      share
        ? `<div class="siyuan-plugin-share__muted">${escapeHtml(
            t("siyuanShare.label.shareId"),
          )}: <span class="siyuan-plugin-share__mono">${escapeHtml(share.slug || "")}</span></div>
      <div class="siyuan-plugin-share__actions" style="align-items: center;">
        <input class="b3-text-field fn__flex-1 siyuan-plugin-share__mono" readonly value="${escapeAttr(url)}" />
        <button class="b3-button b3-button--outline" data-action="copy" data-share-id="${escapeAttr(
          share.id,
        )}">${escapeHtml(t("siyuanShare.action.copyLink"))}</button>
        <button class="b3-button b3-button--outline" data-action="copy-info" data-share-id="${escapeAttr(
          share.id,
        )}">${escapeHtml(t("siyuanShare.action.copyShareInfo"))}</button>
      </div>
      <div class="siyuan-plugin-share__actions">
        <button class="b3-button b3-button--outline" data-action="update" data-share-id="${escapeAttr(
          share.id,
        )}">${escapeHtml(t("siyuanShare.action.updateShare"))}</button>
        <button class="b3-button b3-button--outline" data-action="update-access" data-share-id="${escapeAttr(
          share.id,
        )}">${escapeHtml(t("siyuanShare.action.updateAccess"))}</button>
        <button class="b3-button b3-button--outline" data-action="delete" data-share-id="${escapeAttr(
          share.id,
        )}">${escapeHtml(t("siyuanShare.action.deleteShare"))}</button>
      </div>`
        : `<div class="siyuan-plugin-share__muted">${escapeHtml(
            t("siyuanShare.message.noShareYet"),
          )}</div>
      <div class="siyuan-plugin-share__actions">
        <button class="b3-button b3-button--outline" data-action="share" data-item-id="${escapeAttr(
          itemId,
        )}">${escapeHtml(t("siyuanShare.action.createShare"))}</button>
      </div>`
    }
  </div>
</div>
<div class="b3-dialog__action">
  <button class="b3-button b3-button--cancel" data-action="close">${escapeHtml(
    t("siyuanShare.action.close"),
  )}</button>
  <div class="fn__space"></div>
  <button class="b3-button b3-button--text" data-action="open-settings">${escapeHtml(
    t("siyuanShare.action.openSettings"),
  )}</button>
</div>`;
    };
    const content = `<div class="sps-share-dialog-content">${renderContent()}</div>`;

    const readShareOptions = (root, currentShare) => {
      const passwordInput = root?.querySelector?.("#sps-share-password");
      const expiresInput = root?.querySelector?.("#sps-share-expires");
      const visitorInput = root?.querySelector?.("#sps-share-visitor-limit");
      const includeChildrenInput = root?.querySelector?.("#sps-share-include-children");
      const passwordRaw = (passwordInput?.value || "").trim();
      const expiresAt = parseDateTimeLocalInput(expiresInput?.value || "");
      const visitorRaw = (visitorInput?.value || "").trim();
      const visitorParsed = Number(visitorRaw);
      const visitorLimit = Number.isFinite(visitorParsed)
        ? Math.max(0, Math.floor(visitorParsed))
        : null;
      const hasExistingPassword = !!currentShare?.hasPassword;
      const hasExistingExpires = normalizeTimestampMs(currentShare?.expiresAt || 0) > 0;
      const hasExistingVisitorLimit = Number(currentShare?.visitorLimit || 0) > 0;
      const password = passwordRaw === passwordKeepToken ? "" : passwordRaw;
      const includeChildren = !!includeChildrenInput?.checked;
      return {
        password,
        clearPassword: !!currentShare && hasExistingPassword && passwordRaw === "",
        expiresAt,
        clearExpires: !!currentShare && hasExistingExpires && !expiresAt,
        visitorLimit,
        clearVisitorLimit: !!currentShare && hasExistingVisitorLimit && visitorRaw === "",
        includeChildren,
      };
    };

    const onClick = (event) => {
      const btn = event.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      if (!action) return;

      void (async () => {
        try {
          if (action === "close") {
            dialog.destroy();
            return;
          }
          if (action === "open-settings") {
            this.openSetting();
            setTimeout(() => this.applySettingWideLayout(), 80);
            return;
          }
          if (action === "copy") {
            const shareId = btn.getAttribute("data-share-id");
            await this.copyShareLink(shareId);
            return;
          }
          if (action === "copy-info") {
            const shareId = btn.getAttribute("data-share-id");
            await this.copyShareInfo(shareId, {title: itemTitle});
            return;
          }
          if (action === "update") {
            const shareId = btn.getAttribute("data-share-id");
            const options = readShareOptions(dialog.element, getShare());
            await this.updateShare(shareId, options);
            refreshDialog();
            return;
          }
          if (action === "update-access") {
            const shareId = btn.getAttribute("data-share-id");
            const options = readShareOptions(dialog.element, getShare());
            await this.updateShareAccess(shareId, options);
            refreshDialog();
            return;
          }
          if (action === "delete") {
            const shareId = btn.getAttribute("data-share-id");
            await this.deleteShare(shareId);
            refreshDialog();
            return;
          }
          if (action === "share") {
            const options = readShareOptions(dialog.element, getShare());
            if (itemType === SHARE_TYPES.NOTEBOOK) {
              await this.shareNotebook(itemId, options);
            } else {
              await this.shareDoc(itemId, options);
            }
            refreshDialog();
          }
        } catch (err) {
          this.showErr(err);
        }
      })();
    };

    let dialog = null;
    const attachCopyFocus = () => {
      const input = dialog?.element?.querySelector?.("input.b3-text-field[readonly]");
      if (input) {
        input.addEventListener("focus", () => input.select());
      }
    };
    const refreshDialog = () => {
      const contentEl = dialog?.element?.querySelector?.(".sps-share-dialog-content");
      if (!contentEl) return;
      contentEl.innerHTML = renderContent();
      attachCopyFocus();
    };

    dialog = new Dialog({
      title: t("siyuanShare.title.shareManagement"),
      content,
      width: "min(720px, 92vw)",
      destroyCallback: () => {
        dialog.element.removeEventListener("click", onClick);
      },
    });

    dialog.element.addEventListener("click", onClick);
    attachCopyFocus();
  }

  startSettingLayoutObserver() {
    if (this.settingLayoutObserver || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      this.applySettingWideLayout();
      this.handleSettingVisibilityChange();
    });
    observer.observe(document.body, {childList: true, subtree: true});
    this.settingLayoutObserver = observer;
    this.applySettingWideLayout();
    this.handleSettingVisibilityChange();
  }

  handleSettingVisibilityChange() {
    const {siteInput, apiKeyInput} = this.settingEls || {};
    const isVisible = !!(siteInput?.isConnected || apiKeyInput?.isConnected);
    if (isVisible) {
      this.settingVisible = true;
      return;
    }
    if (this.settingVisible) {
      this.settingVisible = false;
      void this.saveSettingsFromSetting({notify: false});
    }
  }

  makeSettingRowFullWidth(actionEl) {
    if (!actionEl) return false;
    const row = actionEl.closest?.("label.b3-label, .b3-label");
    if (!row) return false;
    if (row.classList.contains("sps-setting-full-row")) return true;
    row.classList.add("sps-setting-full-row");
    try {
      row.style.flexDirection = "column";
      row.style.alignItems = "stretch";
      row.style.justifyContent = "flex-start";
      row.style.gap = "8px";
    } catch {
      // ignore
    }
    try {
      actionEl.style.width = "100%";
      actionEl.style.alignSelf = "stretch";
      actionEl.style.flex = "1";
      actionEl.style.minWidth = "0";
    } catch {
      // ignore
    }
    return true;
  }

  applySettingWideLayout() {
    const {currentWrap, sharesWrap} = this.settingEls || {};
    this.makeSettingRowFullWidth(currentWrap);
    this.makeSettingRowFullWidth(sharesWrap);
    this.alignSettingSiteSelectWidth();
  }

  alignSettingSiteSelectWidth() {
    const {siteSelect, siteNameInput, siteInput, apiKeyInput} = this.settingEls || {};
    if (!siteSelect) return;
    const ref =
      (siteNameInput && siteNameInput.isConnected && siteNameInput) ||
      (siteInput && siteInput.isConnected && siteInput) ||
      (apiKeyInput && apiKeyInput.isConnected && apiKeyInput) ||
      null;
    if (!ref) return;
    const rect = ref.getBoundingClientRect();
    const width = Math.round(rect?.width || 0);
    if (!Number.isFinite(width) || width <= 0) return;
    siteSelect.style.width = `${width}px`;
    siteSelect.style.maxWidth = `${width}px`;
  }

  onDockClick = (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.getAttribute("data-action");
    if (!action) return;

    void (async () => {
      try {
        if (action === "sync-remote") {
          await this.saveSettingsFromUI();
          await this.trySyncRemoteShares({silent: false});
          return;
        }
        if (action === "disconnect") {
          await this.disconnectRemote();
          return;
        }
        if (action === "copy-link") {
          const shareId = target.getAttribute("data-share-id");
          await this.copyShareLink(shareId);
          return;
        }
        if (action === "update") {
          const shareId = target.getAttribute("data-share-id");
          await this.updateShare(shareId);
          return;
        }
        if (action === "update-access") {
          const shareId = target.getAttribute("data-share-id");
          const share = this.getShareById(shareId);
          if (!share) throw new Error(this.t("siyuanShare.error.shareNotFound"));
          const itemId = share.type === SHARE_TYPES.NOTEBOOK ? share.notebookId : share.docId;
          await this.openShareDialogFor({type: share.type, id: itemId, title: share.title || ""});
          return;
        }
        if (action === "delete") {
          const shareId = target.getAttribute("data-share-id");
          await this.deleteShare(shareId);
          return;
        }
      } catch (err) {
        this.showErr(err);
      }
    })();
  };

  onEditorTitleMenu = ({detail}) => {
    try {
      const t = this.t.bind(this);
      const {menu, data} = detail || {};
      const docId = data?.rootID || data?.id;
      if (!isValidDocId(docId)) return;
      const share = this.getShareByDocId(docId);
      menu.addItem({
        icon: "iconSiyuanShare",
        label: t("siyuanShare.title.shareManagement"),
        click: () => void this.openShareDialogFor({type: SHARE_TYPES.DOC, id: docId}),
      });
      if (share) {
        menu.addItem({
          icon: "iconRefresh",
          label: t("siyuanShare.action.updateShare"),
          click: () => void this.updateShare(share?.id).catch(this.showErr),
        });
        menu.addItem({
          icon: "iconCopy",
          label: t("siyuanShare.action.copyShareLink"),
          click: () => void this.copyShareLink(share?.id).catch(this.showErr),
        });
        menu.addItem({
          icon: "iconTrashcan",
          label: t("siyuanShare.action.deleteShare"),
          click: () => void this.deleteShare(share?.id).catch(this.showErr),
        });
      }
    } catch (err) {
      console.error(err);
    }
  };

  onDocTreeMenu = ({detail}) => {
    try {
      const t = this.t.bind(this);
      const {menu, elements, type} = detail || {};
      const rawElements = elements ?? detail?.element;
      let elementList = [];
      if (rawElements) {
        if (Array.isArray(rawElements)) {
          elementList = rawElements;
        } else if (typeof rawElements.length === "number") {
          elementList = Array.from(rawElements);
        } else {
          elementList = [rawElements];
        }
      }
      if (!menu || elementList.length === 0) return;

      const targetEl = elementList[0];
      const pickElementWithId = (el) => {
        if (!el) return null;
        if (findAttrId(el)) return el;
        const closestItem = el.closest?.(".b3-list-item");
        if (closestItem && findAttrId(closestItem)) return closestItem;
        const closestWithId = el.closest?.(
          "[data-node-id],[data-id],[data-doc-id],[data-root-id],[data-box],[data-url],[data-notebook-id],[data-notebook],[data-box-id],[data-boxid]",
        );
        if (closestWithId && findAttrId(closestWithId)) return closestWithId;
        const childWithId = el.querySelector?.(
          "[data-node-id],[data-id],[data-doc-id],[data-root-id],[data-box],[data-url],[data-notebook-id],[data-notebook],[data-box-id],[data-boxid]",
        );
        if (childWithId && findAttrId(childWithId)) return childWithId;
        return el;
      };

      let holder = null;
      let id = "";
      for (const el of elementList) {
        const candidate = pickElementWithId(el);
        const candidateId = findAttrId(candidate);
        if (candidateId) {
          holder = candidate;
          id = candidateId;
          break;
        }
      }
      if (!id) {
        const candidate = pickElementWithId(targetEl);
        id = findAttrId(candidate);
        holder = candidate || targetEl;
      }
      if (!id) id = resolveDetailId(detail);

      const dataType =
        holder?.getAttribute("data-type") ||
        holder?.dataset?.type ||
        targetEl?.getAttribute("data-type") ||
        targetEl?.dataset?.type;
      const detailType = detail?.data?.type || type;
      const docAttrCandidates = [
        holder?.getAttribute?.("data-node-id"),
        holder?.getAttribute?.("data-id"),
        holder?.getAttribute?.("data-doc-id"),
        holder?.getAttribute?.("data-root-id"),
      ];
      const docAttrValue = docAttrCandidates.find((val) => isValidDocId(val));
      let isNotebook =
        detailType === "notebook" ||
        detailType === "navigation-root" ||
        dataType === "notebook" ||
        dataType === "navigation-root";
      const notebookAttrCandidates = [
        holder?.getAttribute?.("data-url"),
        holder?.getAttribute?.("data-box"),
        holder?.getAttribute?.("data-box-id"),
        holder?.getAttribute?.("data-boxid"),
        holder?.getAttribute?.("data-notebook-id"),
        holder?.getAttribute?.("data-notebook"),
      ];
      if (!isNotebook) {
        const urlAttr = notebookAttrCandidates.find((val) => isValidDocId(val));
        if (docAttrValue) {
          isNotebook = false;
        } else if (isValidDocId(urlAttr)) {
          isNotebook = true;
        }
      }
      if (!id && isNotebook) {
        const notebookEl =
          holder?.closest?.("ul[data-url]") ||
          targetEl?.closest?.("ul[data-url]") ||
          targetEl?.querySelector?.("ul[data-url]");
        const notebookId = notebookEl?.getAttribute?.("data-url") || "";
        if (isValidDocId(notebookId)) id = notebookId.trim();
        if (!id) {
          const idFromAttr = notebookAttrCandidates.find((val) => isValidDocId(val));
          if (isValidDocId(idFromAttr)) id = idFromAttr.trim();
        }
      }

      const treeItem =
        holder?.closest?.(".b3-list-item") ||
        targetEl?.closest?.(".b3-list-item") ||
        holder ||
        targetEl;
      const treeInfo = resolveTreeItemInfo(treeItem);
      if (treeInfo?.id) {
        id = treeInfo.id;
        isNotebook = treeInfo.isNotebook;
      }
      if (!id) return;

      const itemType = isNotebook ? SHARE_TYPES.NOTEBOOK : SHARE_TYPES.DOC;
      const title = findTitleFromTree(treeItem || holder || targetEl) || id;
      const share =
        itemType === SHARE_TYPES.NOTEBOOK ? this.getShareByNotebookId(id) : this.getShareByDocId(id);

      menu.addItem({
        icon: "iconSiyuanShare",
        label: share ? t("siyuanShare.action.manageShare") : t("siyuanShare.action.createShare"),
        click: () => void this.openShareDialogFor({type: itemType, id, title}),
      });
      if (share) {
        menu.addItem({
          icon: "iconRefresh",
          label: t("siyuanShare.action.updateShare"),
          click: () => void this.updateShare(share?.id).catch(this.showErr),
        });
        menu.addItem({
          icon: "iconCopy",
          label: t("siyuanShare.action.copyShareLink"),
          click: () => void this.copyShareLink(share?.id).catch(this.showErr),
        });
        menu.addItem({
          icon: "iconTrashcan",
          label: t("siyuanShare.action.deleteShare"),
          click: () => void this.deleteShare(share?.id).catch(this.showErr),
        });
      }
    } catch (err) {
      console.error(err);
    }
  };

  showErr = (err) => {
    console.error(err);
    const t = this.t.bind(this);
    let message = err?.message || String(err);
    const lower = message.toLowerCase();
    if (
      lower.includes("api key") ||
      lower.includes("invalid api key") ||
      lower.includes("unauthorized") ||
      lower.includes("401")
    ) {
      message = t("siyuanShare.error.invalidApiKey");
    } else if (lower.includes("storage") || lower.includes("quota") || lower.includes("space")) {
      message = t("siyuanShare.error.storageLimit");
    } else if (
      lower.includes("failed to fetch") ||
      lower.includes("network") ||
      lower.includes("connect") ||
      lower.includes("fetch")
    ) {
      message = t("siyuanShare.error.networkFail");
    } else if (lower.includes("invalid metadata")) {
      message = t("siyuanShare.error.invalidMetadata");
    } else if (lower.includes("missing docid")) {
      message = t("siyuanShare.error.missingDocId");
    }
    this.notify(message);
  };

  hasReferenceInMarkdown(markdown) {
    if (!markdown) return false;
    return BLOCK_REF_RE.test(markdown) || BLOCK_REF_LINK_RE.test(markdown);
  }

  async hasDocReferencesBySQL(docIds) {
    if (!Array.isArray(docIds) || docIds.length === 0) return false;
    const unique = Array.from(
      new Set(docIds.map((id) => String(id || "").trim()).filter((id) => isValidDocId(id))),
    );
    if (!unique.length) return false;
    const quoted = unique.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
    const statements = [
      `SELECT 1 AS hit FROM refs WHERE root_id IN (${quoted}) LIMIT 1`,
      `SELECT 1 AS hit FROM refs WHERE rootId IN (${quoted}) LIMIT 1`,
      `SELECT 1 AS hit FROM refs WHERE doc_id IN (${quoted}) LIMIT 1`,
      `SELECT 1 AS hit FROM refs WHERE docId IN (${quoted}) LIMIT 1`,
      `SELECT 1 AS hit FROM refs WHERE def_block_root_id IN (${quoted}) LIMIT 1`,
      `SELECT 1 AS hit FROM refs WHERE block_id IN (SELECT id FROM blocks WHERE root_id IN (${quoted})) LIMIT 1`,
      `SELECT 1 AS hit FROM refs WHERE blockId IN (SELECT id FROM blocks WHERE root_id IN (${quoted})) LIMIT 1`,
      `SELECT 1 AS hit FROM ref WHERE root_id IN (${quoted}) LIMIT 1`,
      `SELECT 1 AS hit FROM ref WHERE rootId IN (${quoted}) LIMIT 1`,
      `SELECT 1 AS hit FROM ref WHERE doc_id IN (${quoted}) LIMIT 1`,
      `SELECT 1 AS hit FROM ref WHERE docId IN (${quoted}) LIMIT 1`,
    ];
    for (const stmt of statements) {
      let resp = null;
      try {
        resp = await fetchSyncPost("/api/query/sql", {stmt});
      } catch (err) {
        resp = null;
      }
      if (!resp || resp.code !== 0 || !Array.isArray(resp.data)) {
        continue;
      }
      return resp.data.length > 0;
    }
    return false;
  }

  resolveExportReferenceMode() {
    const exportCfg = globalThis?.siyuan?.config?.export;
    if (!exportCfg || typeof exportCfg !== "object") {
      return {found: false, correct: false};
    }

    const visited = new WeakSet();
    const evalValue = (value, depth = 0) => {
      if (depth > 3 || value == null) return {found: false, correct: false};
      if (typeof value === "number") {
        return {found: true, correct: value === 4};
      }
      if (typeof value === "string") {
        const raw = value.trim();
        if (!raw) return {found: false, correct: false};
        if (/^\d+$/.test(raw)) {
          const num = Number(raw);
          return {found: true, correct: num === 4};
        }
        const lower = raw.toLowerCase();
        const hasFootnote = lower.includes("footnote") || raw.includes("脚注");
        const hasAnchor =
          lower.includes("anchor") ||
          lower.includes("hash") ||
          raw.includes("锚点") ||
          raw.includes("哈希");
        if (hasFootnote && hasAnchor) return {found: true, correct: true};
        return {found: true, correct: false};
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          const res = evalValue(entry, depth + 1);
          if (res.found) return res;
        }
        return {found: false, correct: false};
      }
      if (typeof value === "object") {
        if (visited.has(value)) return {found: false, correct: false};
        visited.add(value);
        const fields = [
          value.mode,
          value.type,
          value.value,
          value.format,
          value.label,
          value.name,
          value.text,
          value.ref,
          value.blockRef,
        ];
        for (const entry of fields) {
          const res = evalValue(entry, depth + 1);
          if (res.found) return res;
        }
        return {found: false, correct: false};
      }
      return {found: false, correct: false};
    };

    const pickInOrder = [
      "blockRef",
      "blockRefMode",
      "blockRefType",
      "blockRefFormat",
      "blockRefRule",
      "ref",
      "refMode",
      "refType",
      "reference",
      "referenceMode",
      "referenceType",
    ];

    for (const key of pickInOrder) {
      if (!Object.prototype.hasOwnProperty.call(exportCfg, key)) continue;
      const res = evalValue(exportCfg[key]);
      if (res.found) return res;
      return {found: true, correct: false};
    }

    return {found: false, correct: false};
  }

  openExportReferenceWarningDialog() {
    const t = this.t.bind(this);
    return new Promise((resolve) => {
      let done = false;
      let dialog = null;
      const onClick = (event) => {
        const btn = event.target?.closest?.("[data-action]");
        if (!btn) return;
        if (btn.getAttribute("data-action") !== "confirm") return;
        const checkbox = dialog?.element?.querySelector?.("[data-ref-warning-disable]");
        if (checkbox?.checked) {
          this.settings.refWarningDisabled = true;
          void this.saveData(STORAGE_SETTINGS, this.settings);
        }
        dialog?.destroy();
      };
      const finish = () => {
        if (done) return;
        done = true;
        dialog?.element?.removeEventListener?.("click", onClick);
        resolve();
      };
      const content = `<div class="b3-dialog__content sps-warning-dialog">
  <div class="sps-warning">
    <div class="sps-warning__icon">!</div>
    <div class="sps-warning__body">
      <div class="sps-warning__desc">${escapeHtml(t("siyuanShare.warning.refSettingMessage"))}</div>
    </div>
  </div>
  <label class="b3-checkbox sps-warning__checkbox">
    <input class="b3-checkbox__input" type="checkbox" data-ref-warning-disable>
    <span class="b3-checkbox__label">${escapeHtml(t("siyuanShare.warning.refSettingDontRemind"))}</span>
  </label>
</div>
<div class="b3-dialog__action">
  <div class="fn__space"></div>
  <button class="b3-button b3-button--text" data-action="confirm">${escapeHtml(
    t("siyuanShare.warning.refSettingOk"),
  )}</button>
</div>`;
      dialog = new Dialog({
        title: t("siyuanShare.warning.refSettingTitle"),
        content,
        width: "460px",
        destroyCallback: finish,
      });
      dialog.element?.addEventListener?.("click", onClick);
    });
  }

  async maybeWarnExportReference(markdownList, docIds = []) {
    if (this.settings.refWarningDisabled) return;
    const setting = this.resolveExportReferenceMode();
    if (setting.found && setting.correct) return;
    const hasDocRefs = await this.hasDocReferencesBySQL(docIds);
    if (!hasDocRefs) return;
    await this.openExportReferenceWarningDialog();
  }

  openProgressDialog(message, controller) {
    const t = this.t.bind(this);
    try {
      if (this.progressDialog) {
        this.progressDialog.destroy();
      }
    } catch {
      // ignore
    }
    const rawMessage = message || t("siyuanShare.message.processing");
    const safeMessage = escapeHtml(rawMessage);
    let onDialogDestroy = () => {};
    const dialog = new Dialog({
      title: t("siyuanShare.title.processing"),
      content: `<div class="sps-progress">
  <div class="sps-progress__header">
    <div class="sps-progress__title">${safeMessage}</div>
    <div class="sps-progress__percent" style="display:none"></div>
  </div>
  <div class="sps-progress__detail" style="display:none"></div>
  <div class="sps-progress__bar"><div class="sps-progress__bar-inner"></div></div>
</div>
<div class="b3-dialog__action">
  <div class="fn__space"></div>
  <button class="b3-button b3-button--outline" data-action="continue" style="display:none"></button>
</div>`,
      width: "360px",
      destroyCallback: () => onDialogDestroy(),
    });
    this.progressDialog = dialog;
    dialog.element?.classList?.add("sps-progress-dialog");

    const label = dialog.element?.querySelector?.(".sps-progress__title");
    const percentEl = dialog.element?.querySelector?.(".sps-progress__percent");
    const detailEl = dialog.element?.querySelector?.(".sps-progress__detail");
    const barWrap = dialog.element?.querySelector?.(".sps-progress__bar");
    const bar = dialog.element?.querySelector?.(".sps-progress__bar-inner");
    const continueBtn = dialog.element?.querySelector?.("[data-action='continue']");
    let confirmResolver = null;
    let currentText = rawMessage;
    let barVisible = true;
    let closed = false;
    const setIndeterminate = () => {
      if (!bar) return;
      bar.style.animation = "";
      bar.style.width = "";
    };
    const setDeterminate = (value) => {
      if (!bar) return 0;
      const clamped = Math.max(0, Math.min(100, value));
      bar.style.animation = "none";
      bar.style.width = `${clamped}%`;
      return clamped;
    };
    const setBarVisible = (visible = true) => {
      barVisible = !!visible;
      if (barWrap) {
        barWrap.style.display = barVisible ? "" : "none";
      }
      if (!barVisible && percentEl) {
        percentEl.textContent = "";
        percentEl.style.display = "none";
      }
    };
    const update = (next, percent = null, detail = "") => {
      let text = next;
      let pct = percent;
      let extra = detail;
      if (next && typeof next === "object") {
        text = next.text;
        pct = next.percent;
        extra = next.detail;
      }
      if (typeof text === "string") {
        currentText = text;
      } else if (text == null) {
        text = currentText;
      } else {
        currentText = String(text);
        text = currentText;
      }
      const extraText = extra ? String(extra) : "";
      const hasPercent = pct !== null && pct !== undefined && pct !== "";
      const numeric = hasPercent ? Number(pct) : NaN;
      if (label) label.textContent = String(text || "");
      if (detailEl) {
        if (extraText) {
          detailEl.textContent = extraText;
          detailEl.style.display = "";
        } else {
          detailEl.textContent = "";
          detailEl.style.display = "none";
        }
      }
      if (!barVisible) {
        if (percentEl) {
          percentEl.textContent = "";
          percentEl.style.display = "none";
        }
      } else if (Number.isFinite(numeric)) {
        const clamped = setDeterminate(numeric);
        if (percentEl) {
          percentEl.textContent = `${Math.round(clamped)}%`;
          percentEl.style.display = "";
        }
      } else {
        setIndeterminate();
        if (percentEl) {
          percentEl.textContent = "";
          percentEl.style.display = "none";
        }
      }
    };
    const hideContinue = () => {
      if (!continueBtn) return;
      continueBtn.style.display = "none";
      continueBtn.textContent = "";
    };
    const showContinue = (labelText) => {
      if (!continueBtn) return;
      continueBtn.textContent = String(labelText || t("siyuanShare.action.continueUpload"));
      continueBtn.style.display = "";
    };
    const settleConfirm = (result) => {
      if (!confirmResolver) return;
      const resolver = confirmResolver;
      confirmResolver = null;
      hideContinue();
      resolver(!!result);
    };
    onDialogDestroy = () => {
      if (closed) return;
      closed = true;
      settleConfirm(false);
      if (controller && !controller.signal?.aborted) {
        try {
          controller.abort();
        } catch {
          // ignore
        }
      }
      if (this.progressDialog === dialog) {
        this.progressDialog = null;
      }
    };
    const confirm = ({text = null, detail = "", continueText = ""} = {}) =>
      new Promise((resolve) => {
        if (typeof text === "string" || (text && typeof text === "object")) {
          update({text, detail});
        } else if (detail) {
          update({detail});
        }
        confirmResolver = resolve;
        showContinue(continueText);
      });
    const close = () => {
      if (closed) return;
      closed = true;
      settleConfirm(false);
      try {
        dialog.destroy();
      } catch {
        // ignore
      }
      if (this.progressDialog === dialog) {
        this.progressDialog = null;
      }
    };

    dialog.element?.addEventListener("click", (event) => {
      const btn = event.target?.closest?.("[data-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      if (action === "continue") {
        settleConfirm(true);
      }
    });

    return {close, update, confirm, setBarVisible};
  }

  async loadState() {
    const settings = (await this.loadData(STORAGE_SETTINGS)) || {};
    const legacyShares = (await this.loadData(STORAGE_SHARES)) || [];
    const siteSharesRaw = (await this.loadData(STORAGE_SITE_SHARES)) || {};
    const shareOptionsRaw = (await this.loadData(STORAGE_SHARE_OPTIONS)) || {};
    const siteShares =
      siteSharesRaw && typeof siteSharesRaw === "object" && !Array.isArray(siteSharesRaw) ? siteSharesRaw : {};
    const shareOptions =
      shareOptionsRaw && typeof shareOptionsRaw === "object" && !Array.isArray(shareOptionsRaw)
        ? shareOptionsRaw
        : {};
    let sites = this.normalizeSiteList(settings.sites);
    let activeSiteId = String(settings.activeSiteId || "");
    let persistSettings = false;
    if (!sites.length && (settings.siteUrl || settings.apiKey)) {
      const fallback = {
        id: randomSlug(10),
        name: this.resolveSiteName("", settings.siteUrl || "", 0),
        siteUrl: String(settings.siteUrl || "").trim(),
        apiKey: String(settings.apiKey || "").trim(),
      };
      sites.push(fallback);
      activeSiteId = fallback.id;
      persistSettings = true;
    }
    if (activeSiteId && !sites.find((site) => String(site.id) === activeSiteId)) {
      activeSiteId = "";
      persistSettings = true;
    }
    if (!activeSiteId && sites.length) {
      activeSiteId = String(sites[0].id || "");
      persistSettings = true;
    }
    const activeSite = sites.find((site) => String(site.id) === activeSiteId) || null;
    let persistShares = false;
    if (Array.isArray(legacyShares) && legacyShares.length && activeSiteId && !siteShares[activeSiteId]) {
      siteShares[activeSiteId] = legacyShares;
      persistShares = true;
    }
    this.siteShares = siteShares;
    this.shareOptions = shareOptions;
    this.settings = {
      siteUrl: activeSite?.siteUrl || "",
      apiKey: activeSite?.apiKey || "",
      uploadAssetConcurrency: normalizePositiveInt(
        settings.uploadAssetConcurrency,
        DEFAULT_UPLOAD_ASSET_CONCURRENCY,
      ),
      uploadChunkConcurrency: normalizePositiveInt(
        settings.uploadChunkConcurrency,
        DEFAULT_UPLOAD_CHUNK_CONCURRENCY,
      ),
      sites,
      activeSiteId,
      refWarningDisabled: !!settings.refWarningDisabled,
    };
    const activeShares = activeSiteId ? this.siteShares[activeSiteId] : null;
    this.shares = Array.isArray(activeShares) ? activeShares.filter((s) => s && s.id && s.type) : [];
    this.hasNodeFs = !!(fs && path);
    this.workspaceDir = "";
    this.syncRemoteStatusFromSite(activeSite);
    this.syncSettingInputs();
    this.renderSettingShares();
    this.renderDock();
    this.updateTopBarState();
    void this.refreshCurrentDocContext();
    if (persistSettings) {
      await this.saveData(STORAGE_SETTINGS, this.settings);
    }
    if (persistShares) {
      await this.saveData(STORAGE_SITE_SHARES, this.siteShares);
    }
    this.startBackgroundSync({immediate: true});
  }

  initSettingPanel() {
    const t = this.t.bind(this);
    const siteSelect = document.createElement("select");
    siteSelect.className = "b3-select sps-site-select sps-site-select--setting";
    siteSelect.addEventListener("change", this.onSiteSelectChange);

    const siteNameInput = document.createElement("input");
    siteNameInput.className = "b3-text-field fn__block";
    siteNameInput.placeholder = t("siyuanShare.label.siteName");

    const siteActions = document.createElement("div");
    siteActions.className = "siyuan-plugin-share__actions";
    siteActions.innerHTML = `
  <button class="b3-button b3-button--outline" data-action="site-add">${t(
    "siyuanShare.action.addSite",
  )}</button>
  <button class="b3-button b3-button--outline" data-action="site-remove">${t(
    "siyuanShare.action.removeSite",
  )}</button>
`;
    siteActions.addEventListener("click", this.onSettingSitesClick);

    const siteInput = document.createElement("input");
    siteInput.className = "b3-text-field fn__block";
    siteInput.placeholder = t("siyuanShare.placeholder.siteUrl");

    const apiKeyInput = document.createElement("input");
    apiKeyInput.className = "b3-text-field fn__block";
    apiKeyInput.type = "password";
    apiKeyInput.placeholder = t("siyuanShare.label.apiKey");

    const currentWrap = document.createElement("div");
    currentWrap.className = "siyuan-plugin-share";
    currentWrap.addEventListener("click", this.onSettingCurrentClick);

    const sharesWrap = document.createElement("div");
    sharesWrap.className = "siyuan-plugin-share";
    sharesWrap.addEventListener("click", this.onSettingSharesClick);

    const envHint = document.createElement("div");
    envHint.className = "siyuan-plugin-share__muted sps-setting-hint";

    this.settingEls = {
      siteInput,
      apiKeyInput,
      siteSelect,
      siteNameInput,
      currentWrap,
      sharesWrap,
      envHint,
    };

    this.setting = new Setting({
      width: "92vw",
      height: "80vh",
    });

    this.setting.addItem({
      title: t("siyuanShare.label.site"),
      description: t("siyuanShare.hint.siteList"),
      createActionElement: () => siteSelect,
    });

    this.setting.addItem({
      title: t("siyuanShare.label.siteName"),
      description: "",
      createActionElement: () => siteNameInput,
    });

    this.setting.addItem({
      title: t("siyuanShare.label.siteActions"),
      description: "",
      createActionElement: () => siteActions,
    });

    this.setting.addItem({
      title: t("siyuanShare.label.siteUrl"),
      description: t("siyuanShare.hint.siteUrl"),
      createActionElement: () => siteInput,
    });
    this.setting.addItem({
      title: t("siyuanShare.label.apiKey"),
      description: t("siyuanShare.hint.apiKey"),
      createActionElement: () => apiKeyInput,
    });

    const connectActions = document.createElement("div");
    connectActions.className = "siyuan-plugin-share__actions";
    connectActions.innerHTML = `
  <button class="b3-button b3-button--outline" data-action="settings-sync">${t(
    "siyuanShare.action.verifySync",
  )}</button>
  <button class="b3-button b3-button--outline" data-action="settings-disconnect">${t(
    "siyuanShare.action.disconnect",
  )}</button>
`;
    connectActions.addEventListener("click", this.onSettingActionsClick);
    this.setting.addItem({
      title: t("siyuanShare.label.connectionSync"),
      description: t("siyuanShare.hint.connectionSync"),
      direction: "column",
      createActionElement: () => connectActions,
    });

    this.setting.addItem({
      title: t("siyuanShare.label.envInfo"),
      description: "",
      direction: "column",
      createActionElement: () => envHint,
    });

    this.setting.addItem({
      title: t("siyuanShare.label.currentShareInfo"),
      description: t("siyuanShare.hint.currentShare"),
      direction: "column",
      createActionElement: () => currentWrap,
    });

    this.setting.addItem({
      title: t("siyuanShare.label.shareList"),
      description: t("siyuanShare.hint.shareList"),
      direction: "column",
      createActionElement: () => sharesWrap,
    });

    this.syncSettingInputs();
    this.renderSettingCurrent();
    this.renderSettingShares();
    this.startSettingLayoutObserver();
  }

  resolveSiteName(name, siteUrl, fallbackIndex = 0) {
    const trimmed = String(name || "").trim();
    if (trimmed) return trimmed;
    const host = getUrlHost(siteUrl);
    if (host) return host;
    const url = String(siteUrl || "").trim();
    if (url) return url;
    return `${this.t("siyuanShare.label.site")} ${fallbackIndex + 1}`;
  }

  normalizeRemoteUser(raw) {
    if (!raw) return null;
    if (typeof raw === "string") {
      const username = raw.trim();
      return username ? {username} : null;
    }
    if (typeof raw !== "object") return null;
    const username = String(raw.username || raw.name || "").trim();
    const id = String(raw.id || raw.userId || "").trim();
    const user = {};
    if (username) user.username = username;
    if (id) user.id = id;
    return Object.keys(user).length ? user : null;
  }

  normalizeRemoteVerifiedAt(value) {
    const ts = Number(value);
    if (!Number.isFinite(ts) || ts <= 0) return 0;
    return Math.floor(ts);
  }

  normalizeRemoteFeatures(raw) {
    if (!raw || typeof raw !== "object") return null;
    return {
      incrementalShare: !!raw.incrementalShare,
    };
  }

  syncRemoteStatusFromSite(site) {
    this.remoteUser = this.normalizeRemoteUser(site?.remoteUser);
    this.remoteVerifiedAt = this.normalizeRemoteVerifiedAt(site?.remoteVerifiedAt);
    this.remoteFeatures = this.normalizeRemoteFeatures(site?.remoteFeatures);
  }

  async persistActiveRemoteStatus({clear = false} = {}) {
    const sites = this.normalizeSiteList(this.settings.sites);
    const activeId = String(this.settings.activeSiteId || "");
    const activeSite = sites.find((site) => String(site.id) === activeId);
    if (!activeSite) return;
    if (clear) {
      activeSite.remoteUser = null;
      activeSite.remoteVerifiedAt = 0;
      activeSite.remoteFeatures = null;
    } else {
      activeSite.remoteUser = this.normalizeRemoteUser(this.remoteUser);
      activeSite.remoteVerifiedAt = this.normalizeRemoteVerifiedAt(this.remoteVerifiedAt);
      activeSite.remoteFeatures = this.normalizeRemoteFeatures(this.remoteFeatures);
    }
    this.settings = {
      ...this.settings,
      sites,
    };
    await this.saveData(STORAGE_SETTINGS, this.settings);
  }

  normalizeSiteList(rawSites) {
    const sites = [];
    const seen = new Set();
    if (!Array.isArray(rawSites)) return sites;
    rawSites.forEach((raw) => {
      if (!raw || typeof raw !== "object") return;
      let id = String(raw.id || "").trim();
      if (!id || seen.has(id)) {
        id = randomSlug(10);
      }
      const siteUrl = String(raw.siteUrl || "").trim();
      const apiKey = String(raw.apiKey || "").trim();
      const name = this.resolveSiteName(raw.name, siteUrl, sites.length);
      const remoteUser = this.normalizeRemoteUser(raw.remoteUser);
      const remoteVerifiedAt = this.normalizeRemoteVerifiedAt(raw.remoteVerifiedAt);
      const remoteFeatures = this.normalizeRemoteFeatures(raw.remoteFeatures);
      sites.push({id, name, siteUrl, apiKey, remoteUser, remoteVerifiedAt, remoteFeatures});
      seen.add(id);
    });
    return sites;
  }

  getActiveSite() {
    const sites = Array.isArray(this.settings.sites) ? this.settings.sites : [];
    const activeId = String(this.settings.activeSiteId || "");
    return sites.find((site) => site && String(site.id) === activeId) || sites[0] || null;
  }

  getSiteOptionLabel(site, index = 0) {
    if (!site) return `${this.t("siyuanShare.label.site")} ${index + 1}`;
    const name = this.resolveSiteName(site.name, site.siteUrl, index);
    const host = getUrlHost(site.siteUrl);
    if (host && host !== name) {
      return `${name} (${host})`;
    }
    return name || host || `${this.t("siyuanShare.label.site")} ${index + 1}`;
  }

  syncSettingInputs() {
    const {siteInput, apiKeyInput, envHint, siteSelect, siteNameInput} = this.settingEls || {};
    if (siteInput) siteInput.value = this.settings.siteUrl || "";
    if (apiKeyInput) apiKeyInput.value = this.settings.apiKey || "";
    if (siteSelect) {
      const sites = Array.isArray(this.settings.sites) ? this.settings.sites : [];
      const activeId = String(this.settings.activeSiteId || "");
      siteSelect.innerHTML = "";
      sites.forEach((site, index) => {
        const option = document.createElement("option");
        option.value = String(site.id || "");
        option.textContent = this.getSiteOptionLabel(site, index);
        siteSelect.appendChild(option);
      });
      if (activeId) {
        siteSelect.value = activeId;
      }
    }
    if (siteNameInput) {
      const active = this.getActiveSite();
      siteNameInput.value = active?.name || "";
    }
    if (envHint) {
      const t = this.t.bind(this);
      const base = normalizeUrlBase(this.settings.siteUrl);
      const hasKey = !!(this.settings.apiKey || "").trim();
      if (!base || !hasKey) {
        envHint.textContent = t("siyuanShare.hint.needSiteAndKey");
        return;
      }
      const displayName = this.remoteUser?.username || this.remoteUser?.name || "";
      const userLabel = displayName
        ? t("siyuanShare.hint.statusConnectedUser", {
            user: escapeHtml(displayName),
          })
        : t("siyuanShare.hint.statusConnectedNoUser");
      const timeLabel = this.remoteVerifiedAt
        ? t("siyuanShare.hint.lastVerifiedAt", {
            time: escapeHtml(this.formatTime(this.remoteVerifiedAt)),
          })
        : "";
      envHint.innerHTML = timeLabel ? `${userLabel} · ${timeLabel}` : userLabel;
    }
  }

  persistCurrentSiteInputs() {
    const {siteInput, apiKeyInput, siteNameInput} = this.settingEls || {};
    const siteUrl = (siteInput?.value || "").trim();
    const apiKey = (apiKeyInput?.value || "").trim();
    const siteName = (siteNameInput?.value || "").trim();
    let sites = this.normalizeSiteList(this.settings.sites);
    let activeSiteId = String(this.settings.activeSiteId || "");
    let activeSite = sites.find((site) => String(site.id) === activeSiteId);
    const prevSiteUrl = activeSite?.siteUrl || "";
    const prevApiKey = activeSite?.apiKey || "";
    if (!activeSite && (siteUrl || apiKey || siteName)) {
      activeSiteId = activeSiteId || randomSlug(10);
      activeSite = {
        id: activeSiteId,
        name: this.resolveSiteName(siteName, siteUrl, sites.length),
        siteUrl,
        apiKey,
        remoteUser: null,
        remoteVerifiedAt: 0,
        remoteFeatures: null,
      };
      sites.push(activeSite);
    } else if (activeSite) {
      activeSite.siteUrl = siteUrl;
      activeSite.apiKey = apiKey;
      activeSite.name = this.resolveSiteName(siteName || activeSite.name, siteUrl, sites.indexOf(activeSite));
      if (prevSiteUrl !== siteUrl || prevApiKey !== apiKey) {
        activeSite.remoteUser = null;
        activeSite.remoteVerifiedAt = 0;
        activeSite.remoteFeatures = null;
        this.remoteUploadLimits = null;
        this.remoteFeatures = null;
      }
    }
    this.settings = {
      ...this.settings,
      siteUrl,
      apiKey,
      sites,
      activeSiteId,
    };
    this.syncRemoteStatusFromSite(activeSite);
    return {siteUrl, apiKey, siteName, sites, activeSiteId};
  }

  async applyActiveSite(siteId, {persist = true} = {}) {
    const sites = this.normalizeSiteList(this.settings.sites);
    const next = sites.find((site) => String(site.id) === String(siteId)) || sites[0] || null;
    const activeSiteId = next ? String(next.id) : "";
    this.settings = {
      ...this.settings,
      sites,
      activeSiteId,
      siteUrl: next?.siteUrl || "",
      apiKey: next?.apiKey || "",
    };
    this.syncRemoteStatusFromSite(next);
    this.remoteUploadLimits = null;
    this.shares = Array.isArray(this.siteShares?.[activeSiteId]) ? this.siteShares[activeSiteId] : [];
    if (persist) {
      await this.saveData(STORAGE_SETTINGS, this.settings);
    }
    this.syncSettingInputs();
    this.renderDock();
    this.renderSettingCurrent();
    this.renderSettingShares();
    this.updateTopBarState();
  }

  saveSettingsFromSetting = async ({notify = true} = {}) => {
    const t = this.t.bind(this);
    this.persistCurrentSiteInputs();
    this.shares = Array.isArray(this.siteShares?.[this.settings.activeSiteId])
      ? this.siteShares[this.settings.activeSiteId]
      : [];
    await this.saveData(STORAGE_SETTINGS, this.settings);
    if (!this.settings.siteUrl || !this.settings.apiKey) {
      this.shares = [];
      if (this.settings.activeSiteId) {
        this.siteShares[this.settings.activeSiteId] = [];
        await this.saveData(STORAGE_SITE_SHARES, this.siteShares);
      }
    }
    this.renderDock();
    this.renderSettingShares();
    this.syncSettingInputs();
    if (notify) this.notify(t("siyuanShare.message.disconnected"));
  };

  onSiteSelectChange = (event) => {
    const nextId = String(event?.target?.value || "");
    if (!nextId || String(this.settings.activeSiteId || "") === nextId) return;
    void (async () => {
      try {
        this.persistCurrentSiteInputs();
        await this.applyActiveSite(nextId, {persist: false});
        await this.saveData(STORAGE_SETTINGS, this.settings);
      } catch (err) {
        this.showErr(err);
      }
    })();
  };

  onDockChange = (event) => {
    const target = event.target;
    if (!target || target.id !== "sps-site-select") return;
    const nextId = String(target.value || "");
    if (!nextId || String(this.settings.activeSiteId || "") === nextId) return;
    void (async () => {
      try {
        const siteUrl = this.getInputValue("sps-site").trim();
        const apiKey = this.getInputValue("sps-apikey").trim();
        let sites = this.normalizeSiteList(this.settings.sites);
        let activeSiteId = String(this.settings.activeSiteId || "");
        let activeSite = sites.find((site) => String(site.id) === activeSiteId);
        const prevSiteUrl = activeSite?.siteUrl || "";
        const prevApiKey = activeSite?.apiKey || "";
        if (!activeSite && (siteUrl || apiKey)) {
          activeSiteId = activeSiteId || randomSlug(10);
          activeSite = {
            id: activeSiteId,
            name: this.resolveSiteName("", siteUrl, sites.length),
            siteUrl,
            apiKey,
            remoteUser: null,
            remoteVerifiedAt: 0,
            remoteFeatures: null,
          };
          sites.push(activeSite);
        } else if (activeSite) {
          activeSite.siteUrl = siteUrl;
          activeSite.apiKey = apiKey;
          activeSite.name = this.resolveSiteName(activeSite.name, siteUrl, sites.indexOf(activeSite));
          if (prevSiteUrl !== siteUrl || prevApiKey !== apiKey) {
            activeSite.remoteUser = null;
            activeSite.remoteVerifiedAt = 0;
            activeSite.remoteFeatures = null;
            this.remoteUploadLimits = null;
            this.remoteFeatures = null;
          }
        }
        this.settings = {
          ...this.settings,
          sites,
          siteUrl,
          apiKey,
          activeSiteId,
        };
        this.syncRemoteStatusFromSite(activeSite);
        await this.applyActiveSite(nextId, {persist: true});
      } catch (err) {
        this.showErr(err);
      }
    })();
  };

  onSettingSitesClick = (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    if (!action) return;
    void (async () => {
      try {
        if (action === "site-add") {
          this.persistCurrentSiteInputs();
          const sites = this.normalizeSiteList(this.settings.sites);
          const newSiteId = randomSlug(10);
          const newSite = {
            id: newSiteId,
            name: this.resolveSiteName("", "", sites.length),
            siteUrl: "",
            apiKey: "",
            remoteUser: null,
            remoteVerifiedAt: 0,
            remoteFeatures: null,
          };
          sites.push(newSite);
          this.settings = {
            ...this.settings,
            sites,
            activeSiteId: newSiteId,
            siteUrl: "",
            apiKey: "",
          };
          this.siteShares[newSiteId] = this.siteShares[newSiteId] || [];
          this.shares = this.siteShares[newSiteId];
          this.remoteUser = null;
          this.remoteVerifiedAt = 0;
          this.remoteFeatures = null;
          this.remoteUploadLimits = null;
          await this.saveData(STORAGE_SETTINGS, this.settings);
          await this.saveData(STORAGE_SITE_SHARES, this.siteShares);
          this.syncSettingInputs();
          this.renderDock();
          this.renderSettingCurrent();
          this.renderSettingShares();
          this.updateTopBarState();
          return;
        }
        if (action === "site-remove") {
          const activeId = String(this.settings.activeSiteId || "");
          if (!activeId) return;
          const sites = this.normalizeSiteList(this.settings.sites).filter(
            (site) => String(site.id) !== activeId,
          );
          if (this.siteShares?.[activeId]) {
            delete this.siteShares[activeId];
          }
          const nextSite = sites[0] || null;
          this.settings = {
            ...this.settings,
            sites,
            activeSiteId: nextSite?.id || "",
            siteUrl: nextSite?.siteUrl || "",
            apiKey: nextSite?.apiKey || "",
          };
          this.shares = nextSite?.id && this.siteShares?.[nextSite.id] ? this.siteShares[nextSite.id] : [];
          this.syncRemoteStatusFromSite(nextSite);
          this.remoteUploadLimits = null;
          await this.saveData(STORAGE_SETTINGS, this.settings);
          await this.saveData(STORAGE_SITE_SHARES, this.siteShares);
          this.syncSettingInputs();
          this.renderDock();
          this.renderSettingCurrent();
          this.renderSettingShares();
          this.updateTopBarState();
          return;
        }
      } catch (err) {
        this.showErr(err);
      }
    })();
  };

  onSettingActionsClick = (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    if (!action) return;

    void (async () => {
      try {
        if (action === "settings-sync") {
          await this.saveSettingsFromSetting({notify: false});
          await this.trySyncRemoteShares({silent: false});
          return;
        }
        if (action === "settings-disconnect") {
          await this.disconnectRemote();
          return;
        }
      } catch (err) {
        this.showErr(err);
      }
    })();
  };

  onSettingCurrentClick = (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    if (!action) return;

    void (async () => {
      try {
        const t = this.t.bind(this);
        const docId = this.currentDoc.id;
        if (!isValidDocId(docId)) throw new Error(t("siyuanShare.message.noCurrentDoc"));

        const share = this.getShareByDocId(docId);
        if (!share) throw new Error(t("siyuanShare.message.currentDocNoShare"));
        if (action === "copy-link") return await this.copyShareLink(share.id);
        if (action === "update") return await this.updateShare(share.id);
        if (action === "update-access") {
          await this.openShareDialogFor({type: SHARE_TYPES.DOC, id: docId});
          return;
        }
        if (action === "delete") return await this.deleteShare(share.id);
      } catch (err) {
        this.showErr(err);
      }
    })();
  };

  onSettingSharesClick = (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    const shareId = btn.getAttribute("data-share-id");
    if (!action || !shareId) return;
    void (async () => {
      try {
        if (action === "copy-link") return await this.copyShareLink(shareId);
        if (action === "copy-info") return await this.copyShareInfo(shareId);
        if (action === "update") return await this.updateShare(shareId);
        if (action === "update-access") {
          const share = this.getShareById(shareId);
          if (!share) throw new Error(this.t("siyuanShare.error.shareNotFound"));
          const itemId = share.type === SHARE_TYPES.NOTEBOOK ? share.notebookId : share.docId;
          await this.openShareDialogFor({type: share.type, id: itemId, title: share.title || ""});
          return;
        }
        if (action === "delete") return await this.deleteShare(shareId);
      } catch (err) {
        this.showErr(err);
      }
    })();
  };

  renderSettingCurrent() {
    const wrap = this.settingEls?.currentWrap;
    if (!wrap) return;

    const t = this.t.bind(this);
    const docId = this.currentDoc.id;
    if (!isValidDocId(docId)) {
      wrap.innerHTML = `<div class="siyuan-plugin-share__section">
  <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.message.noCurrentDoc"))}</div>
</div>`;
      return;
    }

    const title = this.currentDoc.title || t("siyuanShare.label.untitledDoc");
    const share = this.getShareByDocId(docId);
    const url = share ? this.getShareUrl(share) : "";
    const passwordLabel = share?.hasPassword
      ? t("siyuanShare.label.passwordSet")
      : t("siyuanShare.label.passwordNotSet");
    const expiresLabel = share?.expiresAt ? this.formatTime(share.expiresAt) : t("siyuanShare.label.expiresNotSet");
    const visitorLimitValue = Number(share?.visitorLimit) || 0;
    const visitorLabel =
      visitorLimitValue > 0
        ? t("siyuanShare.label.visitorLimitCount", {count: visitorLimitValue})
        : t("siyuanShare.label.visitorLimitNotSet");
    wrap.innerHTML = `<div class="siyuan-plugin-share__section">
  <div class="siyuan-plugin-share__title">${escapeHtml(
    share ? t("siyuanShare.label.sharedDoc") : t("siyuanShare.label.unsharedDoc"),
  )}</div>
  <div>${escapeHtml(title)}</div>
  <div class="siyuan-plugin-share__muted siyuan-plugin-share__mono">${escapeHtml(
    t("siyuanShare.label.id"),
  )}: ${escapeHtml(docId)}</div>
  ${
    share
      ? `<div class="siyuan-plugin-share__muted">${escapeHtml(
          t("siyuanShare.label.shareId"),
        )}: <span class="siyuan-plugin-share__mono">${escapeHtml(
          share.slug || "",
        )}</span> | ${escapeHtml(t("siyuanShare.label.updatedAt"))}: ${escapeHtml(
          this.formatTime(share.updatedAt),
        )}</div>
  <div class="siyuan-plugin-share__muted">${escapeHtml(
          passwordLabel,
        )} | ${escapeHtml(expiresLabel)} | ${escapeHtml(visitorLabel)}</div>
  <div class="siyuan-plugin-share__actions" style="align-items: center;">
    <input class="b3-text-field fn__flex-1 siyuan-plugin-share__mono" readonly value="${escapeAttr(url)}" />
    <button class="b3-button b3-button--outline" data-action="copy-link">${escapeHtml(
      t("siyuanShare.action.copyLink"),
    )}</button>
  </div>
  <div class="siyuan-plugin-share__actions">
    <button class="b3-button b3-button--outline" data-action="update">${escapeHtml(
      t("siyuanShare.action.updateShare"),
    )}</button>
    <button class="b3-button b3-button--outline" data-action="update-access">${escapeHtml(
      t("siyuanShare.action.updateAccess"),
    )}</button>
    <button class="b3-button b3-button--outline" data-action="delete">${escapeHtml(
      t("siyuanShare.action.deleteShare"),
    )}</button>
  </div>`
      : `<div class="siyuan-plugin-share__muted">${escapeHtml(
          t("siyuanShare.message.currentDocNoShare"),
        )}</div>`
  }
</div>`;
  }

  renderSettingShares() {
    const wrap = this.settingEls?.sharesWrap;
    if (!wrap) return;
    const t = this.t.bind(this);
    const items = this.shares
      .map((s) => {
        const url = this.getShareUrl(s);
        const isCurrent = s.type === SHARE_TYPES.DOC && s.docId === this.currentDoc.id;
        const typeLabel =
          s.type === SHARE_TYPES.NOTEBOOK ? t("siyuanShare.label.notebook") : t("siyuanShare.label.document");
        const idLabel = s.type === SHARE_TYPES.NOTEBOOK ? s.notebookId : s.docId;
        const passwordLabel = s.hasPassword ? t("siyuanShare.label.passwordYes") : t("siyuanShare.label.passwordNo");
        const expiresLabel = s.expiresAt ? this.formatTime(s.expiresAt) : t("siyuanShare.label.expiresNotSet");
        const visitorLimitValue = Number(s.visitorLimit) || 0;
        const visitorLabel =
          visitorLimitValue > 0
            ? t("siyuanShare.label.visitorLimitCount", {count: visitorLimitValue})
            : t("siyuanShare.label.visitorLimitNotSet");
        return `<div class="sps-share-item ${isCurrent ? "sps-share-item--current" : ""}">
  <div class="sps-share-item__main">
    <div class="sps-share-item__title" title="${escapeAttr(s.title || "")}">${escapeHtml(
          s.title || t("siyuanShare.label.untitled"),
        )}</div>
    <div class="sps-share-item__meta">
      <span class="siyuan-plugin-share__mono" title="${escapeAttr(
          t("siyuanShare.label.shareId"),
        )}">${escapeHtml(s.slug || "")}</span>
      <span class="siyuan-plugin-share__muted" title="${escapeAttr(
          t("siyuanShare.label.type"),
        )}">${escapeHtml(typeLabel)}</span>
      <span class="siyuan-plugin-share__muted" title="${escapeAttr(
          t("siyuanShare.label.updatedAt"),
        )}">${escapeHtml(
          this.formatTime(s.updatedAt),
        )}</span>
      <span class="siyuan-plugin-share__muted" title="${escapeAttr(
          t("siyuanShare.label.accessSettings"),
        )}">${escapeHtml(
          passwordLabel,
        )} | ${escapeHtml(expiresLabel)} | ${escapeHtml(visitorLabel)}</span>
      <span class="siyuan-plugin-share__muted siyuan-plugin-share__mono" title="${escapeAttr(
          t("siyuanShare.label.id"),
        )}">${escapeHtml(
          idLabel || "",
        )}</span>
    </div>
    <div class="sps-share-item__link">
      <input class="b3-text-field fn__flex-1 siyuan-plugin-share__mono" readonly value="${escapeAttr(url)}" />
      <button class="b3-button b3-button--outline" data-action="copy-link" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.copyLink"))}</button>
      <button class="b3-button b3-button--outline" data-action="copy-info" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.copyShareInfo"))}</button>
    </div>
  </div>
  <div class="sps-share-item__actions">
    <button class="b3-button b3-button--outline" data-action="update" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.updateShare"))}</button>
    <button class="b3-button b3-button--outline" data-action="update-access" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.updateAccess"))}</button>
    <button class="b3-button b3-button--outline" data-action="delete" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.deleteShare"))}</button>
  </div>
</div>`;
      })
      .join("");

    wrap.innerHTML = `<div class="siyuan-plugin-share__section">
  <div class="siyuan-plugin-share__title">${escapeHtml(
    t("siyuanShare.title.shareListCount", {count: this.shares.length}),
  )}</div>
  <div class="sps-share-list">
    ${items || `<div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.message.noShareRecords"))}</div>`}
  </div>
</div>`;
  }


  async saveSettingsFromUI() {
    const siteUrl = this.getInputValue("sps-site").trim();
    const apiKey = this.getInputValue("sps-apikey").trim();
    const siteSelectId = this.getInputValue("sps-site-select").trim();
    let sites = this.normalizeSiteList(this.settings.sites);
    let activeSiteId = siteSelectId || String(this.settings.activeSiteId || "");
    let activeSite = sites.find((site) => String(site.id) === activeSiteId);
    const prevSiteUrl = activeSite?.siteUrl || "";
    const prevApiKey = activeSite?.apiKey || "";
    if (!activeSite && (siteUrl || apiKey)) {
      activeSiteId = activeSiteId || randomSlug(10);
      activeSite = {
        id: activeSiteId,
        name: this.resolveSiteName("", siteUrl, sites.length),
        siteUrl,
        apiKey,
        remoteUser: null,
        remoteVerifiedAt: 0,
        remoteFeatures: null,
      };
      sites.push(activeSite);
    } else if (activeSite) {
      activeSite.siteUrl = siteUrl;
      activeSite.apiKey = apiKey;
      activeSite.name = this.resolveSiteName(activeSite.name, siteUrl, sites.indexOf(activeSite));
      if (prevSiteUrl !== siteUrl || prevApiKey !== apiKey) {
        activeSite.remoteUser = null;
        activeSite.remoteVerifiedAt = 0;
        activeSite.remoteFeatures = null;
        this.remoteUploadLimits = null;
        this.remoteFeatures = null;
      }
    }
    this.settings = {
      ...this.settings,
      siteUrl,
      apiKey,
      sites,
      activeSiteId,
    };
    this.shares = Array.isArray(this.siteShares?.[activeSiteId]) ? this.siteShares[activeSiteId] : [];
    await this.saveData(STORAGE_SETTINGS, this.settings);
    if (!this.settings.siteUrl || !this.settings.apiKey) {
      this.shares = [];
      if (activeSiteId) {
        this.siteShares[activeSiteId] = [];
        await this.saveData(STORAGE_SITE_SHARES, this.siteShares);
      }
      this.remoteUser = null;
      this.remoteVerifiedAt = 0;
      this.remoteFeatures = null;
      this.remoteUploadLimits = null;
    }
    this.syncRemoteStatusFromSite(activeSite);
    this.syncSettingInputs();
    this.renderDock();
    this.renderSettingShares();
    this.updateTopBarState();
  }

  getInputValue(id) {
    if (!this.dockElement) return "";
    const el = this.dockElement.querySelector(`#${CSS.escape(id)}`);
    if (!el) return "";
    return el.value || "";
  }

  openShareDock() {
    try {
      this.openSetting();
      setTimeout(() => this.applySettingWideLayout(), 80);
    } catch (err) {
      console.error(err);
      this.notify(this.t("siyuanShare.message.openSharePanelFailed"));
    }
  }

  getUploadConcurrency() {
    return {
      asset: normalizePositiveInt(
        this.settings.uploadAssetConcurrency,
        DEFAULT_UPLOAD_ASSET_CONCURRENCY,
      ),
      chunk: normalizePositiveInt(
        this.settings.uploadChunkConcurrency,
        DEFAULT_UPLOAD_CHUNK_CONCURRENCY,
      ),
    };
  }

  normalizeUploadLimits(raw) {
    if (!raw || typeof raw !== "object") return null;
    const min = normalizePositiveInt(raw.minChunkSize, UPLOAD_CHUNK_MIN_SIZE);
    const max = normalizePositiveInt(raw.maxChunkSize, UPLOAD_CHUNK_MAX_SIZE);
    const safeMin = Math.max(1, Math.min(min, max));
    const cappedMax = Math.min(max, UPLOAD_CHUNK_HARD_MAX_SIZE);
    const safeMax = Math.max(safeMin, cappedMax);
    return {minChunkSize: safeMin, maxChunkSize: safeMax};
  }

  getUploadChunkLimits() {
    const remote = this.remoteUploadLimits || {};
    const min = normalizePositiveInt(remote.minChunkSize, UPLOAD_CHUNK_MIN_SIZE);
    const max = normalizePositiveInt(remote.maxChunkSize, UPLOAD_CHUNK_MAX_SIZE);
    const safeMin = Math.max(1, Math.min(min, max));
    const cappedMax = Math.min(max, UPLOAD_CHUNK_HARD_MAX_SIZE);
    const safeMax = Math.max(safeMin, cappedMax);
    return {min: safeMin, max: safeMax};
  }

  getUploadSpeedBps() {
    const speed = this.uploadTuner?.avgSpeed;
    if (Number.isFinite(speed) && speed > 0) return speed;
    return UPLOAD_DEFAULT_SPEED_BPS;
  }

  updateUploadSpeed(bytes, ms) {
    const size = Number(bytes);
    const elapsed = Number(ms);
    if (!Number.isFinite(size) || !Number.isFinite(elapsed) || size <= 0 || elapsed <= 0) return;
    const speed = (size / elapsed) * 1000;
    const tuner = this.uploadTuner || {avgSpeed: 0, samples: 0};
    const alpha = 0.2;
    tuner.avgSpeed = tuner.avgSpeed ? tuner.avgSpeed * (1 - alpha) + speed * alpha : speed;
    tuner.samples = (tuner.samples || 0) + 1;
    this.uploadTuner = tuner;
  }

  getAdaptiveAssetConcurrency(totalBytes, totalAssets, maxConcurrency, sizes = []) {
    const limit = normalizePositiveInt(maxConcurrency, DEFAULT_UPLOAD_ASSET_CONCURRENCY);
    const total = Math.max(1, Number(totalAssets) || 1);
    if (total <= 1) return 1;
    const size = Number(totalBytes);
    const avgSize = Number.isFinite(size) && total > 0 ? size / total : 0;
    const speed = this.getUploadSpeedBps();
    let concurrency = 1;
    if (total >= 100) {
      concurrency = 8;
    } else if (total >= 50) {
      concurrency = 6;
    } else if (total >= 20) {
      concurrency = 4;
    } else if (total >= 10) {
      concurrency = 3;
    } else if (total >= 4) {
      concurrency = 2;
    }
    const filteredSizes = Array.isArray(sizes) ? sizes.filter((s) => Number.isFinite(s) && s > 0) : [];
    if (filteredSizes.length > 0) {
      const sorted = filteredSizes.slice().sort((a, b) => a - b);
      const mid = sorted[Math.floor(sorted.length * 0.5)] || 0;
      const p90 = sorted[Math.floor(sorted.length * 0.9)] || mid;
      const max = sorted[sorted.length - 1] || mid;
      if (mid > 0) {
        if (mid <= 128 * 1024) {
          concurrency = Math.max(concurrency, 8);
        } else if (mid <= 256 * 1024) {
          concurrency = Math.max(concurrency, 6);
        } else if (mid <= 512 * 1024) {
          concurrency = Math.max(concurrency, 4);
        } else if (mid <= 2 * MB) {
          concurrency = Math.max(concurrency, 3);
        } else if (mid <= 8 * MB) {
          concurrency = Math.max(concurrency, 2);
        }
      }
      if (p90 >= 32 * MB) {
        concurrency = Math.min(concurrency, 3);
      }
      if (max >= 64 * MB) {
        concurrency = Math.min(concurrency, 2);
      }
      if (max >= 128 * MB) {
        concurrency = 1;
      }
    } else if (avgSize > 0) {
      if (avgSize <= 512 * 1024) {
        concurrency = Math.max(concurrency, 4);
      } else if (avgSize <= 2 * MB) {
        concurrency = Math.max(concurrency, 3);
      } else if (avgSize <= 8 * MB) {
        concurrency = Math.max(concurrency, 2);
      }
      if (avgSize >= 128 * MB) {
        concurrency = Math.min(concurrency, 1);
      } else if (avgSize >= 64 * MB) {
        concurrency = Math.min(concurrency, 2);
      }
    }
    if (speed >= 12 * MB) {
      concurrency = Math.max(concurrency, 6);
    } else if (speed >= 8 * MB) {
      concurrency = Math.max(concurrency, 5);
    } else if (speed >= 4 * MB) {
      concurrency = Math.max(concurrency, 4);
    } else if (speed >= 2 * MB) {
      concurrency = Math.max(concurrency, 3);
    }
    return Math.min(limit, concurrency, total);
  }

  getAdaptiveChunkSize(sizeBytes) {
    const size = Number(sizeBytes) || 0;
    const {min, max} = this.getUploadChunkLimits();
    if (size > 0 && size <= min) return size;
    const speed = this.getUploadSpeedBps();
    let chunkSize = Math.round((speed * UPLOAD_TARGET_CHUNK_MS) / 1000);
    let sizeHint = 0;
    if (size >= 1024 * MB) {
      sizeHint = max;
    } else if (size >= 512 * MB) {
      sizeHint = Math.min(max, 6 * MB);
    } else if (size >= 256 * MB) {
      sizeHint = Math.min(max, 4 * MB);
    } else if (size >= 128 * MB) {
      sizeHint = Math.min(max, 3 * MB);
    } else if (size >= 64 * MB) {
      sizeHint = Math.min(max, 2 * MB);
    } else if (size >= 16 * MB) {
      sizeHint = Math.min(max, 1 * MB);
    } else if (size >= 4 * MB) {
      sizeHint = Math.min(max, Math.max(min, 512 * 1024));
    }
    chunkSize = Math.max(chunkSize, sizeHint);
    chunkSize = Math.max(min, Math.min(max, chunkSize));
    if (size > 0 && chunkSize > size) {
      chunkSize = size;
    }
    return chunkSize;
  }

  getAdaptiveChunkConcurrency(sizeBytes, chunkSize, maxConcurrency) {
    const size = Number(sizeBytes) || 0;
    const chunk = Math.max(1, Number(chunkSize) || 1);
    const totalChunks = Math.max(1, Math.ceil(size / chunk));
    const limit = normalizePositiveInt(maxConcurrency, DEFAULT_UPLOAD_CHUNK_CONCURRENCY);
    const speed = this.getUploadSpeedBps();
    let concurrency = 1;
    if (speed >= 10 * MB) {
      concurrency = 4;
    } else if (speed >= 6 * MB) {
      concurrency = 3;
    } else if (speed >= 2.5 * MB) {
      concurrency = 2;
    }
    if (size >= 512 * MB) {
      concurrency = Math.max(concurrency, 4);
    } else if (size >= 256 * MB) {
      concurrency = Math.max(concurrency, 3);
    } else if (size >= 128 * MB) {
      concurrency = Math.max(concurrency, 2);
    }
    if (totalChunks <= 2) {
      concurrency = 1;
    } else if (totalChunks <= 4) {
      concurrency = Math.min(concurrency, 2);
    }
    return Math.min(limit, concurrency, totalChunks);
  }

  getDocExportConcurrency(totalDocs = 0) {
    const total = Math.max(0, Math.floor(Number(totalDocs) || 0));
    if (total <= 1) return 1;
    const cpu = normalizePositiveInt(globalThis?.navigator?.hardwareConcurrency, 0);
    let concurrency = DEFAULT_DOC_EXPORT_CONCURRENCY;
    if (cpu > 0 && cpu <= 3) {
      concurrency = 2;
    } else if (cpu > 0 && cpu <= 5) {
      concurrency = 3;
    }
    return Math.max(1, Math.min(4, total, concurrency));
  }

  getPrepareAssetsConcurrency(totalAssets = 0, maxConcurrency = DEFAULT_MARKDOWN_ASSET_PREPARE_CONCURRENCY) {
    const total = Math.max(0, Math.floor(Number(totalAssets) || 0));
    if (total <= 1) return 1;
    const cpu = normalizePositiveInt(globalThis?.navigator?.hardwareConcurrency, 0);
    let concurrency = normalizePositiveInt(maxConcurrency, DEFAULT_MARKDOWN_ASSET_PREPARE_CONCURRENCY);
    if (cpu > 0 && cpu <= 3) {
      concurrency = Math.min(concurrency, 2);
    }
    return Math.max(1, Math.min(concurrency, total));
  }

  async collectDocExportResults(docs, notebookId, {controller = null, progress = null} = {}) {
    const t = this.t.bind(this);
    const list = (Array.isArray(docs) ? docs : []).filter((doc) => isValidDocId(String(doc?.docId || "")));
    if (list.length === 0) return [];
    const total = list.length;
    const concurrency = this.getDocExportConcurrency(total);
    const perDocAssetConcurrency = concurrency >= 4 ? 2 : 3;
    const results = new Array(total);
    const docProgress = new Array(total).fill(0);
    const reportProgress = (docIndex, ratio) => {
      if (!progress?.update) return;
      if (docIndex < 0 || docIndex >= total) return;
      const clamped = Math.max(0, Math.min(1, Number(ratio) || 0));
      if (clamped <= docProgress[docIndex]) return;
      docProgress[docIndex] = clamped;
      const sum = docProgress.reduce((acc, value) => acc + value, 0);
      const percent = total > 0 ? (sum / total) * 100 : 0;
      const completed = docProgress.filter((value) => value >= 1).length;
      const currentIndex = Math.max(1, Math.min(total, completed + 1));
      progress.update({
        text: t("siyuanShare.progress.exportingDoc", {index: currentIndex, total}),
        percent,
      });
    };
    reportProgress(0, 0.01);
    const tasks = list.map((doc, index) => async () => {
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      reportProgress(index, 0.05);
      const exportRes = await this.exportDocMarkdown(String(doc.docId || ""));
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      reportProgress(index, 0.35);
      const prepared = await this.prepareMarkdownAssets(exportRes.content || "", controller, notebookId, {
        concurrency: perDocAssetConcurrency,
        onProgress: ({current = 0, total: assetTotal = 0} = {}) => {
          const totalCount = Math.max(1, Math.floor(Number(assetTotal) || 0));
          const doneCount = Math.max(0, Math.min(totalCount, Math.floor(Number(current) || 0)));
          reportProgress(index, 0.35 + (doneCount / totalCount) * 0.6);
        },
      });
      results[index] = {
        doc,
        index,
        exportRes,
        markdown: prepared.markdown,
        assets: prepared.assets,
        failures: prepared.failures,
      };
      reportProgress(index, 1);
    });
    try {
      await runTasksWithConcurrency(tasks, concurrency);
    } catch (err) {
      if (!isAbortError(err) && controller && !controller.signal?.aborted) {
        try {
          controller.abort();
        } catch {
          // ignore
        }
      }
      throw err;
    }
    return results.filter(Boolean);
  }

  formatUploadDetail(uploaded, total, assetDone = null, assetTotal = null) {
    const hasAssets = Number.isFinite(assetDone) && Number.isFinite(assetTotal) && assetTotal > 0;
    if (hasAssets) {
      return this.t("siyuanShare.progress.uploadedAssetsBytes", {
        current: Math.min(assetTotal, Math.max(0, Math.floor(assetDone))),
        total: Math.max(1, Math.floor(assetTotal)),
        bytesCurrent: formatBytes(uploaded),
        bytesTotal: formatBytes(total),
      });
    }
    return this.t("siyuanShare.progress.uploadedBytes", {
      current: formatBytes(uploaded),
      total: formatBytes(total),
    });
  }

  getUploadPercent(tracker) {
    if (!tracker) return null;
    const hasAssets = Number.isFinite(tracker.totalAssets) && tracker.totalAssets > 0;
    const hasBytes = Number.isFinite(tracker.totalBytes) && tracker.totalBytes > 0;
    const assetPercent = hasAssets ? (tracker.completedAssets / tracker.totalAssets) * 100 : 0;
    const bytePercent = hasBytes ? (tracker.uploadedBytes / tracker.totalBytes) * 100 : 0;
    if (hasBytes) {
      let percent = bytePercent;
      if (hasAssets && tracker.completedAssets < tracker.totalAssets && percent >= 100) {
        percent = 99;
      }
      return percent;
    }
    if (hasAssets) return assetPercent;
    return null;
  }

  supportsIncrementalShare() {
    return !!this.remoteFeatures?.incrementalShare;
  }

  async fetchShareSnapshot(shareId, {controller = null, progress = null} = {}) {
    if (!shareId) throw new Error(this.t("siyuanShare.error.missingShareId"));
    return this.remoteRequest(REMOTE_API.shareSnapshot, {
      method: "POST",
      body: {shareId},
      controller,
      progress,
      progressText: this.t("siyuanShare.progress.analyzingIncrement"),
    });
  }

  collectPayloadDocRows(payload) {
    if (!payload || typeof payload !== "object") return [];
    const docs = [];
    if (Array.isArray(payload.docs) && payload.docs.length > 0) {
      payload.docs.forEach((doc, index) => {
        const docId = String(doc?.docId || "").trim();
        if (!isValidDocId(docId)) return;
        docs.push({
          docId,
          title: String(doc?.title || ""),
          icon: normalizeDocIconValue(doc?.icon || ""),
          hPath: String(doc?.hPath || ""),
          parentId: String(doc?.parentId || ""),
          sortIndex: Number.isFinite(Number(doc?.sortIndex)) ? Number(doc.sortIndex) : index,
          sortOrder: Math.max(0, Math.floor(Number(doc?.sortOrder) || index)),
          markdown: String(doc?.markdown || ""),
        });
      });
      return docs;
    }
    const docId = String(payload?.docId || "").trim();
    if (!isValidDocId(docId)) return [];
    docs.push({
      docId,
      title: String(payload?.title || ""),
      icon: normalizeDocIconValue(payload?.icon || ""),
      hPath: String(payload?.hPath || ""),
      parentId: "",
      sortIndex: 0,
      sortOrder: Math.max(0, Math.floor(Number(payload?.sortOrder) || 0)),
      markdown: String(payload?.markdown || ""),
    });
    return docs;
  }

  async buildIncrementalLocalState(payload, assetEntries, {controller = null, progress = null} = {}) {
    const t = this.t.bind(this);
    const docs = this.collectPayloadDocRows(payload);
    const localDocs = [];
    for (let i = 0; i < docs.length; i += 1) {
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const doc = docs[i];
      const contentHash = await hashTextSha256(doc.markdown || "");
      const metaHash = await hashTextSha256(buildDocMetaHashInput(doc));
      localDocs.push({
        ...doc,
        contentHash: normalizeHashHex(contentHash),
        metaHash: normalizeHashHex(metaHash),
        size: String(doc.markdown || "").length,
      });
      progress?.update?.({
        text: t("siyuanShare.progress.analyzingIncrement"),
        detail: t("siyuanShare.progress.analyzingDocs", {index: i + 1, total: docs.length}),
      });
    }

    const localAssets = [];
    const seenPath = new Set();
    const list = Array.isArray(assetEntries) ? assetEntries : [];
    for (let i = 0; i < list.length; i += 1) {
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const entry = list[i] || {};
      const asset = entry.asset || entry;
      const rawPath = normalizeAssetPath(asset?.path || "");
      if (!rawPath || seenPath.has(rawPath)) continue;
      seenPath.add(rawPath);
      const blob = asset?.blob || null;
      const hash = blob ? await hashBlobSha256(blob) : "";
      const size = Number(asset?.blob?.size) || 0;
      localAssets.push({
        path: rawPath,
        docId: String(entry?.docId || "").trim(),
        size: Math.max(0, size),
        hash: normalizeHashHex(hash),
      });
      progress?.update?.({
        text: t("siyuanShare.progress.analyzingIncrement"),
        detail: t("siyuanShare.progress.analyzingAssets", {index: i + 1, total: list.length}),
      });
    }
    return {docs: localDocs, assets: localAssets};
  }

  normalizeSnapshotDocs(rawDocs) {
    if (!Array.isArray(rawDocs)) return [];
    const out = [];
    rawDocs.forEach((doc, index) => {
      const docId = String(doc?.docId || "").trim();
      if (!isValidDocId(docId)) return;
      out.push({
        docId,
        contentHash: normalizeHashHex(doc?.contentHash),
        metaHash: normalizeHashHex(doc?.metaHash),
        sortOrder: Math.max(0, Math.floor(Number(doc?.sortOrder) || index)),
      });
    });
    return out;
  }

  normalizeSnapshotAssets(rawAssets) {
    if (!Array.isArray(rawAssets)) return [];
    const out = [];
    rawAssets.forEach((asset) => {
      const path = normalizeAssetPath(asset?.path || "");
      if (!path) return;
      out.push({
        path,
        docId: String(asset?.docId || "").trim(),
        hash: normalizeHashHex(asset?.hash),
      });
    });
    return out;
  }

  buildIncrementalPlan(localState, remoteSnapshot) {
    const localDocs = Array.isArray(localState?.docs) ? localState.docs : [];
    const localAssets = Array.isArray(localState?.assets) ? localState.assets : [];
    const remoteDocs = this.normalizeSnapshotDocs(remoteSnapshot?.docs);
    const remoteAssets = this.normalizeSnapshotAssets(remoteSnapshot?.assets);
    const localDocMap = new Map(localDocs.map((doc) => [String(doc.docId), doc]));
    const remoteDocMap = new Map(remoteDocs.map((doc) => [String(doc.docId), doc]));
    const localAssetMap = new Map(localAssets.map((asset) => [String(asset.path), asset]));
    const remoteAssetMap = new Map(remoteAssets.map((asset) => [String(asset.path), asset]));

    const addedDocIds = [];
    const updatedDocIds = [];
    const changedDocIds = new Set();
    localDocs.forEach((doc) => {
      const remote = remoteDocMap.get(String(doc.docId));
      if (!remote) {
        addedDocIds.push(String(doc.docId));
        changedDocIds.add(String(doc.docId));
        return;
      }
      if (!remote.contentHash || !remote.metaHash) {
        updatedDocIds.push(String(doc.docId));
        changedDocIds.add(String(doc.docId));
        return;
      }
      if (remote.contentHash !== normalizeHashHex(doc.contentHash)) {
        updatedDocIds.push(String(doc.docId));
        changedDocIds.add(String(doc.docId));
        return;
      }
      if (remote.metaHash !== normalizeHashHex(doc.metaHash)) {
        updatedDocIds.push(String(doc.docId));
        changedDocIds.add(String(doc.docId));
      }
    });

    const deletedDocIds = [];
    remoteDocs.forEach((doc) => {
      if (!localDocMap.has(String(doc.docId))) {
        deletedDocIds.push(String(doc.docId));
      }
    });

    const addedAssetPaths = [];
    const updatedAssetPaths = [];
    const changedAssetPaths = new Set();
    localAssets.forEach((asset) => {
      const remote = remoteAssetMap.get(String(asset.path));
      if (!remote) {
        addedAssetPaths.push(String(asset.path));
        changedAssetPaths.add(String(asset.path));
        return;
      }
      if (!remote.hash || !asset.hash || remote.hash !== normalizeHashHex(asset.hash)) {
        updatedAssetPaths.push(String(asset.path));
        changedAssetPaths.add(String(asset.path));
        return;
      }
      if (String(remote.docId || "") !== String(asset.docId || "")) {
        updatedAssetPaths.push(String(asset.path));
        changedAssetPaths.add(String(asset.path));
      }
    });

    const deletedAssetPaths = [];
    remoteAssets.forEach((asset) => {
      if (!localAssetMap.has(String(asset.path))) {
        deletedAssetPaths.push(String(asset.path));
      }
    });

    const uploadDocs = localDocs
      .filter((doc) => changedDocIds.has(String(doc.docId)))
      .map((doc) => ({
        docId: String(doc.docId),
        title: String(doc.title || ""),
        icon: normalizeDocIconValue(doc.icon || ""),
        hPath: String(doc.hPath || ""),
        parentId: String(doc.parentId || ""),
        sortIndex: Number.isFinite(Number(doc.sortIndex)) ? Number(doc.sortIndex) : 0,
        sortOrder: Math.max(0, Math.floor(Number(doc.sortOrder) || 0)),
        markdown: String(doc.markdown || ""),
        contentHash: normalizeHashHex(doc.contentHash),
        metaHash: normalizeHashHex(doc.metaHash),
      }));
    const uploadAssetPaths = Array.from(changedAssetPaths);
    const uploadAssetEntries = (Array.isArray(localState?.assetEntries) ? localState.assetEntries : []).filter((entry) => {
      const asset = entry?.asset || entry;
      const path = normalizeAssetPath(asset?.path || "");
      return path && changedAssetPaths.has(path);
    });
    const uploadAssets = localAssets
      .filter((asset) => changedAssetPaths.has(String(asset.path)))
      .map((asset) => ({
        path: String(asset.path),
        size: Math.max(0, Number(asset.size) || 0),
        docId: String(asset.docId || ""),
        hash: normalizeHashHex(asset.hash),
      }));

    return {
      uploadDocs,
      uploadAssets,
      uploadAssetEntries,
      uploadAssetPaths,
      deletedDocIds,
      deletedAssetPaths,
      summary: {
        baseDocs: remoteDocs.length,
        baseAssets: remoteAssets.length,
        totalDocs: localDocs.length,
        totalAssets: localAssets.length,
        addedDocs: addedDocIds.length,
        updatedDocs: updatedDocIds.length,
        changedDocs: uploadDocs.length,
        addedAssets: addedAssetPaths.length,
        updatedAssets: updatedAssetPaths.length,
        changedAssets: uploadAssets.length,
        deletedDocs: deletedDocIds.length,
        deletedAssets: deletedAssetPaths.length,
      },
    };
  }

  buildFullUploadPlan(localState, {assumeExisting = false} = {}) {
    const localDocs = Array.isArray(localState?.docs) ? localState.docs : [];
    const localAssets = Array.isArray(localState?.assets) ? localState.assets : [];
    const uploadDocs = localDocs.map((doc) => ({
      docId: String(doc.docId),
      title: String(doc.title || ""),
      icon: normalizeDocIconValue(doc.icon || ""),
      hPath: String(doc.hPath || ""),
      parentId: String(doc.parentId || ""),
      sortIndex: Number.isFinite(Number(doc.sortIndex)) ? Number(doc.sortIndex) : 0,
      sortOrder: Math.max(0, Math.floor(Number(doc.sortOrder) || 0)),
      markdown: String(doc.markdown || ""),
      contentHash: normalizeHashHex(doc.contentHash),
      metaHash: normalizeHashHex(doc.metaHash),
    }));
    const uploadAssets = localAssets.map((asset) => ({
      path: String(asset.path),
      size: Math.max(0, Number(asset.size) || 0),
      docId: String(asset.docId || ""),
      hash: normalizeHashHex(asset.hash),
    }));
    const existing = !!assumeExisting;
    return {
      uploadDocs,
      uploadAssets,
      uploadAssetEntries: Array.isArray(localState?.assetEntries) ? localState.assetEntries : [],
      uploadAssetPaths: uploadAssets.map((asset) => String(asset.path)),
      deletedDocIds: [],
      deletedAssetPaths: [],
      summary: {
        baseDocs: existing ? localDocs.length : 0,
        baseAssets: existing ? localAssets.length : 0,
        totalDocs: localDocs.length,
        totalAssets: localAssets.length,
        addedDocs: existing ? 0 : localDocs.length,
        updatedDocs: existing ? localDocs.length : 0,
        changedDocs: localDocs.length,
        addedAssets: existing ? 0 : localAssets.length,
        updatedAssets: existing ? localAssets.length : 0,
        changedAssets: localAssets.length,
        deletedDocs: 0,
        deletedAssets: 0,
      },
    };
  }

  formatIncrementSummaryDetail(summary) {
    const t = this.t.bind(this);
    const toCount = (value) => Math.max(0, Math.floor(Number(value) || 0));
    const line = (title, base, added, updated, deleted) =>
      `${title}: ${t("siyuanShare.progress.incrementStatBase")} ${toCount(base)} | ${t(
        "siyuanShare.progress.incrementStatAdded",
      )} ${toCount(added)} | ${t("siyuanShare.progress.incrementStatUpdated")} ${toCount(
        updated,
      )} | ${t("siyuanShare.progress.incrementStatDeleted")} ${toCount(deleted)}`;
    return [
      line(
        t("siyuanShare.progress.incrementSectionDocs"),
        summary?.baseDocs,
        summary?.addedDocs,
        summary?.updatedDocs,
        summary?.deletedDocs,
      ),
      line(
        t("siyuanShare.progress.incrementSectionAssets"),
        summary?.baseAssets,
        summary?.addedAssets,
        summary?.updatedAssets,
        summary?.deletedAssets,
      ),
    ].join("\n");
  }

  async uploadAssetsChunked(uploadId, entries, controller, progress, totalBytes = 0) {
    const t = this.t.bind(this);
        if (!uploadId) {
          throw new Error(t("siyuanShare.error.missingUploadId"));
        }
    if (!Array.isArray(entries) || entries.length === 0) return;
    const total = entries.length;
    const baseLabel = t("siyuanShare.progress.uploadingContent");
    const {asset: assetMax, chunk: chunkMax} = this.getUploadConcurrency();
    const sortedEntries = entries
      .slice()
      .sort((a, b) => (Number(b?.asset?.blob?.size) || 0) - (Number(a?.asset?.blob?.size) || 0));
    const sizes = sortedEntries.map((entry) => Number(entry?.asset?.blob?.size) || 0);
    const assetConcurrency = this.getAdaptiveAssetConcurrency(totalBytes, entries.length, assetMax, sizes);
    let fatalError = null;
    const tracker = {
      totalBytes: Number.isFinite(totalBytes) ? totalBytes : 0,
      uploadedBytes: 0,
      totalAssets: total,
      completedAssets: 0,
      label: baseLabel,
      started: false,
    };
    const reportProgress = () => {
      if (!progress?.update) return;
      if (tracker.totalBytes > 0) {
        const percent = this.getUploadPercent(tracker);
        progress.update({
          text: baseLabel,
          percent,
          detail: this.formatUploadDetail(
            tracker.uploadedBytes,
            tracker.totalBytes,
            tracker.completedAssets,
            tracker.totalAssets,
          ),
        });
      } else {
        const percent = this.getUploadPercent(tracker);
        progress.update({text: baseLabel, percent});
      }
    };
    const tasks = sortedEntries.map((entry) => async () => {
      const assetEntry = entry || {};
      const asset = assetEntry.asset || assetEntry;
      const docId = assetEntry.docId || "";
      try {
        if (!tracker.started) {
          tracker.started = true;
          reportProgress();
        }
        await this.uploadAssetInChunks(uploadId, asset, docId, controller, progress, tracker, baseLabel, chunkMax);
        tracker.completedAssets += 1;
        reportProgress();
      } catch (err) {
        if (!fatalError && !isAbortError(err)) {
          fatalError = err;
        }
        if (controller && !controller.signal?.aborted) {
          try {
            controller.abort();
          } catch {
            // ignore
          }
        }
        throw err;
      }
    });
    try {
      await runTasksWithConcurrency(tasks, assetConcurrency);
    } catch (err) {
      if (fatalError && isAbortError(err)) {
        throw fatalError;
      }
      throw err;
    }
    reportProgress();
  }

  async uploadAssetInChunks(
    uploadId,
    asset,
    docId,
    controller,
    progress,
    tracker,
    label,
    chunkMaxConcurrency,
  ) {
    const t = this.t.bind(this);
    const blob = asset?.blob;
    const assetPath = asset?.path;
    if (!blob || !assetPath) return;
    const size = Number(blob.size) || 0;
    const chunkSize = this.getAdaptiveChunkSize(size);
    const totalChunks = Math.max(1, Math.ceil(size / chunkSize));
    const concurrency = this.getAdaptiveChunkConcurrency(size, chunkSize, chunkMaxConcurrency);
    const uploadChunkOnce = async (index, {countBytes = true} = {}) => {
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const start = index * chunkSize;
      const end = Math.min(size, start + chunkSize);
      const chunk = blob.slice(start, end);
      const form = new FormData();
      form.append("uploadId", String(uploadId));
      form.append("assetPath", assetPath);
      if (docId) form.append("assetDocId", String(docId));
      form.append("chunkIndex", String(index));
      form.append("totalChunks", String(totalChunks));
      form.append("totalSize", String(size));
      form.append("chunk", chunk, assetPath);
      const startedAt = nowTs();
      try {
        await withRetry(
          () =>
            this.remoteRequest(REMOTE_API.shareAssetChunk, {
              method: "POST",
              body: form,
              isForm: true,
              controller,
              progress,
            }).catch((err) => {
              if (getMissingChunksFromError(err)) {
                err.noRetry = true;
              }
              throw err;
            }),
          {
            retries: UPLOAD_RETRY_LIMIT,
            baseDelay: UPLOAD_RETRY_BASE_DELAY,
            maxDelay: UPLOAD_RETRY_MAX_DELAY,
            controller,
          },
        );
      } catch (err) {
        throw err;
      }
      const elapsed = nowTs() - startedAt;
      this.updateUploadSpeed(end - start, elapsed);
      if (countBytes && tracker && tracker.totalBytes > 0) {
        tracker.uploadedBytes += end - start;
        const percent = this.getUploadPercent(tracker);
        progress?.update?.({
          text: label || tracker.label,
          percent,
          detail: this.formatUploadDetail(
            tracker.uploadedBytes,
            tracker.totalBytes,
            tracker.completedAssets,
            tracker.totalAssets,
          ),
        });
      }
    };
    if (totalChunks === 1) {
      await uploadChunkOnce(0);
      return;
    }
    const lastChunkIndex = totalChunks - 1;
    const tasks = [];
    for (let index = 0; index < lastChunkIndex; index += 1) {
      tasks.push(() => uploadChunkOnce(index));
    }
    await runTasksWithConcurrency(tasks, concurrency);
    let missingAttempt = 0;
    while (true) {
      try {
        await uploadChunkOnce(lastChunkIndex);
        break;
      } catch (err) {
        const missing = getMissingChunksFromError(err);
        if (!missing || missingAttempt >= UPLOAD_MISSING_CHUNK_RETRY_LIMIT) {
          throw err;
        }
        missingAttempt += 1;
        const normalizedMissing = Array.from(new Set(missing)).filter(
          (idx) => idx >= 0 && idx < totalChunks && idx !== lastChunkIndex,
        );
        if (normalizedMissing.length === 0) {
          throw err;
        }
        console.warn("Missing chunks detected, retrying upload.", {
          assetPath,
          missing: normalizedMissing,
          attempt: missingAttempt,
        });
        const retryTasks = normalizedMissing.map((idx) => () => uploadChunkOnce(idx, {countBytes: false}));
        await runTasksWithConcurrency(retryTasks, Math.min(concurrency, retryTasks.length));
      }
    }
  }


  async shareDoc(
    docId,
    {
      slugOverride = "",
      password = "",
      clearPassword = false,
      expiresAt = null,
      clearExpires = false,
      visitorLimit = null,
      clearVisitorLimit = false,
      includeChildren = false,
      allowRequestError = true,
    } = {},
  ) {
    const t = this.t.bind(this);
    if (!isValidDocId(docId)) throw new Error(t("siyuanShare.error.invalidDocId"));
    const controller = new AbortController();
    const progress = this.openProgressDialog(t("siyuanShare.progress.creatingShare"), controller);
    try {
      progress.update(t("siyuanShare.progress.verifyingSite"));
      await this.verifyRemote({controller, progress});
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      progress.update(t("siyuanShare.progress.fetchingDocInfo"));
      const info = await this.resolveDocInfoFromAnyId(docId);
      const title = info?.title || t("siyuanShare.label.untitled");
      const notebookId = await this.resolveNotebookIdFromDoc(docId);
      let rootIcon = await this.resolveDocIcon(docId);
      if (!normalizeDocIconValue(rootIcon)) {
        rootIcon = DEFAULT_DOC_ICON_LEAF;
      }
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      let payload = null;
      let assetEntries = [];
      let assetManifest = [];
      let resourceFailures = 0;
      let subtreeDocs = [];
      const exportedMarkdowns = [];
      const iconUploadMap = new Map();
      if (includeChildren) {
        progress.update(t("siyuanShare.progress.fetchingNotebookList"));
        subtreeDocs = await this.listDocSubtree(docId);
        if (!Array.isArray(subtreeDocs) || subtreeDocs.length === 0) {
          throw new Error("Doc tree fetch failed: listDocsByPath returned empty.");
        }
        await this.fillDocIcons(subtreeDocs);
        applyDefaultDocIcons(subtreeDocs);
      }
      const useChildren = includeChildren && subtreeDocs.length > 1;
      if (!useChildren) {
        progress.update(t("siyuanShare.progress.exportingMarkdown"));
        const exportRes = await this.exportDocMarkdown(docId);
        throwIfAborted(controller, t("siyuanShare.message.cancelled"));
        progress.update(t("siyuanShare.progress.preparingAssets"));
        const {markdown, assets, failures} = await this.prepareMarkdownAssets(
          exportRes.content || "",
          controller,
          notebookId,
        );
        if (markdown) exportedMarkdowns.push(markdown);
        resourceFailures += failures.length;
        const assetMap = new Map();
        const usedUploadPaths = new Set();
        for (const asset of assets) {
          const assetPath = asset?.path || "";
          if (!assetPath || assetMap.has(assetPath)) continue;
          assetMap.set(assetPath, {asset, docId});
          usedUploadPaths.add(assetPath);
        }
        const finalIcon = await this.resolveIconUpload(rootIcon, {
          docId,
          notebookId,
          usedUploadPaths,
          assetMap,
          iconUploadMap,
          controller,
        });
        payload = {
          docId,
          title,
          hPath: exportRes.hPath || "",
          markdown,
          sortOrder: 0,
        };
        if (finalIcon) payload.icon = finalIcon;
        assetEntries = Array.from(assetMap.values());
        assetManifest = assetEntries.map(({asset, docId: entryDocId}) => ({
          path: asset.path,
          size: Number(asset?.blob?.size) || 0,
          docId: entryDocId,
        }));
      } else {
        const docPayloads = [];
        const assetMap = new Map();
        const usedUploadPaths = new Set();
        const docResults = await this.collectDocExportResults(subtreeDocs, notebookId, {controller, progress});
        for (const result of docResults) {
          const doc = result.doc;
          const index = Number(result.index) || 0;
          const exportRes = result.exportRes || {};
          const markdown = String(result.markdown || "");
          const assets = Array.isArray(result.assets) ? result.assets : [];
          const failures = Array.isArray(result.failures) ? result.failures : [];
          if (markdown) exportedMarkdowns.push(markdown);
          resourceFailures += failures.length;
          const docTitle =
            doc.title || (doc.docId === docId ? title : t("siyuanShare.label.untitled"));
          const iconValue = await this.resolveIconUpload(doc?.icon, {
            docId: doc.docId,
            notebookId,
            usedUploadPaths,
            assetMap,
            iconUploadMap,
            controller,
          });
          docPayloads.push({
            docId: doc.docId,
            title: docTitle,
            hPath: exportRes.hPath || "",
            parentId: doc.docId === docId ? "" : doc.parentId || "",
            sortIndex: Number.isFinite(doc.sortIndex) ? doc.sortIndex : index,
            sortOrder: index,
            markdown,
            ...(iconValue ? {icon: iconValue} : {}),
          });
          for (const asset of assets) {
            if (!asset?.path || assetMap.has(asset.path)) continue;
            assetMap.set(asset.path, {asset, docId: doc.docId});
            usedUploadPaths.add(asset.path);
          }
        }
        payload = {
          docId,
          title,
          docs: docPayloads,
        };
        assetEntries = Array.from(assetMap.values());
        assetManifest = assetEntries.map(({asset, docId}) => ({
          path: asset.path,
          size: Number(asset?.blob?.size) || 0,
          docId,
        }));
      }
      if (resourceFailures > 0) {
        console.warn("Some assets failed to download.", resourceFailures);
      }
      const refDocIds = useChildren
        ? subtreeDocs.map((doc) => String(doc?.docId || ""))
        : [docId];
      await this.maybeWarnExportReference(exportedMarkdowns, refDocIds);
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const slug = sanitizeSlug(slugOverride);
      if (slug) payload.slug = slug;
      if (clearPassword) {
        payload.clearPassword = true;
      } else if (password) {
        payload.password = password;
      }
      if (clearExpires) {
        payload.clearExpires = true;
      } else if (Number.isFinite(expiresAt) && expiresAt > 0) {
        payload.expiresAt = expiresAt;
      }
      if (clearVisitorLimit) {
        payload.clearVisitorLimit = true;
      } else if (Number.isFinite(visitorLimit)) {
        payload.visitorLimit = Math.max(0, Math.floor(visitorLimit));
      }
      let uploadPayload = payload;
      let uploadAssetEntries = assetEntries;
      let uploadAssetManifest = assetManifest;
      const existingShare = this.getShareByDocId(docId);
      const canUseIncremental = !!(existingShare?.id && this.supportsIncrementalShare());
      try {
        progress.update(t("siyuanShare.progress.analyzingIncrement"));
        const localState = await this.buildIncrementalLocalState(payload, assetEntries, {controller, progress});
        localState.assetEntries = assetEntries;
        throwIfAborted(controller, t("siyuanShare.message.cancelled"));
        const plan = canUseIncremental
          ? this.buildIncrementalPlan(
              localState,
              await this.fetchShareSnapshot(existingShare.id, {controller, progress}),
            )
          : this.buildFullUploadPlan(localState, {assumeExisting: !!existingShare?.id});
        const detail = this.formatIncrementSummaryDetail(plan.summary);
        let proceed = false;
        progress.setBarVisible?.(false);
        try {
          proceed = await progress.confirm({
            text: t("siyuanShare.progress.incrementReady"),
            detail,
            continueText: t("siyuanShare.action.continueUpload"),
          });
        } finally {
          progress.setBarVisible?.(true);
        }
        if (!proceed) {
          throw createAbortError(t("siyuanShare.message.cancelled"));
        }
        if (canUseIncremental) {
          uploadPayload = {...payload};
          delete uploadPayload.markdown;
          delete uploadPayload.hPath;
          delete uploadPayload.sortOrder;
          delete uploadPayload.icon;
          uploadPayload.docs = plan.uploadDocs;
          uploadPayload.incremental = {
            enabled: true,
            deletedDocIds: plan.deletedDocIds,
            deletedAssetPaths: plan.deletedAssetPaths,
            ...plan.summary,
          };
          uploadAssetEntries = plan.uploadAssetEntries;
          uploadAssetManifest = plan.uploadAssets;
        }
      } catch (err) {
        if (isAbortError(err) || controller?.signal?.aborted) throw err;
        console.warn("Incremental analysis failed, fallback to full update.", err);
        uploadPayload = payload;
        uploadAssetEntries = assetEntries;
        uploadAssetManifest = assetManifest;
      }
      progress.update(t("siyuanShare.progress.uploadingContent"));
      let requestError = null;
      let uploadId = "";
      let uploadComplete = false;
      try {
        const init = await this.remoteRequest(REMOTE_API.shareDocInit, {
          method: "POST",
          body: {metadata: uploadPayload, assets: uploadAssetManifest},
          progressText: t("siyuanShare.progress.uploadingContent"),
          controller,
          progress,
        });
        uploadId = init?.uploadId;
        if (!uploadId) {
          throw new Error(t("siyuanShare.error.missingUploadId"));
        }
        const totalBytes = uploadAssetEntries.reduce(
          (sum, entry) => sum + (Number(entry?.asset?.blob?.size) || 0),
          0,
        );
        await this.uploadAssetsChunked(uploadId, uploadAssetEntries, controller, progress, totalBytes);
        await this.remoteRequest(REMOTE_API.shareUploadComplete, {
          method: "POST",
          body: {uploadId},
          progressText: t("siyuanShare.progress.uploadingContent"),
          progress,
        });
        uploadComplete = true;
      } catch (err) {
        requestError = err;
        if (uploadId && !uploadComplete) {
          try {
            await this.remoteRequest(REMOTE_API.shareUploadCancel, {
              method: "POST",
              body: {uploadId},
              progress,
            });
          } catch (cancelErr) {
            console.warn("shareDoc cancel upload failed", cancelErr);
          }
        }
      }
      progress.update(t("siyuanShare.progress.syncingShareList"));
      let syncError = null;
      try {
        await this.syncRemoteShares({silent: true, controller, progress});
      } catch (err) {
        syncError = err;
      }
      if (requestError && isAbortError(requestError)) throw requestError;
      if (syncError && isAbortError(syncError)) throw syncError;
      if (requestError && !allowRequestError) throw requestError;
      const share = this.getShareByDocId(docId);
      if (!share) {
        if (requestError) throw requestError;
        if (syncError) throw syncError;
        throw new Error(t("siyuanShare.error.shareCreateFailed"));
      }
      this.shareOptions[String(share.id)] = !!includeChildren;
      await this.saveData(STORAGE_SHARE_OPTIONS, this.shareOptions);
      await this.updateSharePasswordCache(share.id, {password, clearPassword});
      if (requestError) {
        console.warn("shareDoc response error, but share exists after sync", requestError);
      }
      const url = this.getShareUrl(share);
      this.renderSettingCurrent();
      this.refreshDocTreeMarksLater();
      this.notify(t("siyuanShare.message.shareCreated", {value: url || title}));
      if (url) await this.tryCopyToClipboard(url);
    } finally {
      progress?.close();
    }
  }

  async shareNotebook(
    notebookId,
    {
      slugOverride = "",
      password = "",
      clearPassword = false,
      expiresAt = null,
      clearExpires = false,
      visitorLimit = null,
      clearVisitorLimit = false,
      allowRequestError = true,
    } = {},
  ) {
    const t = this.t.bind(this);
    if (!isValidNotebookId(notebookId)) throw new Error(t("siyuanShare.error.invalidNotebookId"));
    const controller = new AbortController();
    const progress = this.openProgressDialog(t("siyuanShare.progress.creatingNotebookShare"), controller);
    try {
      progress.update(t("siyuanShare.progress.verifyingSite"));
      await this.verifyRemote({controller, progress});
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      if (!this.notebooks.length) {
        progress.update(t("siyuanShare.progress.fetchingNotebookList"));
        await this.refreshNotebookOptions({silent: true});
      }
      const notebook = this.notebooks.find((n) => n.id === notebookId);
      const tree = await this.listDocsInNotebook(notebookId);
      const docs = Array.isArray(tree?.docs) ? tree.docs : Array.isArray(tree) ? tree : [];
      const title = notebook?.name || tree?.title || notebookId;
      progress.update(t("siyuanShare.progress.preparingNotebook"));
      if (!docs.length) throw new Error(t("siyuanShare.error.noDocsToShare"));
      await this.fillDocIcons(docs);
      applyDefaultDocIcons(docs);
      const docPayloads = [];
      const assetMap = new Map();
      const usedUploadPaths = new Set();
      const iconUploadMap = new Map();
      const exportedMarkdowns = [];
      let failureCount = 0;
      const docResults = await this.collectDocExportResults(docs, notebookId, {controller, progress});
      for (const result of docResults) {
        const doc = result.doc;
        const index = Number(result.index) || 0;
        const exportRes = result.exportRes || {};
        const markdown = String(result.markdown || "");
        const assets = Array.isArray(result.assets) ? result.assets : [];
        const failures = Array.isArray(result.failures) ? result.failures : [];
        if (markdown) exportedMarkdowns.push(markdown);
        failureCount += failures.length;
        const iconValue = await this.resolveIconUpload(doc?.icon, {
          docId: doc.docId,
          notebookId,
          usedUploadPaths,
          assetMap,
          iconUploadMap,
          controller,
        });
        docPayloads.push({
          docId: doc.docId,
          title: doc.title || t("siyuanShare.label.untitled"),
          hPath: exportRes.hPath || "",
          markdown,
          parentId: doc.parentId || "",
          sortIndex: Number.isFinite(doc.sortIndex) ? doc.sortIndex : index,
          sortOrder: Number.isFinite(doc.sortOrder) ? doc.sortOrder : index,
          ...(iconValue ? {icon: iconValue} : {}),
        });
        for (const asset of assets) {
          if (!asset?.path || assetMap.has(asset.path)) continue;
          assetMap.set(asset.path, {asset, docId: doc.docId});
          usedUploadPaths.add(asset.path);
        }
      }
      if (failureCount > 0) {
        console.warn("Some assets failed to download.", failureCount);
      }
      const refDocIds = docs.map((doc) => String(doc?.docId || ""));
      await this.maybeWarnExportReference(exportedMarkdowns, refDocIds);
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const payload = {
        notebookId,
        title,
        docs: docPayloads,
      };
      const slug = sanitizeSlug(slugOverride);
      if (slug) payload.slug = slug;
      if (clearPassword) {
        payload.clearPassword = true;
      } else if (password) {
        payload.password = password;
      }
      if (clearExpires) {
        payload.clearExpires = true;
      } else if (Number.isFinite(expiresAt) && expiresAt > 0) {
        payload.expiresAt = expiresAt;
      }
      if (clearVisitorLimit) {
        payload.clearVisitorLimit = true;
      } else if (Number.isFinite(visitorLimit)) {
        payload.visitorLimit = Math.max(0, Math.floor(visitorLimit));
      }
      const assetEntries = Array.from(assetMap.values());
      const assetManifest = assetEntries.map(({asset, docId}) => ({
        path: asset.path,
        size: Number(asset?.blob?.size) || 0,
        docId,
      }));
      let uploadPayload = payload;
      let uploadAssetEntries = assetEntries;
      let uploadAssetManifest = assetManifest;
      const existingShare = this.getShareByNotebookId(notebookId);
      const canUseIncremental = !!(existingShare?.id && this.supportsIncrementalShare());
      try {
        progress.update(t("siyuanShare.progress.analyzingIncrement"));
        const localState = await this.buildIncrementalLocalState(payload, assetEntries, {controller, progress});
        localState.assetEntries = assetEntries;
        throwIfAborted(controller, t("siyuanShare.message.cancelled"));
        const plan = canUseIncremental
          ? this.buildIncrementalPlan(
              localState,
              await this.fetchShareSnapshot(existingShare.id, {controller, progress}),
            )
          : this.buildFullUploadPlan(localState, {assumeExisting: !!existingShare?.id});
        const detail = this.formatIncrementSummaryDetail(plan.summary);
        let proceed = false;
        progress.setBarVisible?.(false);
        try {
          proceed = await progress.confirm({
            text: t("siyuanShare.progress.incrementReady"),
            detail,
            continueText: t("siyuanShare.action.continueUpload"),
          });
        } finally {
          progress.setBarVisible?.(true);
        }
        if (!proceed) {
          throw createAbortError(t("siyuanShare.message.cancelled"));
        }
        if (canUseIncremental) {
          uploadPayload = {...payload, docs: plan.uploadDocs};
          uploadPayload.incremental = {
            enabled: true,
            deletedDocIds: plan.deletedDocIds,
            deletedAssetPaths: plan.deletedAssetPaths,
            ...plan.summary,
          };
          uploadAssetEntries = plan.uploadAssetEntries;
          uploadAssetManifest = plan.uploadAssets;
        }
      } catch (err) {
        if (isAbortError(err) || controller?.signal?.aborted) throw err;
        console.warn("Incremental analysis failed, fallback to full update.", err);
        uploadPayload = payload;
        uploadAssetEntries = assetEntries;
        uploadAssetManifest = assetManifest;
      }
      progress.update(t("siyuanShare.progress.uploadingContent"));
      let requestError = null;
      let uploadId = "";
      let uploadComplete = false;
      try {
        const init = await this.remoteRequest(REMOTE_API.shareNotebookInit, {
          method: "POST",
          body: {metadata: uploadPayload, assets: uploadAssetManifest},
          progressText: t("siyuanShare.progress.uploadingContent"),
          controller,
          progress,
        });
        uploadId = init?.uploadId;
        if (!uploadId) {
          throw new Error(t("siyuanShare.error.missingUploadId"));
        }
        const totalBytes = uploadAssetEntries.reduce(
          (sum, entry) => sum + (Number(entry?.asset?.blob?.size) || 0),
          0,
        );
        await this.uploadAssetsChunked(uploadId, uploadAssetEntries, controller, progress, totalBytes);
        await this.remoteRequest(REMOTE_API.shareUploadComplete, {
          method: "POST",
          body: {uploadId},
          progressText: t("siyuanShare.progress.uploadingContent"),
          progress,
        });
        uploadComplete = true;
      } catch (err) {
        requestError = err;
        if (uploadId && !uploadComplete) {
          try {
            await this.remoteRequest(REMOTE_API.shareUploadCancel, {
              method: "POST",
              body: {uploadId},
              progress,
            });
          } catch (cancelErr) {
            console.warn("shareNotebook cancel upload failed", cancelErr);
          }
        }
      }
      progress.update(t("siyuanShare.progress.syncingShareList"));
      let syncError = null;
      try {
        await this.syncRemoteShares({silent: true, controller, progress});
      } catch (err) {
        syncError = err;
      }
      if (requestError && isAbortError(requestError)) throw requestError;
      if (syncError && isAbortError(syncError)) throw syncError;
      if (requestError && !allowRequestError) throw requestError;
      const share = this.getShareByNotebookId(notebookId);
      if (!share) {
        if (requestError) throw requestError;
        if (syncError) throw syncError;
        throw new Error(t("siyuanShare.error.shareCreateFailed"));
      }
      await this.updateSharePasswordCache(share.id, {password, clearPassword});
      if (requestError) {
        console.warn("shareNotebook response error, but share exists after sync", requestError);
      }
      const url = this.getShareUrl(share);
      this.refreshDocTreeMarksLater();
      this.notify(t("siyuanShare.message.shareCreated", {value: url || title}));
      if (url) await this.tryCopyToClipboard(url);
    } finally {
      progress?.close();
    }
  }

  async fetchDocsByPath(notebookId, pathValue = "") {
    if (!isValidNotebookId(notebookId)) return {ok: false, nodes: []};
    try {
      const resp = await fetchSyncPost("/api/filetree/listDocsByPath", {
        notebook: notebookId,
        path: pathValue,
        app: "share",
      });
      if (resp && resp.code === 0) {
        const nodes = extractDocTreeNodes(resp.data);
        if (nodes.length) {
          const hasValid = nodes.some((node) => isValidDocId(getDocTreeNodeId(node)));
          if (!hasValid) {
            return {ok: false, nodes: []};
          }
        }
        return {ok: true, nodes};
      }
    } catch (err) {
      console.warn("listDocsByPath failed", err);
    }
    return {ok: false, nodes: []};
  }

  async collectDocsByPath(notebookId, pathValue, parentId, out, seen) {
    const {ok, nodes} = await this.fetchDocsByPath(notebookId, pathValue);
    if (!ok) return false;
    if (!Array.isArray(nodes) || nodes.length === 0) return true;
    for (const [index, node] of nodes.entries()) {
      const docId = getDocTreeNodeId(node);
      if (!isValidDocId(docId)) continue;
      if (seen.has(docId)) continue;
      seen.add(docId);
      const rawTitle = node?.name || node?.title || node?.content || node?.label || "";
      const rawIcon = extractDocTreeNodeIcon(node);
      out.push({
        docId: String(docId || "").trim(),
        title: normalizeDocTitle(rawTitle),
        icon: normalizeDocIconValue(rawIcon),
        parentId: String(parentId || "").trim(),
        sortIndex: index,
        sortOrder: out.length,
      });
      const nodePath = getDocTreeNodePath(node) || buildDocPath(pathValue, docId);
      const okChild = await this.collectDocsByPath(notebookId, nodePath, docId, out, seen);
      if (!okChild) return false;
    }
    return true;
  }

  async listDocsInNotebookByPath(notebookId) {
    if (!isValidNotebookId(notebookId)) return null;
    const rootCandidates = ["/", ""];
    let rootNodes = null;
    let rootPath = "";
    let ok = false;
    for (const candidate of rootCandidates) {
      const resp = await this.fetchDocsByPath(notebookId, candidate);
      if (resp.ok) {
        ok = true;
        rootNodes = resp.nodes;
        rootPath = candidate;
        break;
      }
    }
    if (!ok) return null;
    const out = [];
    const seen = new Set();
    if (Array.isArray(rootNodes)) {
      for (const [index, node] of rootNodes.entries()) {
        const docId = getDocTreeNodeId(node);
        if (!isValidDocId(docId)) continue;
        seen.add(docId);
        const rawTitle = node?.name || node?.title || node?.content || node?.label || "";
        const rawIcon = extractDocTreeNodeIcon(node);
        out.push({
          docId: String(docId || "").trim(),
          title: normalizeDocTitle(rawTitle),
          icon: normalizeDocIconValue(rawIcon),
          parentId: "",
          sortIndex: index,
          sortOrder: out.length,
        });
        const nodePath = getDocTreeNodePath(node) || buildDocPath(rootPath, docId);
        const okChild = await this.collectDocsByPath(notebookId, nodePath, docId, out, seen);
        if (!okChild) return null;
      }
    }
    await this.fillDocIcons(out);
    return {title: "", docs: out};
  }

  async listDocSubtreeByPath(docId) {
    if (!isValidDocId(docId)) return null;
    const notebookId = await this.resolveNotebookIdFromDoc(docId);
    if (!isValidNotebookId(notebookId)) return null;
    const row = await this.fetchBlockRow(docId);
    const rootPath = row?.path ? String(row.path || "").trim() : "";
    if (!rootPath) return null;
    const out = [];
    const seen = new Set();
    const rootTitle = normalizeDocTitle(
      typeof row?.content === "string" ? row.content : "",
    );
    const rootIcon = await this.resolveDocIcon(docId);
    out.push({
      docId: String(docId || "").trim(),
      title: rootTitle,
      icon: normalizeDocIconValue(rootIcon),
      parentId: "",
      sortIndex: 0,
      sortOrder: 0,
    });
    seen.add(docId);
    const ok = await this.collectDocsByPath(notebookId, rootPath, docId, out, seen);
    if (!ok) return null;
    await this.fillDocIcons(out);
    return out;
  }

  async listDocsInNotebook(notebookId) {
    if (!isValidNotebookId(notebookId)) return {docs: [], title: ""};
    const byPath = await this.listDocsInNotebookByPath(notebookId);
    if (byPath) return byPath;
    return {docs: [], title: ""};
  }

  async resolveNotebookIdFromDoc(docId) {
    if (!isValidDocId(docId)) return "";
    const row = await this.fetchBlockRow(docId);
    const boxId = row?.box ? String(row.box).trim() : "";
    return isValidNotebookId(boxId) ? boxId : "";
  }

  collectDocSubtree(docs, rootDocId) {
    if (!Array.isArray(docs) || !isValidDocId(rootDocId)) return [];
    const nodes = new Map();
    const children = new Map();
    docs.forEach((doc) => {
      const docId = String(doc?.docId || "").trim();
      if (!isValidDocId(docId)) return;
      const parentIdRaw = String(doc?.parentId || "").trim();
      const parentId = isValidDocId(parentIdRaw) ? parentIdRaw : "";
      const normalized = {
        docId,
        title: String(doc?.title || ""),
        parentId,
        sortIndex: Number.isFinite(Number(doc?.sortIndex)) ? Number(doc.sortIndex) : 0,
        sortOrder: Number.isFinite(Number(doc?.sortOrder)) ? Number(doc.sortOrder) : 0,
      };
      nodes.set(docId, normalized);
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(docId);
    });
    if (!nodes.has(rootDocId)) return [];
    const included = new Set();
    const stack = [rootDocId];
    while (stack.length) {
      const current = stack.pop();
      if (!current || included.has(current) || !nodes.has(current)) continue;
      included.add(current);
      const kids = children.get(current) || [];
      kids.forEach((kid) => stack.push(kid));
    }
    const out = [];
    docs.forEach((doc) => {
      const docId = String(doc?.docId || "").trim();
      if (!included.has(docId)) return;
      const node = nodes.get(docId);
      if (node) out.push(node);
    });
    return out;
  }

  async listDocSubtree(docId) {
    const byPath = await this.listDocSubtreeByPath(docId);
    if (byPath && byPath.length) return byPath;
    return [];
  }

  async listDocSubtreeBySQL(docId, notebookId) {
    if (!isValidDocId(docId)) return [];
    try {
      const row = await this.fetchBlockRow(docId);
      const rootPath = row?.path ? String(row.path || "").trim() : "";
      const rootBox = row?.box ? String(row.box || "").trim() : "";
      const safeDocId = docId.replace(/'/g, "''");
      const safeBox = rootBox.replace(/'/g, "''");
      let bestDocs = [];
      const normalizeDocRow = (rowItem, index) => {
        const rowId = String(rowItem?.id || "").trim();
        if (!isValidDocId(rowId)) return null;
        const parentIdRaw = String(rowItem?.parent_id || rowItem?.parentId || "").trim();
        let parentId = isValidDocId(parentIdRaw) ? parentIdRaw : "";
        if (!parentId) {
          parentId = deriveParentIdFromPath(rowItem?.path, rowId);
        }
        if (parentId === rowId) parentId = "";
        const sortRaw = Number(rowItem?.sort);
        return {
          docId: rowId,
          title: typeof rowItem?.content === "string" ? rowItem.content : "",
          parentId,
          sortIndex: Number.isFinite(sortRaw) ? sortRaw : index,
          sortOrder: index,
        };
      };
      const considerDocs = (docs) => {
        if (docs.length > bestDocs.length) bestDocs = docs;
        return docs.length > 1;
      };
      try {
        const stmt = `WITH RECURSIVE doc_tree(id) AS (
          SELECT id FROM blocks WHERE id='${safeDocId}'
          UNION ALL
          SELECT b.id FROM blocks b JOIN doc_tree t ON b.parent_id = t.id WHERE b.type='d'
        )
        SELECT b.id, b.parent_id, b.content, b.sort, b.path FROM blocks b JOIN doc_tree t ON b.id = t.id ORDER BY b.sort`;
        const resp = await fetchSyncPost("/api/query/sql", {stmt});
        if (resp && resp.code === 0 && Array.isArray(resp.data)) {
          const docs = resp.data.map(normalizeDocRow).filter(Boolean);
          if (considerDocs(docs)) return docs;
        }
      } catch (err) {
        console.warn("Doc subtree recursive SQL failed", err);
      }
      if (rootPath) {
        const safePath = rootPath.replace(/'/g, "''");
        const pathPrefix = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
        const safePrefix = pathPrefix.replace(/'/g, "''");
        const altPrefix = rootPath.replace(/\.sy$/i, "");
        const altPrefixValue = altPrefix && altPrefix !== rootPath ? `${altPrefix}/` : "";
        const safeAltPrefix = altPrefixValue ? altPrefixValue.replace(/'/g, "''") : "";
        const pathFilter = safeAltPrefix
          ? `(path='${safePath}' OR path LIKE '${safePrefix}%' OR path LIKE '${safeAltPrefix}%')`
          : `(path='${safePath}' OR path LIKE '${safePrefix}%')`;
        const stmt = `SELECT id, parent_id, content, sort, path FROM blocks WHERE type='d' AND ${pathFilter} ORDER BY sort`;
        const resp = await fetchSyncPost("/api/query/sql", {stmt});
        if (resp && resp.code === 0 && Array.isArray(resp.data)) {
          const docs = resp.data.map(normalizeDocRow).filter(Boolean);
          if (considerDocs(docs)) return docs;
        }
      }
      if (rootBox) {
        const stmt = `SELECT id, parent_id, content, sort, path FROM blocks WHERE type='d' AND box='${safeBox}' ORDER BY sort`;
        const resp = await fetchSyncPost("/api/query/sql", {stmt});
        if (resp && resp.code === 0 && Array.isArray(resp.data)) {
          const docs = resp.data.map(normalizeDocRow).filter(Boolean);
          const subtree = this.collectDocSubtree(docs, docId);
          if (considerDocs(subtree)) return subtree;
        }
      }
      const iterDocs = await this.listDocSubtreeByParentChain(docId, row);
      if (considerDocs(iterDocs)) return iterDocs;
      return bestDocs.length ? bestDocs : [];
    } catch (err) {
      console.warn("Doc subtree SQL failed", err);
      return [];
    }
  }

  async listDocSubtreeByParentChain(docId, rootRow) {
    if (!isValidDocId(docId)) return [];
    const docs = [];
    const seen = new Set();
    const queue = [docId];
    const rootTitle =
      rootRow && typeof rootRow.content === "string" && rootRow.content ? rootRow.content : "";
    docs.push({
      docId,
      title: rootTitle,
      parentId: "",
      sortIndex: 0,
      sortOrder: 0,
    });
    seen.add(docId);
    let order = 1;
    while (queue.length) {
      const chunk = queue.splice(0, 20);
      const ids = chunk.filter((id) => isValidDocId(id)).map((id) => `'${id.replace(/'/g, "''")}'`);
      if (!ids.length) continue;
      const stmt = `SELECT id, parent_id, content, sort FROM blocks WHERE type='d' AND parent_id IN (${ids.join(
        ",",
      )}) ORDER BY sort`;
      const resp = await fetchSyncPost("/api/query/sql", {stmt});
      if (!resp || resp.code !== 0 || !Array.isArray(resp.data)) continue;
      resp.data.forEach((rowItem) => {
        const rowId = String(rowItem?.id || "").trim();
        if (!isValidDocId(rowId) || seen.has(rowId)) return;
        seen.add(rowId);
        const parentIdRaw = String(rowItem?.parent_id || "").trim();
        const parentId = isValidDocId(parentIdRaw) ? parentIdRaw : "";
        const sortRaw = Number(rowItem?.sort);
        docs.push({
          docId: rowId,
          title: typeof rowItem?.content === "string" ? rowItem.content : "",
          parentId,
          sortIndex: Number.isFinite(sortRaw) ? sortRaw : order,
          sortOrder: order,
        });
        order += 1;
        queue.push(rowId);
      });
    }
    return docs.length > 1 ? docs : [];
  }

  async updateShare(
    shareId,
    {
      password = "",
      clearPassword = false,
      expiresAt = null,
      clearExpires = false,
      visitorLimit = null,
      clearVisitorLimit = false,
      includeChildren = null,
    } = {},
  ) {
    const t = this.t.bind(this);
    if (!shareId) throw new Error(t("siyuanShare.error.missingShareId"));
    const existing = this.getShareById(shareId);
    if (!existing) throw new Error(t("siyuanShare.error.shareNotFound"));
    if (existing.type === SHARE_TYPES.NOTEBOOK) {
      await this.shareNotebook(existing.notebookId, {
        slugOverride: existing.slug,
        password,
        clearPassword,
        expiresAt,
        clearExpires,
        visitorLimit,
        clearVisitorLimit,
        allowRequestError: false,
      });
      return;
    }
    const includeChildrenValue =
      typeof includeChildren === "boolean" ? includeChildren : !!existing.includeChildren;
    await this.shareDoc(existing.docId, {
      slugOverride: existing.slug,
      password,
      clearPassword,
      expiresAt,
      clearExpires,
      visitorLimit,
      clearVisitorLimit,
      includeChildren: includeChildrenValue,
      allowRequestError: false,
    });
  }

  async updateShareAccess(
    shareId,
    {
      password = "",
      clearPassword = false,
      expiresAt = null,
      clearExpires = false,
      visitorLimit = null,
      clearVisitorLimit = false,
    } = {},
  ) {
    const t = this.t.bind(this);
    if (!shareId) throw new Error(t("siyuanShare.error.missingShareId"));
    const existing = this.getShareById(shareId);
    if (!existing) throw new Error(t("siyuanShare.error.shareNotFound"));
    const controller = new AbortController();
    const progress = this.openProgressDialog(t("siyuanShare.progress.requesting"), controller);
    try {
      progress.update(t("siyuanShare.progress.verifyingSite"));
      await this.verifyRemote({controller, progress});
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const payload = {shareId: existing.id};
      if (clearPassword) {
        payload.clearPassword = true;
      } else if (password) {
        payload.password = password;
      }
      if (clearExpires) {
        payload.clearExpires = true;
      } else if (Number.isFinite(expiresAt) && expiresAt > 0) {
        payload.expiresAt = expiresAt;
      }
      if (clearVisitorLimit) {
        payload.clearVisitorLimit = true;
      } else if (Number.isFinite(visitorLimit)) {
        payload.visitorLimit = Math.max(0, Math.floor(visitorLimit));
      }
      progress.update(t("siyuanShare.progress.requesting"));
      await this.remoteRequest(REMOTE_API.shareAccessUpdate, {
        method: "POST",
        body: payload,
        progressText: t("siyuanShare.progress.requesting"),
        controller,
        progress,
      });
      progress.update(t("siyuanShare.progress.syncingShareList"));
      await this.syncRemoteShares({silent: true, controller, progress});
      await this.updateSharePasswordCache(existing.id, {password, clearPassword});
      this.renderSettingCurrent();
      this.notify(t("siyuanShare.message.accessUpdated"));
    } finally {
      progress?.close();
    }
  }

  async deleteShare(shareId) {
    const t = this.t.bind(this);
    if (!shareId) throw new Error(t("siyuanShare.error.missingShareId"));
    const existing = this.getShareById(shareId);
    if (!existing) throw new Error(t("siyuanShare.error.shareNotFound"));

    await new Promise((resolve) => {
      confirm(
        t("siyuanShare.confirm.deleteShareTitle"),
        t("siyuanShare.confirm.deleteShareMessage", {
          name: existing.title || existing.slug || existing.id,
        }),
        () => resolve(true),
        () => resolve(false),
      );
    }).then(async (ok) => {
      if (!ok) return;
      await this.verifyRemote();
      await this.remoteRequest(REMOTE_API.deleteShare, {
        method: "POST",
        body: {shareId: existing.id, hardDelete: true},
        progressText: t("siyuanShare.progress.deletingShare"),
      });
      await this.syncRemoteShares({silent: true});
      const key = String(existing.id || "");
      if (key && Object.prototype.hasOwnProperty.call(this.shareOptions, key)) {
        delete this.shareOptions[key];
        await this.saveData(STORAGE_SHARE_OPTIONS, this.shareOptions);
      }
      this.renderSettingCurrent();
      this.notify(t("siyuanShare.message.deleteSuccess"));
    });
  }

  async copyShareLink(shareId) {
    const t = this.t.bind(this);
    const existing = this.getShareById(shareId);
    if (!existing) throw new Error(t("siyuanShare.error.shareNotFound"));
    await this.verifyRemote();
    const url = this.getShareUrl(existing);
    if (!url) throw new Error(t("siyuanShare.error.shareLinkEmpty"));
    await this.tryCopyToClipboard(url);
    this.notify(t("siyuanShare.message.copyLinkSuccess"));
  }

  buildShareInfoText(share, titleOverride = "") {
    const t = this.t.bind(this);
    const titleRaw = String(titleOverride || share?.title || "").trim();
    const title = titleRaw || t("siyuanShare.label.untitled");
    const lines = [t("siyuanShare.copyInfo.title", {title})];
    const url = this.getShareUrl(share);
    if (url) lines.push(t("siyuanShare.copyInfo.link", {value: url}));
    const password = String(share?.password || "").trim();
    if (password) lines.push(t("siyuanShare.copyInfo.password", {value: password}));
    const expiresAt = normalizeTimestampMs(share?.expiresAt || 0);
    if (expiresAt) lines.push(t("siyuanShare.copyInfo.expiresAt", {value: this.formatTime(expiresAt)}));
    const visitorLimitValue = Number.isFinite(Number(share?.visitorLimit))
      ? Math.max(0, Math.floor(Number(share.visitorLimit)))
      : 0;
    if (visitorLimitValue > 0) {
      lines.push(t("siyuanShare.copyInfo.visitorLimit", {count: visitorLimitValue}));
    }
    return lines.join("\n");
  }

  async copyShareInfo(shareId, {title = ""} = {}) {
    const t = this.t.bind(this);
    const existing = this.getShareById(shareId);
    if (!existing) throw new Error(t("siyuanShare.error.shareNotFound"));
    const text = this.buildShareInfoText(existing, title);
    await this.tryCopyToClipboard(text);
    this.notify(t("siyuanShare.message.copyShareInfoSuccess"));
  }

  collectSharePasswords(shares) {
    const map = {};
    if (!Array.isArray(shares)) return map;
    shares.forEach((share) => {
      const id = share?.id;
      if (!id) return;
      const password = String(share?.password || "").trim();
      if (password) map[String(id)] = password;
    });
    return map;
  }

  applySharePasswords(shares, passwordMap) {
    if (!Array.isArray(shares)) return [];
    if (!passwordMap || Object.keys(passwordMap).length === 0) return shares;
    return shares.map((share) => {
      const password = passwordMap[String(share?.id)] || "";
      if (!password) return share;
      return {...share, password};
    });
  }

  applyShareOptions(shares) {
    if (!Array.isArray(shares)) return shares;
    const optionMap = this.shareOptions || {};
    const nextShares = shares.map((share) => {
      const id = share?.id;
      if (!id) return share;
      const key = String(id);
      if (typeof share.includeChildren === "boolean") {
        if (optionMap[key] !== share.includeChildren) {
          optionMap[key] = share.includeChildren;
        }
        return share;
      }
      if (Object.prototype.hasOwnProperty.call(optionMap, key)) {
        return {...share, includeChildren: !!optionMap[key]};
      }
      return share;
    });
    const existingIds = new Set(
      shares.map((share) => String(share?.id || "")).filter((id) => id !== ""),
    );
    let cleaned = false;
    Object.keys(optionMap).forEach((key) => {
      if (!existingIds.has(String(key))) {
        delete optionMap[key];
        cleaned = true;
      }
    });
    if (cleaned) {
      this.shareOptions = optionMap;
    }
    return nextShares;
  }

  async updateSharePasswordCache(shareId, {password = "", clearPassword = false} = {}) {
    const targetId = String(shareId || "");
    if (!targetId) return;
    const nextPassword = clearPassword ? "" : String(password || "").trim();
    if (!nextPassword && !clearPassword) return;
    const updateList = (list) => {
      if (!Array.isArray(list)) return list;
      let changed = false;
      const nextList = list.map((share) => {
        if (String(share?.id) !== targetId) return share;
        if (clearPassword) {
          if (!share || !("password" in share)) return share;
          const next = {...share};
          delete next.password;
          changed = true;
          return next;
        }
        if (nextPassword && share?.password !== nextPassword) {
          changed = true;
          return {...share, password: nextPassword};
        }
        return share;
      });
      return changed ? nextList : list;
    };
    this.shares = updateList(this.shares);
    const activeSiteId = String(this.settings.activeSiteId || "");
    if (!activeSiteId) return;
    if (Array.isArray(this.siteShares?.[activeSiteId])) {
      const updated = updateList(this.siteShares[activeSiteId]);
      if (updated !== this.siteShares[activeSiteId]) {
        this.siteShares[activeSiteId] = updated;
        await this.saveData(STORAGE_SITE_SHARES, this.siteShares);
      }
    }
  }

  async tryCopyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  }

  formatTime(ts) {
    if (!ts) return "";
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return String(ts);
    }
  }

  getRemoteHeaders() {
    const key = String(this.settings.apiKey || "").trim();
    if (!key) return {};
    return {"X-Api-Key": key};
  }

  async remoteRequest(
    path,
    {
      method = "POST",
      body,
      isForm = false,
      progressText = "",
      controller = null,
      progress = null,
      silent = false,
    } = {},
  ) {
    const t = this.t.bind(this);
    const base = normalizeUrlBase(this.settings.siteUrl);
    if (!base) throw new Error(t("siyuanShare.error.siteUrlRequired"));
    const headers = {...this.getRemoteHeaders()};
    if (!headers["X-Api-Key"]) throw new Error(t("siyuanShare.error.apiKeyRequired"));
    if (!isForm && method !== "GET") {
      headers["Content-Type"] = "application/json";
    }
    const options = {
      method,
      headers,
    };
    if (body != null && method !== "GET") {
      options.body = isForm ? body : JSON.stringify(body);
    }
    const requestController = controller || new AbortController();
    options.signal = requestController.signal;
    const ownsProgress = !progress && !silent;
    const handle = progress || (ownsProgress
      ? this.openProgressDialog(progressText || t("siyuanShare.progress.requesting"), requestController)
      : null);
    if (!silent && progressText && handle?.update) {
      handle.update(progressText);
    }
    try {
      const resp = await fetch(`${base}${path}`, options);
      const json = await resp.json().catch(() => null);
      if (!resp.ok || !json || json.code !== 0) {
        const message = json?.msg || t("siyuanShare.error.remoteRequestFailed", {status: resp.status});
        const error = new Error(message);
        error.status = resp.status;
        error.code = typeof json?.code !== "undefined" ? json.code : resp.status;
        error.data = json?.data;
        error.response = json;
        throw error;
      }
      return json.data;
    } catch (err) {
      if (err?.name === "AbortError") {
        throw createAbortError(t("siyuanShare.message.cancelled"));
      }
      throw err;
    } finally {
      if (ownsProgress) {
        handle?.close();
      }
    }
  }

  async verifyRemote({silent = false, controller = null, progress = null, background = false} = {}) {
    const t = this.t.bind(this);
    if (!this.settings.siteUrl || !this.settings.apiKey) {
      if (!silent) throw new Error(t("siyuanShare.error.siteAndKeyRequired"));
      return null;
    }
    if (this.remoteUser && this.remoteVerifiedAt && nowTs() - this.remoteVerifiedAt < 60000) {
      return {user: this.remoteUser, limits: this.remoteUploadLimits, features: this.remoteFeatures};
    }
    const data = await this.remoteRequest(REMOTE_API.verify, {
      method: "POST",
      body: {},
      progressText: background ? "" : t("siyuanShare.progress.verifyingSite"),
      controller,
      progress,
      silent: background,
    });
    this.remoteUser = this.normalizeRemoteUser(data?.user);
    this.remoteUploadLimits = this.normalizeUploadLimits(data?.limits);
    this.remoteFeatures = this.normalizeRemoteFeatures(data?.features);
    this.remoteVerifiedAt = nowTs();
    await this.persistActiveRemoteStatus();
    this.syncSettingInputs();
    return data;
  }

  async syncRemoteShares({silent = false, controller = null, progress = null, background = false} = {}) {
    const t = this.t.bind(this);
    const data = await this.remoteRequest(REMOTE_API.shares, {
      method: "GET",
      progressText: background ? "" : t("siyuanShare.progress.syncingShareList"),
      controller,
      progress,
      silent: background,
    });
    const activeSiteId = String(this.settings.activeSiteId || "");
    const rawShares = Array.isArray(data?.shares) ? data.shares : [];
    const passwordMap = activeSiteId ? this.collectSharePasswords(this.siteShares?.[activeSiteId]) : {};
    const withPasswords = this.applySharePasswords(rawShares, passwordMap);
    const shares = this.applyShareOptions(withPasswords);
    this.shares = shares;
    if (activeSiteId) {
      this.siteShares[activeSiteId] = shares;
      await this.saveData(STORAGE_SITE_SHARES, this.siteShares);
    }
    if (this.shareOptions) {
      await this.saveData(STORAGE_SHARE_OPTIONS, this.shareOptions);
    }
    this.renderDock();
    this.renderSettingCurrent();
    this.renderSettingShares();
    this.refreshDocTreeMarks();
    this.updateTopBarState();
    if (!silent) this.notify(t("siyuanShare.message.verifySuccess"));
    return shares;
  }

  async trySyncRemoteShares({silent = false} = {}) {
    if (!this.settings.siteUrl || !this.settings.apiKey) return;
    try {
      await this.verifyRemote({silent: true});
      await this.syncRemoteShares({silent});
    } catch (err) {
      if (!silent) this.showErr(err);
    }
  }

  async disconnectRemote() {
    const t = this.t.bind(this);
    const activeSiteId = String(this.settings.activeSiteId || "");
    this.remoteUser = null;
    this.remoteVerifiedAt = 0;
    this.remoteUploadLimits = null;
    this.remoteFeatures = null;
    await this.persistActiveRemoteStatus({clear: true});
    this.shares = [];
    if (activeSiteId) {
      this.siteShares[activeSiteId] = [];
      await this.saveData(STORAGE_SITE_SHARES, this.siteShares);
    }
    this.syncSettingInputs();
    this.renderDock();
    this.renderSettingCurrent();
    this.renderSettingShares();
    this.updateTopBarState();
    this.notify(t("siyuanShare.message.disconnected"));
  }

  async fetchNotebooks() {
    const resp = await fetchSyncPost("/api/notebook/lsNotebooks", {});
    if (!resp || resp.code !== 0) throw new Error(resp?.msg || this.t("siyuanShare.error.notebookListFailed"));
    return resp?.data?.notebooks || [];
  }

  async refreshNotebookOptions({silent = false} = {}) {
    const t = this.t.bind(this);
    try {
      this.notebooks = await this.fetchNotebooks();
      if (!silent) this.notify(t("siyuanShare.message.notebookListRefreshed"));
    } catch (err) {
      if (!silent) this.showErr(err);
    }
  }

  async exportDocMarkdown(docId) {
    const resp = await fetchSyncPost("/api/export/exportMdContent", {id: docId});
    if (!resp || resp.code !== 0) throw new Error(resp?.msg || this.t("siyuanShare.error.exportMarkdownFailed"));
    return {
      hPath: resp?.data?.hPath || "",
      content: resp?.data?.content || "",
    };
  }

  async ensureWorkspaceDir() {
    if (this.workspaceDir) return this.workspaceDir;
    try {
      const wsInfo = await fetchSyncPost("/api/system/getWorkspaceInfo", {});
      if (wsInfo && wsInfo.code === 0 && wsInfo.data?.workspaceDir) {
        this.workspaceDir = String(wsInfo.data.workspaceDir);
        return this.workspaceDir;
      }
    } catch (err) {
      // ignore
    }
    return this.workspaceDir;
  }

  async fetchEmojiAssetBlob(assetPath, controller, notebookId = "") {
    const t = this.t.bind(this);
    const normalized = normalizeAssetPath(assetPath);
    if (!normalized) throw new Error(t("siyuanShare.error.resourcePathInvalid"));
    const candidates = [];
    if (DOC_ICON_IMAGE_EXT_RE.test(normalized)) {
      candidates.push(normalized);
    } else {
      candidates.push(normalized);
      EMOJI_IMAGE_EXTENSIONS.forEach((ext) => candidates.push(`${normalized}.${ext}`));
    }
    let lastErr = null;
    for (const candidate of candidates) {
      try {
        return await this.fetchAssetBlob(candidate, controller, notebookId);
      } catch (err) {
        if (isAbortError(err)) throw err;
        lastErr = err;
      }
    }
    if (this.hasNodeFs) {
      const wsDir = await this.ensureWorkspaceDir();
      if (wsDir) {
        for (const candidate of candidates) {
          const clean = candidate.replace(/^[\\/]+/, "");
          const rel = clean.startsWith("emojis/") ? clean.slice("emojis/".length) : clean;
          const fsCandidates = new Set([
            joinFsPath(wsDir, "data", clean),
            joinFsPath(wsDir, "data", "emojis", rel),
            joinFsPath(wsDir, clean),
            joinFsPath(wsDir, "emojis", rel),
          ]);
          for (const fsPath of fsCandidates) {
            try {
              const stat = await fs.promises.stat(fsPath);
              if (!stat || !stat.isFile()) continue;
              const buf = await fs.promises.readFile(fsPath);
              const blob = new Blob([buf]);
              return {path: clean, blob};
            } catch (err) {
              if (isAbortError(err)) throw err;
              lastErr = err;
            }
          }
        }
      }
    }
    throw lastErr || new Error(t("siyuanShare.error.resourceDownloadFailed", {status: 404}));
  }

  async fetchAssetBlob(assetPath, controller, notebookId = "") {
    const t = this.t.bind(this);
    const normalized = normalizeAssetPath(assetPath);
    if (!normalized) throw new Error(t("siyuanShare.error.resourcePathInvalid"));
    const candidates = new Set();
    const appendCandidates = (value) => {
      const cleaned = normalizeAssetPath(value);
      if (!cleaned) return;
      if (cleaned.startsWith("data/")) {
        candidates.add(cleaned);
        return;
      }
      if (cleaned.startsWith("emojis/")) {
        candidates.add(`data/${cleaned}`);
        candidates.add(cleaned);
        return;
      }
      if (cleaned.startsWith("assets/")) {
        candidates.add(`data/${cleaned}`);
        if (isValidNotebookId(notebookId)) {
          candidates.add(`data/${notebookId}/${cleaned}`);
        }
        return;
      }
      candidates.add(`data/${cleaned}`);
    };
    appendCandidates(normalized);
    const decoded = tryDecodeAssetPath(normalized);
    if (decoded) {
      const decodedNormalized = normalizeAssetPath(decoded);
      if (decodedNormalized && decodedNormalized !== normalized) {
        appendCandidates(decodedNormalized);
      }
    }
    let lastErr = null;
    for (const workspacePath of candidates) {
      let resp;
      try {
        resp = await fetch("/api/file/getFile", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...getAuthHeaders(),
          },
          body: JSON.stringify({path: `/${workspacePath}`}),
          signal: controller?.signal,
        });
      } catch (err) {
        if (err?.name === "AbortError") {
          throw new Error(t("siyuanShare.error.resourceDownloadCanceled"));
        }
        lastErr = err;
        continue;
      }
      if (!resp.ok) {
        const err = await resp.json().catch(() => null);
        lastErr = new Error(err?.msg || t("siyuanShare.error.resourceDownloadFailed", {status: resp.status}));
        continue;
      }
      const contentType = resp.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const data = await resp.clone().json().catch(() => null);
        if (data && typeof data.code !== "undefined" && data.code !== 0) {
          lastErr = new Error(data?.msg || t("siyuanShare.error.resourceDownloadFailed", {status: resp.status}));
          continue;
        }
      }
      const blob = await resp.blob();
      return {path: normalized, blob};
    }
    throw lastErr || new Error(t("siyuanShare.error.resourceDownloadFailed", {status: 500}));
  }

  async fetchIconUrlBlob(url, controller) {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        ...getAuthHeaders(),
      },
      credentials: "same-origin",
      signal: controller?.signal,
    });
    if (!resp.ok) {
      throw new Error(`Icon download failed (${resp.status})`);
    }
    const contentType = resp.headers.get("content-type") || "";
    const blob = await resp.blob();
    return {blob, contentType};
  }

  async prepareMarkdownAssets(markdown, controller, notebookId = "", options = {}) {
    const t = this.t.bind(this);
    const cancelledMsg = t("siyuanShare.error.resourceDownloadCanceled");
    const onProgress = typeof options?.onProgress === "function" ? options.onProgress : null;
    const maxConcurrency = normalizePositiveInt(
      options?.concurrency,
      DEFAULT_MARKDOWN_ASSET_PREPARE_CONCURRENCY,
    );
    const reportProgress = (current, total, stage = "asset") => {
      if (!onProgress) return;
      try {
        onProgress({
          current: Math.max(0, Math.floor(Number(current) || 0)),
          total: Math.max(0, Math.floor(Number(total) || 0)),
          stage: String(stage || "asset"),
        });
      } catch {
        // ignore
      }
    };
    let fixed = rewriteAssetLinks(markdown || "");
    const assets = [];
    const failures = [];
    const renameMap = new Map();
    const usedUploadPaths = new Set();
    const seenPaths = new Set();
    const preloadedAssets = new Map();

    const emojiTokenNames = Array.from(collectEmojiTokenNames(fixed));
    if (emojiTokenNames.length > 0) {
      const tokenMap = new Map();
      const resolvedPathMap = new Map();
      const emojiResults = new Array(emojiTokenNames.length).fill(null);
      let emojiDone = 0;
      reportProgress(0, emojiTokenNames.length, "emoji");
      const emojiTasks = emojiTokenNames.map((name, index) => async () => {
        try {
          throwIfAborted(controller, t("siyuanShare.message.cancelled"));
          const basePath = normalizeEmojiAssetPath(name, true);
          if (!basePath) return;
          const asset = await this.fetchEmojiAssetBlob(basePath, controller, notebookId);
          const resolvedPath = normalizeAssetPath(asset?.path || "") || normalizeAssetPath(basePath);
          if (!resolvedPath || !asset?.blob) return;
          emojiResults[index] = {name, resolvedPath, blob: asset.blob};
        } catch (err) {
          if (isAbortError(err) || err?.message === cancelledMsg) {
            throw err;
          }
          emojiResults[index] = null;
        } finally {
          emojiDone += 1;
          reportProgress(emojiDone, emojiTokenNames.length, "emoji");
        }
      });
      await runTasksWithConcurrency(
        emojiTasks,
        this.getPrepareAssetsConcurrency(emojiTokenNames.length, maxConcurrency),
      );
      for (const item of emojiResults) {
        if (!item) continue;
        let uploadPath = resolvedPathMap.get(item.resolvedPath);
        if (!uploadPath) {
          uploadPath = sanitizeAssetUploadPath(item.resolvedPath, usedUploadPaths) || normalizeAssetPath(item.resolvedPath);
          if (!uploadPath) continue;
          resolvedPathMap.set(item.resolvedPath, uploadPath);
        }
        if (!seenPaths.has(uploadPath)) {
          assets.push({path: uploadPath, blob: item.blob});
          seenPaths.add(uploadPath);
          preloadedAssets.set(uploadPath, item.blob);
        }
        tokenMap.set(item.name, `![](<${uploadPath}>)`);
      }
      if (tokenMap.size > 0) {
        fixed = replaceCustomEmojiTokens(fixed, tokenMap);
      }
    }

    fixed = insertAdjacentEmojiImageSpacing(fixed);
    const assetPaths = extractAssetPaths(fixed);
    const assetPlans = [];
    for (const path of assetPaths) {
      if (seenPaths.has(path)) continue;
      seenPaths.add(path);
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const uploadPath = usedUploadPaths.has(path)
        ? path
        : sanitizeAssetUploadPath(path, usedUploadPaths) || normalizeAssetPath(path);
      if (uploadPath && uploadPath !== path) {
        renameMap.set(path, uploadPath);
      }
      assetPlans.push({
        path,
        uploadPath: uploadPath || normalizeAssetPath(path) || path,
      });
    }

    const assetResults = new Array(assetPlans.length).fill(null);
    let assetDone = 0;
    reportProgress(0, assetPlans.length, "asset");
    const assetTasks = assetPlans.map((plan, index) => async () => {
      try {
        throwIfAborted(controller, t("siyuanShare.message.cancelled"));
        const blob = preloadedAssets.has(plan.path)
          ? preloadedAssets.get(plan.path)
          : (await this.fetchAssetBlob(plan.path, controller, notebookId)).blob;
        assetResults[index] = {blob, uploadPath: plan.uploadPath, path: plan.path};
      } catch (err) {
        if (isAbortError(err) || err?.message === cancelledMsg) {
          throw err;
        }
        assetResults[index] = {error: err, path: plan.path};
      } finally {
        assetDone += 1;
        reportProgress(assetDone, assetPlans.length, "asset");
      }
    });
    await runTasksWithConcurrency(
      assetTasks,
      this.getPrepareAssetsConcurrency(assetPlans.length, maxConcurrency),
    );
    for (let i = 0; i < assetResults.length; i += 1) {
      const item = assetResults[i];
      const plan = assetPlans[i];
      if (!item || !plan) continue;
      if (item.error) {
        failures.push({path: plan.path, err: item.error});
        continue;
      }
      if (!item.blob) continue;
      assets.push({path: item.uploadPath, blob: item.blob});
    }

    if (renameMap.size > 0) {
      for (const [from, to] of renameMap) {
        fixed = replaceAllText(fixed, from, to);
      }
    }
    if (failures.length > 0) {
      console.warn("Some assets failed to download.", failures);
    }
    return {markdown: fixed, assets, failures};
  }

  renderDock() {
    if (!this.dockElement) return;
    const t = this.t.bind(this);
    const siteUrl = this.settings.siteUrl || "";
    const apiKey = this.settings.apiKey || "";
    const sites = Array.isArray(this.settings.sites) ? this.settings.sites : [];
    const activeSiteId = String(this.settings.activeSiteId || "");
    const siteOptions = sites
      .map((site, index) => {
        const id = String(site?.id || "");
        const label = this.getSiteOptionLabel(site, index);
        const selected = id && id === activeSiteId ? " selected" : "";
        return `<option value="${escapeAttr(id)}"${selected}>${escapeHtml(label)}</option>`;
      })
      .join("");
    const displayName = this.remoteUser?.username || this.remoteUser?.name || "";
    const statusLabel = !siteUrl || !apiKey
      ? t("siyuanShare.hint.needSiteAndKey")
      : displayName
        ? t("siyuanShare.hint.statusConnectedUser", {
            user: escapeHtml(displayName),
          })
        : t("siyuanShare.hint.statusConnectedNoUser");
    const rows = this.shares
      .map((s) => {
        const url = this.getShareUrl(s);
        const typeLabel =
          s.type === SHARE_TYPES.NOTEBOOK ? t("siyuanShare.label.notebook") : t("siyuanShare.label.document");
        const idLabel = s.type === SHARE_TYPES.NOTEBOOK ? s.notebookId : s.docId;
        const visitorLimitValue = Number(s.visitorLimit) || 0;
        const visitorLabel =
          visitorLimitValue > 0
            ? t("siyuanShare.label.visitorLimitCount", {count: visitorLimitValue})
            : t("siyuanShare.label.visitorLimitNotSet");
        return `<tr>
  <td>
    <div>${escapeHtml(s.title || "")}</div>
    <div class="siyuan-plugin-share__muted siyuan-plugin-share__mono">${escapeHtml(idLabel || "")}</div>
  </td>
  <td class="siyuan-plugin-share__mono">${escapeHtml(typeLabel)}</td>
  <td>
    <div class="siyuan-plugin-share__mono">${escapeHtml(url)}</div>
    <div class="siyuan-plugin-share__muted">${escapeHtml(visitorLabel)}</div>
    <div class="siyuan-plugin-share__muted">${escapeHtml(this.formatTime(s.updatedAt))}</div>
  </td>
  <td>
    <div class="siyuan-plugin-share__actions">
      <button class="b3-button b3-button--outline" data-action="copy-link" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.copyLink"))}</button>
      <button class="b3-button b3-button--outline" data-action="update" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.update"))}</button>
      <button class="b3-button b3-button--outline" data-action="update-access" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.updateAccess"))}</button>
      <button class="b3-button b3-button--outline" data-action="delete" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.delete"))}</button>
    </div>
  </td>
</tr>`;
      })
      .join("");

    this.dockElement.innerHTML = `
<div class="siyuan-plugin-share__section">
  <div class="siyuan-plugin-share__title">${escapeHtml(t("siyuanShare.section.connectionSettings"))}</div>
  <div class="siyuan-plugin-share__grid">
    <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.label.site"))}</div>
    <select id="sps-site-select" class="b3-select sps-site-select">
      ${siteOptions || `<option value="">${escapeHtml(t("siyuanShare.label.siteEmpty"))}</option>`}
    </select>
    <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.label.siteUrl"))}</div>
    <input id="sps-site" class="b3-text-field" placeholder="${escapeAttr(
      t("siyuanShare.placeholder.siteUrl"),
    )}" value="${escapeAttr(siteUrl)}" />
    <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.label.apiKey"))}</div>
    <input id="sps-apikey" type="password" class="b3-text-field" placeholder="${escapeAttr(
      t("siyuanShare.label.apiKey"),
    )}" value="${escapeAttr(apiKey)}" />
  </div>
  <div class="siyuan-plugin-share__actions">
    <button class="b3-button b3-button--outline" data-action="sync-remote">${escapeHtml(
      t("siyuanShare.action.verifySync"),
    )}</button>
    <button class="b3-button b3-button--outline" data-action="disconnect">${escapeHtml(
      t("siyuanShare.action.disconnect"),
    )}</button>
  </div>
  <div class="siyuan-plugin-share__muted">${statusLabel}</div>
  <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.hint.checkApiKey"))}</div>
</div>

<div class="siyuan-plugin-share__section">
  <div class="siyuan-plugin-share__title">${escapeHtml(
    t("siyuanShare.title.shareListCount", {count: this.shares.length}),
  )}</div>
  <table class="siyuan-plugin-share__table">
    <thead>
      <tr>
        <th style="width: 34%;">${escapeHtml(t("siyuanShare.label.title"))}</th>
        <th style="width: 14%;">${escapeHtml(t("siyuanShare.label.type"))}</th>
        <th style="width: 36%;">${escapeHtml(t("siyuanShare.label.link"))}</th>
        <th style="width: 16%;">${escapeHtml(t("siyuanShare.label.actions"))}</th>
      </tr>
    </thead>
    <tbody>
      ${rows || `<tr><td colspan="4" class="siyuan-plugin-share__muted">${escapeHtml(
          t("siyuanShare.message.noShareRecords"),
        )}</td></tr>`}
    </tbody>
  </table>
</div>
`;
    try {
      this.dockElement.removeEventListener("click", this.onDockClick);
      this.dockElement.removeEventListener("change", this.onDockChange);
      this.dockElement.addEventListener("click", this.onDockClick);
      this.dockElement.addEventListener("change", this.onDockChange);
    } catch {
      // ignore
    }
  }

  getBackgroundSyncDelayMs() {
    const hidden = document?.hidden;
    const min = hidden ? this.backgroundSyncHiddenMinDelayMs : this.backgroundSyncMinDelayMs;
    const max = hidden ? this.backgroundSyncHiddenMaxDelayMs : this.backgroundSyncMaxDelayMs;
    const base = Math.min(Math.max(this.backgroundSyncDelayMs || min, min), max);
    const jitter = Math.floor(Math.random() * 60 * 1000);
    return base + jitter;
  }

  updateBackgroundSyncDelay({success = false, changed = false} = {}) {
    if (!success || changed) {
      this.backgroundSyncDelayMs = this.backgroundSyncMinDelayMs;
      return;
    }
    const next = Math.ceil((this.backgroundSyncDelayMs || this.backgroundSyncMinDelayMs) * 1.6);
    this.backgroundSyncDelayMs = Math.min(next, this.backgroundSyncMaxDelayMs);
  }

  startBackgroundSync({immediate = false} = {}) {
    if (this.backgroundSyncTimer) return;
    const loop = async () => {
      if (this.backgroundSyncTimer) {
        clearTimeout(this.backgroundSyncTimer);
        this.backgroundSyncTimer = null;
      }
      const scheduleNext = () => {
        const delay = this.getBackgroundSyncDelayMs();
        this.backgroundSyncTimer = setTimeout(loop, delay);
      };
      if (!this.settings.siteUrl || !this.settings.apiKey) {
        scheduleNext();
        return;
      }
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        scheduleNext();
        return;
      }
      const result = await this.runBackgroundSyncOnce();
      if (result) {
        this.updateBackgroundSyncDelay(result);
      }
      scheduleNext();
    };
    this.backgroundSyncTimer = setTimeout(loop, immediate ? 0 : this.getBackgroundSyncDelayMs());
  }

  stopBackgroundSync() {
    if (this.backgroundSyncTimer) {
      clearTimeout(this.backgroundSyncTimer);
      this.backgroundSyncTimer = null;
    }
    this.backgroundSyncing = false;
  }

  async runBackgroundSyncOnce() {
    if (!this.settings.siteUrl || !this.settings.apiKey) return null;
    if (this.backgroundSyncing) return null;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return null;
    this.backgroundSyncing = true;
    let success = false;
    let changed = false;
    const prevSignature = getShareSignature(this.shares);
    try {
      await this.verifyRemote({silent: true, background: true});
      const shares = await this.syncRemoteShares({silent: true, background: true});
      const nextSignature = getShareSignature(shares);
      changed = nextSignature !== prevSignature;
      success = true;
    } catch {
      // silent background sync: ignore
    } finally {
      this.backgroundSyncing = false;
    }
    return {success, changed};
  }
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/`/g, "&#96;");
}

module.exports = SiYuanSharePlugin;
module.exports.default = SiYuanSharePlugin;
