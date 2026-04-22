async function testSparkOHLC() {
  const symbols = ['THYAO.IS', 'GARAN.IS'];
  // Maybe a shorter range provides more detail?
  const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${symbols.join(',')}&range=1d&interval=1m`;
  
  console.log('Fetching:', url);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    const data = await res.json();
    console.log(JSON.stringify(data.spark.result[0].response[0].indicators.quote[0], null, 2));
  } catch (err) {
    console.error('Error:', err.message);
  }
}

testSparkOHLC();
