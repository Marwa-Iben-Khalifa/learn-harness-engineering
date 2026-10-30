// The single feature-list format (version 1) and the importer for the legacy
// shapes used across the course: status/state/passes, each with its own values.

export const STATUSES = ['not_started', 'in_progress', 'blocked', 'passing'];

const LEGACY_STATUS = {
  not_started: 'not_started',
  'not-started': 'not_started',
  planned: 'not_started',
  in_progress: 'in_progress',
  'in-progress': 'in_progress',
  active: 'in_progress',
  fail: 'in_progress',
  failing: 'in_progress',
  blocked: 'blocked',
  pass: 'passing',
  passed: 'passing',
  passing: 'passing',
  done: 'passing'
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function legacyStatus(feature) {
  if (typeof feature.passes === 'boolean') {
    return feature.passes ? 'passing' : 'not_started';
  }
  const raw = feature.status ?? feature.state;
  if (raw === undefined) return 'not_started';
  const status = LEGACY_STATUS[String(raw).toLowerCase()];
  if (!status) throw new Error(`Feature ${feature.id}: unknown status "${raw}"`);
  return status;
}

function legacyVerify(feature, defaultCmd) {
  const layers = feature.verify ?? feature.layers;
  if (Array.isArray(layers)) {
    return layers
      .filter((layer) => layer && layer.cmd)
      .map(({ label, cmd, repair }) => ({ label: label || cmd, cmd, ...(repair ? { repair } : {}) }));
  }
  return defaultCmd ? [{ label: 'default', cmd: defaultCmd }] : [];
}

function legacyManual(feature) {
  if (Array.isArray(feature.manual)) return feature.manual;
  if (Array.isArray(feature.verification)) return feature.verification;
  return typeof feature.verification === 'string' ? [feature.verification] : [];
}

function normalizeFeature(feature, defaultCmd) {
  const normalized = {
    id: feature.id,
    title: feature.title ?? feature.name ?? feature.description ?? feature.id,
    description: feature.description ?? feature.user_visible_behavior ?? feature.behavior ?? '',
    status: legacyStatus(feature),
    verify: legacyVerify(feature, defaultCmd),
    manual: legacyManual(feature)
  };
  if (Array.isArray(feature.dependencies)) normalized.dependencies = feature.dependencies;
  if (Array.isArray(feature.paths)) normalized.paths = feature.paths;
  if (feature.notes) normalized.notes = feature.notes;
  const claim = feature.claimed_evidence ?? feature.evidence;
  if (claim && claim.length > 0) normalized.claimed_evidence = claim;
  return normalized;
}

export function isCurrentFormat(raw) {
  return !Array.isArray(raw) && raw?.version === 1;
}

export function normalizeList(raw, { defaultCmd } = {}) {
  const features = Array.isArray(raw) ? raw : raw?.features;
  if (!Array.isArray(features)) {
    throw new Error('Feature list must be an array or an object with a "features" array');
  }
  const list = { version: 1, features: features.map((f) => normalizeFeature(f, defaultCmd)) };
  const errors = validateList(list);
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return list;
}

export function validateList(list) {
  const errors = [];
  if (list?.version !== 1) errors.push('version must be 1');
  if (!Array.isArray(list?.features)) return [...errors, 'features must be an array'];

  const seen = new Set();
  for (const [index, feature] of list.features.entries()) {
    const where = feature?.id ?? `features[${index}]`;
    if (typeof feature?.id !== 'string' || !SAFE_ID.test(feature.id)) {
      errors.push(`${where}: id must match ${SAFE_ID}`);
    }
    if (seen.has(feature?.id)) errors.push(`${where}: duplicate id`);
    seen.add(feature?.id);
    if (!STATUSES.includes(feature?.status)) errors.push(`${where}: invalid status "${feature?.status}"`);
    if (!Array.isArray(feature?.verify)) {
      errors.push(`${where}: verify must be an array`);
      continue;
    }
    for (const layer of feature.verify) {
      if (!layer?.label || !layer?.cmd) errors.push(`${where}: each verify entry needs label and cmd`);
    }
  }
  return errors;
}
