/**
 * brokerEngine.js — Broker integration adapters
 *
 * MIDAS DURUM NOTU (2026-04):
 *   Midas Menkul Degerler su an uclu parti entegrasyon icin PUBLIC REST/OAuth
 *   API *yayinlamiyor*. TradingView/cTrader tarzi resmi bir broker API'leri yok.
 *   Bu nedenle "midas_manual" modu bir TICKET olusturur: panoya kopyalanabilen,
 *   Midas mobil / web uygulamasinda 10 saniyede girilecek bir emir fisi.
 *
 *   Yari-otomatik calistirmak isteyen kullanicilar WEBHOOK modunu kullanabilir:
 *   - Kendi Zapier/Make/n8n akislarini Midas'a baglayabilirler
 *   - Webhook body'si JSON formatinda: { symbol, side, shares, price, stop, target }
 *
 *   Gelecekte Midas API acilirsa bu adapter MidasApiAdapter olarak genisletilecek.
 */

export const BROKER_TYPES = {
  SIMULATED: 'simulated',
  MIDAS_MANUAL: 'midas_manual',
  WEBHOOK: 'webhook',
};

class BaseBrokerAdapter {
  constructor(config) {
    this.config = config || {};
  }
  async execute() {
    throw new Error('Execute not implemented');
  }
  getSettingsSchema() {
    return [];
  }
}

class SimulatedAdapter extends BaseBrokerAdapter {
  async execute(order, addToPortfolio) {
    if (addToPortfolio) {
      addToPortfolio(order.symbol, order.price, order.stop, order.target, order.shares, order.positionType || 'trade');
    }
    return { success: true, mode: 'simulated' };
  }
}

class MidasManualAdapter extends BaseBrokerAdapter {
  async execute(order, addToPortfolio) {
    if (addToPortfolio) {
      addToPortfolio(order.symbol, order.price, order.stop, order.target, order.shares, order.positionType || 'trade');
    }
    const side = (order.side || 'BUY').toUpperCase();
    const total = (order.shares || 0) * (order.price || 0);
    const ticket = {
      ticker: order.symbol,
      side,
      lot: order.shares,
      price: order.price,
      total,
      stop: order.stop,
      target: order.target,
      note: `BIST Terminal ${new Date().toLocaleString('tr-TR')}`,
    };
    // Human-readable ticket text (clipboard-friendly for Midas mobile entry)
    ticket.text = [
      `=== MIDAS EMIR FISI ===`,
      `Sembol: ${ticket.ticker}`,
      `Yon: ${side === 'BUY' ? 'ALIM' : 'SATIM'}`,
      `Adet: ${ticket.lot} lot`,
      `Limit Fiyat: ${ticket.price?.toFixed?.(2) ?? ticket.price} TL`,
      `Toplam: ${total.toFixed(2)} TL`,
      ticket.stop ? `OCO Stop: ${ticket.stop.toFixed(2)} TL` : null,
      ticket.target ? `OCO Hedef: ${ticket.target.toFixed(2)} TL` : null,
      `Not: ${ticket.note}`,
    ].filter(Boolean).join('\n');

    // Try to copy to clipboard (Electron/browser)
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(ticket.text);
        ticket.copied = true;
      }
    } catch { ticket.copied = false; }

    return { success: true, mode: 'midas_manual', ticket };
  }

  getSettingsSchema() {
    return [
      { key: '_midasNote', label: 'Midas Modu', type: 'info',
        value: 'Emir fisi otomatik olarak panoya kopyalanir. Midas uygulamasinda yapistirin.' },
    ];
  }
}

class WebhookAdapter extends BaseBrokerAdapter {
  async execute(order) {
    const url = this.config.webhookUrl;
    if (!url) return { success: false, error: 'Webhook URL eksik' };
    try {
      const payload = {
        action: 'ORDER',
        broker: this.config.targetBroker || 'midas',
        symbol: order.symbol,
        side: (order.side || 'BUY').toUpperCase(),
        shares: order.shares,
        price: order.price,
        stop: order.stop,
        target: order.target,
        orderType: order.orderType || 'LIMIT',
        timestamp: new Date().toISOString(),
        secret: this.config.webhookSecret,
      };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return { success: res.ok, status: res.status };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  getSettingsSchema() {
    return [
      { key: 'webhookUrl', label: 'Webhook URL', type: 'text', placeholder: 'https://hooks.zapier.com/...' },
      { key: 'webhookSecret', label: 'Webhook Secret (opsiyonel)', type: 'password', placeholder: 'shared-secret' },
      { key: 'targetBroker', label: 'Hedef Broker', type: 'text', placeholder: 'midas', value: 'midas' },
    ];
  }
}

export function createBrokerAdapter(type, config) {
  switch (type) {
    case BROKER_TYPES.MIDAS_MANUAL:
      return new MidasManualAdapter(config);
    case BROKER_TYPES.WEBHOOK:
      return new WebhookAdapter(config);
    default:
      return new SimulatedAdapter(config);
  }
}
