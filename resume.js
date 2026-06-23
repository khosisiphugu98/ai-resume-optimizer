// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Store FULL original HTML for perfect reset (snapshot the entire resume)
const originalResumeHTML = document.getElementById('resume-content').innerHTML;

// Provider configuration — all per-provider values in one place
const PROVIDER_CONFIG = {
    openai: {
        baseUrl:      'https://api.openai.com/v1/chat/completions',
        models:       [{ value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo (Faster)' },
                       { value: 'gpt-4',         label: 'GPT-4 (Better Quality)' }],
        defaultModel: 'gpt-3.5-turbo',
        extractModel: 'gpt-4o-mini',
        visionModel:  'gpt-4o',
        charLimit:    20000,
        privacyUrl:   'https://openai.com/privacy',
        keyUrl:       'https://platform.openai.com/api-keys',
        keyLabel:     'OpenAI API Key',
        placeholder:  'Enter your OpenAI API key (sk-...)'
    },
    deepseek: {
        baseUrl:      'https://api.deepseek.com/v1/chat/completions',
        models:       [{ value: 'deepseek-chat',     label: 'DeepSeek Chat (Faster)' },
                       { value: 'deepseek-reasoner', label: 'DeepSeek R1 (Better Quality)' }],
        defaultModel: 'deepseek-chat',
        extractModel: 'deepseek-chat',
        visionModel:  'deepseek-chat',
        charLimit:    20000,
        privacyUrl:   'https://www.deepseek.com/privacy',
        keyUrl:       'https://platform.deepseek.com/api-keys',
        keyLabel:     'DeepSeek API Key',
        placeholder:  'Enter your DeepSeek API key (sk-...)'
    }
};

// Built-in key — lets recruiters use the app without any setup
const BUILTIN_PROVIDER = 'deepseek';
const BUILTIN_KEY      = 'sk-0b038d6efff14e3b921d244d5ffa7141';

// Global state
let highlightsVisible = false;
let apiKeys = { openai: null, deepseek: null };
let currentProvider = 'openai';
function activeApiKey() { return apiKeys[currentProvider] || (currentProvider === BUILTIN_PROVIDER ? BUILTIN_KEY : null); }
let isEditing = false;
let extractedKeywords = [];
let usingUploadedResume = false;
let lastAppliedResume = null;
let preOptimizationSnapshot = null; // DOM snapshot taken just before each optimize run
let pendingDiffs = []; // Sprint 4: diffs awaiting user review

// =============================================
// PROVIDER UI HELPERS
// =============================================
function updateModelDropdown() {
    const select = document.getElementById('ai-model');
    const models = PROVIDER_CONFIG[currentProvider].models;
    select.innerHTML = models.map(m => `<option value="${m.value}">${m.label}</option>`).join('');
}

function updateApiKeyUI() {
    const cfg = PROVIDER_CONFIG[currentProvider];
    document.getElementById('api-key-label').textContent = cfg.keyLabel + ':';
    document.getElementById('api-key').placeholder = cfg.placeholder;
    document.getElementById('api-privacy-link').href = cfg.privacyUrl;
    document.getElementById('api-get-key-link').href  = cfg.keyUrl;
    document.getElementById('api-get-key-link').textContent = 'Get your ' + cfg.keyLabel;
    const fmt = (key, id) => {
        const el = document.getElementById(id);
        el.innerHTML = el.innerHTML.replace(/<strong.*<\/strong>/,
            `<strong style="color:${key ? '#27ae60' : '#e74c3c'}">${key ? '✓ configured' : 'not set'}</strong>`);
    };
    fmt(apiKeys.openai,    'openai-key-status');
    fmt(apiKeys.deepseek,  'deepseek-key-status');
}

document.getElementById('ai-provider').addEventListener('change', function() {
    currentProvider = this.value;
    localStorage.setItem('provider', currentProvider);
    updateModelDropdown();
    updateApiKeyUI();
    document.getElementById('api-key-container').style.display = activeApiKey() ? 'none' : 'block';
});

// =============================================
// SECURE API KEY STORAGE — AES-256-GCM + IndexedDB
// The encryption key lives in IndexedDB with extractable:false.
// localStorage only stores the ciphertext + IV — useless without the IDB key.
// Both stores are same-origin and cannot be accessed by other sites.
// =============================================
const _IDB_DB    = 'resume_optimizer_keys';
const _IDB_STORE = 'keys';
const _IDB_KEY_ID = 'apiKeyEncryptionKey';
const _LS_KEY     = 'encApiKey';

function _openKeyDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(_IDB_DB, 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore(_IDB_STORE);
        req.onsuccess = e => resolve(e.target.result);
        req.onerror   = () => reject(req.error);
    });
}

async function _getOrCreateCryptoKey() {
    const db  = await _openKeyDb();
    const get = () => new Promise((res, rej) => {
        const tx = db.transaction(_IDB_STORE, 'readonly');
        const r  = tx.objectStore(_IDB_STORE).get(_IDB_KEY_ID);
        r.onsuccess = () => res(r.result);
        r.onerror   = () => rej(r.error);
    });
    const existing = await get();
    if (existing) return existing;
    const key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,               // non-extractable — JS can never read the raw key bytes
        ['encrypt', 'decrypt']
    );
    await new Promise((res, rej) => {
        const tx = db.transaction(_IDB_STORE, 'readwrite');
        const r  = tx.objectStore(_IDB_STORE).put(key, _IDB_KEY_ID);
        r.onsuccess = res; r.onerror = () => rej(r.error);
    });
    return key;
}

async function _encryptApiKey(plaintext) {
    const key = await _getOrCreateCryptoKey();
    const iv  = crypto.getRandomValues(new Uint8Array(12));
    const enc = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        new TextEncoder().encode(plaintext)
    );
    // Prepend IV to ciphertext, encode as base64
    const combined = new Uint8Array(12 + enc.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(enc), 12);
    return btoa(String.fromCharCode(...combined));
}

async function _decryptApiKey(b64) {
    const key      = await _getOrCreateCryptoKey();
    const combined = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const dec      = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: combined.slice(0, 12) },
        key,
        combined.slice(12)
    );
    return new TextDecoder().decode(dec);
}

async function _deleteEncryptionKey() {
    try {
        const db = await _openKeyDb();
        await new Promise((res, rej) => {
            const tx = db.transaction(_IDB_STORE, 'readwrite');
            const r  = tx.objectStore(_IDB_STORE).delete(_IDB_KEY_ID);
            r.onsuccess = res; r.onerror = () => rej(r.error);
        });
    } catch { /* fail silently — storage may already be cleared */ }
}

async function initApiKey() {
    currentProvider = localStorage.getItem('provider') || BUILTIN_PROVIDER;
    document.getElementById('ai-provider').value = currentProvider;
    updateModelDropdown();

    const stored = localStorage.getItem(_LS_KEY);
    if (stored) {
        try {
            const decrypted = await _decryptApiKey(stored);
            const parsed = JSON.parse(decrypted);
            if (parsed && typeof parsed === 'object' && ('openai' in parsed || 'deepseek' in parsed)) {
                apiKeys = { openai: parsed.openai || null, deepseek: parsed.deepseek || null };
            } else {
                // One-time migration: old format was a plain encrypted string (OpenAI key)
                apiKeys = { openai: typeof decrypted === 'string' ? decrypted : null, deepseek: null };
                const migrated = await _encryptApiKey(JSON.stringify(apiKeys));
                localStorage.setItem(_LS_KEY, migrated);
            }
        } catch {
            localStorage.removeItem(_LS_KEY);
        }
    }

    updateApiKeyUI();
    // Hide the key config panel — built-in key means recruiters never see this
    document.getElementById('api-key-container').style.display = 'none';
}

function showMessage(message, type) {
    const msgEl = document.getElementById('message');
    msgEl.textContent = message;
    msgEl.className = 'message ' + type;
    msgEl.style.display = 'block';
    setTimeout(() => msgEl.style.display = 'none', 5000);
}

// =============================================
// UTILITY: Safely coerce any value into an array
// Handles: arrays, strings (split by newline/bullet), objects, null/undefined
// =============================================
function ensureArray(val) {
    if (Array.isArray(val)) return val;
    if (val == null) return [];
    if (typeof val === 'string') {
        // Split on newlines, bullet chars, numbered lists, or semicolons
        const lines = val.split(/[\n\r]+|(?:\s*[\u2022\u2023\u25E6\u2043•·‣-]\s+)|(?:\s*\d+[.)]\s+)|;\s*/)
            .map(s => s.trim())
            .filter(s => s.length > 0);
        return lines.length > 0 ? lines : [val];
    }
    if (typeof val === 'object') return Object.values(val);
    return [String(val)];
}

// Sanitize URLs: allow only https, http, mailto — block javascript:, data:, etc.
function sanitizeUrl(val) {
    if (!val) return '#';
    const str = String(val).trim();
    try {
        const url = new URL(str.startsWith('http') || str.startsWith('mailto:') ? str : 'https://' + str);
        if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) return '#';
        return url.href;
    } catch {
        return '#';
    }
}

// Sanitize text to prevent XSS when inserting into HTML
function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// =============================================
// IDENTITY-BASED BULLET MATCHING (Phase 1 fix)
// Instead of matching AI enhancements to bullets by array index (fragile),
// we match by content hash. The AI returns {original, enhanced} pairs;
// we find the exact <li> whose text matches `original` and replace only that one.
// Bullets not mentioned by the AI are NEVER touched.
// =============================================
function djb2Hash(str) {
    // Fast non-crypto hash (djb2) — good enough for bullet identity matching
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
    return (h >>> 0).toString(36);
}

function buildBulletMap(ul) {
    // Returns Map<hash, li element> for all bullets in a <ul>
    const map = new Map();
    ul.querySelectorAll('li').forEach(li => {
        const hash = djb2Hash(li.textContent.trim());
        map.set(hash, li);
    });
    return map;
}

function applyEnhancementsByIdentity(ul, enhancements) {
    // Apply {original, enhanced} pairs by identity — never by index.
    // Falls back to index-based for plain string arrays (backwards compat).
    const enhArray = ensureArray(enhancements);
    const isObjectArray = enhArray.length > 0 && typeof enhArray[0] === 'object' && enhArray[0] !== null && 'original' in enhArray[0];

    if (isObjectArray) {
        // Identity-based: find each bullet by its exact original text
        const bulletMap = buildBulletMap(ul);
        enhArray.forEach(enh => {
            if (!enh.original || !enh.enhanced) return;
            if (enh.enhanced === enh.original) return; // no change needed
            const hash = djb2Hash(enh.original.trim());
            const li = bulletMap.get(hash);
            if (li) {
                // Only replace if the enhanced version is not shorter than the original
                // (prevents AI from compressing bullets)
                if (enh.enhanced.length >= enh.original.length * 0.8) {
                    li.textContent = enh.enhanced;
                }
            }
            // If hash not found: the AI hallucinated an original text — silently skip, never touch DOM
        });
    } else {
        // Fallback: index-based for plain string arrays
        const bullets = ul.querySelectorAll('li');
        enhArray.forEach((enh, idx) => {
            if (!bullets[idx]) return;
            const text = (typeof enh === 'object' && enh !== null) ? (enh.enhanced || enh.original || String(enh)) : String(enh);
            if (text && text.length >= bullets[idx].textContent.length * 0.8) {
                bullets[idx].textContent = text;
            }
        });
    }
}

// Helper functions (highlights, editing, reset)
document.getElementById('toggle-highlights').addEventListener('click', function() {
    highlightsVisible = !highlightsVisible;
    document.querySelectorAll('.highlight-skill').forEach(el => {
        if (highlightsVisible) { el.style.backgroundColor = 'rgba(52,152,219,0.2)'; el.style.padding = '2px 4px'; el.style.borderRadius = '3px'; el.style.fontWeight = '600'; }
        else { el.style.backgroundColor = 'transparent'; el.style.padding = '0'; el.style.borderRadius = '0'; el.style.fontWeight = 'inherit'; }
    });
    this.textContent = highlightsVisible ? 'Hide Highlights' : 'Show Highlights';
});

document.getElementById('toggle-edit').addEventListener('click', function() {
    isEditing = !isEditing;
    document.querySelectorAll('.editable-text, .editable-list li, .education ul li').forEach(el => {
        el.contentEditable = isEditing;
        if (isEditing) el.classList.add('editable');
        else el.classList.remove('editable');
    });
    this.textContent = isEditing ? 'Disable Editing' : 'Enable Editing';
    this.classList.toggle('btn-warning', isEditing);
    showMessage(isEditing ? 'Editing enabled' : 'Editing disabled', 'info');
});

