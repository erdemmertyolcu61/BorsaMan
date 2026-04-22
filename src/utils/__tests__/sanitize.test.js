/**
 * sanitize.js XSS-hardening contract tests.
 *
 * Any regression that allows <script>, onerror=..., or javascript: URLs
 * to slip through would re-open the XSS holes that v9 closed — so we
 * verify both the DOMPurify path (jsdom env) and the entity-escape fallback.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeHTML, renderSafeMarkdown, sanitizeText } from '../sanitize.js';

describe('sanitizeHTML', () => {
  it('returns "" for null/undefined', () => {
    expect(sanitizeHTML(null)).toBe('');
    expect(sanitizeHTML(undefined)).toBe('');
  });
  it('strips <script> tags', () => {
    const out = sanitizeHTML('<p>ok</p><script>alert(1)</script>');
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out.toLowerCase()).not.toContain('alert(1)');
  });
  it('strips event-handler attributes', () => {
    const out = sanitizeHTML('<b onclick="alert(1)">x</b>');
    expect(out.toLowerCase()).not.toContain('onclick');
  });
  it('keeps whitelisted bold/italic/code/paragraph tags', () => {
    const out = sanitizeHTML('<b>a</b><i>b</i><code>c</code><p>d</p>');
    expect(out).toMatch(/<b>a<\/b>/);
    expect(out).toMatch(/<i>b<\/i>/);
    expect(out).toMatch(/<code>c<\/code>/);
  });
});

describe('renderSafeMarkdown', () => {
  it('escapes raw HTML before re-injecting the tiny markdown whitelist', () => {
    const out = renderSafeMarkdown('<script>x</script> **bold**');
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out).toMatch(/<b>bold<\/b>/);
  });
  it('converts **bold**, *italic*, `code`, and \\n to tags', () => {
    const out = renderSafeMarkdown('**x**\n*y*\n`z`');
    expect(out).toMatch(/<b>x<\/b>/);
    expect(out).toMatch(/<i>y<\/i>/);
    expect(out).toMatch(/<code>z<\/code>/);
    expect(out).toMatch(/<br\/?>/);
  });
  it('escapes anchor tags rather than rendering a live href', () => {
    const out = renderSafeMarkdown('<a href="javascript:alert(1)">x</a>');
    // Whole tag must be entity-escaped — no live <a> in the output
    expect(out).not.toMatch(/<a\s/i);
    expect(out).toMatch(/&lt;a/);
  });
});

describe('sanitizeText', () => {
  it('drops ALL tags, keeping textual content', () => {
    const out = sanitizeText('<b>Hello</b> <script>bad()</script> World');
    expect(out.toLowerCase()).not.toContain('<');
    expect(out).toMatch(/Hello/);
    expect(out).toMatch(/World/);
    expect(out).not.toMatch(/bad\(\)/);
  });
  it('handles null/undefined', () => {
    expect(sanitizeText(null)).toBe('');
  });
});
