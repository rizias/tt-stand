import { accumulator, expression, group, windowFields } from './expressions.ts';
import { filter } from './filters.ts';
import {
  alternatives,
  array,
  boolean,
  emptyDocument,
  fields,
  integer,
  invalid,
  literal,
  namedOperator,
  nonemptyString,
  number,
  object,
  oneOf,
  sort,
  string,
  strings,
  values,
  type Fields,
  type Rule,
} from './validation.ts';

export function pipeline(value: unknown, path: string): void {
  array((stage, stagePath) => namedOperator(stage, stagePath, STAGES))(value, path);
}

const lookup: Rule = (value, path) => {
  fields(
    {
      from: alternatives(nonemptyString, fields({ db: nonemptyString, coll: nonemptyString }, ['db', 'coll'])),
      localField: nonemptyString,
      foreignField: nonemptyString,
      as: nonemptyString,
      let: values(expression),
      pipeline,
    },
    ['as'],
  )(value, path);
  const document = object(value, path);
  if (Object.hasOwn(document, 'localField') !== Object.hasOwn(document, 'foreignField')) {
    invalid(path, 'localField и foreignField задаются вместе');
  }
  if (!Object.hasOwn(document, 'pipeline') && !Object.hasOwn(document, 'localField')) {
    invalid(path, 'нужен pipeline либо localField и foreignField');
  }
};

const unionWith: Rule = (value, path) => {
  if (typeof value === 'string') {
    nonemptyString(value, path);
    return;
  }
  fields({ coll: nonemptyString, pipeline })(value, path);
  const document = object(value, path);
  if (!Object.hasOwn(document, 'coll') && !Object.hasOwn(document, 'pipeline')) {
    invalid(path, 'нужен coll либо pipeline');
  }
};

const STAGES: Fields = {
  $match: filter,
  $project: values(expression),
  $set: values(expression),
  $addFields: values(expression),
  $unset: alternatives(nonemptyString, array(nonemptyString, 1)),
  $sort: sort,
  $limit: integer(1),
  $skip: integer(0),
  $count: nonemptyString,
  $group: group,
  $lookup: lookup,
  $facet: values(pipeline),
  $unionWith: unionWith,
  $unwind: alternatives(
    nonemptyString,
    fields(
      {
        path: nonemptyString,
        includeArrayIndex: nonemptyString,
        preserveNullAndEmptyArrays: boolean,
      },
      ['path'],
    ),
  ),
  $replaceRoot: fields({ newRoot: expression }, ['newRoot']),
  $replaceWith: expression,
  $sample: fields({ size: integer(1) }, ['size']),
  $sortByCount: expression,
  $bucket: fields(
    {
      groupBy: expression,
      boundaries: array(literal, 2),
      default: literal,
      output: values(accumulator),
    },
    ['groupBy', 'boundaries'],
  ),
  $bucketAuto: fields(
    {
      groupBy: expression,
      buckets: integer(1),
      output: values(accumulator),
      granularity: nonemptyString,
    },
    ['groupBy', 'buckets'],
  ),
  $geoNear: fields(
    {
      near: alternatives(
        array(number, 2, 2),
        fields({ type: oneOf('Point'), coordinates: array(number, 2, 2) }, ['type', 'coordinates']),
      ),
      distanceField: nonemptyString,
      spherical: boolean,
      query: filter,
      distanceMultiplier: number,
      maxDistance: number,
      minDistance: number,
      key: nonemptyString,
      includeLocs: nonemptyString,
      uniqueDocs: boolean,
    },
    ['near'],
  ),
  $graphLookup: fields(
    {
      from: nonemptyString,
      startWith: expression,
      connectFromField: nonemptyString,
      connectToField: nonemptyString,
      as: nonemptyString,
      maxDepth: integer(0),
      depthField: nonemptyString,
      restrictSearchWithMatch: filter,
    },
    ['from', 'startWith', 'connectFromField', 'connectToField', 'as'],
  ),
  $collStats: fields({
    latencyStats: fields({ histograms: boolean }),
    storageStats: fields({ scale: number }),
    count: emptyDocument,
    queryExecStats: emptyDocument,
  }),
  $indexStats: emptyDocument,
  $planCacheStats: emptyDocument,
  $currentOp: fields({
    allUsers: boolean,
    idleConnections: boolean,
    idleCursors: boolean,
    idleSessions: boolean,
    localOps: boolean,
    truncateOps: boolean,
  }),
  $listSessions: fields({ allUsers: boolean, users: array(fields({ user: string, db: string }, ['user', 'db'])) }),
  $listLocalSessions: fields({ allUsers: boolean, users: array(fields({ user: string, db: string }, ['user', 'db'])) }),
  $documents: expression,
  $redact: expression,
  $setWindowFields: windowFields,
  $densify: fields(
    {
      field: nonemptyString,
      partitionByFields: strings,
      range: fields(
        { step: number, bounds: alternatives(oneOf('full', 'partition'), array(literal, 2, 2)), unit: nonemptyString },
        ['step', 'bounds'],
      ),
    },
    ['field', 'range'],
  ),
  $fill: fields(
    {
      partitionBy: expression,
      partitionByFields: strings,
      sortBy: sort,
      output: values(
        alternatives(fields({ value: expression }, ['value']), fields({ method: oneOf('linear', 'locf') }, ['method'])),
      ),
    },
    ['output'],
  ),
  $vectorSearch: fields(
    {
      index: nonemptyString,
      path: nonemptyString,
      queryVector: array(number, 1),
      numCandidates: integer(1),
      limit: integer(1),
      filter,
      exact: boolean,
    },
    ['index', 'path', 'queryVector', 'limit'],
  ),
  $listSearchIndexes: fields({ name: nonemptyString, id: nonemptyString }),
};

export const PIPELINE_STAGE_NAMES = Object.freeze(Object.keys(STAGES));
