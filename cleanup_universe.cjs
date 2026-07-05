const fs = require('fs');
const content = fs.readFileSync('src/utils/constants.js', 'utf8');

// The bad list: NOT FOUND + ETFs
const badList = new Set([
  'ENRYA','GMSTRF','LYDIA','ROYAL','USDTRF','ZGOLDF',
  'APBDL','APGLD','APLIB','APMDL','APX30',
  'GLDTR','GMSTR',
  'OPK30','OPT25','OPTGY','OPTLR','OPX30',
  'ZPBDL','ZPLIB','ZPT10','ZPX30','ZRE20','ZSR25','ZTLRF','ZTLRK','ZTM25',
  'Z30EA','Z30KE','Z30KP','ZELOT','ZGOLD', 'USDTR'
]);

const match = content.match(/const BISTALL_EXTRA = \[([^\]]+)\];/);
if(match) {
  const arrStr = match[1];
  // split by comma, remove quotes, trim
  let list = arrStr.split(',').map(s => s.trim().replace(/'/g, ''));
  const originalLen = list.length;
  list = list.filter(s => !badList.has(s));
  
  const newListStr = list.map(s => `'${s}'`).join(',');
  const newContent = content.replace(match[0], `const BISTALL_EXTRA = [${newListStr}];`);
  
  fs.writeFileSync('src/utils/constants.js', newContent, 'utf8');
  console.log('Removed ' + (originalLen - list.length) + ' tickers from constants.js');
} else {
  console.log('Could not parse BISTALL_EXTRA');
}
