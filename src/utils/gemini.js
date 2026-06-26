import { GoogleGenerativeAI } from '@google/generative-ai';

const GEMINI_API_KEY_STORAGE = 'gemini_api_key';

export function setGeminiApiKey(key) {
  if (typeof key === 'string' && key.trim()) {
    localStorage.setItem(GEMINI_API_KEY_STORAGE, key.trim());
  } else {
    localStorage.removeItem(GEMINI_API_KEY_STORAGE);
  }
}

export function getGeminiApiKey() {
  try { return localStorage.getItem(GEMINI_API_KEY_STORAGE) || ''; } catch { return ''; }
}

export async function askMarketIntel(newsList = []) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    return { error: 'Gemini API anahtari tanimlanmamis. Lutfen ayarlardan ekleyin (Google AI Studio).' };
  }

  const newsText = newsList.map((n, i) => `${i+1}. [${n.source}] ${n.title}`).join('\n');
  const prompt = `Sen BIST (Borsa Istanbul) istihbarat sefisin ve ayni zamanda Turkiye'nin en iyi, en rasyonel borsa analistlerinin (Tuncay Tursucu, Isik Okte, Ahmet Mergen, Kivanc Ozbilgic gibi isimlerin) analitik bakis acisina sahip bir bilgesin.
Asagida bugunun bazi RSS ve KAP haberlerini verdim. 
Senden IKI GOREVIN var:
1. Bu haberleri sadece siradan bir sekilde okumakla kalma; onlari usta bir finansal analist gozuyle suz. "Bu haber piyasada nasil fiyatlanir?", "Hangi sektorlere para girisi yaratir?", "Uzun vadeli trendi nasil etkiler?" gibi sorularin cevaplarini arayarak haberleri yorumla. Rasyonel ve mantikli olan cikarimlarini "Uzman Gorusu" olarak raporuna ekle.
2. Bu yorumlari ve haberleri birlestirip bana detayli bir JSON raporu dondur.

=== BUGUNUN HABERLERI VE KAP BILDIRIMLERI ===
${newsText || 'Haber yok.'}

=== CIKTI FORMATI ===
SADECE gecerli bir JSON dondur, baska metin yazma. Kod blogu (markdown) icinde olsa da olur, ben ayiklayacagim.
JSON formati su sekilde olmali:
{
  "newsMarkdown": "Gunun en onemli 3 finans/ekonomi haberi ve etkileri. Sadece haberler. 1-2 paragraf.",
  "expertMarkdown": "Turkiye'nin usta analistlerinin rasyonel bakis acisiyla (kendi urettigin) piyasa ve hisse yorumlari. Hangi haber hangi hisseyi/sektoru nasil etkiler? Bilgece ve analitik bir dille yaz.",
  "impacts": [
    {
      "symbol": "ASELS",
      "reason": "KAP'ta aciklanan yeni sozlesme is hacmini %10 artiracaktir, rasyonel bir alim firsati."
    }
  ]
}

- impacts dizisine en cok etkilenen max 6 hisseyi ekle. (Sirket kodu mutlaka 4-5 harfli BIST sembolu olmalidir, ornegin THYAO, GARAN)
- Sadece JSON dondur.`;

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    
    let modelName = "gemini-1.5-flash"; // Default fallback
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      const data = await response.json();
      if (data && data.models) {
        // Find the most capable latest flash or pro model that supports generateContent
        const validModels = data.models.filter(m => 
          m.supportedGenerationMethods.includes("generateContent") && 
          !m.name.includes("vision") && 
          m.name.includes("flash")
        );
        if (validModels.length > 0) {
          modelName = validModels[0].name.replace('models/', '');
        }
      }
    } catch(e) { console.error("Model listeleme hatasi:", e); }

    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: { temperature: 0.5 },
    });

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    
    // JSON parse
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = m ? m[1].trim() : text.replace(/^```json\s*/i, '').replace(/```$/g, '').trim();
    
    return JSON.parse(jsonStr);
  } catch (err) {
    return { error: 'Gemini HTTP Hatasi: ' + err.message };
  }
}
