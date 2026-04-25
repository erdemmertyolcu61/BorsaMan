// Quick test: Can we fetch data from İş Yatırım and Yahoo directly?
// Run: node scratch/testFetchDirect.mjs

async function testIsYatirim() {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 200);
  
  const formatDate = (d) => {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return dd + '-' + mm + '-' + yyyy;
  };
  
  const params = `hisse=THYAO&startdate=${formatDate(startDate)}&enddate=${formatDate(endDate)}`;
  const url = 'https://www.isyatirim.com.tr/_layouts/15/Isyatirim.Website/Common/Data.aspx/HisseTekil?' + params;
  
  console.log('[TEST] İş Yatırım URL:', url);
  
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
      }
    });
    const text = await r.text();
    console.log('[TEST] İş Yatırım status:', r.status);
    console.log('[TEST] İş Yatırım response length:', text.length);
    if (text.length > 100) {
      try {
        const data = JSON.parse(text);
        const values = data?.value;
        console.log('[TEST] İş Yatırım parsed values count:', values?.length || 0);
        if (values?.length > 0) console.log('[TEST] İş Yatırım FIRST:', values[0]);
      } catch (e) {
        console.log('[TEST] İş Yatırım parse error:', e.message);
        console.log('[TEST] İş Yatırım first 200 chars:', text.slice(0, 200));
      }
    } else {
      console.log('[TEST] İş Yatırım response too short:', text);
    }
  } catch (e) {
    console.error('[TEST] İş Yatırım FAILED:', e.message);
  }
}

async function testYahoo() {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/THYAO.IS?range=6mo&interval=1d&includePrePost=false';
  console.log('\n[TEST] Yahoo URL:', url);
  
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      }
    });
    const text = await r.text();
    console.log('[TEST] Yahoo status:', r.status);
    console.log('[TEST] Yahoo response length:', text.length);
    if (text.length > 100) {
      try {
        const data = JSON.parse(text);
        const result = data?.chart?.result?.[0];
        console.log('[TEST] Yahoo timestamps count:', result?.timestamp?.length || 0);
      } catch (e) {
        console.log('[TEST] Yahoo parse error:', e.message);
        console.log('[TEST] Yahoo first 200 chars:', text.slice(0, 200));
      }
    } else {
      console.log('[TEST] Yahoo response:', text);
    }
  } catch (e) {
    console.error('[TEST] Yahoo FAILED:', e.message);
  }
}

console.log('=== DATA SOURCE CONNECTIVITY TEST ===');
console.log('Time:', new Date().toLocaleString('tr-TR'));
console.log('');
await testIsYatirim();
await testYahoo();
console.log('\n=== TEST COMPLETE ===');