document.getElementById('reset-btn').addEventListener('click', () => {
    // If we have a pre-optimization snapshot, restore to that (keeps imported resume intact,
    // just undoes the AI optimization). Otherwise fall back to the original hardcoded HTML.
    const container = document.getElementById('resume-content');
    if (preOptimizationSnapshot) {
        container.innerHTML = preOptimizationSnapshot;
        // Re-attach profile picture handler since innerHTML replace kills listeners
        document.querySelector('.profile-img').addEventListener('click', () => document.getElementById('file-input').click());
        document.getElementById('file-input').addEventListener('change', handleProfilePicChange);
        preOptimizationSnapshot = null;
        showMessage('Optimization undone — resume restored to pre-optimize state', 'success');
    } else {
        resetResume();
        showMessage('Resume changes reset', 'success');
    }
    hideHighlights();
    highlightsVisible = false;
    document.getElementById('toggle-highlights').textContent = 'Show Highlights';
    document.getElementById('job-description').value = '';
    document.getElementById('keywords-display').style.display = 'none';
    document.getElementById('keyword-status').style.display = 'none';
    if (isEditing) { disableEditingManually(); }
});

function disableEditingManually() {
    document.querySelectorAll('.editable-text, .editable-list li, .education ul li').forEach(el => {
        el.contentEditable = false;
        el.classList.remove('editable');
    });
    document.getElementById('toggle-edit').textContent = 'Enable Editing';
    document.getElementById('toggle-edit').classList.remove('btn-warning');
    isEditing = false;
}

function hideHighlights() {
    document.querySelectorAll('.highlight-skill').forEach(el => {
        el.style.backgroundColor = 'transparent';
        el.style.padding = '0';
        el.style.borderRadius = '0';
        el.style.fontWeight = 'inherit';
    });
}

function showHighlightsManually() {
    document.querySelectorAll('.highlight-skill').forEach(el => {
        el.style.backgroundColor = 'rgba(52,152,219,0.2)';
        el.style.padding = '2px 4px';
        el.style.borderRadius = '3px';
        el.style.fontWeight = '600';
    });
}

// Reset: restores the ENTIRE original resume HTML (no content leakage)
function resetResume() {
    const container = document.getElementById('resume-content');
    // Clear auto-fit classes and transform before restoring
    container.classList.remove('compact-spacing', 'compact-fonts', 'compact-content');
    container.style.transform = '';
    container.style.transformOrigin = '';
    container.innerHTML = originalResumeHTML;
    usingUploadedResume = false;
    // Re-attach profile picture click handler
    document.querySelector('.profile-img').addEventListener('click', () => document.getElementById('file-input').click());
    document.getElementById('file-input').addEventListener('change', handleProfilePicChange);
}

document.getElementById('configure-ai').addEventListener('click', () => {
    document.getElementById('api-key-container').style.display = document.getElementById('api-key-container').style.display === 'none' ? 'block' : 'none';
});
document.getElementById('save-api-key').addEventListener('click', async () => {
    const key = document.getElementById('api-key').value.trim();
    if (!key) { showMessage('Enter valid API key', 'error'); return; }
    try {
        apiKeys[currentProvider] = key;
        const encrypted = await _encryptApiKey(JSON.stringify(apiKeys));
        localStorage.setItem(_LS_KEY, encrypted);
        document.getElementById('api-key').value = '';
        document.getElementById('api-key-container').style.display = 'none';
        updateApiKeyUI();
        showMessage(`${PROVIDER_CONFIG[currentProvider].keyLabel} saved — encrypted and stored permanently.`, 'success');
    } catch (e) {
        apiKeys[currentProvider] = null; // roll back on failure
        showMessage('Could not save API key: ' + e.message, 'error');
    }
});
document.getElementById('advanced-options').addEventListener('click', () => {
    const cont = document.getElementById('advanced-options-container');
    cont.style.display = cont.style.display === 'none' ? 'block' : 'none';
});

// Print
document.getElementById('print-btn').addEventListener('click', () => {
    hideHighlights();
    window.print();
});

