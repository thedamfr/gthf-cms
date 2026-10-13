#!/usr/bin/env node

'use strict';

const {
  mkdirSync,
  readFileSync,
  writeFileSync,
} = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { parse } = require('csv-parse/sync');

function normalizeCityName(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('fr')
    .replace(/[-‐‑‒–—―]+/g, ' ')
    .replace(/[^a-z0-9'’ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugifyCityName(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('fr')
    .replace(/[’']/g, '-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function mappingRowFromCsvRecord(record, datasetDate) {
  const name = String(record.Ville ?? '').trim();
  const municipalityKey = String(record['ID commune'] ?? '').trim();
  const countryCode = String(record.Pays ?? '').trim().toUpperCase();
  const municipalityCode = String(record['Code commune'] ?? '').trim();
  const administrativeArea = String(record['Département / province'] ?? '').trim();
  const latitudeValue = String(record['Latitude ancre'] ?? '').trim();
  const longitudeValue = String(record['Longitude ancre'] ?? '').trim();
  const coordinateSourceValue = String(record['Source ancre communale'] ?? '').trim();

  if (
    !name
    || !municipalityKey
    || !countryCode
    || !municipalityCode
    || municipalityKey !== `${countryCode}-${municipalityCode}`
  ) {
    throw new Error(`Ligne « ${name || 'sans nom'} » : identité communale incomplète ou incohérente.`);
  }

  if (Boolean(latitudeValue) !== Boolean(longitudeValue)) {
    throw new Error(`Ligne « ${name} » : coordonnées incomplètes.`);
  }

  const mappingRow = {
    name,
    slug: slugifyCityName(name),
    alternativeNames: [],
    municipalityKey,
    countryCode,
    municipalityCode,
  };

  if (administrativeArea) {
    mappingRow.administrativeArea = administrativeArea;
  }

  if (latitudeValue && longitudeValue) {
    const latitude = Number(latitudeValue);
    const longitude = Number(longitudeValue);

    if (
      !Number.isFinite(latitude)
      || latitude < -90
      || latitude > 90
      || !Number.isFinite(longitude)
      || longitude < -180
      || longitude > 180
      || !coordinateSourceValue
      || !datasetDate
    ) {
      throw new Error(`Ligne « ${name} » : coordonnées ou provenance invalides.`);
    }

    mappingRow.latitude = latitude;
    mappingRow.longitude = longitude;
    mappingRow.coordinateSource = {
      source: coordinateSourceValue,
      date: datasetDate,
      method: 'Ancre communale du jeu de données GTHF',
    };
  }

  return mappingRow;
}

function loadCityMapping(mappingPath, datasetDate) {
  const records = parse(readFileSync(mappingPath, 'utf8'), {
    bom: true,
    columns: true,
    skip_empty_lines: true,
  });
  const mapping = records.map((record) => mappingRowFromCsvRecord(record, datasetDate));
  const municipalityKeys = new Set();

  for (const row of mapping) {
    if (municipalityKeys.has(row.municipalityKey)) {
      throw new Error(`La clé commune ${row.municipalityKey} est dupliquée dans le CSV.`);
    }
    municipalityKeys.add(row.municipalityKey);
  }

  return mapping;
}

function loadDatasetDate(mappingPath) {
  const methodPath = join(dirname(mappingPath), 'methode.csv');
  const records = parse(readFileSync(methodPath, 'utf8'), {
    bom: true,
    columns: true,
    skip_empty_lines: true,
  });
  const dateRow = records.find((record) => (
    String(record.Section ?? '').trim() === 'Version'
    && String(record['Élément'] ?? '').trim() === 'Date du calcul'
  ));
  const datasetDate = String(dateRow?.['Règle / valeur'] ?? '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(datasetDate)) {
    throw new Error(`Date du jeu de données introuvable dans ${methodPath}.`);
  }

  return datasetDate;
}

function parseMigrationArguments(argv, cwd = process.cwd()) {
  const options = {
    apply: false,
    confirmRemote: false,
    help: false,
    mappingPath: resolve(
      cwd,
      '../gthf-frontend/documentation/data/gthf_villes_et_produits_seo/csv/villes.csv'
    ),
    resolutionsPath: undefined,
    remote: false,
    reportPath: resolve(cwd, '.tmp/city-migration-report.json'),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--apply') {
      options.apply = true;
      continue;
    }

    if (argument === '--dry-run') {
      options.apply = false;
      continue;
    }

    if (argument === '--remote') {
      options.remote = true;
      continue;
    }

    if (argument === '--confirm-remote') {
      options.confirmRemote = true;
      continue;
    }

    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }

    if (['--mapping', '--resolutions', '--report'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Une valeur est requise après ${argument}.`);
      }
      index += 1;

      if (argument === '--mapping') {
        options.mappingPath = resolve(cwd, value);
      } else if (argument === '--resolutions') {
        options.resolutionsPath = resolve(cwd, value);
      } else {
        options.reportPath = resolve(cwd, value);
      }
      continue;
    }

    throw new Error(`Option inconnue : ${argument}`);
  }

  return options;
}

function configureRemoteDatabaseEnvironment(env = process.env) {
  const remoteVariables = {
    POSTGRESQL_ADDON_HOST: 'POSTGRESQL_ADDON_HOST_REMOTE',
    POSTGRESQL_ADDON_PORT: 'POSTGRESQL_ADDON_PORT_REMOTE',
    POSTGRESQL_ADDON_DB: 'POSTGRESQL_ADDON_DB_REMOTE',
    POSTGRESQL_ADDON_USER: 'POSTGRESQL_ADDON_USER_REMOTE',
    POSTGRESQL_ADDON_PASSWORD: 'POSTGRESQL_ADDON_PASSWORD_REMOTE',
  };
  const missingVariables = Object.values(remoteVariables)
    .filter((remoteName) => !String(env[remoteName] ?? '').trim());

  if (missingVariables.length > 0) {
    throw new Error(`Variables distantes manquantes : ${missingVariables.join(', ')}.`);
  }

  env.DATABASE_CLIENT = 'postgres';
  env.DATABASE_SSL = 'true';

  for (const [targetName, remoteName] of Object.entries(remoteVariables)) {
    env[targetName] = env[remoteName];
  }

  if (env.POSTGRESQL_ADDON_URI_REMOTE) {
    env.POSTGRESQL_ADDON_URI = env.POSTGRESQL_ADDON_URI_REMOTE;
  } else {
    delete env.POSTGRESQL_ADDON_URI;
  }

  return {
    host: env.POSTGRESQL_ADDON_HOST,
    database: env.POSTGRESQL_ADDON_DB,
  };
}

function validateRemoteMigrationSafety({ remote, apply, confirmRemote }) {
  if (confirmRemote && !remote) {
    throw new Error('--confirm-remote ne peut être utilisé qu’avec --remote.');
  }

  if (remote && apply && !confirmRemote) {
    throw new Error(
      'Une écriture distante exige --apply et le second verrou --confirm-remote.'
    );
  }
}

function loadResolutions(resolutionsPath) {
  const payload = JSON.parse(readFileSync(resolutionsPath, 'utf8'));
  if (payload.version !== 1 || !Array.isArray(payload.resolutions)) {
    throw new Error('Le fichier de résolutions doit utiliser le format version 1.');
  }

  const seen = new Set();
  return payload.resolutions.map((resolutionEntry) => {
    const resolution = {
      chapterSlug: String(resolutionEntry.chapterSlug ?? '').trim(),
      cityName: String(resolutionEntry.cityName ?? '').trim(),
      municipalityKey: String(resolutionEntry.municipalityKey ?? '').trim(),
    };

    if (
      !resolution.chapterSlug
      || !resolution.cityName
      || !/^[A-Z]{2}-.+/.test(resolution.municipalityKey)
    ) {
      throw new Error('Chaque résolution doit préciser chapitre, ville et clé commune.');
    }

    const key = `${resolution.chapterSlug}:${normalizeCityName(resolution.cityName)}`;
    if (seen.has(key)) {
      throw new Error(`La résolution ${key} est dupliquée.`);
    }
    seen.add(key);
    return resolution;
  });
}

function buildPassageProposal(chapter) {
  const startStation = String(chapter.startStation ?? '').trim();
  const endStation = String(chapter.endStation ?? '').trim();
  const startKey = normalizeCityName(startStation);
  const endKey = normalizeCityName(endStation);
  const legacyCities = Array.isArray(chapter.cities) ? chapter.cities : [];

  if (legacyCities.some((cityName) => typeof cityName !== 'string')) {
    throw new Error('Le champ legacy cities doit être un tableau de textes.');
  }

  const intermediates = legacyCities
    .map((cityName) => cityName.trim())
    .filter(Boolean)
    .filter((cityName) => {
      const key = normalizeCityName(cityName);
      return key !== startKey && key !== endKey;
    });

  return [
    { name: startStation, role: 'start', featured: false },
    ...intermediates.map((name) => ({
      name,
      role: 'intermediate',
      featured: true,
    })),
    { name: endStation, role: 'end', featured: false },
  ];
}

function cityMatchesName(city, normalizedName) {
  const knownNames = [
    city.name,
    ...(Array.isArray(city.alternativeNames) ? city.alternativeNames : []),
  ];

  return knownNames.some((name) => normalizeCityName(name) === normalizedName);
}

function cityDataFromMapping(mappingRow) {
  return {
    name: String(mappingRow.name).trim(),
    slug: String(mappingRow.slug).trim(),
    alternativeNames: Array.isArray(mappingRow.alternativeNames)
      ? mappingRow.alternativeNames
      : [],
    municipalityKey: String(mappingRow.municipalityKey).trim(),
    countryCode: String(mappingRow.countryCode).trim(),
    municipalityCode: String(mappingRow.municipalityCode).trim(),
    ...(mappingRow.administrativeArea
      ? { administrativeArea: String(mappingRow.administrativeArea).trim() }
      : {}),
    ...(mappingRow.latitude !== undefined ? { latitude: mappingRow.latitude } : {}),
    ...(mappingRow.longitude !== undefined ? { longitude: mappingRow.longitude } : {}),
    ...(mappingRow.coordinateSource
      ? { coordinateSource: mappingRow.coordinateSource }
      : {}),
    hasPublicPage: false,
  };
}

function resolveCityReference(
  name,
  { existingCities = [], mapping = [], municipalityKey } = {}
) {
  const normalizedName = normalizeCityName(name);

  if (municipalityKey) {
    const existingKeyMatches = existingCities.filter(
      (city) => city.municipalityKey === municipalityKey
    );

    if (existingKeyMatches.length === 1) {
      return { status: 'matched', city: existingKeyMatches[0] };
    }

    if (existingKeyMatches.length > 1) {
      return { status: 'ambiguous', name, candidates: existingKeyMatches };
    }

    const mappingKeyMatches = mapping.filter(
      (row) => row.municipalityKey === municipalityKey
    );

    if (mappingKeyMatches.length === 1) {
      return {
        status: 'create',
        name,
        data: cityDataFromMapping(mappingKeyMatches[0]),
      };
    }

    return {
      status: mappingKeyMatches.length > 1 ? 'ambiguous' : 'unresolved',
      name,
      municipalityKey,
      ...(mappingKeyMatches.length > 1 ? { candidates: mappingKeyMatches } : {}),
    };
  }

  const matches = existingCities.filter((city) => cityMatchesName(city, normalizedName));
  const mappingMatches = mapping.filter((row) => cityMatchesName(row, normalizedName));

  if (matches.length > 1 || mappingMatches.length > 1) {
    return {
      status: 'ambiguous',
      name,
      candidates: [...matches, ...mappingMatches],
    };
  }

  if (matches.length === 1) {
    const existingMunicipalityKey = matches[0].municipalityKey;
    const mappedMunicipalityKey = mappingMatches[0]?.municipalityKey;

    if (
      existingMunicipalityKey
      && mappedMunicipalityKey
      && existingMunicipalityKey !== mappedMunicipalityKey
    ) {
      return {
        status: 'ambiguous',
        name,
        candidates: [...matches, ...mappingMatches],
      };
    }

    return { status: 'matched', city: matches[0] };
  }

  if (mappingMatches.length === 1) {
    return {
      status: 'create',
      name,
      data: cityDataFromMapping(mappingMatches[0]),
    };
  }

  return { status: 'unresolved', name };
}

function hasSameCityPassages(currentPassages = [], proposedPassages = []) {
  if (currentPassages.length !== proposedPassages.length) {
    return false;
  }

  return currentPassages.every((passage, index) => {
    const proposed = proposedPassages[index];
    const currentCityId = passage.city?.documentId ?? passage.city;
    const proposedCityId = proposed.city?.documentId ?? proposed.city;

    return passage.role === proposed.role
      && Boolean(passage.featured) === Boolean(proposed.featured)
      && currentCityId === proposedCityId
      && (passage.note ?? null) === (proposed.note ?? null);
  });
}

function resolutionMunicipalityKey(resolutions, chapterSlug, cityName) {
  const normalizedName = normalizeCityName(cityName);
  const matches = resolutions.filter((resolution) => (
    resolution.chapterSlug === chapterSlug
    && normalizeCityName(resolution.cityName) === normalizedName
  ));

  if (matches.length > 1) {
    throw new Error(
      `Plusieurs résolutions existent pour ${chapterSlug} / ${cityName}.`
    );
  }

  return matches[0]?.municipalityKey;
}

function reportCandidate(candidate) {
  return {
    ...(candidate.documentId ? { documentId: candidate.documentId } : {}),
    name: candidate.name,
    municipalityKey: candidate.municipalityKey,
    ...(candidate.administrativeArea
      ? { administrativeArea: candidate.administrativeArea }
      : {}),
  };
}

function refreshSummary(report) {
  report.summary = {
    chaptersScanned: report.chapters.length,
    chaptersReady: report.chapters.filter((chapter) => chapter.status === 'ready').length,
    chaptersUpdated: report.chapters.filter((chapter) => chapter.status === 'updated').length,
    chaptersUnchanged: report.chapters.filter((chapter) => chapter.status === 'unchanged').length,
    chaptersBlocked: report.chapters.filter((chapter) => (
      chapter.status === 'blocked' || chapter.status === 'error'
    )).length,
    citiesProposed: report.cities.proposed.length,
    citiesCreated: report.cities.created.length,
    ambiguities: report.ambiguities.length,
    unresolved: report.unresolved.length,
    conflicts: report.conflicts.length,
    errors: report.errors.length,
  };
}

async function runCityMigration({
  adapter,
  mapping = [],
  resolutions = [],
  apply = false,
  generatedAt = new Date().toISOString(),
}) {
  const report = {
    generatedAt,
    mode: apply ? 'apply' : 'dry-run',
    summary: {},
    cities: {
      proposed: [],
      created: [],
    },
    chapters: [],
    ambiguities: [],
    unresolved: [],
    conflicts: [],
    errors: [],
  };
  const existingCities = await adapter.listCities();
  const chapters = await adapter.listChapters();
  const knownCities = [...existingCities];
  const plannedCities = new Map();
  const chapterPlans = [];

  for (const chapter of chapters) {
    const chapterReport = {
      documentId: chapter.documentId,
      slug: chapter.slug,
      title: chapter.title,
      status: 'blocked',
      passages: [],
    };
    report.chapters.push(chapterReport);

    let proposal;
    try {
      proposal = buildPassageProposal(chapter);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      chapterReport.status = 'error';
      report.errors.push({ chapterSlug: chapter.slug, message });
      continue;
    }

    let blocked = false;
    const proposedPassages = [];
    const proposedMunicipalityKeys = new Set();

    for (const passage of proposal) {
      let municipalityKey;
      try {
        municipalityKey = resolutionMunicipalityKey(
          resolutions,
          chapter.slug,
          passage.name
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.errors.push({
          chapterSlug: chapter.slug,
          cityName: passage.name,
          message,
        });
        blocked = true;
        continue;
      }

      const resolution = resolveCityReference(passage.name, {
        existingCities: knownCities,
        mapping,
        municipalityKey,
      });

      if (resolution.status === 'ambiguous') {
        report.ambiguities.push({
          chapterSlug: chapter.slug,
          cityName: passage.name,
          candidates: (resolution.candidates ?? []).map(reportCandidate),
        });
        blocked = true;
        continue;
      }

      if (resolution.status === 'unresolved') {
        report.unresolved.push({
          chapterSlug: chapter.slug,
          cityName: passage.name,
          ...(resolution.municipalityKey
            ? { municipalityKey: resolution.municipalityKey }
            : {}),
        });
        blocked = true;
        continue;
      }

      let city;
      if (resolution.status === 'create') {
        const key = resolution.data.municipalityKey;
        city = plannedCities.get(key);

        if (!city) {
          city = {
            ...resolution.data,
            documentId: `planned:${key}`,
          };
          plannedCities.set(key, city);
          knownCities.push(city);
        }
        proposedMunicipalityKeys.add(key);
      } else {
        city = resolution.city;
      }

      if (city.documentId.startsWith('planned:')) {
        proposedMunicipalityKeys.add(city.municipalityKey);
      }

      proposedPassages.push({
        role: passage.role,
        featured: passage.featured,
        city: { documentId: city.documentId },
      });
      chapterReport.passages.push({
        cityName: passage.name,
        municipalityKey: city.municipalityKey,
        role: passage.role,
        featured: passage.featured,
      });
    }

    if (blocked) {
      chapterReport.status = 'blocked';
      continue;
    }

    const currentPassages = Array.isArray(chapter.cityPassages)
      ? chapter.cityPassages
      : [];

    if (hasSameCityPassages(currentPassages, proposedPassages)) {
      chapterReport.status = 'unchanged';
      continue;
    }

    if (currentPassages.length > 0) {
      chapterReport.status = 'blocked';
      report.conflicts.push({
        chapterSlug: chapter.slug,
        message: 'Des passages éditoriaux existent déjà et diffèrent de la proposition legacy.',
      });
      continue;
    }

    chapterReport.status = 'ready';
    chapterPlans.push({
      chapter,
      chapterReport,
      proposedPassages,
      proposedMunicipalityKeys,
    });
  }

  const neededMunicipalityKeys = new Set(
    chapterPlans.flatMap((plan) => [...plan.proposedMunicipalityKeys])
  );
  report.cities.proposed = [...plannedCities.values()]
    .filter((city) => neededMunicipalityKeys.has(city.municipalityKey))
    .map(({ documentId: _documentId, ...data }) => data);

  if (!apply) {
    refreshSummary(report);
    return report;
  }

  const createdIds = new Map();
  for (const cityData of report.cities.proposed) {
    try {
      const createdCity = await adapter.createCity(cityData);
      if (!createdCity?.documentId) {
        throw new Error('Strapi n’a pas renvoyé de documentId pour la ville créée.');
      }
      createdIds.set(cityData.municipalityKey, createdCity.documentId);
      report.cities.created.push({
        documentId: createdCity.documentId,
        name: cityData.name,
        municipalityKey: cityData.municipalityKey,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push({
        municipalityKey: cityData.municipalityKey,
        cityName: cityData.name,
        message,
      });
    }
  }

  for (const plan of chapterPlans) {
    const cityPassages = plan.proposedPassages.map((passage) => {
      const documentId = passage.city.documentId;
      if (!documentId.startsWith('planned:')) {
        return passage;
      }

      const municipalityKey = documentId.slice('planned:'.length);
      const createdDocumentId = createdIds.get(municipalityKey);
      return {
        ...passage,
        city: createdDocumentId ? { documentId: createdDocumentId } : null,
      };
    });

    if (cityPassages.some((passage) => !passage.city)) {
      plan.chapterReport.status = 'error';
      report.errors.push({
        chapterSlug: plan.chapter.slug,
        message: 'Le chapitre n’a pas été modifié car une ville n’a pas pu être créée.',
      });
      continue;
    }

    try {
      await adapter.updateChapter(plan.chapter.documentId, cityPassages);
      plan.chapterReport.status = 'updated';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      plan.chapterReport.status = 'error';
      report.errors.push({ chapterSlug: plan.chapter.slug, message });
    }
  }

  refreshSummary(report);
  return report;
}

function createStrapiAdapter(strapi) {
  const cityDocuments = strapi.documents('api::city.city');
  const chapterDocuments = strapi.documents('api::chapter.chapter');

  return {
    listCities: () => cityDocuments.findMany({
      status: 'draft',
      fields: [
        'documentId',
        'name',
        'slug',
        'alternativeNames',
        'municipalityKey',
        'administrativeArea',
      ],
      pagination: { start: 0, limit: 10000 },
    }),
    listChapters: () => chapterDocuments.findMany({
      status: 'draft',
      fields: [
        'documentId',
        'slug',
        'title',
        'startStation',
        'endStation',
        'cities',
      ],
      populate: {
        cityPassages: {
          populate: {
            city: {
              fields: [
                'documentId',
                'name',
                'municipalityKey',
              ],
            },
          },
        },
      },
      pagination: { start: 0, limit: 10000 },
    }),
    createCity: (data) => cityDocuments.create({
      status: 'draft',
      data,
    }),
    updateChapter: (documentId, cityPassages) => chapterDocuments.update({
      documentId,
      data: { cityPassages },
    }),
  };
}

function writeMigrationReport(reportPath, report) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function printHelp() {
  console.log(`Migration du référentiel des villes

Usage : npm run migrate:cities -- [options]

Options :
  --mapping <fichier>      CSV villes.csv (défaut : dépôt frontend voisin)
  --resolutions <fichier>  Choix éditoriaux pour les homonymes, au format JSON v1
  --report <fichier>       Rapport JSON (défaut : .tmp/city-migration-report.json)
  --apply                  Crée les brouillons et met à jour les brouillons de chapitre
  --dry-run                Force le mode lecture seule (comportement par défaut)
  --remote                 Utilise les variables POSTGRESQL_ADDON_*_REMOTE
  --confirm-remote         Second verrou obligatoire avec --remote --apply
  --help                   Affiche cette aide

Le script ne publie jamais de ville ou de chapitre et laisse hasPublicPage=false.`);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseMigrationArguments(argv);
  if (options.help) {
    printHelp();
    return 0;
  }

  validateRemoteMigrationSafety(options);
  if (options.remote) {
    const target = configureRemoteDatabaseEnvironment();
    console.log(`Base distante ciblée : ${target.host} / ${target.database}`);
  }

  const datasetDate = loadDatasetDate(options.mappingPath);
  const mapping = loadCityMapping(options.mappingPath, datasetDate);
  const resolutions = options.resolutionsPath
    ? loadResolutions(options.resolutionsPath)
    : [];
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  let report;
  try {
    report = await runCityMigration({
      adapter: createStrapiAdapter(app),
      mapping,
      resolutions,
      apply: options.apply,
    });
  } finally {
    await app.destroy();
  }

  report.source = {
    mappingPath: options.mappingPath,
    datasetDate,
    mappingRows: mapping.length,
    ...(options.resolutionsPath
      ? { resolutionsPath: options.resolutionsPath }
      : {}),
    resolutionRows: resolutions.length,
  };
  writeMigrationReport(options.reportPath, report);

  console.log(JSON.stringify({
    mode: report.mode,
    reportPath: options.reportPath,
    summary: report.summary,
  }, null, 2));

  return options.apply && report.summary.chaptersBlocked > 0 ? 2 : 0;
}

module.exports = {
  buildPassageProposal,
  configureRemoteDatabaseEnvironment,
  createStrapiAdapter,
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
  writeMigrationReport,
};

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
