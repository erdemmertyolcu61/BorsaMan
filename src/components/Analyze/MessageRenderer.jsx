import { memo } from 'react';
import { renderSafeMarkdown } from '../../utils/sanitize.js';
import { extractTechGrid, TechMiniGrid } from './ChatPanel.jsx';

/**
 * MessageRenderer — Single chat bubble (user OR AI).
 *
 * Extracted from ChatPanel.jsx to enforce SRP. The parent owns:
 *   • the message list + scroll container
 *   • the input form + keyboard bindings
 *   • the AI plumbing (memory, prompts, Claude calls)
 *
 * This file owns ONLY the visual rendering of one message, and is memoized
 * so a 40-message transcript no longer re-renders every bubble when the
 * user types a character in the input box.
 */
function MessageRenderer({ msg }) {
  const isUser = msg.role === 'user';
  const isError = !!msg.error;
  const grid = !isUser && !isError ? extractTechGrid(msg.text) : null;

  const bg = isUser ? 'rgba(99,102,241,.18)' : isError ? 'rgba(239,68,68,.15)' : 'var(--bg3)';
  const border = isUser ? 'rgba(99,102,241,.25)' : isError ? 'rgba(239,68,68,.3)' : 'var(--border)';
  const gradeColor = msg.grade === 'A' ? 'var(--green)'
    : msg.grade === 'B' ? 'var(--cyan)'
    : msg.grade === 'C' ? 'var(--orange)' : 'var(--red)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start' }}>
      <div style={{
        maxWidth: '90%',
        padding: '10px 14px',
        borderRadius: 12,
        fontSize: 11,
        lineHeight: 1.6,
        background: bg,
        color: 'var(--t1)',
        border: '1px solid ' + border,
        borderBottomRightRadius: isUser ? 3 : 12,
        borderBottomLeftRadius: msg.role === 'ai' ? 3 : 12,
      }}>
        {grid && <TechMiniGrid data={grid} />}
        <div dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(msg.text) }} />
      </div>
      <span style={{ fontSize: 8, color: 'var(--t3)', marginTop: 3 }}>
        {msg.time} {msg.expert ? '· UZMAN' : msg.auto ? '· oto' : ''} {msg.offline ? '· OFFLINE' : ''}
        {msg.grade && <b style={{ marginLeft: 6, color: gradeColor }}>[{msg.grade}]</b>}
      </span>
    </div>
  );
}

// Memoize by message identity — chat bubble only re-renders if its own content changes.
export default memo(MessageRenderer, (prev, next) => {
  const a = prev.msg, b = next.msg;
  return a.text === b.text
    && a.role === b.role
    && a.error === b.error
    && a.grade === b.grade
    && a.time === b.time;
});
