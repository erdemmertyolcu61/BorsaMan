async function testBigParaList() {
  const url = 'https://bigpara.hurriyet.com.tr/api/v1/hisse/list';
  console.log('Fetching:', url);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://bigpara.hurriyet.com.tr/'
      }
    });
    const data = await res.json();
    if (data && data.data) {
      console.log('Total stocks:', data.data.length);
      const sample = data.data[0];
      console.log('Sample stock fields:', Object.keys(sample));
      console.log('Sample data:', sample);
    } else {
      console.log('No data found');
      console.log(data);
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
}

testBigParaList();
