// OLX.ba Price per m² — CSV export

const CSVExporter = {
  exportToFile(results) {
    if (!results?.length) return;
    const headers = [
      'Naziv', 'URL', 'm²', 'Sobe', 'Cijena', 'KM/m²',
      'Najam est.', 'Metoda procjene',
      'ROI %', 'ROI Y10 %', 'Real ROI (kraj) %',
      'Break-even (god.)',
      'Rok kredita (mj)', 'Rata KM/mj', 'Avans KM', 'Ukupna dobit KM',
      'ROI najam %', 'Ukupna dobit najam KM',
      'Trend', 'Dana na tržištu',
      'Novo', 'Pad cijene', 'Pad %',
    ];

    const esc = s => `"${String(s || '').replace(/"/g, '""')}"`;

    const rows = results
      .filter(r => !r.isRent)
      .map(r => [
        esc(r.title),
        esc(r.url),
        r.sqm             ?? '',
        r.rooms           ?? '',
        r.price           ?? '',
        r.ppm2            ?? '',
        r.potRent         != null ? Math.round(r.potRent)          : '',
        esc(r.potRentMethod ?? ''),
        r.roi             != null ? r.roi.toFixed(2)               : '',
        r.roiY10          != null ? r.roiY10.toFixed(2)            : '',
        r.realRoiAtEnd    != null ? r.realRoiAtEnd.toFixed(2)      : '',
        r.breakEvenYears  != null && isFinite(r.breakEvenYears)
          ? r.breakEvenYears.toFixed(1) : '',
        r.loanTerm        ?? '',
        r.loanPayment     != null ? Math.round(r.loanPayment)      : '',
        r.downPayment     != null ? Math.round(r.downPayment)      : '',
        r.totalProfit     != null ? Math.round(r.totalProfit)      : '',
        r.roiRent         != null ? r.roiRent.toFixed(2)           : '',
        r.totalProfitRent != null ? Math.round(r.totalProfitRent)  : '',
        r.trend           ?? '',
        r.days            ?? '',
        r.isNew     ? 'Da' : 'Ne',
        r.priceDrop ? 'Da' : 'Ne',
        r.dropPct         != null ? r.dropPct                      : '',
      ]);

    const csv  = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `olx-listings-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
};
