const fs = require('fs');

// Patch AlertLog.jsx
let alertLog = fs.readFileSync('src/components/AlertLog/AlertLog.jsx', 'utf8');

// Change the outer div to be a relative container
alertLog = alertLog.replace(
  /<div className="alert-log" style={{[\s\S]*?fontSize: 11,[\s\S]*?}}>/,
  `<div className="alert-log" style={{
      position: 'relative', zIndex: 950,
      fontSize: 11,
    }}>`
);

// Change the header button to be styled for the app header
alertLog = alertLog.replace(
  /<div onClick={\(\) => setOpen\(o => !o\)} style={{[\s\S]*?}}>[\s\S]*?<\/div>/,
  `<div onClick={() => setOpen(o => !o)} style={{
        padding: '6px 12px', cursor: 'pointer', userSelect: 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        background: open ? 'var(--bg3)' : 'rgba(255,160,0,0.1)', 
        border: '1px solid var(--orange)', borderRadius: 8,
        color: 'var(--orange)', fontSize: 11, fontWeight: 600,
        transition: 'all 0.2s',
      }}
      onMouseOver={e => !open && (e.currentTarget.style.filter = 'brightness(1.2)')}
      onMouseOut={e => !open && (e.currentTarget.style.filter = 'none')}
      >
        <span>⚠️</span> UYARILAR ({alerts.length})
      </div>`
);

// Wrap the expanded content in an absolutely positioned dropdown
alertLog = alertLog.replace(
  /{open && \([\s\S]*?<div style={{ padding: 8, maxHeight: 440, overflowY: 'auto' }}>/,
  `{open && (
        <div style={{ 
          position: 'absolute', top: '100%', right: 0, marginTop: 8,
          background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6,
          width: 420, maxHeight: 480, overflow: 'hidden',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)'
        }}>
        <div style={{ padding: 8, maxHeight: 440, overflowY: 'auto' }}>`
);

// Close the absolutely positioned dropdown
alertLog = alertLog.replace(
  /<\/div>\n\s*<\/div>\n\s*\)}/,
  `</div>\n        </div>\n      )}`
);

fs.writeFileSync('src/components/AlertLog/AlertLog.jsx', alertLog);
console.log('AlertLog.jsx patched successfully');
