import fs from 'fs';

async function getList() {
  const remoteUrl = 'https://bigpara.hurriyet.com.tr/api/v1/hisse/list';
  const r = await fetch(remoteUrl, { headers: {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0'
  }});
  const json = await r.json();
  const codes = json.data.map(h => h.kod.trim());
  const dedup = [...new Set(codes)];
  console.log('Total symbols:', dedup.length);
  
  const content = fs.readFileSync('src/utils/constants.js', 'utf8');
  // replace BISTALL_EXTRA array manually via regex
  const regex = /const BISTALL_EXTRA = \[([\s\S]*?)\];/g;
  const newContent = content.replace(regex, `const BISTALL_EXTRA = [${dedup.map(d=>`'${d}'`).join(',')}];`);
  
  fs.writeFileSync('src/utils/constants.js', newContent);
  console.log('Updated constants.js with', dedup.length, 'symbols');
}
getList();
