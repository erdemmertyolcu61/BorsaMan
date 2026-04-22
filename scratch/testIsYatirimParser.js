const fs = require('fs');
const https = require('https');

async function testFetch() {
  const symbol = 'ASELS';
  const group = '2'; // UFRS
  const url = `https://www.isyatirim.com.tr/_layouts/15/IsYatirim.Website/Common/Data.aspx?companyCode=${symbol}&exchange=TRY&financialGroup=${group}&year1=2023&period1=12&year2=2023&period2=9&year3=2023&period3=6&year4=2023&period4=3`;

  console.log('Fetching:', url);

  https.get(url, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      console.log('Response length:', data.length);
      try {
        const json = JSON.parse(data);
        if (json.value && json.value.length > 0) {
          console.log(`Found ${json.value.length} rows.`);
          console.log('First row example:', json.value[0]);
          
          // Let's test the keys to see what matches our parser
          const firstRow = json.value[0];
          console.log('Keys available in first row:', Object.keys(firstRow));
        } else {
          console.log('JSON value empty:', json);
        }
      } catch (e) {
        console.error('Parse error:', e.message);
        console.log('Raw output snippet:', data.substring(0, 200));
      }
    });
  }).on('error', (e) => {
    console.error('Network error:', e);
  });
}

testFetch();
