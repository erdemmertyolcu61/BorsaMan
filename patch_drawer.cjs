const fs = require('fs');

let drawer = fs.readFileSync('src/components/AIAdvisor/ScanHistoryDrawer.jsx', 'utf8');

// Change the floating pill to an inline button suitable for the Header
drawer = drawer.replace(
  /<div \n\s*onClick={\(\) => setIsOpen\(true\)}\n\s*style={{\n\s*position: 'fixed',\n\s*bottom: 24,\n\s*left: 24,\n\s*zIndex: 1100,/g,
  `<div 
          onClick={() => setIsOpen(true)}
          style={{
            position: 'relative',`
);

drawer = drawer.replace(
  /padding: '8px 16px',\n\s*display: 'flex',\n\s*alignItems: 'center',\n\s*gap: 10,/g,
  `padding: '6px 12px',\n            display: 'flex',\n            alignItems: 'center',\n            gap: 6,\n            marginRight: 10,`
);

drawer = drawer.replace(
  /boxShadow: '0 4px 15px rgba\(0, 0, 0, 0\.5\), 0 0 10px rgba\(0, 229, 255, 0\.1\)',/g,
  `/* no big shadow */`
);

drawer = drawer.replace(
  /background: 'rgba\(13, 17, 23, 0\.9\)',\n\s*border: '1px solid rgba\(0, 229, 255, 0\.3\)',\n\s*borderRadius: 30,/g,
  `background: 'rgba(0, 229, 255, 0.1)',\n            border: '1px solid var(--cyan)',\n            borderRadius: 8,`
);

fs.writeFileSync('src/components/AIAdvisor/ScanHistoryDrawer.jsx', drawer);
console.log('ScanHistoryDrawer.jsx patched successfully');
