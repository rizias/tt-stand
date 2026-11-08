import { expression } from './expressions.ts';
import { filter, projection } from './filters.ts';
import { pipeline } from './pipeline.ts';
import {
  alternatives,
  boolean,
  fields,
  falseOnly,
  hint,
  integer,
  invalid,
  literal,
  nonemptyString,
  number,
  object,
  oneOf,
  sort,
  string,
  values,
  type Fields,
} from './validation.ts';

const collation = fields(
  {
    locale: nonemptyString,
    caseLevel: boolean,
    caseFirst: oneOf('upper', 'lower', 'off'),
    strength: integer(1, 5),
    numericOrdering: boolean,
    alternate: oneOf('non-ignorable', 'shifted'),
    maxVariable: oneOf('punct', 'space'),
    backwards: boolean,
    normalization: boolean,
    version: string,
  },
  ['locale'],
);

const readConcern = fields({
  level: oneOf('local', 'available', 'majority', 'linearizable', 'snapshot'),
  afterClusterTime: fields({ $timestamp: fields({ t: integer(0), i: integer(0) }, ['t', 'i']) }, ['$timestamp']),
  atClusterTime: fields({ $timestamp: fields({ t: integer(0), i: integer(0) }, ['t', 'i']) }, ['$timestamp']),
});
const common: Fields = { comment: literal, maxTimeMS: integer(0) };
const reading: Fields = { ...common, readConcern, collation };
const cursor = fields({ batchSize: integer(0) });
const one = integer(1, 1);

interface CommandDefinition {
  readonly fields: Fields;
  readonly required?: readonly string[];
  readonly cursor?: boolean;
  readonly databaseMode: 'admin' | 'selected' | 'selected-or-admin';
}

const COMMANDS = {
  find: {
    fields: {
      ...reading,
      find: nonemptyString,
      filter,
      sort,
      projection,
      hint,
      skip: integer(0),
      limit: integer(0),
      batchSize: integer(0),
      singleBatch: boolean,
      min: values(literal),
      max: values(literal),
      returnKey: boolean,
      showRecordId: boolean,
      tailable: falseOnly,
      awaitData: falseOnly,
      oplogReplay: falseOnly,
      noCursorTimeout: boolean,
      allowPartialResults: boolean,
      allowDiskUse: boolean,
      let: values(expression),
    },
    cursor: true,
    databaseMode: 'selected',
  },
  aggregate: {
    fields: {
      ...reading,
      aggregate: alternatives(nonemptyString, one),
      pipeline,
      cursor,
      explain: boolean,
      allowDiskUse: boolean,
      allowPartialResults: boolean,
      hint,
      let: values(expression),
    },
    required: ['pipeline'],
    cursor: true,
    databaseMode: 'selected',
  },
  count: {
    fields: { ...reading, count: nonemptyString, query: filter, limit: integer(), skip: integer(0), hint },
    databaseMode: 'selected',
  },
  distinct: {
    fields: { ...reading, distinct: nonemptyString, key: nonemptyString, query: filter, hint },
    required: ['key'],
    databaseMode: 'selected',
  },
  listDatabases: {
    fields: { ...common, listDatabases: one, filter, nameOnly: boolean, authorizedDatabases: boolean },
    databaseMode: 'admin',
  },
  listCollections: {
    fields: { ...common, listCollections: one, filter, nameOnly: boolean, authorizedCollections: boolean, cursor },
    cursor: true,
    databaseMode: 'selected',
  },
  listIndexes: {
    fields: { ...common, listIndexes: nonemptyString, cursor, includeBuildUUIDs: boolean },
    cursor: true,
    databaseMode: 'selected',
  },
  collStats: {
    fields: { ...common, collStats: nonemptyString, scale: number },
    databaseMode: 'selected',
  },
  dbStats: {
    fields: { ...common, dbStats: one, scale: number, freeStorage: boolean },
    databaseMode: 'selected',
  },
  explain: {
    fields: {
      ...common,
      explain: (value, path) => {
        const name = validateCommand(value, path, true).name;
        if (!['find', 'aggregate', 'count', 'distinct'].includes(name)) {
          invalid(path, 'explain поддерживает find, aggregate, count и distinct');
        }
      },
      verbosity: oneOf('queryPlanner', 'executionStats', 'allPlansExecution'),
    },
    databaseMode: 'selected',
  },
  ping: { fields: { ping: one, ...common }, databaseMode: 'selected-or-admin' },
  hello: { fields: { hello: one, ...common }, databaseMode: 'selected-or-admin' },
  buildInfo: { fields: { buildInfo: one, ...common }, databaseMode: 'selected-or-admin' },
} as const satisfies Record<string, CommandDefinition>;

export type MongoCommandName = keyof typeof COMMANDS;
export const MONGO_COMMAND_NAMES = Object.freeze(Object.keys(COMMANDS) as MongoCommandName[]);

export interface ValidatedCommand {
  readonly name: MongoCommandName;
  readonly hasCursor: boolean;
  readonly databaseMode: CommandDefinition['databaseMode'];
}

export function validateCommand(value: unknown, path: string, explained = false): ValidatedCommand {
  const document = object(value, path);
  const first = Object.keys(document)[0];
  if (first === undefined || !Object.hasOwn(COMMANDS, first)) {
    invalid(path, `первая запись должна задавать читающую команду ${MONGO_COMMAND_NAMES.join(', ')}`);
  }
  const name = first as MongoCommandName;
  const definition: CommandDefinition = COMMANDS[name];
  fields(definition.fields, [name, ...(definition.required ?? [])])(document, path);
  const hasCursor = definition.cursor === true && document.explain !== true;
  if (name === 'aggregate' && hasCursor && !explained && !Object.hasOwn(document, 'cursor')) {
    invalid(`${path}.cursor`, 'задайте документ cursor для получения результата агрегации');
  }
  return { name, hasCursor, databaseMode: definition.databaseMode };
}
