import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import migration from '../scripts/migrate-cities.js';

const {
  buildPassageProposal,
  configureRemoteDatabaseEnvironment,
  hasSameCityPassages,
  loadCityMapping,
  loadDatasetDate,
  loadResolutions,
  mappingRowFromCsvRecord,
  normalizeCityName,
  parseMigrationArguments,
  resolveCityReference,
  runCityMigration,
  validateRemoteMigrationSafety,
} = migration;

test('parseMigrationArguments keeps remote production access opt-in', () => {
  assert.deepEqual(
    parseMigrationArguments(['--remote', '--apply', '--confirm-remote'], '/workspace'),
    {
      apply: true,
      confirmRemote: true,
      help: false,
      mappingPath: '/gthf-frontend/documentation/data/gthf_villes_et_produits_seo/csv/villes.csv',
      remote: true,
      reportPath: '/workspace/.tmp/city-migration-report.json',
      resolutionsPath: undefined,
    }
  );
});

test('configureRemoteDatabaseEnvironment maps only explicit remote credentials', () => {
  const env: Record<string, string> = {
    POSTGRESQL_ADDON_HOST_REMOTE: 'remote.example.test',
    POSTGRESQL_ADDON_PORT_REMOTE: '5432',
    POSTGRESQL_ADDON_DB_REMOTE: 'gthdf-production',
    POSTGRESQL_ADDON_USER_REMOTE: 'gthdf-user',
    POSTGRESQL_ADDON_PASSWORD_REMOTE: 'secret',
    POSTGRESQL_ADDON_URI_REMOTE: 'postgresql://remote.example.test/gthdf-production',
  };

  assert.deepEqual(configureRemoteDatabaseEnvironment(env), {
    host: 'remote.example.test',
    database: 'gthdf-production',
  });
  assert.equal(env.DATABASE_CLIENT, 'postgres');
  assert.equal(env.DATABASE_SSL, 'true');
  assert.equal(env.POSTGRESQL_ADDON_HOST, 'remote.example.test');
  assert.equal(env.POSTGRESQL_ADDON_DB, 'gthdf-production');
  assert.equal(env.POSTGRESQL_ADDON_URI, 'postgresql://remote.example.test/gthdf-production');
});

test('configureRemoteDatabaseEnvironment refuses incomplete remote credentials', () => {
  assert.throws(
    () => configureRemoteDatabaseEnvironment({
      POSTGRESQL_ADDON_HOST_REMOTE: 'remote.example.test',
    }),
    /variables distantes manquantes/i
  );
});

test('validateRemoteMigrationSafety requires a second opt-in before remote writes', () => {
  assert.doesNotThrow(() => validateRemoteMigrationSafety({
    remote: true,
    apply: false,
    confirmRemote: false,
  }));
  assert.throws(
    () => validateRemoteMigrationSafety({
      remote: true,
      apply: true,
      confirmRemote: false,
    }),
    /--confirm-remote/
  );
  assert.doesNotThrow(() => validateRemoteMigrationSafety({
    remote: true,
    apply: true,
    confirmRemote: true,
  }));
});

test('normalizeCityName ignores case, accents, spaces and hyphens', () => {
  assert.equal(normalizeCityName('  Saint-Quentin  '), 'saint quentin');
  assert.equal(normalizeCityName('SAINT QUENTIN'), 'saint quentin');
  assert.equal(normalizeCityName('Béthune'), 'bethune');
});

test('buildPassageProposal keeps canonical endpoints and removes their legacy duplicates', () => {
  assert.deepEqual(
    buildPassageProposal({
      startStation: 'Hirson',
      endStation: 'Soissons',
      cities: ['Hirson', 'Guise', 'Saint-Quentin', 'Soissons'],
    }),
    [
      { name: 'Hirson', role: 'start', featured: false },
      { name: 'Guise', role: 'intermediate', featured: true },
      { name: 'Saint-Quentin', role: 'intermediate', featured: true },
      { name: 'Soissons', role: 'end', featured: false },
    ]
  );
});

test('buildPassageProposal rejects malformed legacy city data', () => {
  assert.throws(
    () => buildPassageProposal({
      startStation: 'Hirson',
      endStation: 'Soissons',
      cities: ['Guise', { name: 'Saint-Quentin' }],
    }),
    /tableau de textes/
  );
});

