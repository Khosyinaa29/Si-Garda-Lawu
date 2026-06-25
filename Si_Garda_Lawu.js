// ============================================================
// 1. AREA KAJIAN
// ============================================================
var aoi = ee.FeatureCollection(
  'projects/ee-khosyinuraliya/assets/KH_Lawu_Final'
);

// ============================================================
// 2. LAYOUT UI — root dibersihkan SATU KALI
// ============================================================
var appMap = ui.Map();
appMap.style().set({ stretch: 'both' });
appMap.centerObject(aoi, 14);

var mainPanelKiri = ui.Panel({
  style: { width: '300px', padding: '8px', backgroundColor: 'white' }
});

var mainPanel = ui.Panel({
  style: { width: '300px', padding: '10px', backgroundColor: 'white', stretch: 'vertical' }
});

ui.root.clear();
ui.root.setLayout(ui.Panel.Layout.flow('horizontal'));
ui.root.add(mainPanelKiri);
ui.root.add(appMap);
ui.root.add(mainPanel);


// ============================================================
// 3. DATA SENTINEL-1
// ============================================================
var s1 = ee.ImageCollection('COPERNICUS/S1_GRD')
  .filterBounds(aoi)
  .filterDate('2015-01-01', '2026-03-20')
  .filter(ee.Filter.eq('instrumentMode', 'IW'))
  .filter(ee.Filter.eq('orbitProperties_pass', 'DESCENDING'))
  .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
  .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
  .select(['VV', 'VH']);

print('Jumlah citra Sentinel-1:', s1.size());
// ============================================================
// 4. DEM & TERRAIN MASK
// ============================================================
var dem         = ee.Image('USGS/SRTMGL1_003');
var slope       = ee.Terrain.slope(dem);
var slopeMask   = slope.lt(16.7);
var slopeMaskStrict = slope.lt(16.7);
var aspect      = ee.Terrain.aspect(dem);
var aspectMask  = aspect.gt(45).and(aspect.lt(315));
var terrainMask = slopeMask.and(aspectMask);
// ============================================================
// 5. FUNGSI PREPROCESSING
// ============================================================
function preprocess(img) {
  var vv    = img.select('VV').focal_mean(30, 'circle', 'meters').rename('VV_dB');
  var vh    = img.select('VH').focal_mean(30, 'circle', 'meters').rename('VH_dB');
  var ratio = vv.subtract(vh).rename('VV_VH_ratio');
  return vv.addBands(vh)
    .addBands(ratio)
    .updateMask(terrainMask)
    .clip(aoi)
    .copyProperties(img, ['system:time_start']);
}


// ============================================================
// 6. LOOKUP TANGGAL PER MUSIM
// ============================================================
var seasonDateMap = {
  '2015_Kemarau': ['2015-04-11', '2015-11-20'],
  '2015_Hujan':   ['2015-11-21', '2016-05-10'],
  '2016_Kemarau': ['2016-05-11', '2016-09-30'],
  '2016_Hujan':   ['2016-10-01', '2017-04-30'],
  '2017_Kemarau': ['2017-05-01', '2017-11-10'],
  '2017_Hujan':   ['2017-11-11', '2018-05-10'],
  '2018_Kemarau': ['2018-05-11', '2018-10-31'],
  '2018_Hujan':   ['2018-11-01', '2019-04-30'],
  '2019_Kemarau': ['2019-05-01', '2019-11-10'],
  '2019_Hujan':   ['2019-11-11', '2020-04-30'],
  '2020_Kemarau': ['2020-04-01', '2020-10-20'],
  '2020_Hujan':   ['2020-10-21', '2021-03-31'],
  '2021_Kemarau': ['2021-04-01', '2021-09-30'],
  '2021_Hujan':   ['2021-10-01', '2022-04-20'],
  '2022_Kemarau': ['2022-04-21', '2022-10-31'],
  '2022_Hujan':   ['2022-11-01', '2023-03-31'],
  '2023_Kemarau': ['2023-04-01', '2023-11-20'],
  '2023_Hujan':   ['2023-11-21', '2024-04-30'],
  '2024_Kemarau': ['2024-05-01', '2024-10-31'],
  '2024_Hujan':   ['2024-11-01', '2025-04-30'],
  '2025_Kemarau': ['2025-05-01', '2025-09-30'],
  '2025_Hujan':   ['2025-10-01', '2026-03-20']
};

var seasons = [
  '2015_Kemarau','2015_Hujan','2016_Kemarau','2016_Hujan',
  '2017_Kemarau','2017_Hujan','2018_Kemarau','2018_Hujan',
  '2019_Kemarau','2019_Hujan','2020_Kemarau','2020_Hujan',
  '2021_Kemarau','2021_Hujan','2022_Kemarau','2022_Hujan',
  '2023_Kemarau','2023_Hujan','2024_Kemarau','2024_Hujan',
  '2025_Kemarau','2025_Hujan'
];


// ============================================================
// 7. KOMPOSIT MUSIMAN & STABLE MASK
// ============================================================
var monitoringList = seasons.map(function(label) {
  var dates = seasonDateMap[label];
  return s1.filterDate(dates[0], dates[1])
    .map(preprocess).median()
    .set('label', label)
    .set('system:time_start', ee.Date(dates[0]).millis());
});

var monitoring = ee.ImageCollection(monitoringList);

var monitoringClean = monitoring.map(function(img) {
  var cnt = img.select('VH_dB').reduceRegion({
    reducer: ee.Reducer.count(),
    geometry: aoi, scale: 100, bestEffort: true, maxPixels: 1e7
  });
  return img.set('pixelCount', ee.Number(cnt.get('VH_dB')));
}).filter(ee.Filter.gt('pixelCount', 10));

print('Jumlah citra pemantauan:', monitoringClean.size());

var vhStd      = monitoringClean.select('VH_dB').reduce(ee.Reducer.stdDev());
var stableMask = vhStd.lt(1.5);
var geomMask   = slopeMask.and(stableMask);


// ============================================================
// 8. EXPORT HELPER & STATE GLOBAL
// ============================================================
var currentExportImage = null;
var currentExportName  = 'hasil_pemantauan';

function setCurrentExportResult(defImg, degImg, label) {
  var combined = ee.Image(0)
    .where(degImg, 1).where(defImg, 2)
    .rename('kelas').toByte().clip(aoi);
  currentExportImage = combined;
  currentExportName  = (label || 'hasil_pemantauan').replace(/[^A-Za-z0-9_]+/g, '_');
}

var activeMode = 'season'; // 'season' | 'range' | 'longterm'

var seasonState = { deltaVH: null, confidence: null, magnitude: null, ts: null, label: null };
var rangeState  = { deltaVH: null, confidence: null, magnitude: null, ts: null, label: null };
var ltState     = {
  active: false,
  deltaVH: null, confidence: null, magnitude: null,
  persistCount: null, monitoringClean: null
};


// ============================================================
// 9. CUSUM & BOOTSTRAP
// ============================================================
function cusumFromResidual(ic) {
  var list = ic.toList(ic.size());
  var cusumList = ee.List.sequence(0, list.size().subtract(1))
    .iterate(function(i, prev) {
      prev = ee.List(prev);
      var prevImg = ee.Image(ee.Algorithms.If(
        prev.size().gt(0),
        ee.Image(prev.get(-1)),
        ee.Image(0).rename('CUSUM')
      ));
      var curr = ee.Image(list.get(i));
      return prev.add(
        prevImg.add(curr).rename('CUSUM')
          .set('system:time_start', curr.get('system:time_start'))
      );
    }, ee.List([]));
  return ee.ImageCollection.fromImages(cusumList);
}

function runBootstrap(residuals, magnitude, nBoot) {
  var seeds = ee.List.sequence(1, nBoot);
  var bootIC = ee.ImageCollection(seeds.map(function(seed) {
    var shuffled = residuals.randomColumn('rand', seed).sort('rand');
    var cr       = cusumFromResidual(shuffled);
    var maxR     = cr.select('CUSUM').reduce(ee.Reducer.max());
    var minR     = cr.select('CUSUM').reduce(ee.Reducer.min());
    return maxR.subtract(minR).rename('mag_rand');
  }));
  return bootIC.map(function(img) {
    return magnitude.gt(img).rename('exceed');
  }).reduce(ee.Reducer.sum()).divide(nBoot).rename('confidence');
}


// ============================================================
// 10. ANALISIS JANGKA PANJANG (LT) — dihitung di awal agar
//     ltState siap sebelum UI digunakan
// ============================================================
var lt_stableMask = monitoringClean.select('VH_dB').reduce(ee.Reducer.stdDev()).lt(1.5);
var lt_geomMask   = slopeMaskStrict.and(lt_stableMask);
var lt_ts         = monitoringClean.sort('system:time_start');
var lt_baseline   = lt_ts.select('VH_dB').mean();

var lt_vhEarly = monitoringClean.filter(ee.Filter.eq('label','2015_Kemarau')).first().select('VH_dB');
var lt_vhLate  = monitoringClean.filter(ee.Filter.eq('label','2025_Hujan')).first().select('VH_dB');
var lt_deltaVH = lt_vhLate.subtract(lt_vhEarly).rename('deltaVH');

