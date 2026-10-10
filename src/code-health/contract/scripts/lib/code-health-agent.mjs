// Closed v1 validation and lossless qualitative aggregation for agent evidence.
// Summaries are intentionally short, sanitized paraphrases. Mechanical checks cannot prove
// that a person removed copied code or transcript text, so callers must review source content.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, validateSchema } from './code-health-schema.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const schema = JSON.parse(fs.readFileSync(path.join(here, '../../docs/code-health-agent-v1.schema.json'), 'utf8'));

const dimensions = ['locate', 'understand', 'verify'];
const attemptId = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const repoOwner = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const repoName = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,97}[A-Za-z0-9])?$/;
const taskId = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const unsafeSummary = /(?:https?|file|ssh|ftp):\/\/|(?:^|\s)(?:~\/|\/(?:Users|home|private|tmp|var)\/|[A-Za-z]:\\)|(?:^|\s)[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|`{1,3}/iu;
const identity = (record) => canonical([record.repo_owner, record.repo_name, record.task_id]);
const occurrenceKey = (record) => canonical([record.repo_owner, record.repo_name, record.task_id, record.occurrence_id]);
const attemptKey = (record) => canonical([record.repo_owner, record.repo_name, record.task_id, record.attempt_id]);
const identityMatches = (a, b) => a.repo_owner === b.repo_owner && a.repo_name === b.repo_name && a.task_id === b.task_id;
const ratingMap = (record) => new Map((Array.isArray(record?.ratings) ? record.ratings : []).map((rating) => [rating.dimension, rating]));

function semanticRecordErrors(record, label = 'record') {
  const errors = [];
  if (record?.supersedes_record_id === record?.record_id && record?.supersedes_record_id !== null) {
    errors.push(`${label}.supersedes_record_id cannot refer to itself`);
  }
  if ((record?.supersedes_record_id === null) !== (record?.correction_ref === null)) {
    errors.push(`${label}.supersedes_record_id and correction_ref must be non-null together`);
  }
  if (record?.record_kind === 'observation' && typeof record.summary === 'string' && unsafeSummary.test(record.summary)) {
    errors.push(`${label}.summary contains a locator or code delimiter; use a sanitized paraphrase`);
  }
  if (record?.record_kind === 'observation' && record.record_id === record.occurrence_id) {
    errors.push(`${label}.occurrence_id must be distinct from record_id`);
  }
  if (record?.record_kind !== 'assessment') return errors;

  const ratings = Array.isArray(record.ratings) ? record.ratings : [];
  const byDimension = ratingMap(record);
  if (ratings.length === 3 && (byDimension.size !== 3 || dimensions.some((dimension) => !byDimension.has(dimension))))
    errors.push(`${label}.ratings must contain exactly one rating for each dimension`);

  if (record.task_class === 'qa' && record.applicability !== 'not_applicable') {
    errors.push(`${label} QA assessments must be not_applicable`);
  }
  if (record.applicability === 'not_applicable') {
    if (ratings.some((rating) => rating.value !== 'not-assessable' || rating.reason !== 'not_applicable' || (rating.evidence_refs?.length ?? 0) !== 0)) {
      errors.push(`${label} not_applicable assessments must mark every dimension not-assessable with reason not_applicable and no evidence`);
    }
  } else {
    if (ratings.some((rating) => rating.reason === 'not_applicable')) {
      errors.push(`${label} applicable assessments cannot use the not_applicable reason`);
    }
    for (const rating of ratings) {
      if (rating.reason === 'grounded') {
        if (rating.value === 'not-assessable') errors.push(`${label}.${rating.dimension} grounded ratings need an assessable value`);
        const resolved = record.__resolvedObservations;
        const hasDimensionObservation = resolved instanceof Map && (record.observation_refs ?? []).some((ref) =>
          resolved.get(ref)?.dimension === rating.dimension
        );
        if ((rating.evidence_refs?.length ?? 0) === 0 && resolved instanceof Map && !hasDimensionObservation) {
          errors.push(`${label}.${rating.dimension} grounded rating needs evidence_refs or a matching observation_ref`);
        }
      } else if (rating.value !== 'not-assessable') {
        errors.push(`${label}.${rating.dimension} non-grounded ratings must be not-assessable`);
      }
      if (rating.reason === 'environment_unavailable' && record.environment !== 'unavailable') {
        errors.push(`${label}.${rating.dimension} cites unavailable environment when assessment.environment is not unavailable`);
      }
      if (rating.reason === 'insufficient_evidence' && rating.value !== 'not-assessable') {
        errors.push(`${label}.${rating.dimension} insufficient_evidence must be not-assessable`);
      }
    }
    const verify = byDimension.get('verify');
    if (record.environment === 'unavailable' && verify
      && (verify.value !== 'not-assessable' || verify.reason !== 'environment_unavailable')) {
      errors.push(`${label}.verify must be not-assessable for unavailable environments`);
    }
  }
  if (record.outcome !== 'completed' && record.completeness === 'complete') {
    errors.push(`${label} partial, failed, or aborted outcomes cannot have complete assessments`);
  }
  if (record.parent_attempt_id === record.attempt_id) errors.push(`${label}.parent_attempt_id cannot be its own attempt_id`);
  if (record.child_attempt_ids?.includes(record.attempt_id)) errors.push(`${label}.child_attempt_ids cannot include its own attempt_id`);
  return errors;
}

function assertBatchShape(records) {
  if (!Array.isArray(records)) return ['records must be an array'];
  const errors = [];
  records.forEach((record, index) => {
    const label = `records[${index}]`;
    errors.push(...validateSchema(schema, record).map((error) => `${label}${error.slice(1)}`));
    errors.push(...semanticRecordErrors(record, label));
  });
  return errors;
}

function uniquePayloads(records, errors) {
  const byId = new Map();
  const unique = [];
  for (const [index, record] of records.entries()) {
    const prior = byId.get(record.record_id);
    if (prior) {
      if (canonical(prior) !== canonical(record)) errors.push(`records[${index}] reuses record_id ${record.record_id} with a different payload`);
      continue;
    }
    byId.set(record.record_id, record);
    unique.push(record);
  }
  return { unique, byId };
}

function batchSemanticErrors(unique, byId) {
  const errors = [];
  const observations = unique.filter((record) => record.record_kind === 'observation');
  const assessments = unique.filter((record) => record.record_kind === 'assessment');

  const taskClasses = new Map();
  const attempts = new Map();
  for (const record of unique) {
    const taskKey = identity(record);
    const priorClass = taskClasses.get(taskKey);
    if (priorClass && priorClass !== record.task_class) errors.push(`task ${record.task_id} has inconsistent task_class values`);
    taskClasses.set(taskKey, record.task_class);

    const key = attemptKey(record);
    const priorParent = attempts.get(key);
    if (priorParent !== undefined && priorParent !== record.parent_attempt_id) {
      errors.push(`attempt ${record.attempt_id} has inconsistent parent_attempt_id values`);
    } else attempts.set(key, record.parent_attempt_id);
  }

  const parentOf = new Map();
  for (const record of unique) {
    if (record.parent_attempt_id === null) continue;
    const key = attemptKey(record);
    const prior = parentOf.get(key);
    if (prior && prior !== record.parent_attempt_id) errors.push(`attempt ${record.attempt_id} has conflicting ancestry`);
    parentOf.set(key, record.parent_attempt_id);
  }
  const visiting = new Set();
  const visited = new Set();
  function visitAttempt(key) {
    if (visiting.has(key)) { errors.push('attempt parent references contain a cycle'); return; }
    if (visited.has(key)) return;
    visiting.add(key);
    const record = unique.find((candidate) => attemptKey(candidate) === key);
    if (record?.parent_attempt_id !== null && record?.parent_attempt_id !== undefined) {
      const parentKey = canonical([record.repo_owner, record.repo_name, record.task_id, record.parent_attempt_id]);
      if (parentOf.has(parentKey)) visitAttempt(parentKey);
    }
    visiting.delete(key);
    visited.add(key);
  }
  for (const key of parentOf.keys()) visitAttempt(key);

  const lineageEdges = new Map();
  const addLineageEdge = (from, to) => {
    if (!lineageEdges.has(from)) lineageEdges.set(from, new Set());
    lineageEdges.get(from).add(to);
  };
  for (const record of observations) {
    const sourceRef = record.source_observation_ref;
    if ((record.reporter.kind === 'parent' || record.reporter.kind === 'close') && sourceRef === null) {
      errors.push(`observation ${record.record_id} from ${record.reporter.kind} must reference a source observation`);
    }
    if (sourceRef === null) continue;
    const source = byId.get(sourceRef);
    if (!source || source.record_kind !== 'observation') {
      errors.push(`observation ${record.record_id} source_observation_ref does not resolve to an observation in this batch`);
      continue;
    }
    if (!identityMatches(record, source) || source.occurrence_id !== record.occurrence_id) {
      errors.push(`observation ${record.record_id} source must match repo, task, and occurrence`);
    }
    if (Date.parse(record.observed_at) < Date.parse(source.observed_at)) {
      errors.push(`observation ${record.record_id} predates its source observation`);
    }
    if ((record.reporter.kind === 'parent' || record.reporter.kind === 'close')
      && canonical(record.actual_worker) !== canonical(source.actual_worker)) {
      errors.push(`observation ${record.record_id} actual_worker must match its source observation`);
    }
    addLineageEdge(record.record_id, source.record_id);
  }

  for (const assessment of assessments) {
    const resolved = new Map();
    for (const ref of assessment.observation_refs) {
      const observation = byId.get(ref);
      if (!observation || observation.record_kind !== 'observation') {
        errors.push(`assessment ${assessment.record_id} observation_refs must resolve to observations in this batch`);
        continue;
      }
      if (!identityMatches(assessment, observation)) {
        errors.push(`assessment ${assessment.record_id} observation_refs must match repo and task`);
        continue;
      }
      resolved.set(ref, observation);
    }
    // The rubric check can use resolved refs without adding internal fields to public records.
    errors.push(...semanticRecordErrors({ ...assessment, __resolvedObservations: resolved }, `assessment ${assessment.record_id}`));

    for (const childAttemptId of assessment.child_attempt_ids) {
      const childRecords = unique.filter((record) => identityMatches(assessment, record) && record.attempt_id === childAttemptId);
      if (childRecords.some((child) => child.parent_attempt_id !== assessment.attempt_id)) {
        errors.push(`assessment ${assessment.record_id} child ${childAttemptId} has inconsistent parent_attempt_id`);
      }
    }
  }
  for (const record of unique) {
    if (record.parent_attempt_id === null) continue;
    const parents = assessments.filter((candidate) => identityMatches(record, candidate) && candidate.attempt_id === record.parent_attempt_id);
    if (parents.some((parent) => !parent.child_attempt_ids.includes(record.attempt_id))) {
      errors.push(`attempt ${record.attempt_id} is missing from its in-batch parent assessment child_attempt_ids`);
    }
  }

  for (const record of unique) {
    if (record.supersedes_record_id === null) continue;
    const target = byId.get(record.supersedes_record_id);
    if (!target) {
      errors.push(`correction ${record.correction_ref} target ${record.supersedes_record_id} is absent from the supplied validation context`);
      continue;
    }
    if (record.record_kind !== target.record_kind) {
      errors.push(`correction ${record.correction_ref} target must have the same record_kind`);
    }
    if (!identityMatches(record, target) || record.attempt_id !== target.attempt_id) {
      errors.push(`correction ${record.correction_ref} target must match repo, task, and attempt`);
    }
    if (record.record_kind === 'observation' && record.occurrence_id !== target.occurrence_id) {
      errors.push(`correction ${record.correction_ref} target observation must match occurrence`);
    }
    if (Date.parse(record.observed_at) < Date.parse(target.observed_at)) {
      errors.push(`correction ${record.correction_ref} predates its superseded record`);
    }
    addLineageEdge(record.record_id, target.record_id);
  }
  const lineageVisiting = new Set();
  const lineageVisited = new Set();
  function visitLineage(recordId) {
    if (lineageVisiting.has(recordId)) { errors.push('source and correction references contain a cycle'); return; }
    if (lineageVisited.has(recordId)) return;
    lineageVisiting.add(recordId);
    for (const targetId of lineageEdges.get(recordId) ?? []) visitLineage(targetId);
    lineageVisiting.delete(recordId);
    lineageVisited.add(recordId);
  }
  for (const recordId of lineageEdges.keys()) visitLineage(recordId);
  return errors;
}

export function validateRecord(record) {
  const errors = assertBatchShape([record]);
  if (errors.length) throw new TypeError(`invalid code-health agent record:\n${errors.join('\n')}`);
  return record;
}

export function validateRecords(records, { contextRecords = [] } = {}) {
  if (!Array.isArray(contextRecords)) throw new TypeError('contextRecords must be an array');
  const errors = assertBatchShape(records);
  if (errors.length) throw new TypeError(`invalid code-health agent records:\n${errors.join('\n')}`);
  errors.push(...assertBatchShape(contextRecords).map((error) => `validation context: ${error}`));
  if (errors.length) throw new TypeError(`invalid code-health agent records:\n${errors.join('\n')}`);
  const { unique, byId } = uniquePayloads(records, errors);
  const { unique: uniqueContext } = uniquePayloads(contextRecords, errors);
  const allUnique = [...unique];
  const allById = new Map(byId);
  for (const contextRecord of uniqueContext) {
    const prior = allById.get(contextRecord.record_id);
    if (prior) {
      if (canonical(prior) !== canonical(contextRecord)) {
        errors.push(`validation context reuses record_id ${contextRecord.record_id} with a different payload`);
      }
      continue;
    }
    allById.set(contextRecord.record_id, contextRecord);
    allUnique.push(contextRecord);
  }
  errors.push(...batchSemanticErrors(allUnique, allById));
  if (errors.length) throw new TypeError(`invalid code-health agent records:\n${errors.join('\n')}`);
  return records;
}

function occurrenceVariant(record) {
  return canonical({ dimension: record.dimension, polarity: record.polarity, cause: record.cause });
}

function checkExpectedAttempts(expectedAttempts) {
  if (expectedAttempts === null) return null;
  if (!Array.isArray(expectedAttempts)) throw new TypeError('expectedAttempts must be null or an array of identity tuples');
  const keys = new Set();
  const checked = expectedAttempts.map((entry, index) => {
    const fields = ['repo_owner', 'repo_name', 'task_id', 'attempt_id'];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
      || canonical(Object.keys(entry).sort()) !== canonical([...fields].sort())) {
      throw new TypeError(`expectedAttempts[${index}] must contain exactly ${fields.join(', ')}`);
    }
    if (!fields.every(field => typeof entry[field] === 'string')
      || !repoOwner.test(entry.repo_owner) || !repoName.test(entry.repo_name)
      || !taskId.test(entry.task_id) || !attemptId.test(entry.attempt_id)) {
      throw new TypeError(`expectedAttempts[${index}] contains an unsafe identity value`);
    }
    const tuple = { repo_owner: entry.repo_owner, repo_name: entry.repo_name, task_id: entry.task_id, attempt_id: entry.attempt_id };
    const key = attemptKey(tuple);
    if (keys.has(key)) throw new TypeError('expectedAttempts must be unique by complete repo/task/attempt identity');
    keys.add(key);
    return tuple;
  });
  return checked;
}

export function aggregateRecords(records, { expectedAttempts = null, contextRecords = [] } = {}) {
  validateRecords(records, { contextRecords });
  const expected = checkExpectedAttempts(expectedAttempts);
  const seenIds = new Set();
  const unique = [];
  let replayCount = 0;
  for (const record of records) {
    if (seenIds.has(record.record_id)) { replayCount += 1; continue; }
    seenIds.add(record.record_id);
    unique.push(record);
  }

  const groups = new Map();
  const assessments = [];
  for (const record of unique) {
    if (record.record_kind === 'assessment') {
      assessments.push(record);
      continue;
    }
    const key = occurrenceKey(record);
    let group = groups.get(key);
    if (!group) {
      group = {
        repo_owner: record.repo_owner,
        repo_name: record.repo_name,
        task_id: record.task_id,
        occurrence_id: record.occurrence_id,
        conflict: false,
        variants: [],
        records: []
      };
      groups.set(key, group);
    }
    group.records.push(record);
    const variant = occurrenceVariant(record);
    if (!group.variants.includes(variant)) group.variants.push(variant);
    group.conflict = group.variants.length > 1;
  }

  const assessmentAttempts = new Map();
  for (const record of assessments) {
    const key = attemptKey(record);
    let group = assessmentAttempts.get(key);
    if (!group) {
      group = {
        repo_owner: record.repo_owner,
        repo_name: record.repo_name,
        task_id: record.task_id,
        attempt_id: record.attempt_id,
        applicable: false,
        not_applicable: false,
        applicability_conflict: false,
        rating_conflict: false,
        rating_variants: [],
        records: []
      };
      assessmentAttempts.set(key, group);
    }
    group.records.push(record);
    if (record.applicability === 'applicable') group.applicable = true;
    else group.not_applicable = true;
    group.applicability_conflict = group.applicable && group.not_applicable;
    const ratings = canonical([...record.ratings].sort((a, b) => dimensions.indexOf(a.dimension) - dimensions.indexOf(b.dimension)));
    if (!group.rating_variants.includes(ratings)) group.rating_variants.push(ratings);
    group.rating_conflict = group.rating_variants.length > 1;
  }
  const eligibleGroups = [...assessmentAttempts.values()].filter((group) => group.applicable && !group.not_applicable);
  const eligibleByKey = new Map(eligibleGroups.map((group) => [attemptKey(group), group]));
  if (expected !== null) {
    for (const tuple of expected) {
      const group = assessmentAttempts.get(attemptKey(tuple));
      if (group?.not_applicable) {
        throw new TypeError(`expected eligible attempt ${tuple.task_id}/${tuple.attempt_id} is known not_applicable`);
      }
    }
  }
  const coveredAttempts = expected === null
    ? eligibleGroups.map(({ repo_owner, repo_name, task_id, attempt_id }) => ({ repo_owner, repo_name, task_id, attempt_id }))
    : expected.filter((tuple) => eligibleByKey.has(attemptKey(tuple)));
  const denominator = expected === null ? null : expected.length;
  const numerator = coveredAttempts.length;
  const fraction = denominator === null || denominator === 0 ? null : numerator / denominator;
  return {
    occurrences: [...groups.values()],
    assessments,
    assessment_attempts: [...assessmentAttempts.values()],
    assessment_coverage: {
      expected_attempts: expected,
      assessed_eligible_attempts: coveredAttempts,
      numerator,
      denominator,
      fraction
    },
    replay_count: replayCount
  };
}
