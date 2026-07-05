const list = ['ENRYA','GMSTRF','LYDIA','ROYAL','USDTRF','ZGOLDF','APBDL','APGLD','APLIB','APMDL','APX30','GLDTR','GMSTR','OPK30','OPT25','OPTGY','OPTLR','OPX30','ZPBDL','ZPLIB','ZPT10','ZPX30','ZRE20','ZRGYO','ZSR25','ZTLRF','ZTLRK','ZTM25','Z30EA','Z30KE','Z30KP','ZEDUR','ZELOT','ZERGY','ZGOLD','ZGYO','ZOREN'];
(async () => {
  for(let s of list) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${s}.IS?range=1d`);
      if(r.status === 200) {
        const data = await r.json();
        const meta = data.chart.result[0].meta;
        console.log(s, meta.instrumentType || meta.type, meta.exchangeName);
      } else {
        console.log(s, 'NOT FOUND');
      }
    } catch(e) {
      console.log(s, 'ERROR');
    }
  }
})();
