async function testYahooQuote() {
  const symbols = ['THYAO.IS', 'GARAN.IS', 'AKBNK.IS'];
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(',')}`;
  console.log('Fetching:', url);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    const data = await res.json();
    if (data.quoteResponse && data.quoteResponse.result) {
      data.quoteResponse.result.forEach(q => {
        console.log(`\nSymbol: ${q.symbol}`);
        console.log('- Regular Market Price:', q.regularMarketPrice);
        console.log('- Regular Market Open:', q.regularMarketOpen);
        console.log('- Regular Market Day High:', q.regularMarketDayHigh);
        console.log('- Regular Market Day Low:', q.regularMarketDayLow);
        console.log('- Regular Market Volume:', q.regularMarketVolume);
      });
    } else {
      console.log('No quote data found');
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
}

testYahooQuote();
