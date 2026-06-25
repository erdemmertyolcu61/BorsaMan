const fs = require('fs');

let header = fs.readFileSync('src/components/Header/Header.jsx', 'utf8');

// Add imports for AlertLog and ScanHistoryDrawer
header = header.replace(
  /import ProxySettings from '\.\.\/Common\/ProxySettings\.jsx';/,
  `import ProxySettings from '../Common/ProxySettings.jsx';
import AlertLog from '../AlertLog/AlertLog.jsx';
import ScanHistoryDrawer from '../AIAdvisor/ScanHistoryDrawer.jsx';`
);

// Add props to the function signature
header = header.replace(
  /export default function Header\(\{ badge, notifications, onAnalyze \}\) \{/,
  `export default function Header({ badge, notifications, alertLog, advisor, livePrice, portfolio, scanHistory, onAnalyze }) {`
);

// Add components to the header-r div
header = header.replace(
  /<div className="hdr-r">/,
  `<div className="hdr-r" style={{ display: 'flex', alignItems: 'center' }}>
          <ScanHistoryDrawer history={scanHistory} onAnalyze={onAnalyze} />
          <AlertLog alertLog={alertLog} onAnalyze={onAnalyze} advisor={advisor} livePrice={livePrice} portfolio={portfolio} />`
);

fs.writeFileSync('src/components/Header/Header.jsx', header);
console.log('Header.jsx patched successfully');