var lt_vhMean      = monitoringClean.select('VH_dB').mean();
var lt_forestMask  = lt_vhMean.gt(-22);
var lt_ratioMean   = monitoringClean.select('VV_VH_ratio').mean();
var lt_ratioMask   = lt_ratioMean.lt(8);
var lt_candidateMask = lt_deltaVH.lt(-0.6)
  .and(lt_forestMask).and(lt_ratioMask).and(slopeMaskStrict);

var lt_residuals = lt_ts.map(function(img) {
  return img.select('VH_dB')
    .updateMask(lt_geomMask)
    .subtract(lt_baseline)
    .updateMask(lt_candidateMask)
    .rename('residual')
    .copyProperties(img, ['system:time_start', 'label']);
});

var lt_cusumCol  = cusumFromResidual(lt_residuals);
var lt_magnitude = lt_cusumCol.select('CUSUM').reduce(ee.Reducer.max())
  .subtract(lt_cusumCol.select('CUSUM').reduce(ee.Reducer.min()))
  .rename('CUSUM_magnitude').updateMask(lt_candidateMask);

var lt_confidence = runBootstrap(lt_residuals, lt_magnitude, 100)
  .updateMask(lt_candidateMask);

var lt_residualStdDev  = lt_residuals.reduce(ee.Reducer.stdDev())
  .rename('residual_stddev').updateMask(lt_candidateMask);
var lt_consistencyMask = lt_residualStdDev.gt(0.25).updateMask(lt_candidateMask);

var lt_magStats = lt_magnitude.reduceRegion({
  reducer: ee.Reducer.percentile([50, 75, 85, 90, 95]),
  geometry: aoi, scale: 30, bestEffort: true, maxPixels: 1e8
});
var lt_magP50 = ee.Number(lt_magStats.get('CUSUM_magnitude_p50'));
var lt_magP90 = ee.Number(lt_magStats.get('CUSUM_magnitude_p90'));
var lt_magP95 = ee.Number(lt_magStats.get('CUSUM_magnitude_p95'));

var lt_persistCount = lt_residuals
  .map(function(img) { return img.lt(-0.3).rename('persist'); })
  .sum().rename('persist_count').updateMask(lt_candidateMask);
var lt_persistMask = lt_persistCount.gte(2);

var lt_deforestation_raw = lt_deltaVH.lt(-1.5)
  .and(lt_confidence.gte(0.75))
  .and(lt_consistencyMask).and(lt_candidateMask);
var lt_degradation_raw = lt_deltaVH.lt(-0.8)
  .and(lt_deltaVH.gte(-1.5))
  .and(lt_magnitude.gte(lt_magP50)).and(lt_magnitude.lt(lt_magP90))
  .and(lt_confidence.gte(0.65))
  .and(lt_consistencyMask).and(lt_candidateMask)
  .and(lt_deforestation_raw.not());

var lt_deforestationClean = lt_deforestation_raw
  .updateMask(lt_deforestation_raw.connectedPixelCount(8, true).gte(3))
  .updateMask(lt_persistMask).selfMask().clip(aoi);
var lt_degradationClean = lt_degradation_raw
  .updateMask(lt_degradation_raw.connectedPixelCount(8, true).gte(4))
  .updateMask(lt_persistMask).selfMask().clip(aoi);

ltState.active          = true;
ltState.deltaVH         = lt_deltaVH;
ltState.confidence      = lt_confidence;
ltState.magnitude       = lt_magnitude;
ltState.persistCount    = lt_persistCount;
ltState.monitoringClean = monitoringClean;

print('LT analysis ready');


// ============================================================
// 11. computeOneSeason — menyimpan ke seasonState
// ============================================================
function computeOneSeason(seasonLabel, callback) {
  var dates     = seasonDateMap[seasonLabel];
  var dateStart = dates[0];
  var dateEnd   = dates[1];

  var ts = s1.filterDate(dateStart, dateEnd)
    .map(preprocess).sort('system:time_start');
  ts = ts.map(function(img) {
    return img.set('hasBands', img.bandNames().size().gt(0));
  }).filter(ee.Filter.eq('hasBands', 1));
  ts = ts.map(function(img) {
    var cnt = img.select('VH_dB').reduceRegion({
      reducer: ee.Reducer.count(), geometry: aoi,
      scale: 100, bestEffort: true, maxPixels: 1e7
    });
    return img.set('pixelCount', ee.Number(cnt.get('VH_dB')));
  }).filter(ee.Filter.gt('pixelCount', 10));

  ts.size().evaluate(function(count) {
    if (count < 2) { callback(null); return; }

    var tsReduced;
    if (count > 15) {
      var start   = ee.Date(dateStart);
      var end     = ee.Date(dateEnd);
      var nMonths = end.difference(start, 'month').round();
      tsReduced = ee.ImageCollection(
        ee.List.sequence(0, nMonths.subtract(1)).map(function(m) {
          var ini = start.advance(m, 'month');
          var fin = ini.advance(1, 'month');
          var col = ts.filterDate(ini, fin);
          return ee.Algorithms.If(col.size().gt(0),
            col.median().set('system:time_start', ini.millis()), null);
        })
      ).filter(ee.Filter.notNull(['system:time_start']));
    } else { tsReduced = ts; }

    var isSeason = seasonLabel.indexOf('Kemarau') >= 0 ? 'Kemarau' : 'Hujan';
    var baselineSeasons = [];
    for (var si = 0; si < seasons.length; si++) {
      if (seasons[si].indexOf(isSeason) >= 0) {
        baselineSeasons.push(seasons[si]);
        if (baselineSeasons.length === 5) break;
      }
    }
    var baselineImgs = baselineSeasons.map(function(s) {
      var d = seasonDateMap[s];
      return s1.filterDate(d[0], d[1]).map(preprocess).median()
        .set('system:time_start', ee.Date(d[0]).millis());
    });
    var baselineCollection = ee.ImageCollection(baselineImgs)
      .map(function(img) {
        var cnt = img.select('VH_dB').reduceRegion({
          reducer: ee.Reducer.count(), geometry: aoi,
          scale: 100, bestEffort: true, maxPixels: 1e7
        });
        return img.set('pixelCount', ee.Number(cnt.get('VH_dB')));
      }).filter(ee.Filter.gt('pixelCount', 10));

    baselineCollection.size().evaluate(function(baseCount) {
      if (baseCount < 1) { callback(null); return; }

      var baseline  = baselineCollection.select('VH_dB').mean();
      var residuals = tsReduced.map(function(img) {
        return img.select('VH_dB').updateMask(geomMask)
          .subtract(baseline).rename('residual')
          .copyProperties(img, ['system:time_start']);
      });
      residuals = residuals.map(function(img) {
        var cnt = img.reduceRegion({
          reducer: ee.Reducer.count(), geometry: aoi,
          scale: 100, bestEffort: true, maxPixels: 1e7
        });
        return img.set('rCount', ee.Number(cnt.get('residual')));
      }).filter(ee.Filter.gt('rCount', 10));

      residuals.size().evaluate(function(rCount) {
        if (rCount < 2) { callback(null); return; }

        var cusumCol = cusumFromResidual(residuals);
        var mag = cusumCol.select('CUSUM').reduce(ee.Reducer.max())
          .subtract(cusumCol.select('CUSUM').reduce(ee.Reducer.min()))
          .rename('magnitude');
        var conf  = runBootstrap(residuals, mag, 7);
        var stats = mag.reduceRegion({
          reducer: ee.Reducer.percentile([90, 95]),
          geometry: aoi, scale: 100, bestEffort: true, maxPixels: 1e8
        });
        var p90 = ee.Number(stats.get('magnitude_p90'));
        var p95 = ee.Number(stats.get('magnitude_p95'));

        var vhBase     = baselineCollection.select('VH_dB').mean();
        var vhCurr     = tsReduced.select('VH_dB').mean();
        var deltaLocal = vhCurr.subtract(vhBase).rename('deltaLocal');

        var deforestation = conf.gte(0.80).and(mag.gte(p95)).and(deltaLocal.lt(-0.5));
        var degradation   = conf.gte(0.70).and(conf.lt(0.80))
          .and(mag.gte(p90)).and(mag.lt(p95));

        var deforestationClean = deforestation
          .updateMask(deforestation.connectedPixelCount(25, true).gte(3));
        var degradationClean   = degradation
          .updateMask(degradation.connectedPixelCount(25, true).gte(3));

        // ── Simpan ke seasonState ──────────────────────────
        seasonState.ts         = tsReduced;
        seasonState.magnitude  = mag;
        seasonState.confidence = conf;
        seasonState.deltaVH    = deltaLocal;
        seasonState.label      = seasonLabel;
        activeMode = 'season';
        updateModeIndicator();

        setCurrentExportResult(deforestationClean, degradationClean, seasonLabel);

        callback({
          deforestation: deforestationClean,
          degradation:   degradationClean,
          mag: mag, conf: conf, cusumCol: cusumCol
        });
      });
    });
  });
}