// Download functions
document.getElementById('download-html-btn').addEventListener('click', async () => {
    hideHighlights();
    const resumeHTML = document.getElementById('resume-content').outerHTML;
    // Fetch Font Awesome CSS inline so the exported file has no live CDN dependencies
    let fontAwesomeCSS = '';
    try {
        const faResp = await fetch('https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css');
        fontAwesomeCSS = await faResp.text();
        // Rewrite relative font paths to absolute CDN paths so icons still load
        fontAwesomeCSS = fontAwesomeCSS.replace(/url\((['"]?)\.\.\/webfonts\//g, 'url($1https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/');
    } catch (e) {
        // If fetch fails, fall back to CDN link (better than broken export)
        fontAwesomeCSS = null;
    }
    const faTag = fontAwesomeCSS
        ? `<style>${fontAwesomeCSS}</style>`
        : `<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">`;
    // Restrictive CSP for the exported file — no scripts, no external connects
    const exportCSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; font-src https://cdnjs.cloudflare.com https://fonts.gstatic.com data:; img-src data: blob:; script-src 'none';">`;
    const fullHTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Resume</title>${exportCSP}<link href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;600;700&family=Roboto+Condensed:wght@700&display=swap" rel="stylesheet">${faTag}<style>${getStylesForDownload()}</style></head><body>${resumeHTML}</body></html>`;
    const blob = new Blob([fullHTML], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'Resume.html';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 100);
    if (highlightsVisible) showHighlightsManually();
    showMessage('HTML downloaded', 'success');
});

function getStylesForDownload() {
    const container = document.getElementById('resume-content');
    const hasCompactSpacing = container.classList.contains('compact-spacing');
    const hasCompactFonts = container.classList.contains('compact-fonts');
    const scaleMatch = container.style.transform ? container.style.transform.match(/scale\(([\d.]+)\)/) : null;
    let css = `*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Open Sans',sans-serif;line-height:1.4;color:#333;background:white;padding:20px;font-size:13px}.resume-container{background:white;display:flex;align-items:stretch;max-width:900px;margin:0 auto;position:relative}.resume-container::before{content:'';position:absolute;top:0;left:0;bottom:0;width:35%;background:#2c3e50;z-index:0}.sidebar{width:35%;background:transparent;color:white;padding:20px 15px;position:relative;z-index:1}.main-content{width:65%;padding:20px;background:white;position:relative;z-index:1}h1,h2,h3{font-family:'Roboto Condensed',sans-serif;margin-bottom:10px}h1{font-size:18px;color:white;text-transform:uppercase}h2{font-size:14px;color:#2c3e50;border-bottom:2px solid #3498db}.skill-tag{display:inline-block;background:rgba(255,255,255,0.1);padding:3px 6px;border-radius:3px;margin:2px;font-size:9px}.skill-category h4{color:#3498db;margin-bottom:5px;font-size:11px;text-transform:uppercase}.job-title{font-weight:600;color:#2c3e50;font-size:12px}.company,.degree{font-weight:600;color:#2c3e50;font-size:11px}.date{color:#7f8c8d;font-size:10px}ul{padding-left:16px;margin:6px 0}li{margin-bottom:3px;font-size:10px;line-height:1.3}.language-item{margin-bottom:5px;font-size:10px}.reference-name{font-weight:600;font-size:11px;margin-bottom:2px}.reference-item{margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.1)}.reference-item:last-child{border-bottom:none}.reference-item div{font-size:9px;margin-bottom:2px}.reference-title{color:#3498db;font-size:9px}.reference-contact{display:flex;align-items:center;margin-top:3px}.reference-icon{margin-right:5px;font-size:9px;width:12px;text-align:center}.contact-item{display:flex;align-items:center;margin-bottom:6px;font-size:10px}.contact-icon{margin-right:8px;color:#3498db;width:14px;text-align:center}.contact-link{color:white;text-decoration:none}.profile{margin-bottom:20px;text-align:center}.profile-img{width:70px;height:70px;border-radius:50%;border:3px solid #3498db;margin:0 auto 10px;background-color:#eee;display:flex;align-items:center;justify-content:center;overflow:hidden}.profile-img img{width:100%;height:100%;object-fit:cover}.profile-summary p{font-size:10px;line-height:1.4}.section-hidden{display:none!important}`;
    if (hasCompactSpacing) css += `.compact-spacing .sidebar{padding:12px 10px}.compact-spacing .main-content{padding:12px 15px}.compact-spacing h2{margin-top:8px;margin-bottom:5px;padding-bottom:2px}.compact-spacing .profile{margin-bottom:10px}.compact-spacing ul{margin:2px 0}.compact-spacing li{margin-bottom:1px;line-height:1.2}.compact-spacing .skill-tag{padding:2px 4px;margin:0 2px 2px 0}.compact-spacing .contact-item{margin-bottom:3px}.compact-spacing .reference-item{margin-bottom:6px;padding-bottom:5px}.compact-spacing .language-item{margin-bottom:2px}`;
    if (hasCompactFonts) css += `.compact-fonts h1{font-size:15px}.compact-fonts h2{font-size:12px}.compact-fonts h3{font-size:10px}.compact-fonts .job-title{font-size:10px}.compact-fonts .company,.compact-fonts .degree{font-size:9px}.compact-fonts .date{font-size:8px}.compact-fonts li{font-size:8px}.compact-fonts .skill-tag{font-size:7.5px}.compact-fonts .skill-category h4{font-size:9px}.compact-fonts .contact-item{font-size:8px}.compact-fonts .language-item{font-size:8px}.compact-fonts .reference-name{font-size:9px}.compact-fonts .reference-item div{font-size:7.5px}.compact-fonts .profile-summary p{font-size:8px}.compact-fonts .profile-img{width:55px;height:55px}`;
    if (scaleMatch) css += `.resume-container{transform:scale(${scaleMatch[1]});transform-origin:top center}`;
    return css;
}

// Measure the lowest content edge using offsetTop/offsetHeight traversal.
// Returns the bottom position in CSS layout pixels relative to the container.
//
// IMPORTANT: we must NOT use getBoundingClientRect() here because autoFitResume
// Phase 4 applies a CSS transform: scale(X) to the container. getBoundingClientRect
// returns visual (post-transform) coordinates, but html2canvas captures at the full
// layout size (pre-transform). Using visual coords causes the crop to fire too early
// — cutting off the bottom of the content proportionally to the scale factor.
//
// offsetTop/offsetHeight are always in layout-space (unaffected by CSS transforms),
// which matches the coordinate space html2canvas captures.
function measureContentBottomDOM(container) {
    let maxBottom = 0;
    container.querySelectorAll('*').forEach(el => {
        if (el.dataset.autofitHidden) return;
        if (el.offsetWidth === 0 && el.offsetHeight === 0) return;
        // Walk up the offsetParent chain to accumulate position relative to container
        let bottom = el.offsetTop + el.offsetHeight;
        let node = el.offsetParent;
        while (node && node !== container && container.contains(node)) {
            bottom += node.offsetTop;
            node = node.offsetParent;
        }
        if (bottom > maxBottom) maxBottom = bottom;
    });
    return maxBottom;
}

// Return a new canvas cropped to croppedHeight pixels
function cropCanvas(source, croppedHeight) {
    const h = Math.min(Math.ceil(croppedHeight), source.height);
    const cropped = document.createElement('canvas');
    cropped.width = source.width;
    cropped.height = h;
    cropped.getContext('2d').drawImage(source, 0, 0);
    return cropped;
}

document.getElementById('download-pdf-btn').addEventListener('click', async () => {
    showMessage('Generating PDF...', 'info');
    const wasVisible = highlightsVisible;
    hideHighlights();

    // html2canvas cannot render ::before pseudo-elements, so temporarily
    // set a real background on the sidebar for capture
    const sidebar = document.querySelector('.sidebar');
    const resumeEl = document.getElementById('resume-content');
    const origSidebarBg = sidebar.style.background;
    sidebar.style.background = '#2c3e50';

    try {
        const element = resumeEl;
        const scale = 2;

        // Measure content boundary from the DOM BEFORE rendering the canvas.
        // This gives us the exact bottom of the last real element in CSS pixels.
        const contentBottomCSS = measureContentBottomDOM(element);
        // Convert to canvas pixels and add 20px real-CSS-pixel bottom margin
        const bottomMarginCSS = 20;
        const cropHeightCanvas = (contentBottomCSS + bottomMarginCSS) * scale;

        const rawCanvas = await html2canvas(element, {
            scale,
            backgroundColor: '#ffffff',
            width: element.scrollWidth,
            height: element.scrollHeight,
            windowWidth: element.scrollWidth,
            windowHeight: element.scrollHeight
        });

        const canvas = cropCanvas(rawCanvas, cropHeightCanvas);

        // Compression strategy (all client-side, no data leaves the browser):
        // 1. JPEG encoding at quality 0.82 — typically 80-90% smaller than PNG
        //    for rendered resume content (text on white/dark backgrounds compresses well)
        // 2. jsPDF compress:true — deflate compression on all internal PDF streams
        // Together these reliably produce files well under 2MB.
        const JPEG_QUALITY = 0.82;
        const imgData = canvas.toDataURL('image/jpeg', JPEG_QUALITY);

        const { jsPDF } = window.jspdf;
        const a4Width = 210;
        const a4Height = 297;
        const imgWidth = a4Width;
        const imgHeight = (canvas.height * a4Width) / canvas.width;

        // compress:true enables deflate on PDF object streams
        const pdfOpts = { orientation: 'portrait', unit: 'mm', compress: true };
        let pdf;

        if (imgHeight <= a4Height) {
            pdf = new jsPDF({ ...pdfOpts, format: [a4Width, imgHeight] });
            pdf.addImage(imgData, 'JPEG', 0, 0, imgWidth, imgHeight);
        } else {
            pdf = new jsPDF({ ...pdfOpts, format: 'a4' });
            let yOffset = 0;
            while (yOffset < imgHeight) {
                if (yOffset > 0) pdf.addPage();
                pdf.addImage(imgData, 'JPEG', 0, -yOffset, imgWidth, imgHeight);
                yOffset += a4Height;
            }
        }

        // Report actual file size before triggering the download
        const sizeKB = Math.round(pdf.output('blob').size / 1024);
        const sizeLabel = sizeKB >= 1024 ? `${(sizeKB / 1024).toFixed(1)} MB` : `${sizeKB} KB`;
        pdf.save('Resume.pdf');
        showMessage(`PDF downloaded — ${sizeLabel} (JPEG + deflate compressed)`, 'success');
    } catch (e) { console.error('PDF error:', e); showMessage('PDF error: ' + e.message, 'error'); }
    finally {
        sidebar.style.background = origSidebarBg;
        if (wasVisible) showHighlightsManually();
    }
});

// =============================================
// AI API CALL
// =============================================
async function callAI(prompt, maxTokens, model, { systemMessage = null, temperature = 0.3, jsonMode = false } = {}) {
    const cfg = PROVIDER_CONFIG[currentProvider];
    if (!model) model = cfg.defaultModel;
    const messages = [];
    if (systemMessage) messages.push({ role: 'system', content: systemMessage });
    messages.push({ role: 'user', content: prompt });
    // response_format: json_object is not supported by deepseek-reasoner (R1)
    const body = { model, messages, max_tokens: maxTokens, temperature };
    if (jsonMode && model !== 'deepseek-reasoner') body.response_format = { type: 'json_object' };
    const response = await fetch(cfg.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${activeApiKey()}` },
        body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`API error: ${(await response.json()).error?.message}`);
    return (await response.json()).choices[0].message.content.trim();
}

// =============================================
// KEYWORD NORMALIZATION & STEMMING (Phase 2 Sprint 1)
// Fixes false "missing" reports from brittle .includes() matching.
// "managing" now matches "managed", "A/B testing" matches "ab testing", etc.
// =============================================
function stemKeyword(word) {
    // Minimal suffix-stripping stemmer — covers the most common resume keyword variants
    const suffixes = ['ations', 'ation', 'ment', 'ting', 'ing', 'tion', 'ized', 'ises',
                      'ers', 'ed', 'er', 's'];
    const w = word.toLowerCase();
    for (const suffix of suffixes) {
        if (w.length > suffix.length + 3 && w.endsWith(suffix)) {
            return w.slice(0, -suffix.length);
        }
    }
    return w;
}

function normalizeKeyword(str) {
    return String(str)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ') // strip punctuation (handles A/B → A B)
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeAndStem(str) {
    // Normalize then stem each word individually, rejoin
    return normalizeKeyword(str).split(' ').map(stemKeyword).join(' ').trim();
}

// =============================================
// KEYWORD EXTRACTION & OPTIMIZATION
// =============================================
async function extractAndFilterKeywords(jobDesc, count) {
    // Cap job description length to prevent prompt injection via oversized input
    const safeJobDesc = String(jobDesc).slice(0, 5000);
    // NOTE: json_object mode requires root to be an object, not a bare array.
    // We wrap in { "keywords": [...] } and extract .keywords after parse.
    const prompt = `Analyze the following job description and extract the top ${count} most important keywords for a resume.
Return JSON in this exact format: {"keywords": ["keyword1", "keyword2", ...]}

<job_description>
${safeJobDesc}
</job_description>`;
    const response = await callAI(prompt, 1000, PROVIDER_CONFIG[currentProvider].extractModel, { jsonMode: true });
    try {
        const parsed = JSON.parse(response);
        // Handle both {keywords: [...]} and bare arrays (backwards compat)
        return Array.isArray(parsed) ? parsed : (parsed.keywords || []);
    } catch (e) { return extractKeywordsFallback(jobDesc, count); }
}

function extractKeywordsFallback(text, count) {
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 4).slice(0, count * 2);
    return [...new Set(words)].slice(0, count);
}

function displayKeywords(keywords) {
    const container = document.getElementById('keywords-list');
    container.innerHTML = keywords.map((k, i) => `<span class="keyword-tag">${i + 1}. ${escapeHTML(k)}</span>`).join('');
    document.getElementById('keywords-display').style.display = 'block';
}

async function analyzeKeywordIntegration(keywords) {
    const resumeText = document.getElementById('resume-content').innerText;
    // Build a stemmed token set from the full resume text for accurate matching
    const resumeWords = resumeText.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
    const resumeStemmed = new Set(resumeWords.map(w => stemKeyword(w)));
    // Also keep the original normalized text for multi-word phrase matching
    const resumeNormalized = normalizeKeyword(resumeText);

    const included = [];
    const missing = [];
    for (const k of keywords) {
        const normalized = normalizeKeyword(k);
        const words = normalized.split(' ').filter(Boolean);
        let found = false;
        if (words.length === 1) {
            // Single word: check stemmed set
            found = resumeStemmed.has(stemKeyword(words[0]));
        } else {
            // Multi-word phrase: check normalized text as substring
            found = resumeNormalized.includes(normalized);
            // Fallback: all individual stemmed words present
            if (!found) {
                found = words.every(w => resumeStemmed.has(stemKeyword(w)));
            }
        }
        (found ? included : missing).push(k);
    }
    return { includedKeywords: included, missingKeywords: missing, totalKeywords: keywords.length, inclusionRate: Math.round((included.length / keywords.length) * 100) };
}

function displayKeywordStatus(analysis) {
    const tracker = document.getElementById('keyword-tracker');
    tracker.innerHTML = [...analysis.includedKeywords, ...analysis.missingKeywords].map(k => {
        const inc = analysis.includedKeywords.includes(k);
        return `<div class="keyword-item"><div class="keyword-checkbox"><input type="checkbox" ${inc ? 'checked' : ''} disabled></div><div class="keyword-text">${escapeHTML(k)}</div><div class="keyword-status-indicator ${inc ? 'keyword-included' : 'keyword-missing'}"></div>${inc ? '<span class="keyword-added">\u2713 Included</span>' : ''}</div>`;
    }).join('');
    document.getElementById('keyword-summary').innerHTML = `<strong>Summary:</strong> ${analysis.includedKeywords.length}/${analysis.totalKeywords} keywords integrated (${analysis.inclusionRate}%)${analysis.missingKeywords.length ? `<br><span style="color:#e74c3c;">Missing: ${analysis.missingKeywords.map(k => escapeHTML(k)).join(', ')}</span>` : '<br><span style="color:#27ae60;">\u2713 All keywords integrated!</span>'}`;
    document.getElementById('keyword-status').style.display = 'block';
}

function getResumeContent() {
    const summary = document.getElementById('summary-text')?.textContent || '';
    const experience = {};
    document.querySelectorAll('.experience .experience-item').forEach((item, idx) => {
        const ul = item.querySelector('ul');
        const id = ul ? (ul.id || `exp-${idx}`) : `exp-${idx}`;
        const sectionKey = id.replace('-experience', '');
        experience[sectionKey] = ul ? Array.from(ul.querySelectorAll('li')).map(l => l.textContent) : [];
    });
    return { summary, experience };
}

// Sprint 2: Build a per-section call queue
function buildSectionQueue() {
    const queue = [];
    document.querySelectorAll('.experience .experience-item').forEach((item, idx) => {
        const ul = item.querySelector('ul');
        if (!ul) return;
        const id = ul.id || `exp-${idx}`;
        const jobTitle = item.querySelector('.job-title')?.textContent?.trim() || '';
        const company = item.querySelector('.company')?.textContent?.replace(/^\s*\|\s*/, '').trim() || '';
        const date = item.querySelector('.date')?.textContent?.trim() || '';
        const bullets = Array.from(ul.querySelectorAll('li')).map(l => l.textContent.trim());
        if (bullets.length > 0) {
            queue.push({ sectionId: id, ul, jobTitle, company, date, bullets });
        }
    });
    return queue;
}

function buildSectionPrompt(section, missingKeywords, jobDesc) {
    const keywordList = missingKeywords.join(', ');
    return `You are a professional resume writer. Enhance the bullet points for this specific job role to naturally incorporate relevant keywords. Keep all content truthful and professional. Do not fabricate experience or invent responsibilities not implied by the existing bullets.

Job Role: ${section.jobTitle} at ${section.company} (${section.date})

Keywords to integrate (use only those genuinely relevant to this role):
${keywordList}

Target Job Description Context:
${jobDesc.slice(0, 800)}

Current bullet points:
${section.bullets.map((b, i) => `${i + 1}. ${b}`).join('\n')}

Return ONLY valid JSON in this exact format:
{"enhancements": [{"original": "exact original bullet text", "enhanced": "improved bullet text"}]}

Only include bullets that genuinely benefit from keyword integration. Omit bullets that are already strong. Never change the meaning of a bullet — only strengthen the phrasing.`;
}

function buildSummaryPrompt(summaryText, missingKeywords, jobDesc) {
    const keywordList = missingKeywords.join(', ');
    return `You are a professional resume writer. Enhance this professional summary to naturally incorporate relevant keywords while keeping it concise (2-4 sentences max) and truthful.

Keywords to integrate (only those relevant to the person's background):
${keywordList}

Target Job Description Context:
${jobDesc.slice(0, 600)}

Current summary:
${summaryText}

Return ONLY valid JSON in this exact format:
{"summary": "enhanced summary text here"}

If the summary is already strong and keywords are not naturally applicable, return the original unchanged.`;
}

async function runParallelSectionCalls(queue, missingKeywords, jobDesc, model) {
    const BATCH_SIZE = 3;
    const results = new Array(queue.length).fill(null);
    for (let i = 0; i < queue.length; i += BATCH_SIZE) {
        const batch = queue.slice(i, i + BATCH_SIZE);
        const calls = batch.map(section =>
            callAI(buildSectionPrompt(section, missingKeywords, jobDesc), 1200, model, { jsonMode: true })
                .then(r => JSON.parse(r))
                .catch(e => { console.warn(`Section ${section.sectionId} call failed:`, e); return null; })
        );
        const batchResults = await Promise.all(calls);
        batchResults.forEach((res, batchIdx) => { results[i + batchIdx] = res; });
    }
    return results;
}

function highlightExistingKeywords(keywords) {
    const container = document.getElementById('resume-content');
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    // Sanitize keyword strings before using in regex — never trust AI/user input in regex context
    const safeKeywords = keywords.map(k => String(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (safeKeywords.length === 0) return;
    const combined = new RegExp(safeKeywords.map(k => `\\b${k}\\b`).join('|'), 'gi');

    textNodes.forEach(node => {
        const text = node.textContent;
        combined.lastIndex = 0;
        if (!combined.test(text)) return;

        // Build DOM fragment — never use innerHTML, always use textContent for all text
        const frag = document.createDocumentFragment();
        let lastIndex = 0;
        combined.lastIndex = 0;
        let match;
        while ((match = combined.exec(text)) !== null) {
            if (match.index > lastIndex) {
                frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
            }
            const span = document.createElement('span');
            span.className = 'highlight-skill';
            span.textContent = match[0]; // textContent only — never innerHTML
            frag.appendChild(span);
            lastIndex = match.index + match[0].length;
        }
        if (lastIndex < text.length) {
            frag.appendChild(document.createTextNode(text.slice(lastIndex)));
        }
        node.parentNode.replaceChild(frag, node);
    });
}

// =============================================
// AI OPTIMIZATION (works for both original and uploaded resumes)
// =============================================
document.getElementById('optimize-btn').addEventListener('click', async function() {
    const jobDesc = document.getElementById('job-description').value.trim();
    const kwCount = parseInt(document.getElementById('keyword-count').value) || 15;
    if (!jobDesc) { showMessage('Paste job description', 'error'); return; }
    if (!activeApiKey()) { showMessage('Configure API key', 'error'); document.getElementById('api-key-container').style.display = 'block'; return; }
    document.getElementById('loading').style.display = 'block';
    try {
        // --- PHASE 1 FIX: Snapshot DOM before touching anything ---
        // This is the undo buffer. If anything goes wrong mid-write,
        // the user can click "Reset Optimized Changes" to get back to exactly this state.
        preOptimizationSnapshot = document.getElementById('resume-content').innerHTML;
        ulBulletMaps = new WeakMap(); // invalidate cached bullet maps from previous run

        // --- PHASE 1 FIX: Run auto-fit BEFORE optimization as a baseline ---
        // Previously ran unconditionally AFTER, causing AI-added content to trigger
        // auto-fit which then deleted other bullets to compensate.
        // Now: establish the baseline first, re-run after only if content grew.
        await document.fonts.ready;
        autoFitResume();
        const heightBeforeOptimize = document.getElementById('resume-content').scrollHeight;

        document.getElementById('loading-details').textContent = 'Extracting keywords...';
        extractedKeywords = await extractAndFilterKeywords(jobDesc, kwCount);
        displayKeywords(extractedKeywords);
        document.getElementById('loading-details').textContent = 'Analyzing resume...';
        const analysis = await analyzeKeywordIntegration(extractedKeywords);
        displayKeywordStatus(analysis);
        document.getElementById('loading-details').textContent = 'Optimizing with AI...';
        await optimizeResumeWithAI(jobDesc, extractedKeywords, analysis);
        const updatedAnalysis = await analyzeKeywordIntegration(extractedKeywords);
        displayKeywordStatus(updatedAnalysis);
        // Only re-run auto-fit if content actually grew beyond A4
        const heightAfterOptimize = document.getElementById('resume-content').scrollHeight;
        if (heightAfterOptimize > heightBeforeOptimize) {
            requestAnimationFrame(async () => { await document.fonts.ready; autoFitResume(); });
        }
        highlightsVisible = true;
        showHighlightsManually();
        document.getElementById('toggle-highlights').textContent = 'Hide Highlights';
        // Sprint 5: Render match score based on post-optimization keyword analysis
        renderMatchScoreUI(updatedAnalysis);
        const pendingCount = pendingDiffs.length;
        showMessage(
            `Optimized! ${updatedAnalysis.includedKeywords.length}/${extractedKeywords.length} keywords integrated.` +
            (pendingCount > 0 ? ` Review ${pendingCount} suggested changes below.` : ''),
            'success'
        );
    } catch (e) { showMessage(`Error: ${e.message}`, 'error'); }
    finally { document.getElementById('loading').style.display = 'none'; }
});

async function optimizeResumeWithAI(jobDesc, keywords, analysis) {
    const missing = analysis.missingKeywords;
    if (missing.length === 0) { highlightExistingKeywords(keywords); return; }
    const model = document.getElementById('ai-model').value;
    // Sanitize keyword strings — never trust AI output in DOM/prompt context
    const safeMissing = missing.map(k => String(k).replace(/[<>"']/g, ''));

    try {
        // Sprint 2: per-section parallel calls — no 8000-char cap, no 30-keyword limit
        const sectionQueue = buildSectionQueue();
        const loadingDetails = document.getElementById('loading-details');

        // Run section calls in parallel batches of 3
        loadingDetails.textContent = `Optimizing ${sectionQueue.length} sections...`;
        const sectionResults = await runParallelSectionCalls(sectionQueue, safeMissing, jobDesc, model);

        // Sprint 4: Collect diffs and show review panel instead of auto-applying
        pendingDiffs = collectDiffs(sectionQueue, sectionResults);
        renderDiffView(pendingDiffs);

        // Summary call — separate, runs after sections complete
        loadingDetails.textContent = 'Enhancing summary...';
        const summaryEl = document.getElementById('summary-text');
        if (summaryEl) {
            try {
                const summaryResponse = await callAI(
                    buildSummaryPrompt(summaryEl.textContent, safeMissing, jobDesc),
                    400, model, { jsonMode: true }
                );
                const summaryResult = JSON.parse(summaryResponse);
                if (summaryResult.summary) {
                    const currentLen = summaryEl.textContent.length;
                    // Only apply if new summary is at least 80% as long (prevents AI compression)
                    if (summaryResult.summary.length >= currentLen * 0.8) {
                        summaryEl.textContent = summaryResult.summary;
                    }
                }
            } catch (e) {
                console.warn('Summary optimization failed, keeping original:', e);
            }
        }

        // Sprint 3: Surface still-missing keywords directly in skills section
        // (runs after diffs are collected, before final analysis)
        const postAnalysis = await analyzeKeywordIntegration(keywords);
        if (postAnalysis.missingKeywords.length > 0) {
            addKeywordsToSkillsSection(postAnalysis.missingKeywords);
        }

        highlightExistingKeywords(keywords);
    } catch (e) {
        console.error('AI optimization failed, falling back to highlight-only:', e);
        highlightExistingKeywords(keywords);
    }
}

// =============================================
// RESUME UPLOAD FUNCTIONALITY
// =============================================
document.getElementById('upload-resume-btn').addEventListener('click', async function() {
    const fileInput = document.getElementById('resume-upload');
    const file = fileInput.files[0];
    if (!file) { showMessage('Select a file first', 'error'); return; }
    const MAX_FILE_MB = 10;
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
        showMessage(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is ${MAX_FILE_MB} MB.`, 'error');
        return;
    }
    const ALLOWED_TYPES = new Set(['text/plain', 'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/html']);
    const ALLOWED_EXTS = ['.txt', '.pdf', '.docx', '.html', '.htm'];
    const extOk = ALLOWED_EXTS.some(ext => file.name.toLowerCase().endsWith(ext));
    if (!ALLOWED_TYPES.has(file.type) && !extOk) {
        showMessage('Unsupported file type. Use PDF, DOCX, TXT, or HTML.', 'error');
        return;
    }
    showMessage(`Processing ${file.name}...`, 'info');
    document.getElementById('upload-status').innerHTML = '📄 Reading file...';
    try {
        let extractedText = '';
        if (file.type === 'text/plain' || file.name.endsWith('.txt')) extractedText = await readTextFile(file);
        else if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) extractedText = await readPDFFile(file);
        else if (file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || file.name.endsWith('.docx')) extractedText = await readDOCXFile(file);
        else if (file.type === 'text/html' || file.name.endsWith('.html')) extractedText = await readHTMLFile(file);
        else { showMessage('Unsupported format. Use PDF, DOCX, TXT, or HTML', 'error'); return; }

        if (!extractedText || extractedText.trim().length < 50) {
            showMessage('Could not extract enough text from the file', 'error');
            return;
        }

        // For PDFs, extractedText is actually JSON from Vision API
        let parsed = null;

        if (file.name.endsWith('.pdf')) {
            // PDF was extracted via Vision API, parse the JSON
            try {
                parsed = JSON.parse(extractedText);
                showMessage(`Extracted via Vision API`, 'info');
            } catch (e) {
                console.error('Failed to parse Vision API JSON:', e);
                showMessage('Failed to parse extracted resume data', 'error');
                return;
            }
        } else {
            // Non-PDF: use text-based parsing
            if (activeApiKey()) {
                document.getElementById('upload-status').innerHTML = '🤖 AI parsing resume structure...';
                try {
                    parsed = await parseResumeWithAI(extractedText);
                } catch (e) {
                    console.warn('AI parsing failed, will use fallback:', e);
                    parsed = null;
                }
            }

            if (!parsed) {
                // FALLBACK: Smart text extraction without AI
                document.getElementById('upload-status').innerHTML = '📝 Using smart text extraction...';
                parsed = parseResumeFromText(extractedText);
            }
        }

        if (parsed && (parsed.name || parsed.summary || (parsed.experience && parsed.experience.length > 0))) {
            applyParsedResumeToUI(parsed);
            usingUploadedResume = true;
            // Run auto-fit after rendering imported content
            requestAnimationFrame(async () => { await document.fonts.ready; autoFitResume(); });
            showMessage(`Loaded: ${file.name}`, 'success');
            document.getElementById('upload-status').textContent = `✅ Loaded: ${file.name}`;
        } else {
            showMessage('Could not extract resume data', 'error');
            document.getElementById('upload-status').innerHTML = '❌ Failed to extract data';
        }

        hideHighlights();
        highlightsVisible = false;
        document.getElementById('toggle-highlights').textContent = 'Show Highlights';
        document.getElementById('keywords-display').style.display = 'none';
        document.getElementById('keyword-status').style.display = 'none';
    } catch (e) {
        showMessage(`Error: ${e.message}`, 'error');
        document.getElementById('upload-status').innerHTML = '❌ Failed';
    }
});

document.getElementById('save-default-btn').addEventListener('click', saveCurrentAsDefault);
document.getElementById('clear-data-btn').addEventListener('click', clearAllSavedData);

document.getElementById('reset-to-original').addEventListener('click', function() {
    resetResume();
    usingUploadedResume = false;
    if (isEditing) { disableEditingManually(); }
    hideHighlights();
    highlightsVisible = false;
    document.getElementById('toggle-highlights').textContent = 'Show Highlights';
    document.getElementById('keywords-display').style.display = 'none';
    document.getElementById('keyword-status').style.display = 'none';
    showMessage('Reset to original resume', 'success');
    document.getElementById('upload-status').innerHTML = '';
});

// =============================================
// SAVE AS DEFAULT / REVERT TO HARDCODED
// =============================================
const SAVED_DEFAULT_KEY = 'resumeDefault';
const SAVED_DEFAULT_VERSION = 1;

function saveCurrentAsDefault() {
    if (!lastAppliedResume) {
        showMessage('Import a resume first before saving it as default', 'error');
        return;
    }
    // Warn user their PII will be stored in browser storage
    const ok = confirm(
        'This will save your resume data (including personal details) in your browser\'s local storage so it loads automatically next time.\n\n' +
        '⚠ Saved data expires automatically after 30 days.\n' +
        '⚠ Do not use this on a shared or public device.\n\n' +
        'To remove saved data earlier: click the 🗑 Clear Saved Data button.\n\n' +
        'Continue?'
    );
    if (!ok) return;
    try {
        localStorage.setItem(SAVED_DEFAULT_KEY, JSON.stringify({ version: SAVED_DEFAULT_VERSION, savedAt: Date.now(), data: lastAppliedResume }));
        showMessage('Saved as default — will load automatically on next visit (expires in 30 days)', 'success');
    } catch (e) {
        if (e.name === 'QuotaExceededError') {
            showMessage('Could not save — browser storage is full', 'error');
        } else {
            showMessage('Could not save: ' + e.message, 'error');
        }
    }
}

async function clearAllSavedData() {
    const ok = confirm('This will permanently delete your saved resume and all API keys from this browser. Continue?');
    if (!ok) return;
    localStorage.removeItem(SAVED_DEFAULT_KEY);
    localStorage.removeItem(_LS_KEY);
    await _deleteEncryptionKey();
    apiKeys = { openai: null, deepseek: null };
    updateApiKeyUI();
    document.getElementById('api-key-container').style.display = 'block';
    showMessage('All saved data cleared from browser storage', 'success');
}

function revertToHardcodedDefault() {
    localStorage.removeItem(SAVED_DEFAULT_KEY);
    resetResume();
    usingUploadedResume = false;
    lastAppliedResume = null;
    if (isEditing) { disableEditingManually(); }
    hideHighlights();
    highlightsVisible = false;
    document.getElementById('toggle-highlights').textContent = 'Show Highlights';
    document.getElementById('keywords-display').style.display = 'none';
    document.getElementById('keyword-status').style.display = 'none';
    document.getElementById('upload-status').innerHTML = '';
    showMessage('Saved default cleared — original hardcoded resume restored', 'success');
}

// =============================================
// FILE READERS
// =============================================
async function readTextFile(file) {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = e => res(e.target.result);
        r.onerror = rej;
        r.readAsText(file);
    });
}

async function readPDFFile(file) {
    if (!activeApiKey()) {
        throw new Error('AI API key required for PDF extraction');
    }

    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const numPages = pdf.numPages;

    // Render all pages as images and extract via OpenAI Vision API
    const pageImages = [];

    for (let i = 1; i <= Math.min(numPages, 3); i++) { // Limit to 3 pages to avoid token overuse
        try {
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale: 2 }); // Scale 2 for better quality
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;

            const context = canvas.getContext('2d');
            await page.render({ canvasContext: context, viewport }).promise;

            // Convert canvas to base64 PNG
            const imageBase64 = canvas.toDataURL('image/png').split(',')[1];
            pageImages.push(imageBase64);
        } catch (e) {
            console.warn(`Failed to render page ${i}:`, e);
        }
    }

    if (pageImages.length === 0) {
        throw new Error('Could not render any pages from PDF');
    }

    // Send images to OpenAI Vision API for extraction
    const prompt = `Extract structured resume/CV data from these images. Return ONLY valid JSON with this structure:
{
  "name": "Full Name",
  "title": "Professional Title / Headline",
  "summary": "Professional summary",
  "contact": {
"email": "",
"phone": "",
"location": "",
"linkedin": "",
"website": "",
"portfolio": ""
  },
  "skills": {
"categories": [
  { "name": "Category", "items": ["skill1", "skill2"] }
]
  },
  "experience": [
{
  "title": "Job Title",
  "company": "Company Name",
  "date": "Date Range",
  "bullets": ["achievement 1", "achievement 2"]
}
  ],
  "education": [
{
  "degree": "Degree",
  "institution": "School",
  "date": "Date Range",
  "details": ["detail"]
}
  ],
  "languages": ["Language (Proficiency)"],
  "references": [
{
  "name": "Name",
  "title": "Title",
  "email": "",
  "phone": ""
}
  ],
  "certifications": [
{
  "name": "Cert Name",
  "issuer": "Issuer",
  "date": "Date"
}
  ],
  "achievements": ["achievement 1"],
  "projects": [
{
  "name": "Project Name",
  "description": "Description",
  "bullets": ["detail"]
}
  ]
}

CRITICAL RULES:
- Use EXACT text from the resume for names, titles, companies — NEVER guess or use generic labels
- Extract ALL data: contact info, education, achievements, references, skills, projects
- For phone numbers and emails: search entire resume carefully
- For company names: use EXACT names as written, not descriptions
- Return valid JSON only, no markdown or explanation`;

    // Build vision API request with multiple images
    const messageContent = [
        {
            type: 'text',
            text: prompt
        }
    ];

    // Add all page images
    pageImages.forEach(imageBase64 => {
        messageContent.push({
            type: 'image_url',
            image_url: {
                url: `data:image/png;base64,${imageBase64}`
            }
        });
    });

    try {
        const response = await fetch(PROVIDER_CONFIG[currentProvider].baseUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${activeApiKey()}`
            },
            body: JSON.stringify({
                model: PROVIDER_CONFIG[currentProvider].visionModel,
                messages: [{ role: 'user', content: messageContent }],
                max_tokens: 4000,
                temperature: 0
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(`OpenAI API error: ${error.error?.message}`);
        }

        const result = await response.json();
        let extractedJson = result.choices[0].message.content.trim();

        // Strip markdown code fences if present
        extractedJson = extractedJson.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

        // Parse and return the structured data
        const parsed = JSON.parse(extractedJson);

        // Return as JSON string so upload handler can parse it
        return JSON.stringify(parsed);
    } catch (e) {
        console.error('PDF extraction via Vision API failed:', e);
        throw e;
    }
}

async function readDOCXFile(file) {
    const buf = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer: buf });
    return result.value;
}

async function readHTMLFile(file) {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = e => {
            const parser = new DOMParser();
            const doc = parser.parseFromString(e.target.result, 'text/html');
            doc.querySelectorAll('script,style,iframe,object,embed,link[rel="import"]').forEach(el => el.remove());
            // Walk the DOM and insert newlines between block-level elements so
            // the text parser can identify section boundaries correctly.
            // Without this, all node text concatenates without whitespace separators.
            const BLOCK_TAGS = new Set(['P','DIV','H1','H2','H3','H4','H5','H6','LI','BR','TR','SECTION','ARTICLE','HEADER','FOOTER','BLOCKQUOTE','PRE']);
            const parts = [];
            const walk = node => {
                if (node.nodeType === Node.TEXT_NODE) {
                    const t = node.textContent.trim();
                    if (t) parts.push(t);
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                    if (BLOCK_TAGS.has(node.tagName)) parts.push('\n');
                    node.childNodes.forEach(walk);
                    if (BLOCK_TAGS.has(node.tagName)) parts.push('\n');
                }
            };
            walk(doc.body);
            // Collapse multiple blank lines into a single blank line
            const text = parts.join('').replace(/\n{3,}/g, '\n\n').trim();
            res(text || doc.body.textContent || '');
        };
        r.onerror = rej;
        r.readAsText(file);
    });
}

// =============================================
// AI RESUME PARSING (with robust prompt for dynamic template)
// =============================================
async function parseResumeWithAI(rawText) {
    if (!activeApiKey()) return null;

    const selectedModel = document.getElementById('ai-model').value;
    const charLimit = PROVIDER_CONFIG[currentProvider].charLimit;

    const systemMessage = `You are a precise resume parser. You extract structured data from resume text. You NEVER infer, guess, or fabricate information — you only use text that actually appears in the resume. If a field cannot be determined from the text, leave it as an empty string or empty array.`;

    const prompt = `Parse the following resume text into structured JSON. Return ONLY valid JSON, no markdown fences, no explanation.

The JSON must have this structure (include all fields you can find, leave empty arrays/strings for missing data):
{
  "name": "Full Name",
  "title": "Professional Title / Headline",
  "summary": "Professional summary paragraph",
  "contact": {
"email": "",
"phone": "",
"location": "",
"linkedin": "",
"website": "",
"portfolio": ""
  },
  "skills": {
"categories": [
  { "name": "Category Name", "items": ["skill1", "skill2"] }
]
  },
  "experience": [
{
  "title": "Job Title",
  "company": "Company Name",
  "date": "Date Range",
  "bullets": ["achievement 1", "achievement 2"]
}
  ],
  "education": [
{
  "degree": "Degree Name",
  "institution": "School Name",
  "date": "Date Range",
  "details": ["detail 1"]
}
  ],
  "languages": ["Language (Proficiency)"],
  "references": [
{
  "name": "Reference Name",
  "title": "Their Job Title",
  "organization": "Company or Organization Name",
  "email": "",
  "phone": ""
}
  ],
  "certifications": [
{
  "name": "Certification Name",
  "issuer": "Issuing Organization",
  "date": "Date"
}
  ],
  "achievements": ["achievement or award 1", "achievement or award 2"],
  "projects": [
{
  "name": "Project Name",
  "description": "Brief description",
  "bullets": ["detail 1", "detail 2"]
}
  ]
}

CRITICAL RULES:
- Use EXACT text from the resume for company names, job titles, and person names — NEVER rephrase, infer, or substitute generic labels like "Current Company" or "Previous Company"
- "bullets" MUST be an array of strings, never a single string
- "details" MUST be an array of strings, never a single string
- "items" in skills MUST be an array of strings
- Extract ALL experience entries, education entries, skills, and references you can find
- Search the ENTIRE text for email patterns (word@domain.com) and phone patterns (digits with spaces/dashes)
- If the text contains "---COLUMN_BREAK---", the text before it is from one column (often contact/skills/sidebar) and after it is another column (often experience/education). Parse BOTH columns fully.
- For company names: the company name usually appears near or with the job title, often separated by | or on an adjacent line. Use the EXACT name as written.
- For job titles: use the EXACT title as written in the resume, not a description of the role
- Look for sections labeled "Achievements", "Awards", "Honours", "Accomplishments", "Recognition" and extract them into the achievements array
- Look for sections labeled "Projects", "Key Projects" and extract them into the projects array
- For references: extract the full title AND the full organization/company name separately. E.g. if the CV shows "CEO @ClarenceAI & Commodore Power Manufacturing", set title="CEO" and organization="ClarenceAI & Commodore Power Manufacturing". Never drop the organization.
- If you can't determine a category for skills, use "General" as the category name
- For the professional title, include ALL titles/subtitles shown under the name (e.g. "BSc Property Studies | Entrepreneur | Business Development Manager")

Resume text:
${rawText.substring(0, charLimit)}`;

    try {
        let response = await callAI(prompt, 4000, selectedModel, {
            systemMessage,
            temperature: 0
        });
        // Strip markdown code fences if the AI wraps it
        response = response.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        return JSON.parse(response);
    } catch (e) {
        console.error('AI parse failed:', e);
        return null;
    }
}

// =============================================
// FALLBACK: Parse resume from plain text using patterns
// (No AI needed — works offline)
// =============================================
function parseResumeFromText(text) {
    // Handle column break marker from layout-aware PDF extraction
    text = text.replace(/---COLUMN_BREAK---/g, '\n\n');

    const lines = text.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
    const result = {
        name: '',
        title: '',
        summary: '',
        contact: { email: '', phone: '', location: '', linkedin: '', website: '', portfolio: '' },
        skills: { categories: [] },
        experience: [],
        education: [],
        achievements: [],
        projects: [],
        languages: [],
        references: [],
        certifications: []
    };

    // Extract contact info with regex
    const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
    if (emailMatch) result.contact.email = emailMatch[0];

    const phoneMatch = text.match(/(?:\+?\d{1,3}[\s-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/);
    if (phoneMatch) result.contact.phone = phoneMatch[0];

    const linkedinMatch = text.match(/linkedin\.com\/in\/[\w-]+/i);
    if (linkedinMatch) result.contact.linkedin = linkedinMatch[0];

    // Name is typically the first substantial non-email, non-phone line
    for (const line of lines.slice(0, 5)) {
        if (line.length > 2 && line.length < 60 && !line.includes('@') && !line.match(/^\+?\d/) && !line.match(/linkedin/i)) {
            if (!result.name) { result.name = line; continue; }
            if (!result.title && line.length > 3) { result.title = line; break; }
        }
    }

    // Section detection — find sections by common headings
    const sectionPatterns = {
        summary: /^(?:professional\s+)?summary|^profile|^about|^objective/i,
        contact: /^contact(?:\s+info(?:rmation)?)?$/i,
        experience: /^(?:professional\s+)?experience|^work\s+(?:experience|history)|^employment/i,
        education: /^education|^academic|^qualifications/i,
        skills: /^(?:technical\s+)?skills|^competenc|^expertise|^proficienc/i,
        languages: /^languages?$/i,
        references: /^references?$/i,
        certifications: /^certifications?|^licenses?|^credentials?/i,
        achievements: /^(?:achievements?|awards?|honours?|honors?|accomplishments?|recognition)/i,
        projects: /^(?:key\s+)?projects?$/i
    };

    // Build section map
    const sections = [];
    lines.forEach((line, idx) => {
        for (const [type, pattern] of Object.entries(sectionPatterns)) {
            if (pattern.test(line)) {
                sections.push({ type, startIdx: idx + 1 });
                break;
            }
        }
    });

    // Extract content for each section
    sections.forEach((sec, i) => {
        const endIdx = (i + 1 < sections.length) ? sections[i + 1].startIdx - 1 : lines.length;
        const sectionLines = lines.slice(sec.startIdx, endIdx);

        switch (sec.type) {
            case 'summary':
                result.summary = sectionLines.join(' ');
                break;

            case 'contact':
                // Re-run regex extractors against just this section's text
                // (global extraction above may have already found these, but this
                //  ensures the section boundary stops summary from absorbing contact lines)
                sectionLines.forEach(line => {
                    if (!result.contact.email) { const m = line.match(/[\w.+-]+@[\w-]+\.[\w.]+/); if (m) result.contact.email = m[0]; }
                    if (!result.contact.phone) { const m = line.match(/(?:\+?\d{1,3}[\s-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/); if (m) result.contact.phone = m[0]; }
                    if (!result.contact.linkedin) { const m = line.match(/linkedin\.com\/in\/[\w-]+/i); if (m) result.contact.linkedin = m[0]; }
                    if (!result.contact.location) {
                        // Lines like "Location: New York, NY" or just "New York, NY"
                        const locMatch = line.match(/^(?:location[:\s]+)?([A-Z][a-z]+(?: [A-Z][a-z]+)*(?:,\s*[A-Z]{2})?)/);
                        if (locMatch && !line.includes('@') && !line.match(/\d{3}/) && !line.match(/linkedin/i)) {
                            result.contact.location = locMatch[1];
                        }
                    }
                });
                break;

            case 'experience':
                parseExperienceLines(sectionLines, result.experience);
                break;

            case 'education':
                parseEducationLines(sectionLines, result.education);
                break;

            case 'skills':
                // Try to detect "Category Name: item1, item2, item3" format first
                const categoryLinePattern = /^(.{2,40}):\s+(.{3,})$/;
                let usedCategoryFormat = false;
                sectionLines.forEach(line => {
                    const catMatch = line.match(categoryLinePattern);
                    if (catMatch) {
                        const catName = catMatch[1].trim();
                        const items = catMatch[2]
                            .split(/[,;|•·\u2022\u2023\u25E6\u2043]/)
                            .map(s => s.trim())
                            .filter(s => s.length > 1 && s.length < 60);
                        if (items.length > 0) {
                            result.skills.categories.push({ name: catName, items });
                            usedCategoryFormat = true;
                        }
                    }
                });
                // Fallback: flat list (no "Category:" prefix found)
                if (!usedCategoryFormat) {
                    const allSkills = sectionLines
                        .join(', ')
                        .split(/[,;|•·\u2022\u2023\u25E6\u2043]/)
                        .map(s => s.trim())
                        .filter(s => s.length > 1 && s.length < 50);
                    if (allSkills.length > 0) {
                        result.skills.categories.push({ name: 'Skills', items: allSkills });
                    }
                }
                break;

            case 'languages':
                result.languages = sectionLines.filter(l => l.length > 1 && l.length < 60);
                break;

            case 'references':
                // Simple: each reference is a few lines
                let currentRef = null;
                sectionLines.forEach(line => {
                    const refEmail = line.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
                    const refPhone = line.match(/(?:\+?\d{1,3}[\s-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/);
                    if (!currentRef || (!refEmail && !refPhone && !line.match(/^\s/) && line.length > 3 && line.length < 50 && !line.includes(','))) {
                        if (currentRef) result.references.push(currentRef);
                        currentRef = { name: line, title: '', organization: '', email: '', phone: '' };
                    } else if (refEmail) {
                        currentRef.email = refEmail[0];
                    } else if (refPhone) {
                        currentRef.phone = refPhone[0];
                    } else if (!currentRef.title) {
                        // Check if line contains @ or common org separators
                        const orgMatch = line.match(/^(.+?)\s*[@|]\s*(.+)$/);
                        if (orgMatch) {
                            currentRef.title = orgMatch[1].trim();
                            currentRef.organization = orgMatch[2].trim();
                        } else {
                            currentRef.title = line;
                        }
                    } else if (!currentRef.organization) {
                        currentRef.organization = line;
                    }
                });
                if (currentRef) result.references.push(currentRef);
                break;

            case 'certifications':
                sectionLines.forEach(line => {
                    if (line.length > 3) {
                        result.certifications.push({ name: line, issuer: '', date: '' });
                    }
                });
                break;

            case 'achievements':
                result.achievements = sectionLines
                    .map(l => l.replace(/^\s*[-\u2022\u2023\u25E6\u2043•·*>\u00d8]\s+/i, '').trim())
                    .filter(l => l.length > 3);
                break;

            case 'projects':
                parseProjectLines(sectionLines, result.projects);
                break;
        }
    });

    // If no summary was found in sections, use first paragraph-like text
    if (!result.summary && lines.length > 3) {
        const candidateLines = lines.slice(2, 8).filter(l => l.length > 80);
        if (candidateLines.length > 0) result.summary = candidateLines.join(' ');
    }

    return result;
}

function parseExperienceLines(lines, experienceArr) {
    const datePattern = /\b(?:19|20)\d{2}\b.*?(?:[-–—to]+\s*(?:(?:19|20)\d{2}|present|current|now))?/i;
    let currentJob = null;

    lines.forEach(line => {
        const hasDate = datePattern.test(line);
        const isBullet = /^\s*[-•·\u2022\u2023\u25E6\u2043*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line);

        if (hasDate && !isBullet) {
            // This is likely a job header line
            if (currentJob) experienceArr.push(currentJob);
            const dateMatch = line.match(datePattern);
            const dateStr = dateMatch ? dateMatch[0].trim() : '';
            const titleCompany = line.replace(datePattern, '').replace(/[|,]?\s*$/, '').trim();
            const parts = titleCompany.split(/\s*[|@–—]\s*|\s+at\s+/i);
            currentJob = {
                title: parts[0] || titleCompany,
                company: parts[1] || '',
                date: dateStr,
                bullets: []
            };
        } else if (isBullet && currentJob) {
            currentJob.bullets.push(line.replace(/^\s*[-•·\u2022\u2023\u25E6\u2043*]\s+/, '').replace(/^\s*\d+[.)]\s+/, ''));
        } else if (currentJob && line.length > 20 && !hasDate) {
            // Could be a continuation bullet without a bullet char
            currentJob.bullets.push(line);
        } else if (!currentJob && line.length > 5) {
            // Might be first job title without a date on same line
            currentJob = { title: line, company: '', date: '', bullets: [] };
        }
    });
    if (currentJob) experienceArr.push(currentJob);
}

function parseEducationLines(lines, educationArr) {
    const datePattern = /\b(?:19|20)\d{2}\b/;
    let currentEdu = null;

    lines.forEach(line => {
        const hasDate = datePattern.test(line);
        const isBullet = /^\s*[-•·\u2022*]\s+/.test(line);

        if ((hasDate || line.length > 10) && !isBullet && !currentEdu) {
            const dateMatch = line.match(/\b(?:19|20)\d{2}\b.*?(?:[-–—to]+\s*(?:(?:19|20)\d{2}|present|current))?/i);
            const dateStr = dateMatch ? dateMatch[0].trim() : '';
            const rest = line.replace(/\b(?:19|20)\d{2}\b.*?(?:[-–—to]+\s*(?:(?:19|20)\d{2}|present|current))?/i, '').trim();
            const parts = rest.split(/\s*[|@–—,]\s*|\s+at\s+/i);
            currentEdu = { degree: parts[0] || rest, institution: parts[1] || '', date: dateStr, details: [] };
        } else if (hasDate && !isBullet && currentEdu) {
            educationArr.push(currentEdu);
            const dateMatch = line.match(/\b(?:19|20)\d{2}\b.*?(?:[-–—to]+\s*(?:(?:19|20)\d{2}|present|current))?/i);
            const dateStr = dateMatch ? dateMatch[0].trim() : '';
            const rest = line.replace(/\b(?:19|20)\d{2}\b.*?(?:[-–—to]+\s*(?:(?:19|20)\d{2}|present|current))?/i, '').trim();
            const parts = rest.split(/\s*[|@–—,]\s*|\s+at\s+/i);
            currentEdu = { degree: parts[0] || rest, institution: parts[1] || '', date: dateStr, details: [] };
        } else if (currentEdu && line.length > 3) {
            currentEdu.details.push(line.replace(/^\s*[-•·\u2022*]\s+/, ''));
        }
    });
    if (currentEdu) educationArr.push(currentEdu);
}

function parseProjectLines(lines, projectsArr) {
    let currentProj = null;
    lines.forEach(line => {
        const isBullet = /^\s*[-•·\u2022\u2023\u25E6\u2043*]\s+/.test(line);
        if (!isBullet && line.length > 5 && line.length < 100) {
            if (currentProj) projectsArr.push(currentProj);
            currentProj = { name: line, description: '', bullets: [] };
        } else if (isBullet && currentProj) {
            currentProj.bullets.push(line.replace(/^\s*[-•·\u2022\u2023\u25E6\u2043*]\s+/, ''));
        } else if (currentProj && line.length > 10) {
            if (!currentProj.description) currentProj.description = line;
            else currentProj.bullets.push(line);
        }
    });
    if (currentProj) projectsArr.push(currentProj);
}

// =============================================
// AUTO-FIT SYSTEM — measure after render, compress to fit A4
// =============================================
const A4_PAGE_HEIGHT = 1122; // A4 at 96dpi in pixels

function hideEmptySections() {
    // Hide sections with no meaningful content (empty headings)
    const container = document.getElementById('resume-content');
    if (!container) return;

    // Check experience section
    const expSection = container.querySelector('.experience');
    if (expSection) {
        const items = expSection.querySelectorAll('.experience-item');
        expSection.classList.toggle('section-hidden', items.length === 0);
    }

    // Check education section
    const eduSection = container.querySelector('.education');
    if (eduSection) {
        const items = eduSection.querySelectorAll('.education-item');
        eduSection.classList.toggle('section-hidden', items.length === 0);
    }

    // Check skills section
    const skillsSection = container.querySelector('.skills');
    if (skillsSection) {
        const tags = skillsSection.querySelectorAll('.skill-tag');
        skillsSection.classList.toggle('section-hidden', tags.length === 0);
    }

    // Check languages section
    const langSection = container.querySelector('.languages');
    if (langSection) {
        const items = langSection.querySelectorAll('.language-item');
        langSection.classList.toggle('section-hidden', items.length === 0);
    }

    // Check references section
    const refSection = container.querySelector('.references');
    if (refSection) {
        const items = refSection.querySelectorAll('.reference-item');
        refSection.classList.toggle('section-hidden', items.length === 0);
    }

    // Check profile summary
    const summarySection = container.querySelector('.profile-summary');
    if (summarySection) {
        const text = (summarySection.querySelector('#summary-text') || summarySection.querySelector('p'));
        const isEmpty = !text || !text.textContent.trim();
        summarySection.classList.toggle('section-hidden', isEmpty);
    }

    // Check contact section
    const contactSection = container.querySelector('.contact-info');
    if (contactSection) {
        const items = contactSection.querySelectorAll('.contact-item');
        contactSection.classList.toggle('section-hidden', items.length === 0);
    }

    // Check achievements section
    const achieveSection = container.querySelector('.achievements');
    if (achieveSection) {
        const items = achieveSection.querySelectorAll('li');
        achieveSection.classList.toggle('section-hidden', items.length === 0);
    }

    // Check projects section
    const projSection = container.querySelector('.projects');
    if (projSection) {
        const items = projSection.querySelectorAll('.project-item');
        projSection.classList.toggle('section-hidden', items.length === 0);
    }
}

/**
 * autoFitResume() — Measure-after-render auto-fit system.
 * Guarantees content fits within A4 page height (1122px at 96dpi).
 * Idempotent: resets all compression before re-measuring.
 * Only runs for uploaded/imported resumes or when content overflows.
 */
function autoFitResume() {
    const container = document.getElementById('resume-content');
    if (!container) return;

    // Step 0: Reset all previous compression (idempotent)
    container.classList.remove('compact-spacing', 'compact-fonts', 'compact-content');
    container.style.transform = '';
    container.style.transformOrigin = '';

    // Restore any previously trimmed bullets
    container.querySelectorAll('[data-autofit-hidden]').forEach(el => {
        el.style.display = '';
        el.removeAttribute('data-autofit-hidden');
    });
    // Restore any truncated summary
    const summaryEl = container.querySelector('#summary-text');
    if (summaryEl && summaryEl.dataset.autofitOriginal) {
        summaryEl.textContent = summaryEl.dataset.autofitOriginal;
        delete summaryEl.dataset.autofitOriginal;
    }

    // Hide empty sections first
    hideEmptySections();

    // Only apply compression for uploaded resumes or if content actually overflows
    // The original hardcoded resume should not be affected
    if (!usingUploadedResume && container.scrollHeight <= A4_PAGE_HEIGHT) {
        return;
    }

    // Measure initial height
    let currentHeight = container.scrollHeight;
    if (currentHeight <= A4_PAGE_HEIGHT) return; // Already fits

    // Phase 1: Reduce spacing
    container.classList.add('compact-spacing');
    currentHeight = container.scrollHeight;
    if (currentHeight <= A4_PAGE_HEIGHT) return;

    // Phase 2: Reduce font sizes
    container.classList.add('compact-fonts');
    currentHeight = container.scrollHeight;
    if (currentHeight <= A4_PAGE_HEIGHT) return;

    // Phase 3: Trim content
    container.classList.add('compact-content');

    // Phase 3a: Trim achievements and projects first (less critical than experience)
    const achievementItems = container.querySelectorAll('.achievements li');
    for (let i = achievementItems.length - 1; i >= 0; i--) {
        achievementItems[i].style.display = 'none';
        achievementItems[i].setAttribute('data-autofit-hidden', 'true');
        currentHeight = container.scrollHeight;
        if (currentHeight <= A4_PAGE_HEIGHT) return;
    }
    const projectItems = container.querySelectorAll('.projects .project-item');
    for (let i = projectItems.length - 1; i >= 0; i--) {
        projectItems[i].style.display = 'none';
        projectItems[i].setAttribute('data-autofit-hidden', 'true');
        currentHeight = container.scrollHeight;
        if (currentHeight <= A4_PAGE_HEIGHT) return;
    }

    // Phase 3b: Remove experience bullets from oldest jobs first, protect recent ones
    const experienceItems = container.querySelectorAll('.experience-item');
    if (experienceItems.length > 0) {
        // Start from the last (oldest) experience and remove bullets
        for (let i = experienceItems.length - 1; i >= 0; i--) {
            const bullets = experienceItems[i].querySelectorAll('li');
            // Remove bullets from the end of each job (least important first)
            for (let j = bullets.length - 1; j >= 0; j--) {
                // Keep at least 2 bullets for the most recent job, 1 for others
                const minBullets = (i === 0) ? 2 : 1;
                if (j < minBullets) break;
                bullets[j].style.display = 'none';
                bullets[j].setAttribute('data-autofit-hidden', 'true');
                currentHeight = container.scrollHeight;
                if (currentHeight <= A4_PAGE_HEIGHT) return;
            }
            // If we've trimmed bullets and still need space,
            // hide entire oldest job entries (never hide the 2 most recent)
            if (i >= 2 && experienceItems.length > 2) {
                experienceItems[i].style.display = 'none';
                experienceItems[i].setAttribute('data-autofit-hidden', 'true');
                currentHeight = container.scrollHeight;
                if (currentHeight <= A4_PAGE_HEIGHT) return;
            }
        }

        // Collapse skill categories — hide overflow skill tags
        const skillCategories = container.querySelectorAll('.skill-category');
        skillCategories.forEach(cat => {
            const tags = cat.querySelectorAll('.skill-tag');
            for (let t = tags.length - 1; t >= 6; t--) {
                tags[t].style.display = 'none';
                tags[t].setAttribute('data-autofit-hidden', 'true');
            }
        });
        currentHeight = container.scrollHeight;
        if (currentHeight <= A4_PAGE_HEIGHT) return;

        // Truncate summary
        if (summaryEl && summaryEl.textContent.length > 150) {
            summaryEl.dataset.autofitOriginal = summaryEl.textContent;
            const words = summaryEl.textContent.split(/\s+/);
            // Binary search for the right length
            let lo = 10, hi = words.length;
            while (lo < hi) {
                const mid = Math.floor((lo + hi + 1) / 2);
                summaryEl.textContent = words.slice(0, mid).join(' ') + '...';
                if (container.scrollHeight <= A4_PAGE_HEIGHT) {
                    lo = mid;
                } else {
                    hi = mid - 1;
                }
            }
            summaryEl.textContent = words.slice(0, lo).join(' ') + '...';
            currentHeight = container.scrollHeight;
            if (currentHeight <= A4_PAGE_HEIGHT) return;
        }
    }

    // Phase 4: Scale transform as absolute last resort (minimum 0.8)
    currentHeight = container.scrollHeight;
    if (currentHeight > A4_PAGE_HEIGHT) {
        let scale = A4_PAGE_HEIGHT / currentHeight;
        if (scale < 0.8) scale = 0.8;
        container.style.transform = `scale(${scale})`;
        container.style.transformOrigin = 'top center';
    }
}

// =============================================
// APPLY PARSED RESUME TO UI
// Completely replaces ALL content — no original data leaks through
// =============================================
function applyParsedResumeToUI(resume) {
    lastAppliedResume = resume;
    // --- SIDEBAR ---
    // Name & Title
    const nameEl = document.querySelector('.profile h1');
    const titleEl = document.querySelector('.profile h3');
    if (nameEl) nameEl.textContent = resume.name || 'Name Not Found';
    if (titleEl) titleEl.textContent = resume.title || '';

    // Profile image initials
    const initialsSpan = document.querySelector('.profile-img span');
    if (initialsSpan && resume.name) {
        const parts = resume.name.trim().split(/\s+/);
        initialsSpan.textContent = parts.map(p => p[0]).join('').substring(0, 2).toUpperCase();
    }
    // Hide any previously uploaded profile picture
    const profilePic = document.getElementById('profile-picture');
    if (profilePic) { profilePic.style.display = 'none'; profilePic.src = ''; }
    if (initialsSpan) initialsSpan.style.display = '';

    // Contact
    updateContactSection(resume.contact || {});

    // Skills — support both old format {technical:[], marketing:[]} and new {categories:[{name, items}]}
    if (resume.skills) updateSkillsSection(resume.skills);

    // Languages
    updateLanguagesSection(resume.languages || []);

    // References
    updateReferencesSection(resume.references || []);

    // --- MAIN CONTENT ---
    // Summary
    const summaryEl = document.getElementById('summary-text');
    if (summaryEl) summaryEl.textContent = resume.summary || '';

    // Experience — fully dynamic, replaces all experience items
    updateExperienceSection(resume.experience || []);

    // Education + Certifications — fully dynamic
    updateEducationSection(resume.education || [], resume.certifications || []);

    // Achievements
    updateAchievementsSection(resume.achievements || []);

    // Projects
    updateProjectsSection(resume.projects || []);
}

// =============================================
// SECTION UPDATERS (all fully replace their content)
// =============================================
function updateSkillsSection(skills) {
    const container = document.querySelector('.skills .skills-container');
    if (!container) return;
    container.innerHTML = '';

    let categories = [];

    // Handle new format: { categories: [{name, items}] }
    if (skills.categories && Array.isArray(skills.categories)) {
        categories = skills.categories;
    } else {
        // Handle old/flat format: { technical: [], marketing: [], ... }
        for (const [key, val] of Object.entries(skills)) {
            if (key === 'categories') continue;
            const items = ensureArray(val);
            if (items.length > 0) {
                // Convert key to readable name
                const name = key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
                categories.push({ name, items });
            }
        }
    }

    categories.forEach(cat => {
        const items = ensureArray(cat.items);
        if (items.length === 0) return;
        const div = document.createElement('div');
        div.className = 'skill-category';
        div.innerHTML = `<h4>${escapeHTML(cat.name || 'Skills')}</h4>`;
        items.forEach(s => {
            const tag = document.createElement('div');
            tag.className = 'skill-tag';
            tag.textContent = s;
            div.appendChild(tag);
        });
        container.appendChild(div);
    });
}

// Sprint 3: Add missing keywords as skill tags
// Only adds keywords that aren't already present in ANY skill-tag (normalized+stemmed match)
function addKeywordsToSkillsSection(missingKeywords) {
    const container = document.querySelector('.skills .skills-container');
    if (!container) return;

    // Build set of already-present skill stems
    const existingStems = new Set();
    container.querySelectorAll('.skill-tag').forEach(tag => {
        normalizeAndStem(tag.textContent).split(' ').forEach(w => existingStems.add(w));
    });

    // Filter to keywords genuinely absent from skills
    const toAdd = missingKeywords.filter(k => {
        const stemWords = normalizeAndStem(k).split(' ').filter(Boolean);
        // Consider present if ALL words in the keyword stem are already in the skills
        return !stemWords.every(w => existingStems.has(w));
    });

    if (toAdd.length === 0) return;

    // Find the best target category: prefer last category (usually "General" or broadest)
    // Fall back to creating a new "Key Skills" category
    let targetCategory = container.querySelector('.skill-category:last-child');
    if (!targetCategory) {
        targetCategory = document.createElement('div');
        targetCategory.className = 'skill-category';
        targetCategory.innerHTML = '<h4>Key Skills</h4>';
        container.appendChild(targetCategory);
    }

    toAdd.forEach(k => {
        const tag = document.createElement('div');
        tag.className = 'skill-tag';
        tag.textContent = k;
        targetCategory.appendChild(tag);
    });
}

// Sprint 4: Diff view — collect pending diffs, render review panel, apply on accept
// pendingDiffs is declared at module scope above
function collectDiffs(sectionQueue, sectionResults) {
    const diffs = [];
    sectionQueue.forEach((section, idx) => {
        const result = sectionResults[idx];
        if (!result || !Array.isArray(result.enhancements)) return;
        const label = `${section.jobTitle}${section.company ? ' @ ' + section.company : ''}`;
        result.enhancements.forEach(e => {
            if (e.original && e.enhanced && e.original.trim() !== e.enhanced.trim()) {
                diffs.push({ sectionId: section.sectionId, ul: section.ul, original: e.original, enhanced: e.enhanced, sectionLabel: label });
            }
        });
    });
    return diffs;
}

function renderDiffView(diffs) {
    const panel = document.getElementById('diff-view-panel');
    const container = document.getElementById('diff-items-container');
    if (!diffs.length) { panel.style.display = 'none'; return; }

    container.innerHTML = '';
    diffs.forEach((diff, idx) => {
        const item = document.createElement('div');
        item.className = 'diff-item';
        item.dataset.idx = idx;
        item.innerHTML = `
            <div class="diff-section-label">${escapeHTML(diff.sectionLabel)}</div>
            <div class="diff-original">&#x2212; ${escapeHTML(diff.original)}</div>
            <div class="diff-enhanced">&#x2b; ${escapeHTML(diff.enhanced)}</div>
            <div class="diff-item-actions">
                <button class="diff-accept" data-idx="${idx}">Accept</button>
                <button class="diff-reject" data-idx="${idx}">Reject</button>
            </div>`;
        container.appendChild(item);
    });

    panel.style.display = 'block';
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ulBulletMaps: per-ul cache so Accept All doesn't rebuild the map on every diff
// Maps ul element → Map<hash, li>. Invalidated on each new optimization run.
let ulBulletMaps = new WeakMap();

function getOrBuildBulletMap(ul) {
    if (!ulBulletMaps.has(ul)) {
        ulBulletMaps.set(ul, buildBulletMap(ul));
    }
    return ulBulletMaps.get(ul);
}

function applyDiff(idx) {
    const diff = pendingDiffs[idx];
    if (!diff) return false;
    const ul = diff.ul;
    if (!ul) return false;
    const bulletMap = getOrBuildBulletMap(ul);
    const hash = djb2Hash(diff.original.trim());
    const li = bulletMap.get(hash);
    if (li) {
        // Update the DOM
        li.textContent = diff.enhanced;
        // Keep the map consistent: swap old hash for new so later diffs
        // in the same ul still resolve correctly if they reference this bullet
        bulletMap.delete(hash);
        bulletMap.set(djb2Hash(diff.enhanced.trim()), li);
        return true;
    }
    return false;
}

// Collapse diff panel and re-highlight all integrated keywords
async function finaliseDiffs() {
    const panel = document.getElementById('diff-view-panel');

    // Re-run highlights on the updated resume DOM (applied bullets now have new text)
    hideHighlights(); // clear any old spans' inline styles first
    if (extractedKeywords.length > 0) {
        highlightExistingKeywords(extractedKeywords);
        showHighlightsManually();
        highlightsVisible = true;
        document.getElementById('toggle-highlights').textContent = 'Hide Highlights';
    }

    // Collapse the diff panel with CSS transition
    panel.classList.add('collapsing');
    await new Promise(resolve => setTimeout(resolve, 420)); // wait for transition
    panel.style.display = 'none';
    panel.classList.remove('collapsing');

    // Update keyword status + match score
    if (extractedKeywords.length > 0) {
        const updated = await analyzeKeywordIntegration(extractedKeywords);
        displayKeywordStatus(updated);
        renderMatchScoreUI(updated);
    }
}

// Wire diff accept/reject click handlers (individual items)
document.getElementById('diff-items-container').addEventListener('click', function(e) {
    const btn = e.target.closest('.diff-accept, .diff-reject');
    if (!btn) return;
    const idx = parseInt(btn.dataset.idx, 10);
    const item = document.querySelector(`.diff-item[data-idx="${idx}"]`);
    if (btn.classList.contains('diff-accept')) {
        applyDiff(idx);
        item.classList.add('accepted');
    } else {
        item.classList.add('rejected');
    }
    // If every diff is now resolved, collapse the panel and show highlights
    const allResolved = [...document.querySelectorAll('.diff-item')]
        .every(el => el.classList.contains('accepted') || el.classList.contains('rejected'));
    if (allResolved) finaliseDiffs();
});

// Accept All — async with rAF yield between batches to avoid UI freeze
document.getElementById('diff-accept-all').addEventListener('click', async function() {
    const btn = this;
    const rejectBtn = document.getElementById('diff-reject-all');
    const pending = pendingDiffs
        .map((_, idx) => idx)
        .filter(idx => {
            const item = document.querySelector(`.diff-item[data-idx="${idx}"]`);
            return item && !item.classList.contains('accepted') && !item.classList.contains('rejected');
        });

    if (pending.length === 0) return;

    // Disable buttons + show progress
    btn.disabled = true;
    rejectBtn.disabled = true;
    btn.textContent = `Applying 0/${pending.length}...`;

    const BATCH = 5; // process 5 diffs per frame to stay responsive
    for (let i = 0; i < pending.length; i += BATCH) {
        const slice = pending.slice(i, i + BATCH);
        slice.forEach(idx => {
            const item = document.querySelector(`.diff-item[data-idx="${idx}"]`);
            if (item) {
                applyDiff(idx);
                item.classList.add('accepted');
            }
        });
        btn.textContent = `Applying ${Math.min(i + BATCH, pending.length)}/${pending.length}...`;
        await new Promise(resolve => requestAnimationFrame(resolve));
    }

    btn.textContent = `✓ All Applied`;
    btn.disabled = false;
    rejectBtn.disabled = false;

    await finaliseDiffs();
});

document.getElementById('diff-reject-all').addEventListener('click', async function() {
    document.querySelectorAll('.diff-item:not(.accepted):not(.rejected)').forEach(item => {
        item.classList.add('rejected');
    });
    await finaliseDiffs();
});

// Sprint 5: Job Match Score
// Tier weights: title/role keywords > hard skills > soft skills > general terms
function classifyKeywordTier(keyword) {
    const k = keyword.toLowerCase();
    // Hard skills — tools, technologies, methodologies
    if (/\b(python|java|sql|crm|salesforce|monday|hubspot|jira|excel|powerbi|tableau|api|saas|erp|aws|azure|gcp|agile|scrum|linkedin|seo|ppc|kpi|roi|b2b|b2c|mrr|arr|pipeline|quota)\b/.test(k)) return 'hard';
    // Soft skills — interpersonal
    if (/\b(communicat|collaborat|leadership|team|problem.solv|negotiat|present|relationship|empathy|adaptab|organiz)\b/.test(k)) return 'soft';
    return 'general';
}

function calculateJobMatchScore(analysis) {
    if (!analysis || analysis.totalKeywords === 0) return null;
    const tierWeights = { hard: 3, soft: 1.5, general: 1 };
    let totalWeight = 0;
    let earnedWeight = 0;
    const breakdown = { hard: { total: 0, included: 0 }, soft: { total: 0, included: 0 }, general: { total: 0, included: 0 } };

    [...analysis.includedKeywords, ...analysis.missingKeywords].forEach(k => {
        const tier = classifyKeywordTier(k);
        const w = tierWeights[tier];
        totalWeight += w;
        breakdown[tier].total++;
        if (analysis.includedKeywords.includes(k)) {
            earnedWeight += w;
            breakdown[tier].included++;
        }
    });

    const score = totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0;

    let tier, color;
    if (score >= 85) { tier = 'Excellent Match'; color = '#27ae60'; }
    else if (score >= 65) { tier = 'Good Match'; color = '#2980b9'; }
    else if (score >= 45) { tier = 'Partial Match'; color = '#f39c12'; }
    else { tier = 'Low Match'; color = '#e74c3c'; }

    return { score, tier, color, breakdown };
}

function renderMatchScoreUI(analysis) {
    const result = calculateJobMatchScore(analysis);
    const panel = document.getElementById('match-score-panel');
    if (!result) { panel.style.display = 'none'; return; }

    document.getElementById('match-score-value').textContent = `${result.score}%`;
    document.getElementById('match-score-value').style.color = result.color;
    document.getElementById('match-score-tier').textContent = result.tier;
    document.getElementById('match-score-tier').style.color = result.color;
    document.getElementById('match-score-bar').style.width = `${result.score}%`;
    document.getElementById('match-score-bar').style.background = result.color;

    const bd = result.breakdown;
    document.getElementById('match-score-breakdown').innerHTML =
        `Hard skills: ${bd.hard.included}/${bd.hard.total} &nbsp;|&nbsp; ` +
        `Soft skills: ${bd.soft.included}/${bd.soft.total} &nbsp;|&nbsp; ` +
        `General: ${bd.general.included}/${bd.general.total}`;

    panel.style.display = 'block';
}

function updateExperienceSection(experiences) {
    const expContainer = document.querySelector('.experience');
    if (!expContainer) return;
    // Remove all existing experience items but keep the H2
    expContainer.querySelectorAll('.experience-item').forEach(e => e.remove());

    const expArray = ensureArray(experiences);
    expArray.forEach((exp, idx) => {
        if (!exp || typeof exp !== 'object') return;
        const bullets = ensureArray(exp.bullets);
        const div = document.createElement('div');
        div.className = 'experience-item';
        div.innerHTML = `<div class="job-header"><div><span class="job-title">${escapeHTML(exp.title || '')}</span><span class="company"> | ${escapeHTML(exp.company || '')}</span></div><div class="date">${escapeHTML(exp.date || '')}</div></div><ul id="exp-${idx}" class="editable-list">${bullets.map(b => `<li>${escapeHTML(b)}</li>`).join('')}</ul>`;
        expContainer.appendChild(div);
    });
}

function updateEducationSection(educations, certifications) {
    const eduContainer = document.querySelector('.education');
    if (!eduContainer) return;
    eduContainer.querySelectorAll('.education-item').forEach(e => e.remove());

    const eduArray = ensureArray(educations);
    eduArray.forEach((edu, idx) => {
        if (!edu || typeof edu !== 'object') return;
        const details = ensureArray(edu.details);
        const div = document.createElement('div');
        div.className = 'education-item';
        div.innerHTML = `<div class="education-header"><div><span class="degree">${escapeHTML(edu.degree || '')}</span><span class="company"> | ${escapeHTML(edu.institution || '')}</span></div><div class="date">${escapeHTML(edu.date || '')}</div></div>${details.length ? `<ul>${details.map(d => `<li>${escapeHTML(d)}</li>`).join('')}</ul>` : ''}`;
        eduContainer.appendChild(div);
    });

    // Append certifications as education items
    const certArray = ensureArray(certifications);
    certArray.forEach(cert => {
        if (!cert || typeof cert !== 'object') return;
        const div = document.createElement('div');
        div.className = 'education-item';
        div.innerHTML = `<div class="education-header"><div><span class="degree">${escapeHTML(cert.name || '')}</span><span class="company"> | ${escapeHTML(cert.issuer || '')}</span></div><div class="date">${escapeHTML(cert.date || '')}</div></div>`;
        eduContainer.appendChild(div);
    });
}

function updateLanguagesSection(languages) {
    const langContainer = document.querySelector('.languages');
    if (!langContainer) return;
    langContainer.querySelectorAll('.language-item').forEach(e => e.remove());
    const langArray = ensureArray(languages);
    if (langArray.length === 0) {
        // Hide the section if no languages
        langContainer.style.display = 'none';
        return;
    }
    langContainer.style.display = '';
    langArray.forEach(l => {
        const div = document.createElement('div');
        div.className = 'language-item';
        div.innerHTML = `<div>${escapeHTML(typeof l === 'string' ? l : JSON.stringify(l))}</div>`;
        langContainer.appendChild(div);
    });
}

function updateReferencesSection(references) {
    const refContainer = document.querySelector('.references');
    if (!refContainer) return;
    refContainer.querySelectorAll('.reference-item').forEach(e => e.remove());
    const refArray = ensureArray(references);
    if (refArray.length === 0) {
        // Show "Available upon request" instead of nothing
        const div = document.createElement('div');
        div.className = 'reference-item';
        div.innerHTML = `<div style="font-size: 10px; color: rgba(255,255,255,0.7);">Available upon request</div>`;
        refContainer.appendChild(div);
        return;
    }
    refArray.forEach(ref => {
        if (!ref || typeof ref !== 'object') return;
        const div = document.createElement('div');
        div.className = 'reference-item';
        let html = `<div class="reference-name">${escapeHTML(ref.name || '')}</div>`;
        if (ref.title && ref.organization) {
            html += `<div class="reference-title">${escapeHTML(ref.title)} @ ${escapeHTML(ref.organization)}</div>`;
        } else if (ref.title) {
            html += `<div class="reference-title">${escapeHTML(ref.title)}</div>`;
        } else if (ref.organization) {
            html += `<div class="reference-title">${escapeHTML(ref.organization)}</div>`;
        }
        if (ref.email) html += `<div class="reference-contact"><span class="reference-icon"><i class="fas fa-envelope"></i></span><span>${escapeHTML(ref.email)}</span></div>`;
        if (ref.phone) html += `<div class="reference-contact"><span class="reference-icon"><i class="fas fa-phone"></i></span><span>${escapeHTML(ref.phone)}</span></div>`;
        div.innerHTML = html;
        refContainer.appendChild(div);
    });
}

function updateContactSection(contact) {
    const contactContainer = document.querySelector('.contact-info');
    if (!contactContainer) return;
    contactContainer.querySelectorAll('.contact-item').forEach(i => i.remove());

    const fields = [
        { icon: 'fas fa-envelope', val: contact.email },
        { icon: 'fas fa-phone', val: contact.phone },
        { icon: 'fas fa-map-marker-alt', val: contact.location },
        { icon: 'fab fa-linkedin', val: contact.linkedin, isLink: true },
        { icon: 'fas fa-globe', val: contact.website, isLink: true },
        { icon: 'fas fa-folder-open', val: contact.portfolio, isLink: true }
    ];

    fields.forEach(f => {
        if (!f.val) return;
        const div = document.createElement('div');
        div.className = 'contact-item';
        if (f.isLink) {
            const href = sanitizeUrl(f.val);
            div.innerHTML = `<span class="contact-icon"><i class="${f.icon}"></i></span><a href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer" class="contact-link">${escapeHTML(f.val)}</a>`;
        } else {
            div.innerHTML = `<span class="contact-icon"><i class="${f.icon}"></i></span><span>${escapeHTML(f.val)}</span>`;
        }
        contactContainer.appendChild(div);
    });
}

