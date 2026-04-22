import fetch from 'node-fetch';

async function testFetch() {
  const symbol = 'THYAO';
  const group = '3'; // Try '3' UFRS Konsolide
  const url = `https://www.isyatirim.com.tr/_layouts/15/IsYatirim.Website/Common/Data.aspx/MaliTablo?companyCode=${symbol}&exchange=TRY&financialGroup=${group}&year1=2023&period1=12&year2=2023&period2=9&year3=2023&period3=6&year4=2023&period4=3`;

  console.log('Fetching directly from Node:', url);

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json'
      }
    });

    console.log('Status:', resp.status, resp.statusText);
    const text = await resp.text();
    console.log('Body length:', text.length);

    const json = JSON.parse(text);
    console.log('Rows found:', json?.value?.length);
    if (json?.value?.length > 0) {
      console.log('First row:', JSON.stringify(json.value[0]).substring(0, 100));
    }
  } catch (err) {
    console.error('Fetch error:', err.message);
  }
}
testFetch();