// ============================================================
// 12. runAnalysis — untuk range, menyimpan ke rangeState
// ============================================================
function runAnalysis(dateStart, dateEnd, label, statusLabel) {
  var ts = s1.filterDate(dateStart, dateEnd)
    .map(preprocess).sort('system:time_start');
  ts = ts.map(function(img) {
    return img.set('hasBands', img.bandNames().size().gt(0));
  }).filter(ee.Filter.eq('hasBands', 1));
  ts = ts.map(function(img) {
    var cnt = img.select('VH_dB').reduceRegion({
      reducer: ee.Reducer.count(), geometry: aoi,
      scale: 100, bestEffort: true, maxPixels: 1e7
    });
    return img.set('pixelCount', ee.Number(cnt.get('VH_dB')));
  }).filter(ee.Filter.gt('pixelCount', 10));

  ts.size().evaluate(function(count) {
    print('Jumlah citra valid untuk ' + label + ':', count);
    if (count < 2) {
      statusLabel.setValue('Data tidak cukup (' + count + ' citra).');
      return;
    }

    var tsReduced;
    if (count > 15) {
      var start   = ee.Date(dateStart);
      var end     = ee.Date(dateEnd);
      var nMonths = end.difference(start, 'month').round();
      tsReduced = ee.ImageCollection(
        ee.List.sequence(0, nMonths.subtract(1)).map(function(m) {
          var ini = start.advance(m, 'month');
          var fin = ini.advance(1, 'month');
          var col = ts.filterDate(ini, fin);
          return ee.Algorithms.If(col.size().gt(0),
            col.median().set('system:time_start', ini.millis()), null);
        })
      ).filter(ee.Filter.notNull(['system:time_start']));
    } else { tsReduced = ts; }

    var isSeason = label.indexOf('Kemarau') >= 0 ? 'Kemarau' : 'Hujan';
    var baselineSeasons = [];
    for (var si = 0; si < seasons.length; si++) {
      if (seasons[si].indexOf(isSeason) >= 0) {
        baselineSeasons.push(seasons[si]);
        if (baselineSeasons.length === 5) break;
      }
    }
    var baselineImgs = baselineSeasons.map(function(s) {
      var d = seasonDateMap[s];
      return s1.filterDate(d[0], d[1]).map(preprocess).median()
        .set('system:time_start', ee.Date(d[0]).millis());
    });
    var baselineCollection = ee.ImageCollection(baselineImgs)
      .map(function(img) {
        var cnt = img.select('VH_dB').reduceRegion({
          reducer: ee.Reducer.count(), geometry: aoi,
          scale: 100, bestEffort: true, maxPixels: 1e7
        });
        return img.set('pixelCount', ee.Number(cnt.get('VH_dB')));
      }).filter(ee.Filter.gt('pixelCount', 10));

    var baseline  = baselineCollection.select('VH_dB').mean();
    var residuals = tsReduced.map(function(img) {
      return img.select('VH_dB').updateMask(geomMask)
        .subtract(baseline).rename('residual')
        .copyProperties(img, ['system:time_start']);
    });
    residuals = residuals.map(function(img) {
      var cnt = img.reduceRegion({
        reducer: ee.Reducer.count(), geometry: aoi,
        scale: 100, bestEffort: true, maxPixels: 1e7
      });
      return img.set('rCount', ee.Number(cnt.get('residual')));
    }).filter(ee.Filter.gt('rCount', 10));

    var cusumCol = cusumFromResidual(residuals);
    var mag = cusumCol.select('CUSUM').reduce(ee.Reducer.max())
      .subtract(cusumCol.select('CUSUM').reduce(ee.Reducer.min()))
      .rename('magnitude');
    var conf  = runBootstrap(residuals, mag, 7);
    var stats = mag.reduceRegion({
      reducer: ee.Reducer.percentile([90, 95]),
      geometry: aoi, scale: 100, bestEffort: true, maxPixels: 1e8
    });
    var p90 = ee.Number(stats.get('magnitude_p90'));
    var p95 = ee.Number(stats.get('magnitude_p95'));

    var vhBase     = baselineCollection.select('VH_dB').mean();
    var vhCurr     = tsReduced.select('VH_dB').mean();
    var deltaLocal = vhCurr.subtract(vhBase).rename('deltaLocal');

    var deforestation = conf.gte(0.80).and(mag.gte(p95)).and(deltaLocal.lt(-0.5));
    var degradation   = conf.gte(0.70).and(conf.lt(0.80))
      .and(mag.gte(p90)).and(mag.lt(p95));

    var deforestationClean = deforestation
      .updateMask(deforestation.connectedPixelCount(25, true).gte(3));
    var degradationClean   = degradation
      .updateMask(degradation.connectedPixelCount(25, true).gte(3));

    // ── Simpan state ──────────────────────────────────────
    var isRangeLabel = label.indexOf('→') >= 0;
    if (isRangeLabel) {
      rangeState.ts         = tsReduced;
      rangeState.magnitude  = mag;
      rangeState.confidence = conf;
      rangeState.deltaVH    = deltaLocal;
      rangeState.label      = label;
      activeMode = 'range';
    } else {
      seasonState.ts         = tsReduced;
      seasonState.magnitude  = mag;
      seasonState.confidence = conf;
      seasonState.deltaVH    = deltaLocal;
      seasonState.label      = label;
      activeMode = 'season';
    }
    updateModeIndicator();
    setCurrentExportResult(deforestationClean, degradationClean, label);

    appMap.addLayer(deforestationClean.updateMask(deforestationClean),
      { palette: 'red' }, 'Deforestasi - ' + label);
    appMap.addLayer(degradationClean.updateMask(degradationClean),
      { palette: 'orange' }, 'Degradasi - ' + label);
    appMap.addLayer(mag,
      { min: 0, max: 3, palette: ['white', 'yellow', 'orange', 'red'] },
      'Magnitudo - ' + label, false);
    appMap.addLayer(conf,
      { min: 0, max: 1, palette: ['white', 'cyan', 'blue'] },
      'Confidence - ' + label, false);

    statusLabel.setValue('Selesai: ' + label);
  });
}


// ============================================================
// 13. WRAPPER MUSIMAN & RENTANG
// ============================================================
function analyzeSeasonRange(seasonStart, seasonEnd, statusLabel) {
  var idxStart = seasons.indexOf(seasonStart);
  var idxEnd   = seasons.indexOf(seasonEnd);
  if (idxStart < 0 || idxEnd < 0 || idxStart >= idxEnd) {
    statusLabel.setValue('⚠ Rentang tidak valid'); return;
  }
  runAnalysis(
    seasonDateMap[seasonStart][0],
    seasonDateMap[seasonEnd][1],
    seasonStart + ' → ' + seasonEnd,
    statusLabel
  );
}

function computeRangeStats(selStart, selEnd, statusLabel, chartPanel) {
  var rangeSeasons = seasons.slice(
    seasons.indexOf(selStart), seasons.indexOf(selEnd) + 1
  );
  statusLabel.setValue('Menghitung statistik ' + rangeSeasons.length + ' musim...');
  chartPanel.clear();
  chartPanel.add(ui.Label('Sedang menghitung...', { fontSize: '11px', color: '#666' }));

  var results = [];
  rangeSeasons.forEach(function(sl) {
    computeOneSeason(sl, function(result) {
      if (!result) {
        results.push({ season: sl, def_ha: 0, deg_ha: 0 });
      } else {
        var defArea = result.deforestation.multiply(ee.Image.pixelArea())
          .rename('def_area').reduceRegion({
            reducer: ee.Reducer.sum(), geometry: aoi,
            scale: 30, bestEffort: true, maxPixels: 1e9
          });
        var degArea = result.degradation.multiply(ee.Image.pixelArea())
          .rename('deg_area').reduceRegion({
            reducer: ee.Reducer.sum(), geometry: aoi,
            scale: 30, bestEffort: true, maxPixels: 1e9
          });
        defArea.evaluate(function(dv) {
          degArea.evaluate(function(gv) {
            results.push({
              season: sl,
              def_ha: dv && dv.def_area ? Math.round(dv.def_area / 10000 * 100) / 100 : 0,
              deg_ha: gv && gv.deg_area ? Math.round(gv.deg_area / 10000 * 100) / 100 : 0
            });
            if (results.length === rangeSeasons.length) {
              results.sort(function(a, b) {
                return seasons.indexOf(a.season) - seasons.indexOf(b.season);
              });
              showChart(results, selStart, selEnd, chartPanel, statusLabel);
            }
          });
        });
        return;
      }
      if (results.length === rangeSeasons.length) {
        results.sort(function(a, b) {
          return seasons.indexOf(a.season) - seasons.indexOf(b.season);
        });
        showChart(results, selStart, selEnd, chartPanel, statusLabel);
      }
    });
  });
}