test('resolveCityReference reuses one existing city through an alternative name', () => {
  const result = resolveCityReference('St Omer', {
    existingCities: [
      {
        documentId: 'city-1',
        name: 'Saint-Omer',
        alternativeNames: ['St Omer'],
        municipalityKey: 'FR-62765',
      },
    ],
    mapping: [],
  });

  assert.equal(result.status, 'matched');
  assert.equal(result.city?.documentId, 'city-1');
});

test('resolveCityReference reports homonyms instead of merging them', () => {
  const result = resolveCityReference('Saint-Aubin', {
    existingCities: [
      { documentId: 'city-1', name: 'Saint-Aubin', municipalityKey: 'FR-62743' },
      { documentId: 'city-2', name: 'Saint-Aubin', municipalityKey: 'FR-76562' },
    ],
    mapping: [],
  });

  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.candidates?.map((city) => city.documentId), ['city-1', 'city-2']);
});

test('resolveCityReference uses an explicit municipality key to resolve a homonym', () => {
  const result = resolveCityReference('Saint-Aubin', {
    existingCities: [],
    mapping: [
      {
        name: 'Saint-Aubin',
        slug: 'saint-aubin',
        municipalityKey: 'FR-62743',
        countryCode: 'FR',
        municipalityCode: '62743',
      },
      {
        name: 'Saint-Aubin',
        slug: 'saint-aubin',
        municipalityKey: 'FR-76562',
        countryCode: 'FR',
        municipalityCode: '76562',
      },
    ],
    municipalityKey: 'FR-76562',
  });

  assert.equal(result.status, 'create');
  assert.equal(result.data?.municipalityKey, 'FR-76562');
});

test('resolveCityReference does not hide mapping homonyms behind one existing name match', () => {
  const result = resolveCityReference('Saint-Aubin', {
    existingCities: [
      { documentId: 'city-1', name: 'Saint-Aubin', municipalityKey: 'FR-62743' },
    ],
    mapping: [
      { name: 'Saint-Aubin', municipalityKey: 'FR-62743' },
      { name: 'Saint-Aubin', municipalityKey: 'FR-76562' },
    ],
  });

  assert.equal(result.status, 'ambiguous');
});

test('resolveCityReference proposes a disabled city from an unambiguous mapping row', () => {
  const result = resolveCityReference('St Omer', {
    existingCities: [],
    mapping: [
      {
        name: 'Saint-Omer',
        alternativeNames: ['St Omer'],
        slug: 'saint-omer',
        municipalityKey: 'FR-62765',
        countryCode: 'FR',
        municipalityCode: '62765',
      },
    ],
  });

  assert.equal(result.status, 'create');
  assert.equal(result.data?.municipalityKey, 'FR-62765');
  assert.equal(result.data?.hasPublicPage, false);
});

test('hasSameCityPassages detects an already migrated chapter', () => {
  const passages = [
    { role: 'start', featured: false, city: { documentId: 'city-1' } },
    { role: 'end', featured: false, city: { documentId: 'city-2' } },
  ];

  assert.equal(hasSameCityPassages(passages, passages), true);
  assert.equal(
    hasSameCityPassages(passages, [
      passages[1],
      passages[0],
    ]),
    false
  );
});

test('mappingRowFromCsvRecord maps only municipality identity and coordinate provenance', () => {
  assert.deepEqual(
    mappingRowFromCsvRecord({
      'ID commune': 'FR-02381',
      Pays: 'FR',
      'Code commune': '02381',
      Ville: 'Hirson',
      'Département / province': '02',
      'Longitude ancre': '4.0841',
      'Latitude ancre': '49.9202',
      'Source ancre communale': 'mairie api.gouv.fr',
      'Commerces admissibles': '10',
    }, '2026-07-19'),
    {
      name: 'Hirson',
      slug: 'hirson',
      alternativeNames: [],
      municipalityKey: 'FR-02381',
      countryCode: 'FR',
      municipalityCode: '02381',
      administrativeArea: '02',
      longitude: 4.0841,
      latitude: 49.9202,
      coordinateSource: {
        source: 'mairie api.gouv.fr',
        date: '2026-07-19',
        method: 'Ancre communale du jeu de données GTHF',
      },
    }
  );
});

