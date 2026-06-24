import https from 'https';

const postData = JSON.stringify({
    "filter": [
        { "left": "exchange", "operation": "equal", "right": "BIST" },
        { "left": "type", "operation": "in_range", "right": ["stock"] }
    ],
    "options": { "lang": "tr" },
    "markets": ["turkey"],
    "symbols": { "query": { "types": [] }, "tickers": [] },
    "columns": ["name", "close", "change"],
    "sort": { "sortBy": "change", "sortOrder": "desc" },
    "range": [0, 20]
});

const options = {
    hostname: 'scanner.tradingview.com',
    port: 443,
    path: '/turkey/scan',
    method: 'POST',
    headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
    }
};

const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
        console.log(data);
    });
});

req.on('error', (e) => {
    console.error(e);
});

req.write(postData);
req.end();
