
async function testSpark() {
  const symbols = ['THYAO.IS', 'GARAN.IS', 'AKBNK.IS'];
  const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${symbols.join(',')}&range=1mo&interval=1d`;
  
  console.log('Fetching:', url);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    const data = await res.json();
    
    if (data.spark && data.spark.result) {
      data.spark.result.forEach(r => {
        console.log(`\nSymbol: ${r.symbol}`);
        const resp = r.response[0];
        if (resp && resp.indicators && resp.indicators.quote) {
          const q = resp.indicators.quote[0];
          const results = [];
          for (let i = 0; i < resp.timestamp.length; i++) {
            const close = q.close[i];
            const open = (q.open && q.open[i] !== null) ? q.open[i] : close;
            const high = (q.high && q.high[i] !== null) ? q.high[i] : close;
            const low = (q.low && q.low[i] !== null) ? q.low[i] : close;
            if (close !== null) {
              results.push({ open, high, low, close });
            }
          }
          console.log('- Repaired prices count:', results.length);
          console.log('- Sample (Repaired last):', results.slice(-1)[0]);
        }
      });
    } else {
      console.log('No spark data found in response');
      console.log(JSON.stringify(data, null, 2));
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
}

testSpark();
