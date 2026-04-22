async function testKAP() {
  const symbol = 'ASELS';
  // Try another proxy
  const url = `https://corsproxy.io/?` + encodeURIComponent(`https://www.kap.org.tr/tr/api/disclosures/ticker/${symbol}`);
  console.log(`Testing corsproxy.io for ${symbol}...`);
  try {
    const resp = await fetch(url);
    const text = await resp.text();
    console.log('Response status:', resp.status);
    console.log('Contents sample:', text.substring(0, 500));
  } catch (e) {
    console.error('Error:', e);
  }
}
testKAP();