function showChart(results, selStart, selEnd, chartPanel, statusLabel) {
  chartPanel.clear();
  var features = results.map(function(r) {
    return ee.Feature(null, {
      musim: r.season, def_ha: r.def_ha, deg_ha: r.deg_ha,
      total_ha: r.def_ha + r.deg_ha
    });
  });
  var fc = ee.FeatureCollection(features);

  chartPanel.add(ui.Label({
    value: 'Statistik: ' + selStart + ' → ' + selEnd,
    style: { fontWeight: 'bold', fontSize: '13px', margin: '0 0 6px 0' }
  }));
  var totalDef = results.reduce(function(s, r) { return s + r.def_ha; }, 0);
  var totalDeg = results.reduce(function(s, r) { return s + r.deg_ha; }, 0);
  chartPanel.add(ui.Label(
    'Deforestasi: ' + Math.round(totalDef * 100) / 100 + ' ha  |  ' +
    'Degradasi: ' + Math.round(totalDeg * 100) / 100 + ' ha  |  ' +
    'Musim: ' + results.length,
    { fontSize: '11px', color: '#333', margin: '0 0 8px 0' }
  ));
  chartPanel.add(
    ui.Chart.feature.byFeature({ features: fc, xProperty: 'musim', yProperties: ['def_ha', 'deg_ha'] })
      .setChartType('ColumnChart')
      .setOptions({
        title: 'Luas Deforestasi & Degradasi (' + selStart + ' → ' + selEnd + ')',
        hAxis: { title: 'Musim', slantedText: true, slantedTextAngle: 45 },
        vAxis: { title: 'Luas (ha)' },
        series: { 0: { color: 'red' }, 1: { color: 'orange' } },
        legend: { position: 'top' }, bar: { groupWidth: '70%' }
      })
  );
  chartPanel.add(
    ui.Chart.feature.byFeature({ features: fc, xProperty: 'musim', yProperties: ['def_ha', 'deg_ha', 'total_ha'] })
      .setChartType('LineChart')
      .setOptions({
        title: 'Tren Dinamika Gangguan Hutan (' + selStart + ' → ' + selEnd + ')',
        hAxis: { title: 'Musim', slantedText: true, slantedTextAngle: 45 },
        vAxis: { title: 'Luas (ha)' },
        series: {
          0: { color: 'red', lineWidth: 2, pointSize: 5 },
          1: { color: 'orange', lineWidth: 2, pointSize: 5 },
          2: { color: 'brown', lineWidth: 2, pointSize: 5, lineDashStyle: [4, 4] }
        },
        legend: { position: 'top' }
      })
  );
  chartPanel.add(ui.Button({
    label: 'X Tutup', style: { stretch: 'horizontal', margin: '6px 0 0 0' },
    onClick: function() { chartPanel.style().set('shown', false); }
  }));
  statusLabel.setValue('Grafik selesai: ' + selStart + ' → ' + selEnd);
}


// ============================================================
// 14. UI HELPERS
// ============================================================
function statRow(label, value, valueColor) {
  return ui.Panel([
    ui.Label({ value: label, style: { fontSize: '12px', color: '#555', margin: '0px', width: '130px' } }),
    ui.Label({ value: value, style: { fontSize: '12px', fontWeight: 'bold', color: valueColor || '#222', margin: '0px' } })
  ], ui.Panel.Layout.flow('horizontal'), { margin: '3px 0px', stretch: 'horizontal' });
}

function divider() {
  return ui.Panel([], null, { stretch: 'horizontal', height: '1px', backgroundColor: '#ddd', margin: '8px 0px' });
}

function kelasBadge(kelas) {
  var color = kelas === 'Indikatif Deforestasi' ? '#c0392b' :
              kelas === 'Indikatif Degradasi'   ? '#e67e22' : '#27ae60';
  var icon  = kelas === 'Indikatif Deforestasi' ? '🔴' :
              kelas === 'Indikatif Degradasi'   ? '🟠' : '🟢';
  return ui.Panel([ui.Label({
    value: icon + '  ' + kelas,
    style: { fontWeight: 'bold', fontSize: '13px', color: '#fff', margin: '0px', padding: '4px 10px', backgroundColor: color }
  })], null, { margin: '6px 0px 10px 0px' });
}

function ltKelasBadge(kelas) {
  var color = kelas === 'Deforestasi' ? '#c0392b' : kelas === 'Degradasi' ? '#e67e22' : '#27ae60';
  var icon  = kelas === 'Deforestasi' ? '🔴' : kelas === 'Degradasi' ? '🟠' : '🟢';
  return ui.Panel([ui.Label({
    value: icon + '  ' + kelas,
    style: { fontWeight: 'bold', fontSize: '13px', color: '#fff', margin: '0px', padding: '4px 10px', backgroundColor: color }
  })], null, { margin: '6px 0px 10px 0px' });
}

function sectionLabel(text) {
  return ui.Label({ value: text, style: { fontSize: '10px', color: '#888', fontWeight: 'bold', margin: '6px 0px 4px 0px' } });
}

function createHeader() {
  return ui.Panel([
    ui.Label({ value: 'Analisis Perubahan Hutan', style: { fontWeight: 'bold', fontSize: '15px', color: '#1a5c2a', margin: '0px' } }),
    ui.Button({ label: '✕', style: { fontSize: '13px', color: '#888', margin: '0px' },
      onClick: function() { infoPopup.style().set('shown', false); } })
  ], ui.Panel.Layout.flow('horizontal'),
  { stretch: 'horizontal', margin: '0px 0px 10px 0px', padding: '8px 12px', backgroundColor: '#eaf4ec', border: '1px solid #b2d8bc' });
}

function createLtHeader() {
  return ui.Panel([
    ui.Label({ value: 'Analisis Jangka Panjang (2015–2026)', style: { fontWeight: 'bold', fontSize: '13px', color: '#1a3a5c', margin: '0px' } }),
    ui.Button({ label: '✕', style: { fontSize: '13px', color: '#888', margin: '0px' },
      onClick: function() { ltPopup.style().set('shown', false); } })
  ], ui.Panel.Layout.flow('horizontal'),
  { stretch: 'horizontal', margin: '0px 0px 10px 0px', padding: '8px 12px', backgroundColor: '#e8f0fa', border: '1px solid #aac4e0' });
}

function showLoading() {
  infoPopup.clear(); infoPopup.style().set('shown', true);
  infoPopup.add(createHeader());
  infoPopup.add(ui.Label({ value: 'Memuat informasi...', style: { fontWeight: 'bold', fontSize: '13px', margin: '12px 0px 4px 0px' } }));
  infoPopup.add(ui.Label({ value: 'Mohon menunggu proses ekstraksi statistik temporal Sentinel-1.', style: { fontSize: '11px', color: 'gray', margin: '0px' } }));
}

function showLtLoading() {
  ltPopup.clear(); ltPopup.style().set('shown', true);
  ltPopup.add(createLtHeader());
  ltPopup.add(ui.Label({ value: 'Memuat data jangka panjang...', style: { fontWeight: 'bold', fontSize: '13px', margin: '12px 0px 4px 0px' } }));
  ltPopup.add(ui.Label({ value: 'Mohon menunggu ekstraksi statistik 22 musim Sentinel-1.', style: { fontSize: '11px', color: 'gray', margin: '0px' } }));
}


// ============================================================
// 15. POPUP & MODE INDIKATOR 
// ============================================================
var infoPopup = ui.Panel({
  style: { position: 'bottom-right', width: '400px', height: '420px',
    backgroundColor: 'white', padding: '12px', border: '1px solid #cccccc', shown: false }
});
appMap.add(infoPopup);

var ltPopup = ui.Panel({
  style: { position: 'bottom-left', width: '420px', height: '480px',
    backgroundColor: 'white', padding: '12px', border: '1px solid #aac4e0', shown: false }
});
appMap.add(ltPopup);

var chartPanel = ui.Panel({
  style: { width: '480px', position: 'bottom-left', padding: '10px', backgroundColor: 'white', shown: false }
});
appMap.add(chartPanel);

var ltChartPanel = ui.Panel({
  style: { position: 'bottom-right', width: '300px', padding: '12px',
    backgroundColor: 'white', border: '1px solid #ccc', shown: false }
});
appMap.add(ltChartPanel);

var ltCloseButton = ui.Button({
  label: 'X Tutup', style: { stretch: 'horizontal', margin: '0 0 6px 0' },
  onClick: function() { ltChartPanel.style().set('shown', false); }
});
ltChartPanel.add(ltCloseButton);

// Mode indicator overlay di peta
var modeIndicator = ui.Panel({
  widgets: [ui.Label({ value: 'Mode Aktif: Musiman',
    style: { fontSize: '11px', fontWeight: 'bold', color: '#1a5c2a', margin: '0px' } })],
  style: { position: 'top-right', backgroundColor: 'rgba(234,244,236,0.95)',
    padding: '6px 10px', border: '1px solid #b2d8bc', shown: true }
});
appMap.add(modeIndicator);

