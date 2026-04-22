// ErrorBoundary.jsx — Minimal, zero-dep React error boundary.
// Wrap failure-prone subtrees (Chart, ChatPanel, AIAdvisorPanel) to keep the
// rest of the Electron app alive if one widget crashes.

import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null, key: 0 };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    try {
      console.error('[ErrorBoundary]', this.props.name || 'component', error, info?.componentStack);
      this.props.onError?.(error, info);
    } catch {}
  }

  reset = () => {
    this.setState(s => ({ error: null, info: null, key: s.key + 1 }));
  };

  render() {
    const { error } = this.state;
    if (!error) {
      // key bump forces remount of children on reset
      return <div key={this.state.key} style={{ display: 'contents' }}>{this.props.children}</div>;
    }

    if (this.props.fallback) {
      return this.props.fallback(error, this.reset);
    }

    const label = this.props.name || 'Component';
    return (
      <div
        role="alert"
        style={{
          padding: 14,
          margin: 6,
          background: '#1f0f0f',
          color: '#fecaca',
          border: '1px solid #991b1b',
          borderRadius: 6,
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 12,
          lineHeight: 1.5,
        }}
      >
        <div style={{ fontWeight: 800, color: '#fca5a5', marginBottom: 6, fontSize: 13 }}>
          ⚠️ {label} Error
        </div>
        <div style={{ opacity: 0.85, marginBottom: 8, wordBreak: 'break-word' }}>
          {String(error?.message || error)}
        </div>
        <button
          onClick={this.reset}
          style={{
            background: '#ef4444',
            color: '#0b0f19',
            border: 'none',
            borderRadius: 4,
            padding: '5px 12px',
            fontFamily: 'inherit',
            fontSize: 11,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Reload Component
        </button>
      </div>
    );
  }
}
