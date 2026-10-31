// Surface hydrology provenance. These resources are deliberately distinguished
// from measured 3D aquifer geometry and from datasets already loaded in the app.
export const WATERSHED_SOURCES = Object.freeze([
  {
    id: 'gadakwadi', title: 'Gadakwadi · original watershed and streams', publisher: 'Supplied ACWADAM field dataset',
    status: 'Available in this model', type: 'Georeferenced surface geometry',
    description: 'The original archive contains one watershed polygon (72 source vertices) and 37 drainage segments, labeled first to fourth order. The boundary and streams are draped over the real terrain surface.',
    limitation: 'A surface-water watershed is not an underground aquifer boundary. Source KML elevations are not used as measured terrain heights.',
    url: './assets/watershed-gadakwadi.geojson', linkLabel: 'Download original-source geometry (GeoJSON)', download: true,
    sourceFiles: ['watershed_Gadakwadi.kmz', 'Drainage.kmz'],
  },
  {
    id: 'pune-report', title: 'Pune · drainage and third-order basins', publisher: 'ACWADAM · supplied Pune aquifer report',
    status: 'Reference map', type: 'Published figure, not imported geometry',
    description: 'Figure 19 maps natural drainage and third-order basins within the Pune municipal boundary. The report describes 55 third-order sub-basins and provides a watershed-area table. See printed pages 37–41 (PDF pages 47–51).',
    limitation: 'This figure has not been converted into georeferenced polygons. It is a reference for review, not a 3D volume or a layer loaded on Gadakwadi.',
    url: './assets/pune-watersheds-figure.jpg', linkLabel: 'View Figure 19 from the supplied report', image: './assets/pune-watersheds-figure.jpg',
  },
  {
    id: 'icrisat-watersheds', title: 'ICRISAT · watershed research', publisher: 'International Crops Research Institute for the Semi-Arid Tropics',
    status: 'Research source', type: 'Watershed methods and research',
    description: 'ICRISAT documents participatory watershed management, learning landscapes, aquifer-recharging interventions and biophysical modeling of natural-resource use. Its official data directory points to Dataverse and the ICRISAT map portal.',
    limitation: 'No downloadable, ready-to-render 3D watershed geometry was verified here. The Dataverse and map portals returned HTTP 503 during verification on 30 October 2026; none of their data is represented as loaded in this model.',
    url: 'https://www.icrisat.org/research/landscapes-soil-fertility-and-water-management/about', linkLabel: 'View ICRISAT watershed research',
    additionalLinks: [{label: 'Official data directory', url: 'https://www.icrisat.org/resources/data/comparative-map-homepage'}],
  },
  {
    id: 'bhuvan', title: 'Bhuvan · Indian thematic GIS', publisher: 'ISRO / NRSC',
    status: 'GIS source portal', type: 'Indian thematic maps and OGC services',
    description: 'The official thematic portal provides Indian GIS layers and WMS access. It is a source for locating regional evidence and comparing mapped themes before importing a specific dataset.',
    limitation: 'Availability, map scale and reuse terms vary by layer. A watershed layer was not retrieved from the service during this build, so no Bhuvan geometry is claimed as loaded.',
    url: 'https://bhuvan-app1.nrsc.gov.in/thematic/thematic/index.php', linkLabel: 'Open Bhuvan thematic services',
  },
  {
    id: 'hydrobasins', title: 'HydroBASINS · regional catchment polygons', publisher: 'HydroSHEDS',
    status: 'Downloadable regional dataset', type: 'Nested watershed boundaries',
    description: 'Twelve nested basin levels cover the world, including India. The vector boundaries were derived from 15 arc-second HydroSHEDS grids, roughly 500 m at the equator. Asia shapefiles are available from the official download page.',
    limitation: 'Useful for regional context, not village-scale surveyed divides or aquifer geometry. The dataset is not loaded automatically here. Use and redistribution follow the HydroSHEDS license; the provider permits scientific, educational and commercial use.',
    url: 'https://www.hydrosheds.org/products/hydrobasins', linkLabel: 'View HydroBASINS data and license',
    additionalLinks: [{label: 'HydroBASINS technical documentation', url: 'https://data.hydrosheds.org/file/technical-documentation/HydroBASINS_TechDoc_v1c.pdf'}],
  },
  {
    id: 'hydrorivers', title: 'HydroRIVERS · regional river network', publisher: 'HydroSHEDS',
    status: 'Downloadable regional dataset', type: 'River lines, not watershed polygons',
    description: 'River reaches are linked to HydroBASINS sub-basins. Coverage includes rivers with upstream area of at least 10 km² or estimated average flow of at least 0.1 m³/s, derived from 15 arc-second grids.',
    limitation: 'Small village drains may be absent. River linework cannot establish a watershed divide or an underground aquifer. This dataset is not loaded automatically here.',
    url: 'https://www.hydrosheds.org/products/hydrorivers', linkLabel: 'View HydroRIVERS data and license',
  },
]);