test('mappingRowFromCsvRecord rejects an incomplete municipality identity', () => {
  assert.throws(
    () => mappingRowFromCsvRecord({
      'ID commune': '',
      Pays: 'FR',
      'Code commune': '02381',
      Ville: 'Hirson',
    }, '2026-07-19'),
    /identité communale incomplète/
  );
});

test('loadCityMapping parses quoted CSV while preserving administrative codes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gthf-city-mapping-'));
  const mappingPath = join(directory, 'villes.csv');

  try {
    writeFileSync(
      mappingPath,
      [
        'ID commune,Pays,Code commune,Ville,Département / province,Longitude ancre,Latitude ancre,Source ancre communale',
        'FR-02381,FR,02381,"Hirson",02,4.0841,49.9202,"mairie, api.gouv.fr"',
      ].join('\n'),
      'utf8'
    );

    const mapping = loadCityMapping(mappingPath, '2026-07-19');

    assert.equal(mapping.length, 1);
    assert.equal(mapping[0].municipalityCode, '02381');
    assert.equal(mapping[0].coordinateSource.source, 'mairie, api.gouv.fr');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('loadDatasetDate reads the version date next to the city CSV', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gthf-city-date-'));
  const mappingPath = join(directory, 'villes.csv');

  try {
    writeFileSync(mappingPath, 'placeholder', 'utf8');
    writeFileSync(
      join(directory, 'methode.csv'),
      [
        'Section,Élément,Règle / valeur,Source URL',
        'Version,Date du calcul,2026-07-19,',
      ].join('\n'),
      'utf8'
    );

    assert.equal(loadDatasetDate(mappingPath), '2026-07-19');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('parseMigrationArguments keeps dry-run safe by default and requires --apply', () => {
  const defaults = parseMigrationArguments([], '/workspace/gthdf-cms');
  const applied = parseMigrationArguments([
    '--mapping', '/data/villes.csv',
    '--resolutions', '/data/resolutions.json',
    '--report', '/tmp/report.json',
    '--apply',
  ], '/workspace/gthdf-cms');

  assert.equal(defaults.apply, false);
  assert.match(defaults.mappingPath, /gthf-frontend.*villes\.csv$/);
  assert.deepEqual(applied, {
    apply: true,
    confirmRemote: false,
    help: false,
    mappingPath: '/data/villes.csv',
    resolutionsPath: '/data/resolutions.json',
    remote: false,
    reportPath: '/tmp/report.json',
  });
});

test('loadResolutions accepts explicit chapter and municipality choices', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gthf-city-resolutions-'));
  const resolutionsPath = join(directory, 'resolutions.json');

  try {
    writeFileSync(
      resolutionsPath,
      JSON.stringify({
        version: 1,
        resolutions: [{
          chapterSlug: 'hirson-soissons',
          cityName: 'Saint-Aubin',
          municipalityKey: 'FR-76562',
        }],
      }),
      'utf8'
    );

    assert.deepEqual(loadResolutions(resolutionsPath), [{
      chapterSlug: 'hirson-soissons',
      cityName: 'Saint-Aubin',
      municipalityKey: 'FR-76562',
    }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runCityMigration is a read-only dry run by default', async () => {
  let createCalls = 0;
  let updateCalls = 0;
  const mapping = ['Hirson', 'Guise', 'Soissons'].map((name, index) => ({
    name,
    slug: name.toLowerCase(),
    alternativeNames: [],
    municipalityKey: `FR-0000${index}`,
    countryCode: 'FR',
    municipalityCode: `0000${index}`,
  }));

  const report = await runCityMigration({
    adapter: {
      listCities: async () => [],
      listChapters: async () => [{
        documentId: 'chapter-1',
        slug: 'hirson-soissons',
        title: 'Hirson → Soissons',
        startStation: 'Hirson',
        endStation: 'Soissons',
        cities: ['Guise'],
        cityPassages: [],
      }],
      createCity: async () => {
        createCalls += 1;
        return { documentId: 'unexpected' };
      },
      updateChapter: async () => {
        updateCalls += 1;
      },
    },
    mapping,
    generatedAt: '2026-08-04T12:00:00.000Z',
  });

  assert.equal(report.mode, 'dry-run');
  assert.equal(report.summary.chaptersReady, 1);
  assert.equal(report.summary.citiesProposed, 3);
  assert.equal(createCalls, 0);
  assert.equal(updateCalls, 0);
  assert.ok(report.cities.proposed.every((city) => city.hasPublicPage === false));
});

test('runCityMigration applies drafts once and is idempotent on a second pass', async () => {
  const cityStore = [];
  const chapter = {
    documentId: 'chapter-1',
    slug: 'hirson-soissons',
    title: 'Hirson → Soissons',
    startStation: 'Hirson',
    endStation: 'Soissons',
    cities: [],
    cityPassages: [],
  };
  let updateCalls = 0;
  const adapter = {
    listCities: async () => cityStore,
    listChapters: async () => [chapter],
    createCity: async (data) => {
      const city = { ...data, documentId: `city-${cityStore.length + 1}` };
      cityStore.push(city);
      return city;
    },
    updateChapter: async (_documentId, cityPassages) => {
      updateCalls += 1;
      chapter.cityPassages = cityPassages;
    },
  };
  const mapping = ['Hirson', 'Soissons'].map((name, index) => ({
    name,
    slug: name.toLowerCase(),
    alternativeNames: [],
    municipalityKey: `FR-0000${index}`,
    countryCode: 'FR',
    municipalityCode: `0000${index}`,
  }));

  const firstReport = await runCityMigration({ adapter, mapping, apply: true });
  const secondReport = await runCityMigration({ adapter, mapping, apply: true });

  assert.equal(firstReport.summary.citiesCreated, 2);
  assert.equal(firstReport.summary.chaptersUpdated, 1);
  assert.equal(secondReport.summary.citiesCreated, 0);
  assert.equal(secondReport.summary.chaptersUnchanged, 1);
  assert.equal(cityStore.length, 2);
  assert.equal(updateCalls, 1);
});

test('runCityMigration never overwrites differing editorial passages', async () => {
  let updateCalls = 0;
  const existingCities = [
    { documentId: 'city-1', name: 'Hirson', municipalityKey: 'FR-02381' },
    { documentId: 'city-2', name: 'Soissons', municipalityKey: 'FR-02722' },
  ];
  const report = await runCityMigration({
    adapter: {
      listCities: async () => existingCities,
      listChapters: async () => [{
        documentId: 'chapter-1',
        slug: 'hirson-soissons',
        title: 'Hirson → Soissons',
        startStation: 'Hirson',
        endStation: 'Soissons',
        cities: [],
        cityPassages: [
          { role: 'start', featured: false, city: { documentId: 'city-2' } },
          { role: 'end', featured: false, city: { documentId: 'city-1' } },
        ],
      }],
      createCity: async () => ({ documentId: 'unexpected' }),
      updateChapter: async () => {
        updateCalls += 1;
      },
    },
    mapping: [],
    apply: true,
  });

  assert.equal(report.summary.conflicts, 1);
  assert.equal(report.summary.chaptersBlocked, 1);
  assert.equal(updateCalls, 0);
});

test('runCityMigration keeps a planned city when its first chapter is blocked', async () => {
  const mapping = ['Hirson', 'Soissons'].map((name, index) => ({
    name,
    slug: name.toLowerCase(),
    alternativeNames: [],
    municipalityKey: `FR-0000${index}`,
    countryCode: 'FR',
    municipalityCode: `0000${index}`,
  }));
  const report = await runCityMigration({
    adapter: {
      listCities: async () => [],
      listChapters: async () => [
        {
          documentId: 'chapter-blocked',
          slug: 'blocked',
          title: 'Bloqué',
          startStation: 'Hirson',
          endStation: 'Ville inconnue',
          cities: [],
          cityPassages: [],
        },
        {
          documentId: 'chapter-ready',
          slug: 'ready',
          title: 'Prêt',
          startStation: 'Hirson',
          endStation: 'Soissons',
          cities: [],
          cityPassages: [],
        },
      ],
      createCity: async () => ({ documentId: 'unused' }),
      updateChapter: async () => {},
    },
    mapping,
  });

  assert.equal(report.summary.chaptersReady, 1);
  assert.deepEqual(
    report.cities.proposed.map((city) => city.name).sort(),
    ['Hirson', 'Soissons']
  );
});
