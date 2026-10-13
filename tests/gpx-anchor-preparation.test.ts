import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import anchorCore from '../scripts/gpx-anchor-core.js';
import preparation from '../scripts/prepare-gpx-anchors.js';

const { parseOfficialGpxBytes, proposeOrderedAnchors } = anchorCore;
const {
  configuredMediaOrigins,
  emptyResolutions,
  fetchOfficialMediaBytes,
  loadAnchorResolutions,
  loadControlledAnchorHints,
  parseAnchorPreparationArguments,
  runGpxAnchorPreparation,
  warnAboutTlsException,
} = preparation;

test('loadControlledAnchorHints converts global chainages to chapter-local hints', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gthdf-anchor-hints-'));
  const citiesPath = join(directory, 'villes.csv');
  const chaptersPath = join(directory, 'chapitres.csv');
  writeFileSync(citiesPath, [
    'ID commune,Ville,Premier chapitre,Chaînage premier passage (m),Nombre de passages',
    'FR-00001,Alpha,Alpha → Beta,200,1',
    'FR-00002,Gamma,Beta → Gamma,1300,3',
  ].join('\n'));
  writeFileSync(chaptersPath, [
    'Slug chapitre,Chapitre,SHA-256 GPX,Distance GPX (m)',
    `alpha-beta,Alpha → Beta,${'a'.repeat(64)},1000`,
    `beta-gamma,Beta → Gamma,${'b'.repeat(64)},2000`,
  ].join('\n'));

  try {
    const hints = loadControlledAnchorHints(citiesPath, chaptersPath);

    assert.deepEqual(hints.anchors.get('alpha-beta:FR-00001'), {
      abChainageMetres: 200,
      cityName: 'Alpha',
      expectedOccurrences: 1,
      municipalityKey: 'FR-00001',
    });
    assert.deepEqual(hints.anchors.get('beta-gamma:FR-00002'), {
      abChainageMetres: 300,
      cityName: 'Gamma',
      expectedOccurrences: 3,
      municipalityKey: 'FR-00002',
    });
    assert.deepEqual(hints.sources.get('beta-gamma'), {
      distanceMetres: 2000,
      sourceSha256: 'b'.repeat(64),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('loadControlledAnchorHints explains how to provide a missing controlled CSV', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gthdf-anchor-hints-missing-'));
  const citiesPath = join(directory, 'villes.csv');
  const chaptersPath = join(directory, 'chapitres.csv');

  try {
    assert.throws(
      () => loadControlledAnchorHints(citiesPath, chaptersPath),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /CSV contrôlé des villes/);
        assert.match(error.message, /--cities/);
        assert.match(error.message, new RegExp(citiesPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        return true;
      }
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('loadControlledAnchorHints identifies every invalid chapter field', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gthdf-anchor-hints-invalid-'));
  const citiesPath = join(directory, 'villes.csv');
  const chaptersPath = join(directory, 'chapitres.csv');
  writeFileSync(
    citiesPath,
    'ID commune,Ville,Premier chapitre,Chaînage premier passage (m),Nombre de passages\n'
  );
  writeFileSync(chaptersPath, [
    'Slug chapitre,Chapitre,SHA-256 GPX,Distance GPX (m)',
    'alpha-beta,Alpha → Beta,not-a-hash,-1',
  ].join('\n'));

  try {
    assert.throws(
      () => loadControlledAnchorHints(citiesPath, chaptersPath),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /ligne 2/i);
        assert.match(error.message, /alpha-beta/);
        assert.match(error.message, /SHA-256 invalide/);
        assert.match(error.message, /distance invalide/);
        return true;
      }
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('loadAnchorResolutions expands one reviewed place into AB and BA junctions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gthdf-junction-pair-'));
  const resolutionsPath = join(directory, 'resolutions.json');
  writeFileSync(resolutionsPath, JSON.stringify({
    version: 1,
    anchors: [],
    junctions: [],
    junctionPairs: [
      {
        cityName: 'Arras',
        referenceKind: 'train_station',
        referenceLabel: 'Gare SNCF d’Arras',
        abChapterSlug: 'lille-a-arras',
        baChapterSlug: 'arras-a-conde-sur-l-escaut',
        decision: 'accepted_gap',
        reviewNote: 'Même lieu de jonction éditorial en AB et BA.',
      },
    ],
  }));

  try {
    const resolutions = loadAnchorResolutions(resolutionsPath);

    assert.deepEqual(resolutions.junctions.get('lille-a-arras:AB'), {
      decision: 'accepted_gap',
      reviewNote: 'Gare SNCF d’Arras — Même lieu de jonction éditorial en AB et BA.',
    });
    assert.deepEqual(resolutions.junctions.get('arras-a-conde-sur-l-escaut:BA'), {
      decision: 'accepted_gap',
      reviewNote: 'Gare SNCF d’Arras — Même lieu de jonction éditorial en AB et BA.',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('proposeOrderedAnchors projects passages onto ordered GPX edges', () => {
  const bytes = new TextEncoder().encode(`<gpx version="1.1"><trk><trkseg>
    <trkpt lat="0" lon="0"><ele>0</ele></trkpt>
    <trkpt lat="0" lon="1"><ele>10</ele></trkpt>
    <trkpt lat="0" lon="2"><ele>20</ele></trkpt>
    <trkpt lat="0" lon="3"><ele>30</ele></trkpt>
  </trkseg></trk></gpx>`);
  const proposals = proposeOrderedAnchors({
    bytes,
    passages: [
      { passageIndex: 0, city: { name: 'Départ', latitude: 0, longitude: 0.2 } },
      { passageIndex: 1, city: { name: 'Étape 1', latitude: 0, longitude: 1.2 } },
      { passageIndex: 2, city: { name: 'Étape 2', latitude: 0, longitude: 1.8 } },
      { passageIndex: 3, city: { name: 'Arrivée', latitude: 0, longitude: 2.8 } },
    ],
  });

  assert.equal(proposals.sourceSha256.length, 64);
  assert.equal(proposals.anchors[1].pointIndex, 1);
  assert.ok(Math.abs(proposals.anchors[1].fraction - 0.2) < 1e-9);
  assert.equal(proposals.anchors[2].pointIndex, 1);
  assert.ok(Math.abs(proposals.anchors[2].fraction - 0.8) < 1e-9);
  assert.ok(proposals.anchors[2].chainageMetres > proposals.anchors[1].chainageMetres);
  assert.equal(proposals.anchors.every((anchor: { status: string }) => anchor.status === 'proposed'), true);
});

test('proposeOrderedAnchors pins chapter boundary passages to GPX endpoints', () => {
  const bytes = new TextEncoder().encode(`<gpx version="1.1"><trk><trkseg>
    <trkpt lat="0" lon="0" />
    <trkpt lat="0" lon="1" />
    <trkpt lat="0" lon="2" />
    <trkpt lat="0" lon="3" />
  </trkseg></trk></gpx>`);
  const proposals = proposeOrderedAnchors({
    bytes,
    passages: [
      { passageIndex: 0, city: { name: 'Départ', latitude: 0, longitude: 0.4 } },
      { passageIndex: 1, city: { name: 'Intermédiaire', latitude: 0, longitude: 1.5 } },
      { passageIndex: 2, city: { name: 'Arrivée', latitude: 0, longitude: 2.6 } },
    ],
  });

  assert.equal(proposals.anchors[0].pointIndex, 0);
  assert.equal(proposals.anchors[0].fraction, 0);
  assert.equal(proposals.anchors[0].chainageMetres, 0);
  assert.equal(proposals.anchors[0].candidates.length, 1);

  const last = proposals.anchors[2];
  assert.equal(last.pointIndex, 2);
  assert.equal(last.fraction, 1);
  assert.equal(last.chainageMetres, proposals.distanceMetres);
  assert.equal(last.candidates.length, 1);
});

test('proposeOrderedAnchors pins a controlled primary passage to its source chainage', () => {
  const bytes = new TextEncoder().encode(`<gpx version="1.1"><trk><trkseg>
    <trkpt lat="0" lon="0" />
    <trkpt lat="0" lon="1" />
    <trkpt lat="0" lon="2" />
    <trkpt lat="0" lon="3" />
  </trkseg></trk></gpx>`);
  const source = parseOfficialGpxBytes(bytes);
  const chainageHintMetres = source.distanceMetres / 3;
  const proposals = proposeOrderedAnchors({
    source,
    passages: [
      { passageIndex: 0, city: { name: 'Départ', latitude: 0, longitude: 0 } },
      {
        passageIndex: 1,
        city: { name: 'Intermédiaire', latitude: 0, longitude: 2.8 },
        chainageHintMetres,
      },
      { passageIndex: 2, city: { name: 'Arrivée', latitude: 0, longitude: 3 } },
    ],
  });

  const primary = proposals.anchors[1];
  assert.ok(Math.abs(primary.chainageMetres - chainageHintMetres) < 1e-6);
  assert.ok(Math.abs(primary.projectedLongitude - 1) < 1e-9);
  assert.equal(primary.candidates.length, 1);
  assert.ok(primary.distanceToCityMetres > 100_000);
});

test('proposeOrderedAnchors uses a reviewed AB point to locate the BA occurrence', () => {
  const bytes = new TextEncoder().encode(`<gpx version="1.1"><trk><trkseg>
    <trkpt lat="0" lon="0" />
    <trkpt lat="0" lon="1" />
    <trkpt lat="0" lon="2" />
  </trkseg></trk></gpx>`);
  const proposals = proposeOrderedAnchors({
    bytes,
    passages: [
      { passageIndex: 0, city: { name: 'Départ', latitude: 0, longitude: 0 } },
      {
        passageIndex: 1,
        city: { name: 'Intermédiaire', latitude: 0, longitude: 1.8 },
        referencePoint: { latitude: 0, longitude: 0.2 },
      },
      { passageIndex: 2, city: { name: 'Arrivée', latitude: 0, longitude: 2 } },
    ],
  });

  const primary = proposals.anchors[1];
  assert.ok(Math.abs(primary.projectedLongitude - 0.2) < 1e-9);
  assert.ok(primary.distanceToCityMetres > 100_000);
});

test('proposeOrderedAnchors keeps distant occurrences instead of 64 adjacent edges', () => {
  const points = [
    '<trkpt lat="0.0001" lon="0" />',
    '<trkpt lat="0" lon="0.1" />',
    ...Array.from({ length: 100 }, (_, index) => (
      `<trkpt lat="${index % 2 === 0 ? '0.00001' : '-0.00001'}" lon="0.1" />`
    )),
    '<trkpt lat="0" lon="0" />',
    ...Array.from({ length: 100 }, (_, index) => (
      `<trkpt lat="${index % 2 === 0 ? '0.00001' : '-0.00001'}" lon="0" />`
    )),
  ];
  const bytes = new TextEncoder().encode(
    `<gpx version="1.1"><trk><trkseg>${points.join('')}</trkseg></trk></gpx>`
  );
  const proposals = proposeOrderedAnchors({
    bytes,
    passages: [
      { passageIndex: 0, city: { name: 'Départ', latitude: 0.0001, longitude: 0 } },
      { passageIndex: 1, city: { name: 'A', latitude: 0, longitude: 0 } },
      { passageIndex: 2, city: { name: 'B', latitude: 0, longitude: 0.1 } },
      { passageIndex: 3, city: { name: 'Arrivée', latitude: 0, longitude: 0 } },
    ],
  });

  assert.ok(proposals.anchors[1].chainageMetres < proposals.anchors[2].chainageMetres);
  assert.ok(proposals.anchors[1].distanceToCityMetres < 20);
  assert.ok(proposals.anchors[2].distanceToCityMetres < 20);
});

test('proposeOrderedAnchors exposes distant review candidates despite adjacent duplicates', () => {
  const repeatedFirstOccurrence = Array.from({ length: 50 }, (_, index) => (
    `<trkpt lat="${index % 2 === 0 ? '0.000001' : '-0.000001'}" lon="0" />`
  ));
  const points = [
    '<trkpt lat="0" lon="-0.01" />',
    '<trkpt lat="0" lon="0" />',
    ...repeatedFirstOccurrence,
    '<trkpt lat="0" lon="0.1" />',
    '<trkpt lat="0" lon="0" />',
    '<trkpt lat="0" lon="0.2" />',
  ];
  const bytes = new TextEncoder().encode(
    `<gpx version="1.1"><trk><trkseg>${points.join('')}</trkseg></trk></gpx>`
  );
  const proposals = proposeOrderedAnchors({
    bytes,
    passages: [
      { passageIndex: 0, city: { name: 'Départ', latitude: 0, longitude: -0.01 } },
      { passageIndex: 1, city: { name: 'A', latitude: 0, longitude: 0 } },
      { passageIndex: 2, city: { name: 'B', latitude: 0, longitude: 0.1 } },
      { passageIndex: 3, city: { name: 'Arrivée', latitude: 0, longitude: 0.2 } },
    ],
  });

  const cityA = proposals.anchors[1];
  assert.ok(cityA.ambiguityReasons.includes('competing_distant_occurrence'));
  assert.ok(cityA.candidates.some((candidate: { chainageMetres: number }) => (
    candidate.chainageMetres > cityA.chainageMetres + 10_000
  )));
});

test('proposeOrderedAnchors reuses an already parsed GPX source', () => {
  const bytes = new TextEncoder().encode(`<gpx version="1.1"><trk><trkseg>
    <trkpt lat="0" lon="0" />
    <trkpt lat="0" lon="1" />
  </trkseg></trk></gpx>`);
  const source = parseOfficialGpxBytes(bytes);

  const proposals = proposeOrderedAnchors({
    source,
    passages: [
      { passageIndex: 0, city: { name: 'A', latitude: 0, longitude: 0.1 } },
      { passageIndex: 1, city: { name: 'B', latitude: 0, longitude: 0.9 } },
    ],
  });

  assert.equal(proposals.sourceSha256, source.sourceSha256);
  assert.equal(proposals.anchors.length, 2);
});

test('configuredMediaOrigins trims comma-separated environment values', () => {
  const previous = process.env.STRAPI_MEDIA_ORIGINS;
  process.env.STRAPI_MEDIA_ORIGINS = 'https://media-one.example, https://media-two.example ';
  try {
    const origins = configuredMediaOrigins(' http://127.0.0.1:1337 ');
    assert.equal(origins.has('https://media-one.example'), true);
    assert.equal(origins.has('https://media-two.example'), true);
    assert.equal(origins.has('http://127.0.0.1:1337'), true);
  } finally {
    if (previous === undefined) delete process.env.STRAPI_MEDIA_ORIGINS;
    else process.env.STRAPI_MEDIA_ORIGINS = previous;
  }
});

test('fetchOfficialMediaBytes reports an invalid public Strapi URL clearly', async () => {
  const previous = process.env.STRAPI_PUBLIC_URL;
  process.env.STRAPI_PUBLIC_URL = 'not-a-url';
  try {
    await assert.rejects(
      () => fetchOfficialMediaBytes({ url: '/chapter.gpx' }),
      /URL publique Strapi est invalide/
    );
  } finally {
    if (previous === undefined) delete process.env.STRAPI_PUBLIC_URL;
    else process.env.STRAPI_PUBLIC_URL = previous;
  }
});

test('parseAnchorPreparationArguments keeps dry-run safe and requires confirmation for apply', () => {
  const options = parseAnchorPreparationArguments([], '/tmp/gthdf-anchor-test');

  assert.equal(options.apply, false);
  assert.equal(options.remote, false);
  assert.equal(options.cleverApp, 'gthdf-cms');
  assert.equal(options.allowSelfSignedTls, false);
  assert.match(options.citiesPath, /gthf-frontend.*villes\.csv$/);
  assert.match(options.chaptersPath, /gthf-frontend.*chapitres\.csv$/);
  assert.match(options.reportPath, /gpx-anchor-report\.json$/);
  assert.throws(
    () => parseAnchorPreparationArguments(['--apply'], '/tmp/gthdf-anchor-test'),
    /--confirm-apply/
  );
  assert.equal(
    parseAnchorPreparationArguments(
      ['--apply', '--confirm-apply'],
      '/tmp/gthdf-anchor-test'
    ).apply,
    true
  );
});

test('parseAnchorPreparationArguments accepts the external Clever database options', () => {
  const options = parseAnchorPreparationArguments([
    '--remote',
    '--clever-app',
    'app_test',
    '--allow-self-signed-tls',
    '--cities',
    'controlled/villes.csv',
    '--chapters',
    'controlled/chapitres.csv',
  ], '/tmp/gthdf-anchor-test');

  assert.equal(options.remote, true);
  assert.equal(options.cleverApp, 'app_test');
  assert.equal(options.allowSelfSignedTls, true);
  assert.equal(options.citiesPath, '/tmp/gthdf-anchor-test/controlled/villes.csv');
  assert.equal(options.chaptersPath, '/tmp/gthdf-anchor-test/controlled/chapitres.csv');
});

test('warnAboutTlsException makes the certificate exception visible', () => {
  const warnings: string[] = [];

  warnAboutTlsException({
    allowSelfSignedTls: true,
    remote: true,
  }, {
    warn: (message: string) => warnings.push(message),
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /certificat auto-signé/i);
  assert.match(warnings[0], /vérification/i);
});

test('runGpxAnchorPreparation is dry-run first, applies drafts and becomes idempotent', async () => {
  const bytes = {
    '/one-ab.gpx': new TextEncoder().encode('<gpx version="1.1"><trk><trkseg><trkpt lat="0" lon="0" /><trkpt lat="0" lon="1" /></trkseg></trk></gpx>'),
    '/one-ba.gpx': new TextEncoder().encode('<gpx version="1.1"><trk><trkseg><trkpt lat="0" lon="1" /><trkpt lat="0" lon="0" /></trkseg></trk></gpx>'),
    '/two-ab.gpx': new TextEncoder().encode('<gpx version="1.1"><trk><trkseg><trkpt lat="0" lon="1" /><trkpt lat="0" lon="0" /></trkseg></trk></gpx>'),
    '/two-ba.gpx': new TextEncoder().encode('<gpx version="1.1"><trk><trkseg><trkpt lat="0" lon="0" /><trkpt lat="0" lon="1" /></trkseg></trk></gpx>'),
  };
  const city = (documentId: string, name: string, longitude: number) => ({
    documentId,
    name,
    latitude: 0,
    longitude,
  });
  const chapters = [
    {
      documentId: 'chapter-one',
      slug: 'one',
      title: 'Un',
      displayOrder: 1,
      gpxFileAB: { url: '/one-ab.gpx' },
      gpxFileBA: { url: '/one-ba.gpx' },
      cityPassages: [
        { id: 1, role: 'start', featured: false, city: city('city-a', 'A', 0.2) },
        { id: 2, role: 'end', featured: false, city: city('city-b', 'B', 0.8) },
      ],
    },
    {
      documentId: 'chapter-two',
      slug: 'two',
      title: 'Deux',
      displayOrder: 2,
      gpxFileAB: { url: '/two-ab.gpx' },
      gpxFileBA: { url: '/two-ba.gpx' },
      cityPassages: [
        { id: 3, role: 'start', featured: false, city: city('city-b', 'B', 0.8) },
        { id: 4, role: 'end', featured: false, city: city('city-a', 'A', 0.2) },
      ],
    },
  ];
  let updateCalls = 0;
  const adapter = {
    listChapters: async () => chapters,
    updateChapter: async (documentId: string, update: any) => {
      updateCalls += 1;
      const chapter = chapters.find((item) => item.documentId === documentId)!;
      chapter.cityPassages = chapter.cityPassages.map((passage, index) => ({
        ...passage,
        gpxAnchorAB: update.cityPassages[index].gpxAnchorAB,
        gpxAnchorBA: update.cityPassages[index].gpxAnchorBA,
      })) as typeof chapter.cityPassages;
      Object.assign(chapter, {
        gpxJunctionAfterAB: update.gpxJunctionAfterAB,
        gpxJunctionAfterBA: update.gpxJunctionAfterBA,
      });
    },
  };
  const fetchMediaBytes = async (media: { url: keyof typeof bytes }) => bytes[media.url];

  const dryRun = await runGpxAnchorPreparation({
    adapter,
    fetchMediaBytes,
    resolutions: emptyResolutions(),
  });
  assert.equal(updateCalls, 0);
  assert.equal(dryRun.summary.ready, 2);
  assert.equal(dryRun.summary.proposedAnchors, 8);

  const applied = await runGpxAnchorPreparation({
    adapter,
    fetchMediaBytes,
    resolutions: emptyResolutions(),
    apply: true,
  });
  assert.equal(applied.summary.updated, 2);
  assert.equal(updateCalls, 2);

  for (const chapter of chapters as any[]) {
    for (const passage of chapter.cityPassages) {
      for (const anchor of [passage.gpxAnchorAB, passage.gpxAnchorBA]) {
        for (const field of [
          'fraction',
          'chainageMetres',
          'projectedLatitude',
          'projectedLongitude',
          'distanceToCityMetres',
        ]) {
          anchor[field] = String(anchor[field]);
        }
      }
    }
    chapter.gpxJunctionAfterAB.gapMetres = String(chapter.gpxJunctionAfterAB.gapMetres);
    chapter.gpxJunctionAfterBA.gapMetres = String(chapter.gpxJunctionAfterBA.gapMetres);
    chapter.gpxJunctionAfterAB.reviewNote = null;
    chapter.gpxJunctionAfterBA.reviewNote = null;
  }

  const secondApply = await runGpxAnchorPreparation({
    adapter,
    fetchMediaBytes,
    resolutions: emptyResolutions(),
    apply: true,
  });
  assert.equal(secondApply.summary.unchanged, 2);
  assert.equal(updateCalls, 2);
});

test('runGpxAnchorPreparation carries the controlled AB occurrence into BA', async () => {
  const abBytes = new TextEncoder().encode(`<gpx version="1.1"><trk><trkseg>
    <trkpt lat="0" lon="0" />
    <trkpt lat="0" lon="1" />
    <trkpt lat="0" lon="2" />
  </trkseg></trk></gpx>`);
  const baBytes = new TextEncoder().encode(`<gpx version="1.1"><trk><trkseg>
    <trkpt lat="0" lon="2" />
    <trkpt lat="0" lon="1" />
    <trkpt lat="0" lon="0" />
  </trkseg></trk></gpx>`);
  const abSource = parseOfficialGpxBytes(abBytes);
  const hintChainage = abSource.distanceMetres / 4;
  const chapter = {
    documentId: 'chapter-controlled',
    slug: 'controlled',
    title: 'Contrôlé',
    displayOrder: 1,
    gpxFileAB: { url: '/ab.gpx' },
    gpxFileBA: { url: '/ba.gpx' },
    cityPassages: [
      { id: 1, role: 'start', city: { documentId: 'a', municipalityKey: 'FR-A', name: 'A', latitude: 0, longitude: 0 } },
      { id: 2, role: 'intermediate', city: { documentId: 'b', municipalityKey: 'FR-B', name: 'B', latitude: 0, longitude: 1.8 } },
      { id: 3, role: 'end', city: { documentId: 'c', municipalityKey: 'FR-C', name: 'C', latitude: 0, longitude: 2 } },
    ],
  };
  const controlledHints = {
    anchors: new Map([['controlled:FR-B', {
      abChainageMetres: hintChainage,
      cityName: 'B',
      expectedOccurrences: 2,
      municipalityKey: 'FR-B',
    }]]),
    sources: new Map([['controlled', {
      distanceMetres: abSource.distanceMetres,
      sourceSha256: abSource.sourceSha256,
    }]]),
    source: { chapterRows: 1, chaptersSha256: 'a', cityRows: 1, citiesSha256: 'b' },
  };

  const report = await runGpxAnchorPreparation({
    adapter: {
      listChapters: async () => [chapter],
      updateChapter: async () => assert.fail('Le dry-run ne doit rien écrire.'),
    },
    fetchMediaBytes: async (media: { url: string }) => (
      media.url === '/ab.gpx' ? abBytes : baBytes
    ),
    controlledHints,
    resolutions: emptyResolutions(),
  });

  const abAnchor = report.chapters[0].directions.AB.anchors[1];
  const baAnchor = report.chapters[0].directions.BA.anchors[1];
  assert.ok(Math.abs(abAnchor.candidates[0].chainageMetres - hintChainage) < 1e-6);
  assert.ok(Math.abs(abAnchor.candidates[0].projectedLongitude - 0.5) < 1e-9);
  assert.ok(Math.abs(baAnchor.candidates[0].projectedLongitude - 0.5) < 1e-9);
  assert.equal(abAnchor.controlledHint.expectedOccurrences, 2);
  assert.equal(baAnchor.controlledHint.expectedOccurrences, 2);
  assert.deepEqual(report.controlledHintSource, controlledHints.source);
});

test('runGpxAnchorPreparation blocks a controlled hint after an AB source change', async () => {
  const bytes = new TextEncoder().encode('<gpx version="1.1"><trk><trkseg><trkpt lat="0" lon="0" /><trkpt lat="0" lon="1" /></trkseg></trk></gpx>');
  const chapter = {
    documentId: 'chapter-stale-control',
    slug: 'stale-control',
    title: 'Contrôle périmé',
    displayOrder: 1,
    gpxFileAB: { url: '/ab.gpx' },
    gpxFileBA: { url: '/ba.gpx' },
    cityPassages: [
      { role: 'start', city: { documentId: 'a', municipalityKey: 'FR-A', name: 'A', latitude: 0, longitude: 0 } },
      { role: 'end', city: { documentId: 'b', municipalityKey: 'FR-B', name: 'B', latitude: 0, longitude: 1 } },
    ],
  };
  const report = await runGpxAnchorPreparation({
    adapter: {
      listChapters: async () => [chapter],
      updateChapter: async () => assert.fail('Un contrôle périmé ne doit rien écrire.'),
    },
    fetchMediaBytes: async () => bytes,
    controlledHints: {
      anchors: new Map(),
      sources: new Map([['stale-control', {
        distanceMetres: 1,
        sourceSha256: 'a'.repeat(64),
      }]]),
      source: { chapterRows: 1, chaptersSha256: 'a', cityRows: 0, citiesSha256: 'b' },
    },
    resolutions: emptyResolutions(),
  });

  assert.equal(report.summary.blocked, 1);
  assert.equal(report.summary.errors, 1);
  assert.match(report.errors[0].message, /ne correspond plus au référentiel contrôlé/);
});

test('runGpxAnchorPreparation never exposes internal Maps in a blocked JSON report', async () => {
  const validBytes = new TextEncoder().encode('<gpx version="1.1"><trk><trkseg><trkpt lat="0" lon="0" /><trkpt lat="0" lon="1" /></trkseg></trk></gpx>');
  const chapter = {
    documentId: 'chapter-blocked',
    slug: 'blocked',
    title: 'Bloqué',
    displayOrder: 1,
    gpxFileAB: { url: '/valid.gpx' },
    gpxFileBA: { url: '/invalid.gpx' },
    cityPassages: [
      {
        id: 1,
        role: 'start',
        city: { documentId: 'city-a', name: 'A', latitude: 0, longitude: 0.1 },
      },
      {
        id: 2,
        role: 'end',
        city: { documentId: 'city-b', name: 'B', latitude: 0, longitude: 0.9 },
      },
    ],
  };

  const report = await runGpxAnchorPreparation({
    adapter: {
      listChapters: async () => [chapter],
      updateChapter: async () => assert.fail('Le dry-run ne doit rien écrire.'),
    },
    fetchMediaBytes: async (_media: unknown, _chapter: unknown, direction: string) => {
      if (direction === 'BA') throw new Error('Source BA indisponible.');
      return validBytes;
    },
    resolutions: emptyResolutions(),
  });
  const serialized = JSON.parse(JSON.stringify(report));

  assert.equal(serialized.summary.blocked, 1);
  assert.equal('resolvedByPassage' in serialized.chapters[0].directions.AB, false);
});