function updateAchievementsSection(achievements) {
    const container = document.querySelector('.achievements');
    if (!container) return;
    container.querySelectorAll('ul, li').forEach(e => e.remove());
    const arr = ensureArray(achievements);
    if (arr.length === 0) return;
    const ul = document.createElement('ul');
    arr.forEach(a => {
        const li = document.createElement('li');
        li.textContent = typeof a === 'string' ? a : JSON.stringify(a);
        ul.appendChild(li);
    });
    container.appendChild(ul);
}

function updateProjectsSection(projects) {
    const container = document.querySelector('.projects');
    if (!container) return;
    container.querySelectorAll('.project-item').forEach(e => e.remove());
    const arr = ensureArray(projects);
    if (arr.length === 0) return;
    arr.forEach((proj, idx) => {
        if (!proj || typeof proj !== 'object') return;
        const bullets = ensureArray(proj.bullets);
        const div = document.createElement('div');
        div.className = 'project-item experience-item';
        let html = `<div class="job-header"><div><span class="job-title">${escapeHTML(proj.name || '')}</span></div></div>`;
        if (proj.description) html += `<p style="font-size:10px;margin-bottom:4px;">${escapeHTML(proj.description)}</p>`;
        if (bullets.length > 0) html += `<ul class="editable-list">${bullets.map(b => `<li>${escapeHTML(b)}</li>`).join('')}</ul>`;
        div.innerHTML = html;
        container.appendChild(div);
    });
}

