const fs = require('fs');
let code = fs.readFileSync('src/components/AIAdvisor/AIAdvisorPanel.jsx', 'utf8');

// 1. open state
code = code.replace(
    `const [open, setOpen] = useState(true); // start expanded so user always sees it`,
    `const [open, setOpen] = useState(typeof window !== 'undefined' && window.innerWidth > 768); // start expanded on desktop, collapsed on mobile`
);

// 2. map sort
code = code.replace(
    `{hasPicks && picks.map((p, idx) => {`,
    `{hasPicks && [...picks].sort((a, b) => (b.score || 0) - (a.score || 0)).map((p, idx) => {`
);

// 3. card width
const oldCardWidth = `flexShrink: 0, width: 235,`;
const newCardWidth = `flexShrink: 0, width: typeof window !== 'undefined' && window.innerWidth <= 768 ? '85vw' : 235,`;
code = code.replace(oldCardWidth, newCardWidth);

// 4. mlBestRule string type check
const oldML = `if (p.mlBestRule && (p.mlMatchedCount || 0) > 0) {
            tooltipLines.push(\`🎯 ML: \${p.mlBestRule.setupName} (%\${(p.mlBestRule.winRate || 0).toFixed(1)} win rate)\`);
            tooltipLines.push(\`  Güven boost: +\${(p.mlConfidenceBoost || 0).toFixed(1)}, ROI ort.: %\${(p.mlBestRule.avgRoi || 0).toFixed(2)}\`);
            if (p.mlMatchedCount > 1) tooltipLines.push(\`  \${p.mlMatchedCount} kural eşleşti (konfluens bonusu)\`);
          }`;
const newML = `if (p.mlBestRule && (p.mlMatchedCount || 0) > 0) {
            const ruleName = typeof p.mlBestRule === 'string' ? p.mlBestRule : p.mlBestRule.setupName;
            const wr = typeof p.mlBestRule === 'object' ? p.mlBestRule.winRate || 0 : 0;
            const roi = typeof p.mlBestRule === 'object' ? p.mlBestRule.avgRoi || 0 : 0;
            tooltipLines.push(\`🎯 ML: \${ruleName} (%\${wr.toFixed(1)} win rate)\`);
            tooltipLines.push(\`  Güven boost: +\${(p.mlConfidenceBoost || 0).toFixed(1)}, ROI ort.: %\${roi.toFixed(2)}\`);
            if (p.mlMatchedCount > 1) tooltipLines.push(\`  \${p.mlMatchedCount} kural eşleşti (konfluens bonusu)\`);
          }`;
if (code.includes('if (p.mlBestRule && (p.mlMatchedCount || 0) > 0) {')) {
    code = code.replace(oldML, newML);
} else {
    console.log('ML not found');
}

fs.writeFileSync('src/components/AIAdvisor/AIAdvisorPanel.jsx', code);
console.log('Patch 2 successful');
