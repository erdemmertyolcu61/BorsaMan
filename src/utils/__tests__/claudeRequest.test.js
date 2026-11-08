/**
 * The Claude request shape (v31.46).
 *
 * JARVIS ran on claude-sonnet-4-20250514, which was retired on 2026-06-15: every
 * request failed upstream from then on. Claude Opus 5.5 rejects parts of the old
 * request surface with a 400 — sampling parameters, disabled thinking — and spends
 * part of max_tokens on (always-on) thinking. These tests lock the shape that works.
 */
import { describe, it, expect } from 'vitest';
import {
  buildClaudeRequest, readClaudeResponse, CLAUDE_MODEL, CLAUDE_BETA,
  THINKING_HEADROOM, WEB_SEARCH_TOOL_TYPE, webSearchTool,
} from '../claude.js';

describe('buildClaudeRequest', () => {
  it('targets Claude Opus 5.5 and never sends sampling parameters', () => {
    const { payload } = buildClaudeRequest({ prompt: 'merhaba', temperature: 0.6 });
    expect(CLAUDE_MODEL).toBe('claude-opus-5-5');
    expect(payload.model).toBe('claude-opus-5-5');
    for (const k of ['temperature', 'top_p', 'top_k', 'thinking']) expect(payload).not.toHaveProperty(k);
  });

  // Opus 5.5 defaults to "medium" — an omitted effort would silently change cost
  // and latency, so every request carries one.
  it('always sets an explicit effort, defaulting to medium', () => {
    expect(buildClaudeRequest({ prompt: 'x' }).payload.output_config.effort).toBe('medium');
    expect(buildClaudeRequest({ prompt: 'x', effort: 'low' }).payload.output_config.effort).toBe('low');
    expect(buildClaudeRequest({ prompt: 'x', effort: 'bogus' }).payload.output_config.effort).toBe('medium');
  });

  it('keeps a structured-output format alongside the effort', () => {
    const format = { type: 'json_schema', schema: { type: 'object' } };
    const { payload } = buildClaudeRequest({ prompt: 'x', outputConfig: { format } });
    expect(payload.output_config).toEqual({ format, effort: 'medium' });
  });

  // Thinking counts toward max_tokens: a 1,200 reply budget sized for Sonnet 4
  // would be eaten by reasoning and come back empty.
  it('adds thinking headroom on top of the reply budget', () => {
    expect(buildClaudeRequest({ prompt: 'x', maxTokens: 1200, effort: 'low' }).payload.max_tokens)
      .toBe(1200 + THINKING_HEADROOM.low);
    expect(buildClaudeRequest({ prompt: 'x', maxTokens: 1600, effort: 'medium' }).payload.max_tokens)
      .toBe(1600 + THINKING_HEADROOM.medium);
  });

  it('opts into server-side refusal fallbacks with the matching beta header', () => {
    const { payload, headers } = buildClaudeRequest({ prompt: 'x' });
    expect(payload.fallbacks).toBe('default');
    expect(headers['anthropic-beta']).toBe(CLAUDE_BETA);
    expect(CLAUDE_BETA).toBe('server-side-fallback-2026-07-01');
  });

  it('wraps a single prompt as one user turn and passes history through untouched', () => {
    expect(buildClaudeRequest({ prompt: 'soru' }).payload.messages).toEqual([{ role: 'user', content: 'soru' }]);
    const history = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }];
    expect(buildClaudeRequest({ messages: history }).payload.messages).toBe(history);
  });

  it('uses the current web search tool version', () => {
    expect(WEB_SEARCH_TOOL_TYPE).toBe('web_search_20260209');
    const { payload } = buildClaudeRequest({ prompt: 'x', tools: [webSearchTool(3)] });
    expect(payload.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }]);
    expect(buildClaudeRequest({ prompt: 'x' }).payload).not.toHaveProperty('tools');
  });
});

describe('readClaudeResponse', () => {
  // A response can open with (empty) thinking blocks before the text.
  it('reads text by block type, skipping thinking blocks', () => {
    const data = {
      stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Merhaba' }, { type: 'text', text: 'dunya' }],
    };
    expect(readClaudeResponse(data).text).toBe('Merhaba\ndunya');
  });

  it('turns a classifier decline into an explicit error, not an empty answer', () => {
    const res = readClaudeResponse({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] });
    expect(res.error).toMatch(/guvenlik/);
    expect(res.error).toMatch(/cyber/);
  });

  it('reports a reply cut off by max_tokens when nothing came back', () => {
    expect(readClaudeResponse({ stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '' }] }).error)
      .toMatch(/token/);
    // partial text is still useful — keep it
    expect(readClaudeResponse({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'yarim' }] }).text)
      .toBe('yarim');
  });
});
