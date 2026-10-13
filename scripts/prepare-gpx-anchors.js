#!/usr/bin/env node

'use strict';

const { createHash } = require('node:crypto');
const {
  mkdirSync,
  readFileSync,
  writeFileSync,
} = require('node:fs');
const { dirname, resolve } = require('node:path');
const { parse } = require('csv-parse/sync');
const {
  validateRemoteMigrationSafety,
} = require('./migrate-cities.js');
const {
  configureCleverRemoteDatabaseEnvironment,
} = require('./clever-remote-database.js');
const {
  candidateKey,
  distanceWgs84Metres,
  parseOfficialGpxBytes,
  proposeOrderedAnchors,
} = require('./gpx-anchor-core.js');

const MAXIMUM_GPX_BYTES = 5 * 1024 * 1024;
const GPX_FETCH_TIMEOUT_MS = 15000;
const EXACT_JUNCTION_TOLERANCE_METRES = 1;
const STALE_JUNCTION_TOLERANCE_METRES = 2;
const DEFAULT_MEDIA_ORIGINS = [
  'https://cellar-c2.services.clever-cloud.com',
  'https://cms.gthf.fr',
];

function parseControlledCsv(filePath, label, option) {
  let bytes;
  try {
    bytes = readFileSync(filePath);
  } catch (error) {
    throw new Error(
      `Impossible de lire le CSV contrôlé ${label} « ${filePath} ». Vérifiez l’option ${option}.`,
      { cause: error }
    );
  }

  try {
    return {
      bytes,
      rows: parse(bytes, {
        bom: true,
        columns: true,
        skip_empty_lines: true,
      }),
    };
  } catch (error) {
    throw new Error(
      `Le CSV contrôlé ${label} « ${filePath} » est invalide. Vérifiez son contenu ou l’option ${option}.`,
      { cause: error }
    );
  }
}

function loadControlledAnchorHints(citiesPath, chaptersPath) {
  const { bytes: cityBytes, rows: cityRows } = parseControlledCsv(
    citiesPath,
    'des villes',
    '--cities'
  );
  const { bytes: chapterBytes, rows: chapterRows } = parseControlledCsv(
    chaptersPath,
    'des chapitres',
    '--chapters'
  );
  const anchors = new Map();
  const sources = new Map();
  const chaptersByLabel = new Map();
  let globalOffsetMetres = 0;

  for (const [rowIndex, row] of chapterRows.entries()) {
    const slug = String(row['Slug chapitre'] ?? '').trim();
    const label = String(row.Chapitre ?? '').trim();
    const sourceSha256 = String(row['SHA-256 GPX'] ?? '').trim().toLowerCase();
    const distanceMetres = Number(row['Distance GPX (m)']);
    const validationErrors = [];
    if (!slug) validationErrors.push('slug manquant');
    if (!label) validationErrors.push('libellé manquant');
    if (!/^[a-f0-9]{64}$/.test(sourceSha256)) validationErrors.push('SHA-256 invalide');
    if (!Number.isFinite(distanceMetres) || distanceMetres <= 0) {
      validationErrors.push('distance invalide');
    }
    if (slug && sources.has(slug)) validationErrors.push(`slug dupliqué « ${slug} »`);
    if (label && chaptersByLabel.has(label)) {
      validationErrors.push(`libellé dupliqué « ${label} »`);
    }
    if (validationErrors.length > 0) {
      const identity = [slug, label].filter(Boolean).join(' / ') || 'chapitre inconnu';
      throw new Error(
        `La ligne ${rowIndex + 2} du référentiel contrôlé des chapitres (${identity}) `
        + `est invalide : ${validationErrors.join(', ')}.`
      );
    }
    sources.set(slug, { distanceMetres, sourceSha256 });
    chaptersByLabel.set(label, { slug, globalOffsetMetres, distanceMetres });
    globalOffsetMetres += distanceMetres;
  }
  if (sources.size === 0) throw new Error('Le référentiel contrôlé ne contient aucun chapitre GPX.');

  for (const row of cityRows) {
    const municipalityKey = String(row['ID commune'] ?? '').trim();
    const cityName = String(row.Ville ?? '').trim();
    const chapterLabel = String(row['Premier chapitre'] ?? '').trim();
    const globalChainageMetres = Number(row['Chaînage premier passage (m)']);
    const expectedOccurrences = Number(row['Nombre de passages']);
    const chapter = chaptersByLabel.get(chapterLabel);
    if (
      !municipalityKey || !cityName || !chapter
      || !Number.isFinite(globalChainageMetres)
      || !Number.isInteger(expectedOccurrences) || expectedOccurrences < 1
    ) {
      throw new Error(`La ligne d’ancrage contrôlé de ${cityName || municipalityKey || 'ville inconnue'} est invalide.`);
    }
    const abChainageMetres = globalChainageMetres - chapter.globalOffsetMetres;
    if (abChainageMetres < 0 || abChainageMetres > chapter.distanceMetres) {
      throw new Error(`Le chaînage contrôlé de ${cityName} sort du chapitre ${chapter.slug}.`);
    }
    const key = `${chapter.slug}:${municipalityKey}`;
    if (anchors.has(key)) throw new Error(`L’ancrage contrôlé ${key} est dupliqué.`);
    anchors.set(key, {
      abChainageMetres,
      cityName,
      expectedOccurrences,
      municipalityKey,
    });
  }

  return {
    anchors,
    sources,
    source: {
      chapterRows: chapterRows.length,
      chaptersSha256: createHash('sha256').update(chapterBytes).digest('hex'),
      cityRows: cityRows.length,
      citiesSha256: createHash('sha256').update(cityBytes).digest('hex'),
    },
  };
}

