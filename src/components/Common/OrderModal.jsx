import { useState } from 'react';

export default function OrderModal({ isOpen, onClose, order, brokerType, onConfirm }) {
  const [step, setStep] = useState(1);
  const [processing, setProcessing] = useState(false);

  if (!isOpen || !order) return null;

  const isMidas = brokerType === 'midas_manual';

  const handleConfirm = async () => {
    setProcessing(true);
    await onConfirm();
    setProcessing(false);
    onClose();
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content fi" style={{ maxWidth: 450, padding: 0, overflow: 'hidden' }}>
        {/* Header */}
        <div style={{
          background: 'var(--bg3)', padding: '16px 20px',
          borderBottom: '1px solid var(--border)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className={`dot ${isMidas ? 'yellow' : 'cyan'}`} style={{ width: 10, height: 10 }} />
            <div style={{ fontFamily: 'Space Grotesk', fontWeight: 700, fontSize: 16, letterSpacing: 0.5 }}>
              {isMidas ? 'MIDAS İŞLEM KÖPRÜSÜ' : 'İŞLEM ONAYI'}
            </div>
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontSize: 20,
          }}>×</button>
        </div>

        {/* Summary */}
        <div style={{ padding: 20, background: 'rgba(0,0,0,0.2)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 15 }}>
            <div>
              <div style={{ fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase' }}>HİSSE</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--t1)' }}>{order.symbol}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase' }}>EMİR TİPİ</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--green)' }}>PİYASA (ALIM)</div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ background: 'var(--bg0)', padding: 10, borderRadius: 6, border: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ fontSize: 9, color: 'var(--t3)', marginBottom: 4 }}>LOT SAYISI</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--cyan)' }}>{order.shares} Adet</div>
            </div>
            <div style={{ background: 'var(--bg0)', padding: 10, borderRadius: 6, border: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ fontSize: 9, color: 'var(--t3)', marginBottom: 4 }}>TAHMİNİ FİYAT</div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{order.price.toFixed(2)} TL</div>
            </div>
          </div>

          <div style={{ marginTop: 12, fontSize: 10, color: 'var(--t3)', display: 'flex', justifyContent: 'space-between' }}>
            <span>Toplam Maliyet:</span>
            <span style={{ color: 'var(--t1)', fontWeight: 600 }}>
              {(order.shares * order.price).toLocaleString('tr-TR')} TL
            </span>
          </div>
        </div>

        {/* Midas manual steps */}
        {isMidas ? (
          <div style={{ padding: 20, borderTop: '1px solid var(--border)' }}>
            <div style={{ marginBottom: 15 }}>
              {[
                { n: 1, jsx: <>Telefondan <b>Midas</b> uygulamasını açın.</> },
                { n: 2, jsx: <>Arama kısmına <b>{order.symbol}</b> yazın ve seçin.</> },
                { n: 3, jsx: <><b>{order.shares}</b> adet olacak şekilde alım emrini iletin.</> },
              ].map(({ n, jsx }) => (
                <div key={n} style={{ display: 'flex', gap: 12, marginBottom: 12 }} onClick={() => setStep(Math.max(step, n))}>
                  <div style={{
                    width: 20, height: 20, borderRadius: '50%',
                    background: step >= n ? 'var(--yellow)' : 'var(--bg3)',
                    color: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 10, fontWeight: 800, cursor: 'pointer',
                  }}>{n}</div>
                  <div style={{ fontSize: 11, color: step >= n ? 'var(--t1)' : 'var(--t3)' }}>{jsx}</div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" style={{ flex: 1, background: 'var(--bg3)', color: 'var(--t2)', fontSize: 11 }} onClick={onClose}>
                VAZGEÇ
              </button>
              <button
                className="btn btn-go"
                style={{ flex: 2, background: 'var(--yellow)', color: '#000', fontSize: 11, fontWeight: 700 }}
                disabled={processing}
                onClick={handleConfirm}
              >
                {processing ? 'İŞLENİYOR...' : 'İŞLEMİ TAMAMLADIM'}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ padding: 20, borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--t2)', marginBottom: 15, lineHeight: 1.5 }}>
              Bu işlem <b>Simülasyon</b> modunda gerçekleşecektir. İşlem gerçekleştikten sonra portföyünüze eklenecektir.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" style={{ flex: 1, background: 'var(--bg3)', color: 'var(--t2)' }} onClick={onClose}>
                İPTAL
              </button>
              <button className="btn btn-go" style={{ flex: 2 }} disabled={processing} onClick={handleConfirm}>
                {processing ? 'ONAYLANIYOR...' : 'ONAYLA VE EKLE'}
              </button>
            </div>
          </div>
        )}

        {/* Footer */}
        <div style={{ padding: '10px 20px', background: 'var(--bg0)', borderTop: '1px solid var(--border)' }}>
          <div style={{ fontSize: 8, color: 'var(--t3)', textAlign: 'center', textTransform: 'uppercase', letterSpacing: 1 }}>
            Bu bir emir iletim köprüsü arayüzüdür.
          </div>
        </div>
      </div>
    </div>
  );
}