function updateModeIndicator() {
  modeIndicator.clear();
  var isLt    = activeMode === 'longterm';
  var txt     = isLt ? 'Mode Aktif: Analisis Jangka Panjang'
              : activeMode === 'range' ? '📊 Mode Aktif: Rentang Musim'
              : 'Mode Aktif: Musiman';
  var color   = isLt ? '#1a3a5c' : '#1a5c2a';
  var bgColor = isLt ? 'rgba(232,240,250,0.95)' : 'rgba(234,244,236,0.95)';
  var border  = isLt ? '1px solid #aac4e0' : '1px solid #b2d8bc';
  modeIndicator.style().set({ backgroundColor: bgColor, border: border });
  modeIndicator.add(ui.Label({ value: txt, style: { fontSize: '11px', fontWeight: 'bold', color: color, margin: '0px' } }));
}


// ============================================================
// 16. onClick HANDLER
// ============================================================
appMap.onClick(function(coords) {
  var point = ee.Geometry.Point([coords.lon, coords.lat]);
  if (activeMode === 'longterm') {
    handleLtClick(point);
  } else {
    handleSeasonClick(point);
  }
});

function handleSeasonClick(point) {
  showLoading();
  var state = (activeMode === 'range') ? rangeState : seasonState;

  if (!state || !state.deltaVH || !state.confidence || !state.magnitude) {
    infoPopup.clear(); infoPopup.style().set('shown', true);
    infoPopup.add(createHeader());
    infoPopup.add(ui.Label({
      value: activeMode === 'range'
        ? 'Silakan jalankan analisis rentang musim terlebih dahulu.'
        : 'Silakan jalankan analisis musiman terlebih dahulu.',
      style: { fontSize: '12px', color: '#c0392b', margin: '8px 0px' }
    }));
    return;
  }

  var sample = ee.Image.cat([
    state.deltaVH.rename('deltaVH'),
    state.confidence.rename('confidence'),
    state.magnitude.rename('magnitude')
  ]);

  sample.reduceRegion({
    reducer: ee.Reducer.first(), geometry: point,
    scale: 10, bestEffort: true, maxPixels: 1e8
  }).evaluate(function(result) {
    infoPopup.clear(); infoPopup.style().set('shown', true);
    infoPopup.add(createHeader());

    if (!result || Object.keys(result).length === 0) {
      infoPopup.add(ui.Label({ value: 'Tidak ada data pada lokasi yang dipilih.',
        style: { fontSize: '12px', color: '#888', margin: '8px 0px' } }));
      return;
    }

    var kelas = 'Tidak Terindikasi';
    if      (result.confidence >= 0.80) kelas = 'Indikatif Deforestasi';
    else if (result.confidence >= 0.70) kelas = 'Indikatif Degradasi';

    infoPopup.add(sectionLabel('HASIL INTERPRETASI'));
    infoPopup.add(kelasBadge(kelas));
    infoPopup.add(statRow('Mode', activeMode === 'range' ? 'Rentang Musim' : 'Musim Tunggal'));
    infoPopup.add(statRow('Periode', state.label));
    infoPopup.add(statRow('Confidence',
      (result.confidence * 100).toFixed(1) + ' %',
      result.confidence >= 0.80 ? '#c0392b' : result.confidence >= 0.70 ? '#e67e22' : '#27ae60'));
    infoPopup.add(statRow('Magnitude', Number(result.magnitude).toFixed(3)));
    infoPopup.add(statRow('Delta VH',
      Number(result.deltaVH).toFixed(2) + ' dB',
      result.deltaVH < -0.5 ? '#c0392b' : '#27ae60'));

    infoPopup.add(divider());
    infoPopup.add(sectionLabel('TREN TEMPORAL VH'));

    var lineColor = kelas === 'Indikatif Deforestasi' ? '#c0392b' :
                   kelas === 'Indikatif Degradasi'   ? '#e67e22' : '#27ae60';

    if (activeMode === 'range') {
      // Ambil label rentang: 'XXXX_Musim → YYYY_Musim'
      var rangeParts  = state.label.split(' → ');
      var rangeStart  = rangeParts[0];
      var rangeEnd    = rangeParts[1] || rangeStart;
      var idxS = seasons.indexOf(rangeStart);
      var idxE = seasons.indexOf(rangeEnd);
      if (idxS < 0) idxS = 0;
      if (idxE < 0) idxE = seasons.length - 1;

      // Ambil komposit musiman dalam rentang dari monitoringClean
      var rangeLabels  = seasons.slice(idxS, idxE + 1);
      var rangeIC = monitoringClean.filter(
        ee.Filter.inList('label', rangeLabels)
      ).sort('system:time_start');

      infoPopup.add(
        ui.Chart.image.series({
          imageCollection: rangeIC.select('VH_dB').filterBounds(point),
          region: point.buffer(30),
          reducer: ee.Reducer.mean(),
          scale: 30,
          xProperty: 'system:time_start'
        }).setChartType('LineChart').setOptions({
          title: 'Dinamika VH per Musim (' + rangeStart + ' → ' + rangeEnd + ')',
          titleTextStyle: { fontSize: 11, bold: true, color: '#333' },
          hAxis: {
            title: 'Musim / Waktu',
            format: 'MMM yyyy',
            textStyle: { fontSize: 9 },
            titleTextStyle: { fontSize: 10, italic: false },
            slantedText: true,
            slantedTextAngle: 45
          },
          vAxis: {
            title: 'VH (dB)',
            textStyle: { fontSize: 10 },
            titleTextStyle: { fontSize: 10, italic: false }
          },
          series: { 0: { color: lineColor, lineWidth: 2, pointSize: 5 } },
          legend: { position: 'none' },
          chartArea: { left: 44, top: 28, right: 8, bottom: 60, width: '100%' },
          backgroundColor: '#fafafa',
          height: 210
        })
      );
    } else {
      var selectedYear = parseInt(state.label.match(/\d{4}/)[0]);
      var startYear    = Math.max(2015, selectedYear - 5);
      var annualVH = ee.ImageCollection(
        ee.List.sequence(startYear, selectedYear).map(function(y) {
          y = ee.Number(y);
          var start = ee.Date.fromYMD(y, 1, 1);
          var col   = s1.filterDate(start, start.advance(1, 'year')).map(preprocess).select('VH_dB');
          return ee.Algorithms.If(col.size().gt(0),
            col.mean().rename('VH_dB').set('system:time_start', start.millis()).set('year', y), null);
        })
      ).filter(ee.Filter.notNull(['system:time_start']));

      infoPopup.add(
        ui.Chart.image.series({
          imageCollection: annualVH.filterBounds(point),
          region: point.buffer(20), reducer: ee.Reducer.mean(),
          scale: 30, xProperty: 'year'
        }).setChartType('LineChart').setOptions({
          title: 'Rata-rata VH Tahunan (' + startYear + '–' + selectedYear + ')',
          titleTextStyle: { fontSize: 12, bold: true, color: '#333' },
          hAxis: { title: 'Tahun', format: '####', textStyle: { fontSize: 10 },
            ticks: ee.List.sequence(startYear, selectedYear).getInfo() },
          vAxis: { title: 'VH (dB)', textStyle: { fontSize: 10 } },
          series: { 0: { color: lineColor, lineWidth: 2, pointSize: 5 } },
          legend: { position: 'none' },
          chartArea: { left: 48, top: 36, right: 12, bottom: 40, width: '100%' },
          backgroundColor: '#fafafa', height: 200
        })
      );
    }

    infoPopup.add(divider());
    infoPopup.add(sectionLabel('CATATAN INTERPRETASI'));
    var narasi = kelas === 'Indikatif Deforestasi'
      ? '🔴 Terjadi penurunan VH yang kuat dan persisten. Area memenuhi kriteria indikatif kehilangan tutupan hutan.'
      : kelas === 'Indikatif Degradasi'
      ? '🟠 Terdapat penurunan VH berintensitas sedang yang mengarah pada penurunan kualitas tutupan hutan.'
      : '🟢 Tidak ditemukan pola penurunan yang cukup kuat.';
    infoPopup.add(ui.Panel(
      [ui.Label({ value: narasi, style: { fontSize: '11px', color: '#444', margin: '0px' } })],
      null, { backgroundColor: '#f5f5f5', padding: '8px 10px', margin: '0px 0px 6px 0px', border: '1px solid #e0e0e0' }
    ));
    infoPopup.add(ui.Label({
      value: 'Penurunan nilai VH mengindikasikan berkurangnya biomassa dan kerapatan tajuk hutan dari tahun ke tahun.',
      style: { fontSize: '10px', color: '#999', margin: '4px 0px 0px 0px', fontStyle: 'italic' }
    }));
  });
}

