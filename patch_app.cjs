const fs = require('fs');

let appCode = fs.readFileSync('src/App.jsx', 'utf8');

// We need to remove AlertLog and ScanHistoryDrawer from the bottom of App.jsx
appCode = appCode.replace(/<AlertLog [^\/>]+\/>\s*/g, '');
appCode = appCode.replace(/<ScanHistoryDrawer [^\/>]+\/>\s*/g, '');

// And we need to add the props to PremiumHeader
appCode = appCode.replace(
  /<PremiumHeader badge={state\.badge} notifications={notifications} \/>/g,
  `<PremiumHeader 
        badge={state.badge} 
        notifications={notifications} 
        alertLog={alertLog}
        advisor={advisor}
        livePrice={livePrice}
        portfolio={state.portfolio}
        scanHistory={scanHistory}
        onAnalyze={handleAIAnalyze}
      />`
);

fs.writeFileSync('src/App.jsx', appCode);
console.log('App.jsx patched successfully');