const escape = value => String(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

export function watershedSourceCards({local = false} = {}) {
  return `<div class="source-card"><h3>Watersheds &amp; drainage</h3><p>${local ? 'Gold lines show the supplied watershed boundary; blue lines show the supplied streams. Both follow the terrain surface.' : 'No local watershed boundary or stream survey has been loaded for this region. The resources below are evidence sources to explore, not local data already included in this model.'}</p><p>A watershed describes where surface runoff drains. An aquifer describes water-bearing rock below ground; the boundaries need not match.</p></div>` + WATERSHED_SOURCES.map(source => `<div class="source-card" data-source="${source.id}"><small>${escape(source.id === 'gadakwadi' && !local ? 'Available for the Gadakwadi example' : source.status)} · ${escape(source.type)}</small><h3>${escape(source.title)}</h3><p>${escape(source.description)}</p>${source.image ? `<a href="${source.url}" target="_blank" rel="noopener"><img src="${source.image}" alt="ACWADAM Figure 19: Pune natural drainage and third-order surface-water basins" loading="lazy"></a>` : ''}<p class="micro">${escape(source.limitation)}</p><a href="${source.url}" ${source.download ? 'download="gadakwadi-watershed-and-drainage.geojson"' : 'target="_blank" rel="noopener"'}>${escape(source.linkLabel)} ↗</a>${(source.additionalLinks || []).map(link => `<p><a href="${link.url}" target="_blank" rel="noopener">${escape(link.label)} ↗</a></p>`).join('')}<p class="micro">${escape(source.publisher)}</p></div>`).join('');
}

export function hydrologySummary(fieldData) {
  return {
    watershedCount: fieldData?.watershed?.length || 0,
    streamCount: fieldData?.drainage?.length || 0,
    watershedLabel: 'Surface-water watershed boundary',
    drainageLabel: 'Mapped stream network',
    aquiferNotice: 'Surface drainage does not establish underground aquifer boundaries.',
  };
}

// Clip source polylines to the selected rectangle before draping. Bounds use the
// application's [north, west, south, east] order. No new stream is inferred.
function clipSegment(a, b, bounds) {
  const [north, west, south, east] = bounds;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let lo = 0, hi = 1;
  for (const [p, q] of [[-dx, a[0] - west], [dx, east - a[0]], [-dy, a[1] - south], [dy, north - a[1]]]) {
    if (p === 0) { if (q < 0) return null; }
    else { const t = q / p; if (p < 0) lo = Math.max(lo, t); else hi = Math.min(hi, t); if (lo > hi) return null; }
  }
  return [[a[0] + lo * dx, a[1] + lo * dy], [a[0] + hi * dx, a[1] + hi * dy]];
}

export function hydrologyLinework(fieldData, bounds) {
  if (!fieldData || !Array.isArray(bounds) || bounds.length !== 4 || bounds.some(n => !Number.isFinite(n))) return [];
  const lines = [];
  for (const [kind, items] of [['watershed', fieldData.watershed || []], ['drainage', fieldData.drainage || []]]) {
    for (const item of items) {
      let run = [];
      const flush = () => { if (run.length > 1) lines.push({kind, name: kind === 'watershed' ? 'Gadakwadi watershed boundary' : `${item.name} order stream`, points: run, color: kind === 'watershed' ? 0xe5e6a5 : 0x94d8e3}); run = []; };
      for (let i = 1; i < item.points.length; i++) {
        const segment = clipSegment(item.points[i - 1], item.points[i], bounds);
        if (!segment) { flush(); continue; }
        const last = run[run.length - 1];
        if (last && (Math.abs(last[0] - segment[0][0]) > 1e-10 || Math.abs(last[1] - segment[0][1]) > 1e-10)) flush();
        if (!run.length) run.push(segment[0]);
        run.push(segment[1]);
      }
      flush();
    }
  }
  return lines;
}