// =============================================
// PROFILE PICTURE HANDLER
// =============================================
function handleProfilePicChange(e) {
    if (e.target.files[0]) {
        const reader = new FileReader();
        reader.onload = function(ev) {
            const img = document.getElementById('profile-picture');
            img.src = ev.target.result;
            img.style.display = 'block';
            document.querySelector('.profile-img span').style.display = 'none';
        };
        reader.readAsDataURL(e.target.files[0]);
    }
}

document.querySelector('.profile-img').addEventListener('click', () => document.getElementById('file-input').click());
document.getElementById('file-input').addEventListener('change', handleProfilePicChange);
hideHighlights();

// =============================================
// SECRET REVERT: Cmd+Shift+Z (Mac) / Ctrl+Shift+Z (Win/Linux)
// =============================================
document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Z') {
        e.preventDefault();
        revertToHardcodedDefault();
    }
});

// =============================================
// STARTUP: load saved default if present
// =============================================
function loadDefaultOnStartup() {
    const raw = localStorage.getItem(SAVED_DEFAULT_KEY);
    if (!raw) return;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        console.warn('resumeDefault in localStorage was corrupted — clearing.', e);
        localStorage.removeItem(SAVED_DEFAULT_KEY);
        return;
    }
    if (!parsed || parsed.version !== SAVED_DEFAULT_VERSION || !parsed.data) {
        console.warn('resumeDefault version mismatch or missing data — clearing.');
        localStorage.removeItem(SAVED_DEFAULT_KEY);
        return;
    }
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    if (parsed.savedAt && (Date.now() - parsed.savedAt) > THIRTY_DAYS_MS) {
        console.warn('resumeDefault expired (>30 days) — clearing.');
        localStorage.removeItem(SAVED_DEFAULT_KEY);
        return;
    }
    applyParsedResumeToUI(parsed.data);
    usingUploadedResume = true;
    document.getElementById('upload-status').innerHTML = '<span style="color:#27ae60;">✓ Loaded your saved default resume</span>';
    requestAnimationFrame(async () => {
        await document.fonts.ready;
        autoFitResume();
    });
}
loadDefaultOnStartup();
initApiKey();
