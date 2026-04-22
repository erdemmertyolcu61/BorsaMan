/**
 * sanitize.js — XSS-hardening wrapper around DOMPurify.
 *
 * Used for any user-visible content sourced from untrusted feeds:
 *   • Claude AI responses (markdown-lite rendering)
 *   • News/RSS items (title, summary, body)
 *   • KAP disclosures (company announcements)
 *
 * Falls back to a strict entity-escape if DOMPurify is not bundled
 * (e.g. during a unit test run without jsdom), so the app never
 * silently renders raw HTML.
 */

import DOMPurify from 'dompurify';

const SAFE_TAGS = ['b', 'strong', 'i', 'em', 'u', 'br', 'p', 'ul', 'ol', 'li', 'code', 'pre', 'span', 'a'];
const SAFE_ATTR = ['href', 'title', 'target', 'rel'];

function escapeEntities(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sanitize raw HTML for safe injection via dangerouslySetInnerHTML.
 * Strips <script>, event handlers, javascript: URLs, iframes, etc.
 */
export function sanitizeHTML(dirty) {
  if (dirty == null) return '';
  const input = String(dirty);
  try {
    if (DOMPurify && typeof DOMPurify.sanitize === 'function') {
      return DOMPurify.sanitize(input, {
        ALLOWED_TAGS: SAFE_TAGS,
        ALLOWED_ATTR: SAFE_ATTR,
        FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
        ALLOW_DATA_ATTR: false,
      });
    }
  } catch { /* fall through */ }
  return escapeEntities(input);
}

/**
 * Render minimal markdown (bold + line breaks) from untrusted text.
 * Entities are escaped FIRST, then a tiny whitelist is re-injected,
 * then DOMPurify does a final scrub.
 */
export function renderSafeMarkdown(text) {
  const escaped = escapeEntities(text)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.+?)\*/g, '<i>$1</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br/>');
  return sanitizeHTML(escaped);
}

/** Plain-text scrubber — drops ALL tags. Use for news titles, KAP summaries. */
export function sanitizeText(dirty) {
  if (dirty == null) return '';
  try {
    if (DOMPurify && typeof DOMPurify.sanitize === 'function') {
      return DOMPurify.sanitize(String(dirty), { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
    }
  } catch { /* fall through */ }
  return escapeEntities(dirty).replace(/&lt;[^&]*&gt;/g, '');
}
