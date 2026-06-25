const fs = require('fs');
let code = fs.readFileSync('src/components/AIAdvisor/AIAdvisorPanel.jsx', 'utf8');

// The file currently has Div A, C, D opened at the top.
// Let's revert back to the original by doing the exact reverse, so we can apply the fix cleanly.

code = code.replace(
    `<div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>`,
    `<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>`
);

// Now we have the original structure again!
// Let's use a very careful regex to extract the whole block.
// The block starts with `{/* Row 1: symbol + sector + signal + grade + early */}`
// and ends right before `{/* Row 2: price`

const row1Start = `              {/* Row 1: symbol + sector + signal + grade + early */}`;
const row2Start = `              {/* Row 2: price (CANLI PRIMARY) + change + R/R + score */}`;

const p1 = code.indexOf(row1Start);
const p2 = code.indexOf(row2Start);

if (p1 !== -1 && p2 !== -1) {
    const originalRow1 = code.substring(p1, p2);
    
    // We want to reconstruct it beautifully.
    // 1. Extract Symbol
    // 2. Extract Grade
    // 3. Extract Sector
    // 4. Extract Signal Label block
    // 5. Extract all other badges
    
    let modifiedRow1 = originalRow1;
    
    // Replace the outer container to be a column
    modifiedRow1 = modifiedRow1.replace(
        /<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>/,
        `<div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>`
    );
    
    // Replace the inner container (which holds symbol + badges + sector) to be the "Top Row" and "Badges Row"
    // Wait, it's easier to just inject the row breaks using regex.
    
    // Step 1: Change the inner wrapper into the top row (Symbol, Grade, Sector on left, Signal on right)
    modifiedRow1 = modifiedRow1.replace(
        /<div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>/,
        `<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>`
    );
    
    // Step 2: The sector span is the last thing before the closing </div> of the inner wrapper.
    // We match the sector span, and its trailing </div>.
    const sectorRegex = /(<span style={{[^}]+}}>\s*\{p\.sector\}\s*<\/span>\s*)<\/div>/;
    modifiedRow1 = modifiedRow1.replace(sectorRegex, (match, p1) => {
        return p1 + `
                  </div>
                  {/* Right side: Signal Label */}
                  <div style={{ display: 'flex', alignItems: 'center' }}>
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
                {/* Badges Row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>`;
    });
    
    // Step 3: Remove the old signal label from the bottom of Row 1
    const oldSignalRegex = /<span style={{[\s\S]*?\{signalLabel\}\s*<\/span>\s*<\/div>/;
    modifiedRow1 = modifiedRow1.replace(oldSignalRegex, `</div>`);
    
    // Step 4: Move Grade to the top row (right after symbol).
    // Grade badge is `{p.grade && (\n <span ... \n </span>\n )}`
    // Since it's already right after {p.symbol}, it will naturally fall into the top row!
    // But we want the badges (ERKEN, etc.) to fall into the "Badges Row".
    // Wait... if they are right after Grade, they will also be in the Top Row!
    // Because we just opened `Badges Row` AFTER `p.sector`!!
    
    // AH! p.sector is at the very END of all badges.
    // So all badges are BEFORE p.sector.
    // This means they will all be inside the Top Row. This is wrong.
}
