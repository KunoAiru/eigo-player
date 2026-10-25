export const $ = (id) => document.getElementById(id);

export const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

export const norm = (s) => (s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
