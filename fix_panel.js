const fs = require('fs');
let code = fs.readFileSync('src/components/AIAdvisor/AIAdvisorPanel.jsx', 'utf8');

code = code.replace(
  'const [open, setOpen] = useState(true); // start expanded so user always sees it',
  'const [open, setOpen] = useState(typeof window !== \'undefined\' && window.innerWidth > 768); // start expanded on desktop, collapsed on mobile'
);

code = code.replace(
  '{hasPicks && picks.map((p, idx) => {',
  '{hasPicks && [...picks].sort((a, b) => (b.score || 0) - (a.score || 0)).map((p, idx) => {'
);

const oldML = 'tooltipLines.push(\🎯 ML:  (% win rate)\);\n            tooltipLines.push(\  Güven boost: +, ROI ort.: %\);';
const newML = 'const ruleName = typeof p.mlBestRule === \'string\' ? p.mlBestRule : p.mlBestRule.setupName;\n            const wr = typeof p.mlBestRule === \'object\' ? p.mlBestRule.winRate || 0 : 0;\n            const roi = typeof p.mlBestRule === \'object\' ? p.mlBestRule.avgRoi || 0 : 0;\n            tooltipLines.push(\🎯 ML:  (% win rate)\);\n            tooltipLines.push(\  Güven boost: +, ROI ort.: %\);';
code = code.replace(oldML, newML);

code = code.replace(
  /flex: '0 0 auto',\s*minWidth: 280, maxWidth: 280,/g,
  \lex: '0 0 auto',
              minWidth: typeof window !== 'undefined' && window.innerWidth <= 768 ? '85vw' : 280,
              maxWidth: typeof window !== 'undefined' && window.innerWidth <= 768 ? '85vw' : 280,\
);

fs.writeFileSync('src/components/AIAdvisor/AIAdvisorPanel.jsx', code);
console.log('Update successful');

