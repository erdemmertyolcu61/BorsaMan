const fs = require('fs');
const path = require('path');
const walk = (dir) => {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) { 
      results = results.concat(walk(file));
    } else if (file.endsWith('.jsx') || file.endsWith('.js')) { 
      results.push(file);
    }
  });
  return results;
};

const files = walk('c:/Users/Erdem Mert Yolcu/Desktop/bist-terminal-project/src');

const replacements = {
  'Strateji Insasi': 'Strateji İnşası',
  'Hizli Tara': 'Hızlı Tara',
  'Tum Pazari Tara': 'Tüm Pazarı Tara',
  'Taraniyor': 'Taranıyor',
  'Hisse senedi sembolu': 'Hisse senedi sembolü',
  'Degisim': 'Değişim',
  'Deger': 'Değer',
  'Sonuclar': 'Sonuçlar',
  'Sonuc': 'Sonuç',
  'Giris': 'Giriş',
  'Cikis': 'Çıkış',
  'Kisa Vade': 'Kısa Vade',
  'Yukselis': 'Yükseliş',
  'Dusus': 'Düşüş',
  'Alis': 'Alış',
  'Satis': 'Satış',
  'Portfoy': 'Portföy',
  'Islem': 'İşlem',
  'Agirlik': 'Ağırlık',
  'Guncel': 'Güncel',
  'Gorunum': 'Görünüm',
  'Gosterge': 'Gösterge',
  'Ayarlarim': 'Ayarlarım',
  'Icerik': 'İçerik',
  'Basari': 'Başarı',
  'Once bir hisse': 'Önce bir hisse',
  'yazin veya sesle': 'yazın veya sesle',
  'Grafiğe bakiyorum': 'Grafiğe bakıyorum',
  'Gerceklesti': 'Gerçekleşti',
  'Aciklama': 'Açıklama',
  'Ayarlari': 'Ayarları',
  'Piyasa Ozeti': 'Piyasa Özeti',
  'Sektor': 'Sektör',
  'Para Akisi': 'Para Akışı',
  'Dagilim': 'Dağılım',
  'Trend Gucu': 'Trend Gücü',
  'Direncler': 'Dirençler',
  'Detayli Rapor': 'Detaylı Rapor',
  'cunku': 'çünkü',
  'acisindan': 'açısından',
  'baslatayim': 'başlatayım',
  'gerkcesi': 'gerekçesi',
  'Goruntulenemiyor': 'Görüntülenemiyor',
  'verilerini cekerken': 'verilerini çekerken',
  'hata olustu': 'hata oluştu',
  'Firsat': 'Fırsat',
  'Hic islem': 'Hiç işlem'
};

let totalReplacements = 0;

files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  let original = content;

  Object.keys(replacements).forEach(key => {
    const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(safeKey, 'g');
    content = content.replace(regex, replacements[key]);
  });

  if (content !== original) {
    fs.writeFileSync(file, content, 'utf8');
    totalReplacements++;
    console.log('Updated: ' + file);
  }
});
console.log('Total files updated: ' + totalReplacements);
