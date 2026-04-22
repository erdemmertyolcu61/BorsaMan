async function testKAP() {
  const url = 'https://api.allorigins.win/get?url=' + encodeURIComponent('https://www.kap.org.tr/tr/bist-sirketler');
  console.log('Fetching KAP company list via proxy...');
  try {
    const resp = await fetch(url);
    const json = await resp.json();
    const html = json.contents;
    
    // The browser subagent mentioned: 
    // /\"mkkMemberOid\":\"([^\"]+)\",[^}]*\"stockCode\":\"([^\"]+)\"/g
    // Let's try to extract several to see the data structure
    
    const re = /"mkkMemberOid":"([^"]+)","[^"]*stockCode":"([^"]+)"/g;
    let match;
    const mappings = {};
    let count = 0;
    while ((match = re.exec(html)) !== null && count < 20) {
      mappings[match[2]] = match[1];
      count++;
    }
    
    console.log('Sample Mappings:', JSON.stringify(mappings, null, 2));
    
    const aselsOid = mappings['ASELS'];
    if (aselsOid) {
      console.log('ASELS OID:', aselsOid);
      const drillUrl = 'https://api.allorigins.win/get?url=' + encodeURIComponent(`https://www.kap.org.tr/tr/bildirim-sorgu-sonuc?member=${aselsOid}`);
      console.log('Fetching disclosures for ASELS...');
      const dresp = await fetch(drillUrl);
      const djson = await dresp.json();
      console.log('Disclosures HTML sample:', djson.contents.substring(0, 1000));
      
      // Look for disclosure items in the result
      // The subagent says: publishDate, disclosureIndex, title
      const discRe = /"publishDate":"([^"]+)".*?"disclosureIndex":(\d+).*?"title":"([^"]+)"/g;
      let dMatch;
      while ((dMatch = discRe.exec(djson.contents)) !== null) {
        console.log(`- [${dMatch[1]}] ${dMatch[3]} (ID: ${dMatch[2]})`);
      }
    } else {
      console.log('ASELS not found in sample. Try searching specifically.');
      const aselsRe = /"mkkMemberOid":"([^"]+)","[^"]*stockCode":"ASELS"/;
      const aselsMatch = html.match(aselsRe);
      if (aselsMatch) console.log('ASELS OID (specific search):', aselsMatch[1]);
    }
  } catch (e) {
    console.error('Error:', e);
  }
}

testKAP();