function parseAnchorPreparationArguments(argv, cwd = process.cwd()) {
  const options = {
    allowSelfSignedTls: false,
    apply: false,
    cleverApp: 'gthdf-cms',
    confirmApply: false,
    confirmRemote: false,
    citiesPath: resolve(
      cwd,
      '../gthf-frontend/documentation/data/gthf_villes_et_produits_seo/csv/villes.csv'
    ),
    chaptersPath: resolve(
      cwd,
      '../gthf-frontend/documentation/data/gthf_villes_et_produits_seo/csv/chapitres.csv'
    ),
    help: false,
    remote: false,
    reportPath: resolve(cwd, '.tmp/gpx-anchor-report.json'),
    resolutionsPath: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--dry-run') options.apply = false;
    else if (argument === '--confirm-apply') options.confirmApply = true;
    else if (argument === '--remote') options.remote = true;
    else if (argument === '--confirm-remote') options.confirmRemote = true;
    else if (argument === '--allow-self-signed-tls') options.allowSelfSignedTls = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (
      argument === '--report'
      || argument === '--resolutions'
      || argument === '--clever-app'
      || argument === '--cities'
      || argument === '--chapters'
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Une valeur est requise après ${argument}.`);
      }
      index += 1;
      if (argument === '--report') options.reportPath = resolve(cwd, value);
      else if (argument === '--resolutions') options.resolutionsPath = resolve(cwd, value);
      else if (argument === '--cities') options.citiesPath = resolve(cwd, value);
      else if (argument === '--chapters') options.chaptersPath = resolve(cwd, value);
      else options.cleverApp = value;
    } else {
      throw new Error(`Option inconnue : ${argument}`);
    }
  }

  if (options.apply && !options.confirmApply) {
    throw new Error('L’application exige --apply et --confirm-apply après revue du rapport.');
  }
  validateRemoteMigrationSafety(options);
  return options;
}

function emptyResolutions() {
  return { anchors: new Map(), junctions: new Map() };
}

function addJunctionResolution(resolutions, key, decision, reviewNote) {
  if (resolutions.junctions.has(key)) {
    throw new Error(`Résolution de jonction dupliquée : ${key}.`);
  }
  resolutions.junctions.set(key, { decision, reviewNote: reviewNote || null });
}

function loadAnchorResolutions(resolutionsPath) {
  if (!resolutionsPath) return emptyResolutions();
  const payload = JSON.parse(readFileSync(resolutionsPath, 'utf8'));
  if (payload.version !== 1 || !Array.isArray(payload.anchors) || !Array.isArray(payload.junctions)) {
    throw new Error('Les résolutions GPX doivent utiliser le format version 1.');
  }
  const resolutions = emptyResolutions();

  for (const item of payload.anchors) {
    const chapterSlug = String(item.chapterSlug ?? '').trim();
    const direction = String(item.direction ?? '').toUpperCase();
    const passageIndex = Number(item.passageIndex);
    const selectedCandidateKey = String(item.candidateKey ?? '').trim();
    if (
      !chapterSlug || !['AB', 'BA'].includes(direction)
      || !Number.isInteger(passageIndex) || passageIndex < 0
      || !/^[a-f0-9]{64}$/i.test(selectedCandidateKey)
      || item.decision !== 'validated'
    ) {
      throw new Error('Une résolution d’ancrage est incomplète ou invalide.');
    }
    const key = `${chapterSlug}:${direction}:${passageIndex}`;
    if (resolutions.anchors.has(key)) throw new Error(`Résolution d’ancrage dupliquée : ${key}.`);
    resolutions.anchors.set(key, {
      candidateKey: selectedCandidateKey.toLowerCase(),
      decision: 'validated',
      reviewNote: String(item.reviewNote ?? '').trim() || null,
    });
  }

  for (const item of payload.junctions) {
    const chapterSlug = String(item.chapterSlug ?? '').trim();
    const direction = String(item.direction ?? '').toUpperCase();
    const decision = String(item.decision ?? '');
    const reviewNote = String(item.reviewNote ?? '').trim();
    if (
      !chapterSlug || !['AB', 'BA'].includes(direction)
      || !['accepted_gap', 'blocked'].includes(decision)
      || (decision === 'accepted_gap' && !reviewNote)
    ) {
      throw new Error('Une résolution de jonction est incomplète ou invalide.');
    }
    const key = `${chapterSlug}:${direction}`;
    addJunctionResolution(resolutions, key, decision, reviewNote);
  }

  if (payload.junctionPairs !== undefined && !Array.isArray(payload.junctionPairs)) {
    throw new Error('junctionPairs doit être un tableau lorsqu’il est renseigné.');
  }
  for (const item of payload.junctionPairs ?? []) {
    const cityName = String(item.cityName ?? '').trim();
    const referenceKind = String(item.referenceKind ?? '');
    const referenceLabel = String(item.referenceLabel ?? '').trim();
    const abChapterSlug = String(item.abChapterSlug ?? '').trim();
    const baChapterSlug = String(item.baChapterSlug ?? '').trim();
    const decision = String(item.decision ?? '');
    const reviewNote = String(item.reviewNote ?? '').trim();
    if (
      !cityName || !['train_station', 'landmark'].includes(referenceKind)
      || !referenceLabel || !abChapterSlug || !baChapterSlug
      || !['accepted_gap', 'blocked'].includes(decision)
      || (decision === 'accepted_gap' && !reviewNote)
    ) {
      throw new Error('Une paire de jonctions est incomplète ou invalide.');
    }
    const sharedReviewNote = `${referenceLabel} — ${reviewNote || `Jonction bloquée à ${cityName}.`}`;
    addJunctionResolution(
      resolutions,
      `${abChapterSlug}:AB`,
      decision,
      sharedReviewNote
    );
    addJunctionResolution(
      resolutions,
      `${baChapterSlug}:BA`,
      decision,
      sharedReviewNote
    );
  }

  return resolutions;
}

function candidateAsAnchor(proposal, selected, status, reviewNote, existingId) {
  return {
    ...(existingId === undefined ? {} : { id: existingId }),
    status,
    sourceSha256: proposal.sourceSha256,
    trackIndex: selected.trackIndex,
    segmentIndex: selected.segmentIndex,
    pointIndex: selected.pointIndex,
    fraction: selected.fraction,
    chainageMetres: selected.chainageMetres,
    projectedLatitude: selected.projectedLatitude,
    projectedLongitude: selected.projectedLongitude,
    distanceToCityMetres: selected.distanceToCityMetres,
    algorithmVersion: proposal.algorithmVersion,
    ...(reviewNote ? { reviewNote } : {}),
  };
}

function existingCandidateKey(existing) {
  if (!existing || typeof existing.sourceSha256 !== 'string') return null;
  try {
    return candidateKey(existing.sourceSha256, {
      trackIndex: Number(existing.trackIndex),
      segmentIndex: Number(existing.segmentIndex),
      pointIndex: Number(existing.pointIndex),
      fraction: Number(existing.fraction),
    });
  } catch {
    return null;
  }
}

function resolveAnchor({ chapterSlug, direction, proposal, existing, resolution }) {
  if (resolution) {
    const selected = proposal.candidates.find(
      (item) => item.candidateKey.toLowerCase() === resolution.candidateKey
    );
    if (!selected) {
      throw new Error(
        `La résolution ${chapterSlug}:${direction}:${proposal.passageIndex} ne correspond à aucun candidat du rapport courant.`
      );
    }
    return {
      stored: candidateAsAnchor(
        proposal,
        selected,
        'validated',
        resolution.reviewNote,
        existing?.id
      ),
      outcome: 'validated_from_resolution',
    };
  }

  if (
    existing?.status === 'validated'
    && String(existing.sourceSha256).toLowerCase() === proposal.sourceSha256
  ) {
    return {
      stored: { ...existing },
      outcome: existingCandidateKey(existing) === proposal.candidateKey
        ? 'validated_unchanged'
        : 'validated_preserved_review_required',
    };
  }

  if (existing?.status === 'validated') {
    return {
      stored: { ...existing, status: 'stale' },
      outcome: 'stale_source_changed',
    };
  }

  return {
    stored: candidateAsAnchor(
      proposal,
      proposal,
      'proposed',
      null,
      existing?.id
    ),
    outcome: proposal.ambiguityReasons.length > 0 ? 'proposed_ambiguous' : 'proposed',
  };
}

function endpoint(source, side) {
  const segment = side === 'start'
    ? source.segments[0]
    : source.segments[source.segments.length - 1];
  return side === 'start'
    ? segment.points[0]
    : segment.points[segment.points.length - 1];
}

function resolveJunction({
  chapterSlug,
  direction,
  source,
  nextSource,
  existing,
  resolution,
}) {
  const gapMetres = distanceWgs84Metres(endpoint(source, 'end'), endpoint(nextSource, 'start'));
  const sameSources = existing
    && String(existing.sourceSha256).toLowerCase() === source.sourceSha256
    && String(existing.nextSourceSha256).toLowerCase() === nextSource.sourceSha256;

  if (gapMetres <= EXACT_JUNCTION_TOLERANCE_METRES) {
    return {
      stored: {
        ...(existing?.id === undefined ? {} : { id: existing.id }),
        status: 'exact',
        sourceSha256: source.sourceSha256,
        nextSourceSha256: nextSource.sourceSha256,
        gapMetres,
      },
      outcome: 'exact',
    };
  }

  if (resolution) {
    return {
      stored: {
        ...(existing?.id === undefined ? {} : { id: existing.id }),
        status: resolution.decision,
        sourceSha256: source.sourceSha256,
        nextSourceSha256: nextSource.sourceSha256,
        gapMetres,
        ...(resolution.reviewNote ? { reviewNote: resolution.reviewNote } : {}),
      },
      outcome: resolution.decision,
    };
  }

  if (
    sameSources
    && ['exact', 'accepted_gap', 'blocked'].includes(existing.status)
    && Math.abs(Number(existing.gapMetres) - gapMetres) <= STALE_JUNCTION_TOLERANCE_METRES
  ) {
    return { stored: { ...existing }, outcome: 'qualified_unchanged' };
  }

  if (existing && ['exact', 'accepted_gap'].includes(existing.status)) {
    return { stored: { ...existing, status: 'stale' }, outcome: 'stale_source_changed' };
  }

  return {
    stored: {
      ...(existing?.id === undefined ? {} : { id: existing.id }),
      status: 'proposed',
      sourceSha256: source.sourceSha256,
      nextSourceSha256: nextSource.sourceSha256,
      gapMetres,
    },
    outcome: 'proposed_review_required',
  };
}

function passageForWrite(passage, anchorAB, anchorBA) {
  const cityDocumentId = passage.city?.documentId;
  if (!cityDocumentId) throw new Error('Chaque passage doit référencer une ville par documentId.');
  return {
    ...(passage.id === undefined ? {} : { id: passage.id }),
    role: passage.role,
    featured: passage.featured === true,
    ...(passage.note === undefined || passage.note === null ? {} : { note: passage.note }),
    city: { documentId: cityDocumentId },
    gpxAnchorAB: anchorAB,
    gpxAnchorBA: anchorBA,
  };
}

const BUILDER_DECIMAL_FIELDS = new Set([
  'fraction',
  'chainageMetres',
  'projectedLatitude',
  'projectedLongitude',
  'distanceToCityMetres',
  'gapMetres',
]);

function normalizeBuilderState(value, field = null) {
  if (BUILDER_DECIMAL_FIELDS.has(field) && value !== null && value !== '') {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeBuilderState(item, field));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) => (
        key !== 'id'
        && !(key === 'reviewNote' && (item === null || item === undefined))
      ))
      .map(([key, item]) => [key, normalizeBuilderState(item, key)])
  );
}

function sameBuilderState(chapter, update) {
  return JSON.stringify(normalizeBuilderState({
    anchors: chapter.cityPassages.map((passage) => ({
      gpxAnchorAB: passage.gpxAnchorAB ?? null,
      gpxAnchorBA: passage.gpxAnchorBA ?? null,
    })),
    gpxJunctionAfterAB: chapter.gpxJunctionAfterAB,
    gpxJunctionAfterBA: chapter.gpxJunctionAfterBA,
  })) === JSON.stringify(normalizeBuilderState({
    anchors: update.cityPassages.map((passage) => ({
      gpxAnchorAB: passage.gpxAnchorAB ?? null,
      gpxAnchorBA: passage.gpxAnchorBA ?? null,
    })),
    gpxJunctionAfterAB: update.gpxJunctionAfterAB,
    gpxJunctionAfterBA: update.gpxJunctionAfterBA,
  }));
}

function resolutionForAnchor(resolutions, chapterSlug, direction, passageIndex) {
  return resolutions.anchors.get(`${chapterSlug}:${direction}:${passageIndex}`) ?? null;
}

async function runGpxAnchorPreparation({
  adapter,
  controlledHints = null,
  fetchMediaBytes,
  resolutions = emptyResolutions(),
  apply = false,
  generatedAt = new Date().toISOString(),
}) {
  const report = {
    version: 1,
    generatedAt,
    mode: apply ? 'apply' : 'dry-run',
    algorithmVersion: 'gpx-anchor-v1',
    ...(controlledHints ? { controlledHintSource: controlledHints.source } : {}),
    summary: {},
    chapters: [],
    errors: [],
  };
  const chapters = [...await adapter.listChapters()].sort((first, second) => (
    Number(first.displayOrder) - Number(second.displayOrder)
  ));
  if (chapters.length === 0) {
    report.errors.push({ message: 'Aucun chapitre brouillon n’est disponible.' });
  }
  const sources = new Map();
  const resolvedAnchors = new Map();

  for (const chapter of chapters) {
    const chapterReport = {
      documentId: chapter.documentId,
      slug: chapter.slug,
      title: chapter.title,
      displayOrder: chapter.displayOrder,
      status: 'blocked',
      directions: {},
      junctions: {},
    };
    report.chapters.push(chapterReport);
    try {
      if (!chapter.documentId || !chapter.slug || !Number.isInteger(chapter.displayOrder)) {
        throw new Error('Le chapitre doit exposer documentId, slug et displayOrder.');
      }
      if (!Array.isArray(chapter.cityPassages) || chapter.cityPassages.length < 2) {
        throw new Error('Le chapitre doit contenir au moins deux passages de ville.');
      }
      let abReferences = null;

      for (const direction of ['AB', 'BA']) {
        const media = direction === 'AB' ? chapter.gpxFileAB : chapter.gpxFileBA;
        if (!media?.url) throw new Error(`Le média GPX ${direction} est absent.`);
        const bytes = await fetchMediaBytes(media, chapter, direction);
        const source = parseOfficialGpxBytes(bytes);
        sources.set(`${chapter.slug}:${direction}`, source);
        if (controlledHints && direction === 'AB') {
          const controlledSource = controlledHints.sources.get(chapter.slug);
          if (!controlledSource) {
            throw new Error(`Le chapitre ${chapter.slug} est absent du référentiel GPX contrôlé.`);
          }
          if (controlledSource.sourceSha256 !== source.sourceSha256) {
            throw new Error(`Le GPX AB de ${chapter.slug} ne correspond plus au référentiel contrôlé.`);
          }
        }
        const orderedPassages = chapter.cityPassages.map((passage, passageIndex) => {
          const municipalityKey = String(passage.city?.municipalityKey ?? '').trim();
          const isBoundary = passageIndex === 0
            || passageIndex === chapter.cityPassages.length - 1;
          const controlledHint = controlledHints?.anchors.get(
            `${chapter.slug}:${municipalityKey}`
          ) ?? null;
          if (controlledHints && !isBoundary && !controlledHint) {
            throw new Error(
              `Le passage ${chapter.slug}:${passageIndex} n’a pas de chaînage AB contrôlé.`
            );
          }
          const prepared = {
            passageIndex,
            city: passage.city,
          };
          if (!isBoundary && controlledHint && direction === 'AB') {
            prepared.chainageHintMetres = controlledHint.abChainageMetres;
          }
          if (!isBoundary && controlledHint && direction === 'BA') {
            const referencePoint = abReferences?.get(passageIndex);
            if (!referencePoint) {
              throw new Error(
                `Le passage ${chapter.slug}:${passageIndex} n’a pas de référence AB relue.`
              );
            }
            prepared.referencePoint = referencePoint;
          }
          return prepared;
        });
        if (direction === 'BA') orderedPassages.reverse();
        const proposal = proposeOrderedAnchors({ source, passages: orderedPassages });
        if (direction === 'AB') {
          abReferences = new Map(proposal.anchors.map((anchor) => [
            anchor.passageIndex,
            {
              latitude: anchor.projectedLatitude,
              longitude: anchor.projectedLongitude,
            },
          ]));
        }
        const resolvedByPassage = new Map();
        const outcomes = [];

        for (const proposedAnchor of proposal.anchors) {
          const passage = chapter.cityPassages[proposedAnchor.passageIndex];
          const controlledHint = controlledHints?.anchors.get(
            `${chapter.slug}:${String(passage.city?.municipalityKey ?? '').trim()}`
          ) ?? null;
          const existing = direction === 'AB' ? passage.gpxAnchorAB : passage.gpxAnchorBA;
          const resolution = resolutionForAnchor(
            resolutions,
            chapter.slug,
            direction,
            proposedAnchor.passageIndex
          );
          const resolved = resolveAnchor({
            chapterSlug: chapter.slug,
            direction,
            proposal: proposedAnchor,
            existing,
            resolution,
          });
          resolvedByPassage.set(proposedAnchor.passageIndex, resolved.stored);
          outcomes.push({
            passageIndex: proposedAnchor.passageIndex,
            cityName: proposedAnchor.cityName,
            candidateKey: proposedAnchor.candidateKey,
            distanceToCityMetres: proposedAnchor.distanceToCityMetres,
            ambiguityReasons: proposedAnchor.ambiguityReasons,
            outcome: resolved.outcome,
            candidates: proposedAnchor.candidates,
            ...(controlledHint ? { controlledHint } : {}),
          });
        }
        chapterReport.directions[direction] = {
          sourceSha256: proposal.sourceSha256,
          pointCount: proposal.pointCount,
          distanceMetres: proposal.distanceMetres,
          anchors: outcomes,
        };
        resolvedAnchors.set(`${chapter.slug}:${direction}`, resolvedByPassage);
      }
      chapterReport.status = 'ready';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push({ chapterSlug: chapter.slug ?? null, message });
      chapterReport.error = message;
    }
  }

  const readyReports = report.chapters.filter((chapter) => chapter.status === 'ready');
  if (readyReports.length === chapters.length && chapters.length > 0) {
    for (let index = 0; index < chapters.length; index += 1) {
      const chapter = chapters[index];
      const chapterReport = report.chapters[index];
      for (const direction of ['AB', 'BA']) {
        const nextIndex = direction === 'AB'
          ? (index + 1) % chapters.length
          : (index - 1 + chapters.length) % chapters.length;
        const source = sources.get(`${chapter.slug}:${direction}`);
        const nextSource = sources.get(`${chapters[nextIndex].slug}:${direction}`);
        const existing = direction === 'AB'
          ? chapter.gpxJunctionAfterAB
          : chapter.gpxJunctionAfterBA;
        const resolution = resolutions.junctions.get(`${chapter.slug}:${direction}`) ?? null;
        const resolved = resolveJunction({
          chapterSlug: chapter.slug,
          direction,
          source,
          nextSource,
          existing,
          resolution,
        });
        chapterReport.junctions[direction] = resolved;
      }

      const anchorsAB = resolvedAnchors.get(`${chapter.slug}:AB`);
      const anchorsBA = resolvedAnchors.get(`${chapter.slug}:BA`);
      const update = {
        cityPassages: chapter.cityPassages.map((passage, passageIndex) => (
          passageForWrite(passage, anchorsAB.get(passageIndex), anchorsBA.get(passageIndex))
        )),
        gpxJunctionAfterAB: chapterReport.junctions.AB.stored,
        gpxJunctionAfterBA: chapterReport.junctions.BA.stored,
      };
      chapterReport.before = {
        cityPassages: chapter.cityPassages.map((passage) => ({
          gpxAnchorAB: passage.gpxAnchorAB ?? null,
          gpxAnchorBA: passage.gpxAnchorBA ?? null,
        })),
        gpxJunctionAfterAB: chapter.gpxJunctionAfterAB ?? null,
        gpxJunctionAfterBA: chapter.gpxJunctionAfterBA ?? null,
      };
      chapterReport.changed = !sameBuilderState(chapter, update);
      chapterReport.update = update;
    }
  }

  if (apply && report.errors.length === 0) {
    for (let index = 0; index < chapters.length; index += 1) {
      const chapterReport = report.chapters[index];
      if (!chapterReport.changed) {
        chapterReport.status = 'unchanged';
        continue;
      }
      try {
        await adapter.updateChapter(chapters[index].documentId, chapterReport.update);
        chapterReport.status = 'updated';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        chapterReport.status = 'blocked';
        report.errors.push({ chapterSlug: chapters[index].slug, message });
      }
    }
  } else if (report.errors.length === 0) {
    report.chapters.forEach((chapter) => {
      chapter.status = chapter.changed ? 'ready' : 'unchanged';
    });
  }

  report.summary = {
    chapters: report.chapters.length,
    ready: report.chapters.filter((chapter) => chapter.status === 'ready').length,
    updated: report.chapters.filter((chapter) => chapter.status === 'updated').length,
    unchanged: report.chapters.filter((chapter) => chapter.status === 'unchanged').length,
    blocked: report.chapters.filter((chapter) => chapter.status === 'blocked').length,
    proposedAnchors: report.chapters.flatMap((chapter) => (
      ['AB', 'BA'].flatMap((direction) => chapter.directions[direction]?.anchors ?? [])
    )).filter((anchor) => anchor.outcome.startsWith('proposed')).length,
    staleAnchors: report.chapters.flatMap((chapter) => (
      ['AB', 'BA'].flatMap((direction) => chapter.directions[direction]?.anchors ?? [])
    )).filter((anchor) => anchor.outcome.startsWith('stale')).length,
    errors: report.errors.length,
  };
  return report;
}

function configuredMediaOrigins(baseUrl) {
  const values = [
    ...DEFAULT_MEDIA_ORIGINS,
    baseUrl,
    process.env.AWS_CDN_URL,
    ...(process.env.STRAPI_MEDIA_ORIGINS ?? '').split(','),
  ]
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean);
  try {
    return new Set(values.map((value) => new URL(value).origin));
  } catch {
    throw new Error('La configuration des origines de médias GPX est invalide.');
  }
}

async function readResponseBytesWithLimit(response, maximumBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error('Le média GPX dépasse 5 Mio.');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new Error('Le média GPX dépasse 5 Mio.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchOfficialMediaBytes(media) {
  const baseUrl = process.env.STRAPI_PUBLIC_URL
    || process.env.URL
    || 'http://127.0.0.1:1337';
  let baseOrigin;
  try {
    baseOrigin = new URL(baseUrl).origin;
  } catch {
    throw new Error('L’URL publique Strapi est invalide.');
  }
  const url = new URL(media.url, `${baseOrigin}/`);
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username || url.password
    || !configuredMediaOrigins(baseUrl).has(url.origin)
  ) {
    throw new Error('L’origine du média GPX n’est pas autorisée.');
  }
  const response = await fetch(url, {
    headers: { Accept: 'application/gpx+xml, application/xml, text/xml, */*' },
    redirect: 'error',
    signal: AbortSignal.timeout(GPX_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Le média GPX répond avec le statut ${response.status}.`);
  if (response.url && new URL(response.url).origin !== url.origin) {
    throw new Error('Le média GPX a changé d’origine pendant le téléchargement.');
  }
  return readResponseBytesWithLimit(response, MAXIMUM_GPX_BYTES);
}

function createStrapiAdapter(strapi) {
  const chapters = strapi.documents('api::chapter.chapter');
  return {
    listChapters: () => chapters.findMany({
      status: 'draft',
      fields: ['documentId', 'slug', 'title', 'displayOrder'],
      populate: {
        gpxFileAB: { fields: ['url', 'documentId', 'name', 'size', 'updatedAt'] },
        gpxFileBA: { fields: ['url', 'documentId', 'name', 'size', 'updatedAt'] },
        gpxJunctionAfterAB: true,
        gpxJunctionAfterBA: true,
        cityPassages: {
          populate: {
            city: {
              fields: ['documentId', 'name', 'municipalityKey', 'latitude', 'longitude'],
            },
            gpxAnchorAB: true,
            gpxAnchorBA: true,
          },
        },
      },
      pagination: { start: 0, limit: 100 },
    }),
    updateChapter: (documentId, data) => chapters.update({
      documentId,
      status: 'draft',
      data,
    }),
  };
}

function writeReport(reportPath, report) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function printHelp() {
  console.log(`Préparation des ancrages GPX du Builder ville à ville

Usage : npm run prepare:gpx-anchors -- [options]

Options :
  --report <fichier>       Rapport JSON (défaut : .tmp/gpx-anchor-report.json)
  --resolutions <fichier>  Décisions relues au format JSON v1
  --cities <fichier>       CSV contrôlé des villes et premiers chaînages AB
  --chapters <fichier>     CSV contrôlé des chapitres et empreintes AB
  --apply                  Met à jour uniquement les brouillons de chapitre
  --confirm-apply          Confirmation obligatoire avec --apply
  --remote                 Lit l’accès PostgreSQL DIRECT avec la CLI Clever
  --clever-app <app>       Application Clever source (défaut : gthdf-cms)
  --allow-self-signed-tls  Accepte le certificat auto-signé de l’endpoint DIRECT
  --confirm-remote         Confirmation supplémentaire pour --remote --apply
  --dry-run                Force le mode lecture seule, valeur par défaut
  --help                   Affiche cette aide

Le script ne publie aucun chapitre et ne modifie pas le coupe-circuit public.`);
}

function warnAboutTlsException(options, logger = console) {
  if (!options.remote || !options.allowSelfSignedTls) return;
  logger.warn(
    'AVERTISSEMENT : le certificat auto-signé de l’endpoint PostgreSQL DIRECT '
    + 'est accepté explicitement ; la vérification de son autorité est désactivée pour cette exécution.'
  );
}

async function main(argv = process.argv.slice(2)) {
  const options = parseAnchorPreparationArguments(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  if (options.remote) {
    warnAboutTlsException(options);
    const target = configureCleverRemoteDatabaseEnvironment({
      allowSelfSignedTls: options.allowSelfSignedTls,
      cleverApp: options.cleverApp,
    });
    console.log(`Base distante ciblée : ${target.host} / ${target.database}`);
  }
  const resolutions = loadAnchorResolutions(options.resolutionsPath);
  const controlledHints = loadControlledAnchorHints(
    options.citiesPath,
    options.chaptersPath
  );
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  let report;
  try {
    report = await runGpxAnchorPreparation({
      adapter: createStrapiAdapter(app),
      controlledHints,
      fetchMediaBytes: fetchOfficialMediaBytes,
      resolutions,
      apply: options.apply,
    });
  } finally {
    await app.destroy();
  }
  writeReport(options.reportPath, report);
  console.log(JSON.stringify({
    mode: report.mode,
    reportPath: options.reportPath,
    summary: report.summary,
  }, null, 2));
  return report.summary.errors > 0 ? 2 : 0;
}

module.exports = {
  configuredMediaOrigins,
  createStrapiAdapter,
  emptyResolutions,
  fetchOfficialMediaBytes,
  loadAnchorResolutions,
  loadControlledAnchorHints,
  parseAnchorPreparationArguments,
  resolveAnchor,
  resolveJunction,
  runGpxAnchorPreparation,
  warnAboutTlsException,
  writeReport,
};

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
