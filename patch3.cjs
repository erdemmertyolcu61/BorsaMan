const fs = require('fs');
let code = fs.readFileSync('src/components/AIAdvisor/AIAdvisorPanel.jsx', 'utf8');

// 1. Simplify hold text
code = code.replace(
    `{p.holdText || (isSell ? 'Kısa pozisyon' : '1-3 gün (kısa vade)')}`,
    `{p.holdText || (isSell ? 'Kısa poz.' : '1-3 gün')}`
);

// 2. Adjust Stop/Target layout to space-between
const oldRow3 = `<div style={{ display: 'flex', gap: 10, fontSize: 11, marginTop: 6 }}>`;
const newRow3 = `<div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginTop: 6 }}>`;
code = code.replace(oldRow3, newRow3);

fs.writeFileSync('src/components/AIAdvisor/AIAdvisorPanel.jsx', code);
console.log('Patch 3 successful');
