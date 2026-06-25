const fs = require('fs');
let code = fs.readFileSync('src/components/AIAdvisor/AIAdvisorPanel.jsx', 'utf8');

// Target the start of Row 1
const row1Match = `<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>`;
const row1Repl = `<div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>`;

// Target the inner badges wrapper
const innerWrapperMatch = `<div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>`;
const innerWrapperRepl = `<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>`;

// Close the top row after p.sector and open the badges wrapper
const sectorMatch = `<span style={{ fontSize: 10, color: '#a8b3c7', fontWeight: 600, marginLeft: 2 }}>{p.sector}</span>
                </div>`;
const sectorRepl = `<span style={{ fontSize: 10, color: '#a8b3c7', fontWeight: 600, marginLeft: 2 }}>{p.sector}</span>
                  </div>
                  {/* Right side: Signal Label (moved from bottom) */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{
                      fontSize: 10, fontWeight: 800, padding: '3px 7px', borderRadius: 3,
                      background: accentDim, color: accent, border: \`1px solid \${accent}66\`,
                      whiteSpace: 'nowrap', letterSpacing: 0.4,
                      textShadow: \`0 0 8px \${accent}33\`,
                    }}>
                      {signalLabel}
                    </span>
                  </div>
                </div>
                {/* Row 1.5: Badges wrapper */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>`;

// Remove the old signal label at the bottom of the block
const oldSignalMatch = `<span style={{
                  fontSize: 10, fontWeight: 800, padding: '3px 7px', borderRadius: 3,
                  background: accentDim, color: accent, border: \`1px solid \${accent}66\`,
                  whiteSpace: 'nowrap', letterSpacing: 0.4,
                  textShadow: \`0 0 8px \${accent}33\`,
                }}>
                  {signalLabel}
                </span>`;
const oldSignalRepl = ``;

if (code.includes(row1Match) && code.includes(innerWrapperMatch)) {
    code = code.replace(row1Match, row1Repl);
    code = code.replace(innerWrapperMatch, innerWrapperRepl);
    code = code.replace(sectorMatch, sectorRepl);
    code = code.replace(oldSignalMatch, oldSignalRepl);
    
    fs.writeFileSync('src/components/AIAdvisor/AIAdvisorPanel.jsx', code);
    console.log('Layout patched successfully');
} else {
    console.log('Targets not found');
}