function handleLtClick(point) {
  showLtLoading();
  if (!ltState.active) {
    ltPopup.clear(); ltPopup.style().set('shown', true);
    ltPopup.add(createLtHeader());
    ltPopup.add(ui.Label({ value: 'Data jangka panjang belum selesai.',
      style: { fontSize: '12px', color: '#c0392b', margin: '8px 0px' } }));
    return;
  }

  var sample = ee.Image.cat([
    ltState.deltaVH.rename('deltaVH'),
    ltState.confidence.rename('confidence'),
    ltState.magnitude.rename('magnitude'),
    ltState.persistCount.rename('persistCount')
  ]);

  sample.reduceRegion({
    reducer: ee.Reducer.first(), geometry: point,
    scale: 30, bestEffort: true, maxPixels: 1e8
  }).evaluate(function(result) {
    ltPopup.clear(); ltPopup.style().set('shown', true);
    ltPopup.add(createLtHeader());

    if (!result || Object.keys(result).length === 0 || result.deltaVH === null) {
      ltPopup.add(ui.Label({ value: 'Tidak ada data pada lokasi yang dipilih.',
        style: { fontSize: '12px', color: '#888', margin: '8px 0px' } }));
      return;
    }

    var dvh  = result.deltaVH;
    var conf = result.confidence;
    var mag  = result.magnitude;

    var kelas = 'Tidak Terindikasi';
    if      (dvh < -1.5 && conf >= 0.75) kelas = 'Deforestasi';
    else if (dvh < -0.8 && conf >= 0.65) kelas = 'Degradasi';

    ltPopup.add(sectionLabel('HASIL KLASIFIKASI JANGKA PANJANG'));
    ltPopup.add(ltKelasBadge(kelas));
    ltPopup.add(statRow('Periode', '2015 – 2026'));
    ltPopup.add(statRow('Total Musim', '22 komposit musiman'));
    ltPopup.add(divider());
    ltPopup.add(sectionLabel('STATISTIK PIKSEL'));
    ltPopup.add(statRow('Delta VH (2015→2024)', Number(dvh).toFixed(2) + ' dB',
      dvh < -1.5 ? '#c0392b' : dvh < -0.8 ? '#e67e22' : '#27ae60'));
    ltPopup.add(statRow('Confidence', (conf * 100).toFixed(1) + ' %',
      conf >= 0.75 ? '#c0392b' : conf >= 0.65 ? '#e67e22' : '#27ae60'));
    ltPopup.add(statRow('CUSUM Magnitude', Number(mag).toFixed(3)));
    ltPopup.add(statRow('Persistensi Negatif', result.persistCount + ' musim',
      result.persistCount >= 3 ? '#c0392b' : '#27ae60'));
    ltPopup.add(divider());
    ltPopup.add(sectionLabel('TIME SERIES VH (2015–2026)'));
    ltPopup.add(
      ui.Chart.image.series({
        imageCollection: ltState.monitoringClean.select('VH_dB').filterBounds(point),
        region: point.buffer(30), reducer: ee.Reducer.mean(),
        scale: 30, xProperty: 'system:time_start'
      }).setChartType('LineChart').setOptions({
        title: 'Tren VH per Musim (22 komposit)',
        titleTextStyle: { fontSize: 11, bold: true, color: '#333' },
        hAxis: { title: 'Waktu', format: 'MMM yyyy', textStyle: { fontSize: 9 },
          slantedText: true, slantedTextAngle: 45 },
        vAxis: { title: 'VH (dB)', textStyle: { fontSize: 10 } },
        series: { 0: { color: kelas === 'Deforestasi' ? '#c0392b' :
                              kelas === 'Degradasi'   ? '#e67e22' : '#27ae60',
                       lineWidth: 2, pointSize: 4 } },
        legend: { position: 'none' },
        chartArea: { left: 44, top: 28, right: 8, bottom: 60, width: '100%' },
        backgroundColor: '#fafafa', height: 200
      })
    );
    ltPopup.add(divider());
    ltPopup.add(sectionLabel('CATATAN INTERPRETASI'));
    var narasi = kelas === 'Deforestasi'
      ? '🔴 ΔVH < -1.5 dB & confidence ≥ 75% mengindikasikan kehilangan tutupan hutan persisten (2015–2026).'
      : kelas === 'Degradasi'
      ? '🟠 ΔVH -0.8 hingga -1.5 dB & confidence ≥ 65% menunjukkan penurunan kualitas tutupan hutan.'
      : '🟢 Tidak terdeteksi pola penurunan VH yang cukup kuat selama 2015–2026.';
    ltPopup.add(ui.Panel(
      [ui.Label({ value: narasi, style: { fontSize: '11px', color: '#444', margin: '0px' } })],
      null, { backgroundColor: '#f5f5f5', padding: '8px 10px', margin: '0px 0px 4px 0px', border: '1px solid #e0e0e0' }
    ));
    ltPopup.add(ui.Panel([
      sectionLabel('THRESHOLD YANG DIGUNAKAN'),
      statRow('Deforestasi', 'ΔVH < −1.5 dB  &  conf ≥ 75%'),
      statRow('Degradasi',   '−1.5 ≤ ΔVH < −0.8 dB  &  conf ≥ 65%'),
      statRow('Filtering',   'min. 3 piksel tersambung + ≥ 2 musim persisten')
    ], null, { backgroundColor: '#fafaf0', padding: '6px 10px', margin: '4px 0px 0px 0px', border: '1px solid #e8e8d0' }));
  });
}


// ============================================================
// 17. PANEL KIRI — Informasi & Keterangan
// ============================================================
mainPanelKiri.add(ui.Label({ value: 'Tentang Aplikasi',
  style: { fontSize: '13px', fontWeight: 'bold', color: '#1B5E20', margin: '0 0 8px 0' } }));
mainPanelKiri.add(ui.Label({ value: '──────────────────────',
  style: { color: '#c8e6c9', fontSize: '11px', margin: '0 0 6px 0' } }));
mainPanelKiri.add(ui.Label({
  value: 'Aplikasi ini digunakan sebagai deteksi awal area indikatif degradasi dan deforestasi yang dapat dipantau secara berkala berdasarkan dinamika hamburan citra satelit radar.',
  style: { fontSize: '12px', color: '#333', margin: '0 0 10px 0' }
}));
mainPanelKiri.add(ui.Label({
  value: 'Aplikasi difokuskan untuk memantau dampak pembangunan jalan alternatif dan peningkatan aktivitas ekonomi terhadap kondisi eksisting kawasan hutan Gunung Lawu.',
  style: { fontSize: '12px', color: '#333', margin: '0 0 10px 0' }
}));
mainPanelKiri.add(ui.Label({ value: '──────────────────────',
  style: { color: '#c8e6c9', fontSize: '11px', margin: '0 0 6px 0' } }));
mainPanelKiri.add(ui.Label({ value: 'Catatan',
  style: { fontSize: '12px', fontWeight: 'bold', color: '#E65100', margin: '0 0 4px 0' } }));
mainPanelKiri.add(ui.Label({
  value: 'Area terdeteksi bersifat indikatif dan memerlukan validasi lapangan. Luasan area deteksi tidak dimaksudkan sebagai justifikasi luas aktual di lapangan, melainkan estimasi spasial berdasarkan respon hamburan paling signifikan.',
  style: { fontSize: '11px', color: '#BF360C', backgroundColor: '#FFF3E0', padding: '8px', margin: '0 0 10px 0' }
}));
mainPanelKiri.add(ui.Label({ value: '──────────────────────',
  style: { color: '#c8e6c9', fontSize: '11px', margin: '0 0 6px 0' } }));
mainPanelKiri.add(ui.Label({ value: 'Informasi Teknis',
  style: { fontSize: '12px', fontWeight: 'bold', color: '#1B5E20', margin: '0 0 6px 0' } }));

function makeMetaRow(labelText, valueText) {
  var row = ui.Panel({ layout: ui.Panel.Layout.flow('horizontal'), style: { margin: '0 0 6px 0' } });
  row.add(ui.Label({ value: labelText, style: { fontSize: '11px', color: '#777', width: '90px' } }));
  row.add(ui.Label({ value: valueText, style: { fontSize: '11px', color: '#333', fontWeight: 'bold' } }));
  return row;
}
mainPanelKiri.add(makeMetaRow('Satelit',  'Sentinel-1 SAR'));
mainPanelKiri.add(makeMetaRow('Metode',   'CUSUM + Bootstrap'));
mainPanelKiri.add(makeMetaRow('Periode',  '2015 – 2025'));
mainPanelKiri.add(makeMetaRow('Resolusi', '10 meter (GRD)'));

mainPanelKiri.add(ui.Label({ value: '──────────────────────',
  style: { color: '#c8e6c9', fontSize: '11px', margin: '6px 0' } }));
mainPanelKiri.add(ui.Label({ value: 'Petunjuk Penggunaan',
  style: { fontSize: '12px', fontWeight: 'bold', color: '#333', margin: '0 0 8px 0' } }));

var steps = [
  '1. Aktifkan basemap "Satelit" di pojok kanan atas.',
  '2. Aktifkan checkbox "Fungsi Kawasan Hutan" dan atur transparansi.',
  '3. Pilih tipe pemantauan dan klik "Jalankan".',
  '4. Tunggu proses pengolahan data.',
  '5. Jika error (Layers berwarna merah), ulangi klik "Jalankan". Jangan melakukan navigasi kursor saat proses berlangsung.',
  '6. Tampilkan hasil dengan skala besar (zoom in) agar poligon terlihat.',
  '7. Klik "Lihat Grafik" untuk melihat dinamika perubahan.',
  '8. Klik "Unduh Hasil Pemantauan" untuk menyimpan hasil.'
];
steps.forEach(function(s) {
  mainPanelKiri.add(ui.Label({ value: s, style: { fontSize: '11px', color: '#333', margin: '0 0 6px 0' } }));
});

