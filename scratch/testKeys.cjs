const https = require('https');

const symbol = 'THYAO';
const group = 'XI_29';
const url = `https://www.isyatirim.com.tr/_layouts/15/IsYatirim.Website/Common/Data.aspx/MaliTablo?companyCode=${symbol}&exchange=TRY&financialGroup=${group}&year1=2024&period1=9&year2=2024&period2=6&year3=2024&period3=3&year4=2023&period4=12`;

https.get(url, (res) => {
  let data = '';
  res.on('data', d => data += d);
  res.on('end', () => {
    const json = JSON.parse(data);
    if(json.value && json.value.length > 0) {
      console.log('Keys:', Object.keys(json.value[0]));
      console.log('Example row descTr:', json.value[0].itemDescTr || json.value[0].itemDesc || json.value[0].itemDescEng);
      console.log('Example row values:', 
        json.value[0].value1, 
        json.value[0].itemValue1,
        json.value[0]['value1'],
        json.value[0]['2024/9']
      );
      console.log(json.value[0]);
    }
  });
});
