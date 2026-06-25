const fs = require('fs');

async function testFetch() {
  try {
    const res = await fetch('https://www.isyatirim.com.tr/tr-tr/analiz/hisse/Sayfalar/yabanci-oranlari.aspx');
    const text = await res.text();
    // Look for JSON or table data
    fs.writeFileSync('isyatirim_yabanci_test.html', text);
    console.log('Saved to isyatirim_yabanci_test.html. Length:', text.length);
  } catch (e) {
    console.error(e);
  }
}
testFetch();