mainPanelKiri.add(ui.Label({
  value: '*Data spasial yang digunakan cukup besar. Semakin panjang rentang pemantauan, semakin lama data terproses. Mohon menunggu sekitar 2-10 menit.',
  style: { fontSize: '11px', color: '#BF360C', backgroundColor: '#FFF3E0', padding: '6px', margin: '4px 0 8px 0' }
}));

mainPanelKiri.add(ui.Label({ value: '──────────────────────',
  style: { color: '#c8e6c9', fontSize: '11px', margin: '4px 0' } }));
mainPanelKiri.add(ui.Label({ value: 'Video Tutorial',
  style: { fontSize: '12px', fontWeight: 'bold', color: '#333', margin: '0 0 4px 0' } }));
mainPanelKiri.add(ui.Label({
  value: 'Klik untuk membuka video tutorial aplikasi',
  targetUrl: 'https://youtu.be/GGWqRgF1bvI?si=rLkg0-WwhcdetiKR',
  style: { color: 'blue', fontSize: '11px', textDecoration: 'underline', margin: '0 0 8px 0' }
}));

mainPanelKiri.add(ui.Label({ value: '──────────────────────',
  style: { color: '#c8e6c9', fontSize: '11px', margin: '4px 0' } }));
mainPanelKiri.add(ui.Label({ value: 'Developer: Khosyi Nur Aliya',
  style: { fontSize: '10px', color: '#aaa', margin: '0' } }));
mainPanelKiri.add(ui.Label({ value: 'Undergraduate GIS Thesis · Universitas Gadjah Mada',
  style: { fontSize: '10px', color: '#aaa', margin: '0 0 8px 0' } }));

mainPanelKiri.add(ui.Label({ value: '──────────────────────',
  style: { color: '#c8e6c9', fontSize: '11px', margin: '4px 0' } }));



// ============================================================
// 18. PANEL KANAN — Kontrol & Analisis
// ============================================================
mainPanel.add(ui.Label({
  value: 'Pemetaan Indikatif Deforestasi dan Degradasi di Kawasan Hutan Gunung Lawu Tahun 2015–2025',
  style: { fontSize: '16px', fontWeight: 'bold', margin: '0 0 8px 0' }
}));
mainPanel.add(ui.Label({ value: '──────────────────────',
  style: { color: '#c8e6c9', fontSize: '11px', margin: '0 0 8px 0' } }));

// Layer kawasan hutan
var styled = aoi.map(function(feature) {
  var kelas = ee.String(feature.get('Nama_KH'));
  var color = ee.Algorithms.If(kelas.compareTo('Hutan Lindung').eq(0), 'green',
              ee.Algorithms.If(kelas.compareTo('Taman Hutan Raya').eq(0), 'purple',
              ee.Algorithms.If(kelas.compareTo('Taman Wisata Alam/Hutan Wisata').eq(0), 'yellow', 'gray')));
  return feature.set({ style: { color: color, fillColor: color, width: 1 } });
});
var styledLayer = styled.style({ styleProperty: 'style' });
var khMapLayer  = ui.Map.Layer(styledLayer, {}, 'Batas Kawasan Hutan', false);
appMap.layers().add(khMapLayer);

var khCheckbox = ui.Checkbox({
  label: 'Fungsi Kawasan Hutan Area Kajian', value: false, style: { fontSize: '12px' },
  onChange: function(val) { khMapLayer.setShown(val); }
});
var khOpacity = ui.Slider({
  min: 0, max: 1, value: 1, step: 0.1,
  onChange: function(value) { khMapLayer.setOpacity(value); }
});
mainPanel.add(khCheckbox);
mainPanel.add(ui.Label('Transparansi:', { fontSize: '11px' }));
mainPanel.add(khOpacity);

// Legenda
function makeLegendRow(color, name) {
  return ui.Panel({
    widgets: [
      ui.Label({ style: { backgroundColor: color, padding: '7px', margin: '0 8px 4px 0' } }),
      ui.Label(name)
    ],
    layout: ui.Panel.Layout.Flow('horizontal')
  });
}
var legendPanel = ui.Panel({ style: { fontSize: '12px' } });
legendPanel.add(ui.Label('Fungsi Kawasan Hutan', { fontWeight: 'bold', margin: '10px 0 4px 0' }));
legendPanel.add(makeLegendRow('green',  'Hutan Lindung'));
legendPanel.add(makeLegendRow('purple', 'Taman Hutan Raya (Kawasan Konservasi)'));
legendPanel.add(makeLegendRow('yellow', 'Taman Wisata Alam (Kawasan Konservasi)'));
legendPanel.add(ui.Label('Analisis Indikatif Deforestasi dan Degradasi', { fontWeight: 'bold', margin: '10px 0 4px 0' }));
legendPanel.add(makeLegendRow('red',    'Indikatif Deforestasi'));
legendPanel.add(makeLegendRow('orange', 'Indikatif Degradasi'));
mainPanel.add(legendPanel);

// ── 1. Analisis Per Musim ────────────────────────────────────
mainPanel.add(ui.Label({ value: '1. Pemantauan Per Musim',
  style: { fontWeight: 'bold', fontSize: '12px', backgroundColor: '#e8f5e9', padding: '4px', margin: '10px 0 5px 0' } }));

var seasonSelect = ui.Select({ items: seasons, placeholder: 'Pilih musim...', style: { stretch: 'horizontal' } });
var statusLabel1 = ui.Label('', { fontSize: '11px', color: '#444', margin: '4px 0 0 0' });

var runSeasonButton = ui.Button({
  label: 'Jalankan',
  style: { stretch: 'horizontal' },
  onClick: function() {
    var selected = seasonSelect.getValue();
    if (!selected) { statusLabel1.setValue('Pilih musim terlebih dahulu'); return; }
    statusLabel1.setValue('Memproses ' + selected + '...');
    appMap.layers().reset();
    appMap.addLayer(aoi, {}, 'AOI', false, 0.5);
    khMapLayer.setShown(khCheckbox.getValue());
    appMap.layers().add(khMapLayer);

    computeOneSeason(selected, function(result) {
      if (!result) { statusLabel1.setValue('Data tidak cukup untuk ' + selected); return; }

      appMap.addLayer(result.deforestation.updateMask(result.deforestation),
        { palette: 'red' }, 'Deforestasi - ' + selected);
      appMap.addLayer(result.degradation.updateMask(result.degradation),
        { palette: 'orange' }, 'Degradasi - ' + selected);

      result.deforestation.multiply(ee.Image.pixelArea()).rename('def_area')
        .reduceRegion({ reducer: ee.Reducer.sum(), geometry: aoi, scale: 30, bestEffort: true, maxPixels: 1e9 })
        .evaluate(function(defVal) {
          result.degradation.multiply(ee.Image.pixelArea()).rename('deg_area')
            .reduceRegion({ reducer: ee.Reducer.sum(), geometry: aoi, scale: 30, bestEffort: true, maxPixels: 1e9 })
            .evaluate(function(degVal) {
              var defHa = Math.round((defVal && defVal.def_area ? defVal.def_area / 10000 : 0) * 100) / 100;
              var degHa = Math.round((degVal && degVal.deg_area ? degVal.deg_area / 10000 : 0) * 100) / 100;
              statusLabel1.setValue(selected + ' | Deforestasi: ' + defHa + ' ha | Degradasi: ' + degHa + ' ha');
            });
        });
    });
  }
});
mainPanel.add(seasonSelect);
mainPanel.add(runSeasonButton);
mainPanel.add(statusLabel1);

// ── 2. Analisis Rentang Musim ────────────────────────────────
mainPanel.add(ui.Label({ value: '2. Pemantauan Rentang Musim',
  style: { fontWeight: 'bold', fontSize: '12px', backgroundColor: '#e3f2fd', padding: '4px', margin: '10px 0 5px 0' } }));
mainPanel.add(ui.Label('Musim Awal:', { fontSize: '10px' }));
var startSelect = ui.Select({ items: seasons, placeholder: 'Pilih musim awal...', style: { stretch: 'horizontal' } });
mainPanel.add(startSelect);
mainPanel.add(ui.Label('Musim Akhir:', { fontSize: '10px' }));
var endSelect = ui.Select({ items: seasons, placeholder: 'Pilih musim akhir...', style: { stretch: 'horizontal' } });
mainPanel.add(endSelect);
var statusLabel2 = ui.Label('', { fontSize: '11px', color: '#444', margin: '4px 0 0 0' });

