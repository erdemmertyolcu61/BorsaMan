async function testKAPTicker() {
  const symbol = 'ASELS';
  const url = `https://api.allorigins.win/get?url=` + encodeURIComponent(`https://www.kap.org.tr/tr/api/disclosures/ticker/${symbol}`);
  console.log(`Testing ticker API for ${symbol}...`);
  try {
    const resp = await fetch(url);
    const json = await resp.json();
    console.log('Response status:', resp.status);
    console.log('Contents sample:', json.contents?.substring(0, 500));
  } catch (e) {
    console.error('Error:', e);
  }
}
testKAPTicker();
