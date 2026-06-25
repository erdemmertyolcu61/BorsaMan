const fs = require('fs');
let code = fs.readFileSync('src/components/AIAdvisor/AIAdvisorPanel.jsx', 'utf8');

// I need to fix the mangled JSX.
const mangledMatch = `                    }} title={\`Tavan/yüksek pump ama devam ihtimali yüksek (%\${p.continuationProbability})\`}>
                      ⚡ DEVAM %{p.continuationProbability}
                    </span>
                  )}`;

if (code.includes(mangledMatch)) {
    code = code.replace(mangledMatch, '');
    fs.writeFileSync('src/components/AIAdvisor/AIAdvisorPanel.jsx', code);
    console.log('Fixed mangled JSX');
} else {
    console.log('Mangled JSX not found');
}