var runRangeButton = ui.Button({
  label: 'Jalankan Pemantauan Rentang Musim',
  style: { stretch: 'horizontal' },
  onClick: function() {
    var selStart = startSelect.getValue();
    var selEnd   = endSelect.getValue();
    if (!selStart || !selEnd) { statusLabel2.setValue('Pilih musim awal dan akhir'); return; }
    if (seasons.indexOf(selStart) >= seasons.indexOf(selEnd)) {
      statusLabel2.setValue('Musim awal harus sebelum musim akhir'); return;
    }
    statusLabel2.setValue('Memproses...');
    appMap.layers().reset();
    appMap.addLayer(aoi, {}, 'AOI', false, 0.5);
    khMapLayer.setShown(khCheckbox.getValue());
    appMap.layers().add(khMapLayer);
    analyzeSeasonRange(selStart, selEnd, statusLabel2);
  }
});
mainPanel.add(runRangeButton);
mainPanel.add(statusLabel2);

mainPanel.add(ui.Label('Grafik Statistik:', { fontSize: '11px', margin: '6px 0 2px 0' }));
var statusLabel5 = ui.Label('', { fontSize: '11px', color: '#444', margin: '4px 0 0 0' });
var chartButton  = ui.Button({
  label: 'Lihat Grafik Statistik Rentang Musim',
  style: { stretch: 'horizontal', margin: '4px 0 0 0' },
  onClick: function() {
    var selStart = startSelect.getValue();
    var selEnd   = endSelect.getValue();
    if (!selStart || !selEnd) { statusLabel5.setValue('Pilih rentang dulu'); return; }
    chartPanel.style().set('shown', true);
    computeRangeStats(selStart, selEnd, statusLabel5, chartPanel);
  }
});
mainPanel.add(chartButton);
mainPanel.add(statusLabel5);



// ── 3. Analisis Jangka Panjang ───────────────────────────────
mainPanel.add(ui.Label({ value: '3. Pemantauan Jangka Panjang',
  style: { fontWeight: 'bold', fontSize: '12px', backgroundColor: '#fff3e0', padding: '4px', margin: '10px 0 5px 0' } }));
var ltStatusLabel = ui.Label('', { fontSize: '11px' });

// Tombol toggle mode Long Term
var ltModeBtn = ui.Button({
  label: 'Aktifkan Mode Jangka Panjang',
  style: { stretch: 'horizontal', margin: '6px 0px' },
  onClick: function() {
    if (activeMode === 'longterm') {
      activeMode = 'season';
      ltModeBtn.setLabel('Aktifkan Mode Jangka Panjang');
      ltPopup.style().set('shown', false);
    } else {
      activeMode = 'longterm';
      ltModeBtn.setLabel('Kembali ke Mode Musiman');
      infoPopup.style().set('shown', false);
    }
    updateModeIndicator();
  }
});
mainPanel.add(ltModeBtn);


var ltRunButton = ui.Button({
  label: 'Jalankan Pemantauan Jangka Panjang',
  style: { stretch: 'horizontal' },
  onClick: function() {
    ltStatusLabel.setValue('Memproses...');
    appMap.layers().reset();
    appMap.addLayer(aoi, {}, 'AOI', false, 0.5);
    khMapLayer.setShown(khCheckbox.getValue());
    appMap.layers().add(khMapLayer);
    appMap.addLayer(lt_deforestationClean.updateMask(lt_deforestationClean), { palette: 'red' }, 'Deforestasi LT');
    appMap.addLayer(lt_degradationClean.updateMask(lt_degradationClean), { palette: 'orange' }, 'Degradasi LT');
    setCurrentExportResult(lt_deforestationClean, lt_degradationClean, 'Jangka_Panjang_2015_2025');
    ltStatusLabel.setValue('Selesai.');
  }
});
mainPanel.add(ltRunButton);
mainPanel.add(ltStatusLabel);

mainPanel.add(ui.Label('Grafik Statistik:', { fontSize: '11px', margin: '6px 0 2px 0' }));
var ltStatsButton = ui.Button({
  label: 'Lihat Grafik Statistik Jangka Panjang',
  style: { stretch: 'horizontal', margin: '4px 0 0 0' },
  onClick: function() {
    ltStatusLabel.setValue('Menghitung luas...');
    ltChartPanel.style().set('shown', true);
    ltChartPanel.clear();
    ltChartPanel.add(ltCloseButton);
    ltChartPanel.add(ui.Label('Menghitung statistik luas...', { fontSize: '11px', color: '#666' }));

    var defImg = lt_deforestationClean.multiply(ee.Image.pixelArea()).rename('def_area');
    var degImg = lt_degradationClean.multiply(ee.Image.pixelArea()).rename('deg_area');

    defImg.reduceRegion({ reducer: ee.Reducer.sum(), geometry: aoi, scale: 30, bestEffort: true, maxPixels: 1e9 })
      .evaluate(function(defVal) {
        degImg.reduceRegion({ reducer: ee.Reducer.sum(), geometry: aoi, scale: 30, bestEffort: true, maxPixels: 1e9 })
          .evaluate(function(degVal) {
            var defHa   = Math.round((defVal && defVal.def_area ? defVal.def_area / 10000 : 0) * 100) / 100;
            var degHa   = Math.round((degVal && degVal.deg_area ? degVal.deg_area / 10000 : 0) * 100) / 100;
            var totalHa = Math.round((defHa + degHa) * 100) / 100;

            ltChartPanel.clear();
            ltChartPanel.add(ltCloseButton);
            ltChartPanel.add(ui.Label('Statistik Deforestasi & Degradasi 2015–2025',
              { fontWeight: 'bold', fontSize: '14px', margin: '0 0 4px 0' }));
            ltChartPanel.add(ui.Label('Gunung Lawu | Sentinel-1 SAR | CUSUM + Bootstrap',
              { fontSize: '10px', color: 'gray', margin: '0 0 10px 0' }));
            ltChartPanel.add(ui.Label('Deforestasi  :  ' + defHa + ' ha',
              { fontSize: '13px', color: 'red', margin: '2px 0' }));
            ltChartPanel.add(ui.Label('Degradasi    :  ' + degHa + ' ha',
              { fontSize: '13px', color: 'orange', margin: '2px 0' }));
            ltChartPanel.add(ui.Label('Total Gangguan:  ' + totalHa + ' ha',
              { fontSize: '13px', fontWeight: 'bold', color: '#333', margin: '2px 0 10px 0' }));

            var fc = ee.FeatureCollection([
              ee.Feature(null, { kelas: 'Deforestasi', luas_ha: defHa }),
              ee.Feature(null, { kelas: 'Degradasi',   luas_ha: degHa })
            ]);
            ltChartPanel.add(
              ui.Chart.feature.byFeature({ features: fc, xProperty: 'kelas', yProperties: ['luas_ha'] })
                .setChartType('ColumnChart')
                .setOptions({
                  title: 'Luas Kumulatif 2015–2025',
                  hAxis: { title: 'Kelas' }, vAxis: { title: 'Luas (ha)' },
                  colors: ['red', 'orange'], legend: { position: 'none' }, bar: { groupWidth: '50%' }
                })
            );
            ltStatusLabel.setValue('Deforestasi: ' + defHa + ' ha | Degradasi: ' + degHa + ' ha');
          });
      });
  }
});
mainPanel.add(ltStatsButton);

// ============================================================
// CLICK HINT (pojok kiri bawah peta)
// ============================================================
var clickHint = ui.Panel({
  widgets: [
    ui.Label({
      value: 'Klik poligon merah atau oranye untuk melihat tren perubahan hutan.',
      style: {
        fontWeight: 'bold',
        fontSize: '11px',
        color: '#333'
      }
    })
  ],
  style: {
    position: 'bottom-left',
    backgroundColor: 'rgba(255,255,255,0.92)',
    padding: '8px 12px',
    border: '1px solid #ccc'
  }
});

appMap.add(clickHint);

// ── 4. Unduh Hasil ───────────────────────────────────────────
mainPanel.add(ui.Label({ value: '4. Unduh Hasil Pemantauan',
  style: { fontSize: '12px', fontWeight: 'bold', backgroundColor: '#ede7f6', padding: '4px', margin: '10px 0 5px 0' } }));

var downloadStatusLabel = ui.Label('', { fontSize: '11px', color: '#444', margin: '4px 0 0 0' });
var downloadLink = ui.Label({ value: '', style: { shown: false, margin: '6px 0 0 0', color: 'blue' } });

var downloadButton = ui.Button({
  label: 'Unduh Hasil Pemantauan',
  style: { stretch: 'horizontal' },
  onClick: function() {
    if (!currentExportImage) {
      downloadStatusLabel.setValue('Jalankan analisis dulu sebelum mengunduh');
      downloadLink.style().set('shown', false);
      return;
    }
    downloadStatusLabel.setValue('Memproses tautan unduhan...');
    var url = currentExportImage.getDownloadURL({
      name: currentExportName, format: 'GEO_TIFF',
      region: aoi.geometry(), crs: 'EPSG:4326', scale: 30
    });
    downloadLink.setValue('Klik di sini untuk mengunduh hasil pemantauan');
    downloadLink.setUrl(url);
    downloadLink.style().set('shown', true);
    downloadStatusLabel.setValue('✓ Tautan selesai');
  }
});
mainPanel.add(downloadButton);
mainPanel.add(downloadStatusLabel);
mainPanel.add(downloadLink);

print('Aplikasi berhasil dimuat');