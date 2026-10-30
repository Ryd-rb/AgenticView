import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldPath, fieldValue, configurationSchema, configureCollection, matches, resolveConfiguration } from '../shared/component-config.ts';
import { gridDataSchema, evaluatePrecedence, coerceGridChanges, validateGridRow, cellRules } from '../shared/grid-config.ts';

test('manual settings fail closed on authority and prototype paths', () => {
  for (const path of ['configuration.manualFields', 'configuration.context', 'kind', 'id', 'data.__proto__.polluted', 'data.constructor.x', 'data..value', 'data.a.b.c.d.e.f.g.h']) {
    assert.equal(configurationSchema.safeParse({ manualFields: [path] }).success, false, path);
  }
  assert.equal(configurationSchema.safeParse({ manualFields: ['data.options', 'configuration.presentation', 'configuration.rules'] }).success, true);
  assert.equal(fieldPath.safeParse('constructor').success, false);
  assert.equal(fieldValue(Object.create({ hidden: 1 }), 'hidden'), undefined);
  assert.equal(fieldValue({ item: { present: false } }, 'item.present'), false);
});

test('configuration rules merge in declared order and collection transforms preserve source order and data', () => {
  const configuration = configurationSchema.parse({ context: { mode: 'inspect' }, presentation: { color: '#abcdef', fontSize: 14 }, rules: [
    { when: { all: [{ field: 'data.count', op: 'gt', value: 2 }] }, effect: { label: 'Many', presentation: { emphasis: 'bold' } } },
    { when: { all: [{ field: 'context.mode', op: 'eq', value: 'inspect' }] }, effect: { label: 'Inspect', presentation: { color: '#123456' } } },
  ] });
  const resolved = resolveConfiguration(configuration, { count: 3 });
  assert.equal(resolved.label, 'Inspect'); assert.deepEqual(resolved.presentation, { color: '#123456', fontSize: 14, emphasis: 'bold' });
  assert.equal(configuration.presentation?.color, '#abcdef');
  const data = { items: [{ id: 'a', n: 2 }, { id: 'b', n: 1 }, { id: 'c', n: 2 }], retained: 7 }, before = JSON.stringify(data);
  const output = configureCollection(data, { collection: { field: 'items', sortBy: 'n', descending: true, limit: 2 } });
  assert.deepEqual(output.items.map(item => item.id), ['a', 'c']); assert.equal(output.retained, 7); assert.equal(JSON.stringify(data), before);
  assert.equal(matches({ all: [{ field: 'n', op: 'gt', value: 2 }] }, { n: '3' }), false, 'conditions must not coerce string storage');
});

const columns = ['key', 'machine', 'user', 'tenant'].map(key => ({ key, label: key }));
test('partial and empty precedence context cannot declare different unresolved targets overridden', () => {
  for (const context of [undefined, {}, { tenant: 'example' }, { machine: '' }]) {
    const data = gridDataSchema.parse({ columns, precedence: { groupBy: ['key'], dimensions: ['machine', 'user'], context } });
    const result = evaluatePrecedence(data, [{ key: 'timeout', machine: 'A', user: 'alice' }, { key: 'timeout', machine: 'B', user: '' }]);
    assert.deepEqual(result.map(row => row.state), ['conflict', 'conflict'], JSON.stringify(context));
  }
  const configured = gridDataSchema.parse({ columns, precedence: { groupBy: ['key'], dimensions: ['machine', 'user'], context: { machine: 'A', user: 'alice' } } });
  const result = evaluatePrecedence(configured, [{ key: 'timeout', machine: '', user: '' }, { key: 'timeout', machine: 'A', user: '' }, { key: 'timeout', machine: '', user: 'alice' }, { key: 'timeout', machine: 'B', user: '' }]);
  assert.deepEqual(result.map(row => row.state), ['overridden', 'active', 'overridden', 'ineligible']);
});

test('compound grid keys must be nonempty, unique and refer to declared columns', () => {
  for (const keyColumns of [[], ['key', 'key'], ['missing']]) assert.equal(gridDataSchema.safeParse({ columns, keyColumns }).success, false, JSON.stringify(keyColumns));
  assert.equal(gridDataSchema.safeParse({ columns, keyColumns: ['key', 'machine'] }).success, true);
});

test('strict typed string storage validates numeric and boolean values and retains storage representation', () => {
  const data = gridDataSchema.parse({ columns: [
    { key: 'count', label: 'Count', constraints: { storage: 'string', type: 'integer', required: true, min: 0, max: 10 } },
    { key: 'flag', label: 'Flag', constraints: { storage: 'string', type: 'boolean', required: true } },
    { key: 'name', label: 'Name', constraints: { type: 'string', required: true } },
  ] });
  assert.deepEqual(validateGridRow(data, { count: '2', flag: 'false', name: 'sample' }), []);
  for (const row of [ { count: '2x', flag: 'false', name: 'sample' }, { count: 2, flag: 'false', name: 'sample' }, { count: '2.5', flag: 'false', name: 'sample' }, { count: '2', flag: 'FALSE', name: 'sample' }, { count: '2', flag: 'false', name: false } ]) assert.ok(validateGridRow(data, row).length > 0, JSON.stringify(row));
  assert.deepEqual(coerceGridChanges(data, { count: '2', flag: 'false', name: 'sample' }, { count: '3', flag: 'true' }), { count: '3', flag: 'true', name: 'sample' });
});

test('conditional grid constraints use full draft and later matching rules win', () => {
  const data = gridDataSchema.parse({ columns: [{ key: 'mode', label: 'Mode' }, { key: 'value', label: 'Value', constraints: { type: 'number' } }], rules: [
    { id: 'base', column: 'value', when: { all: [{ field: 'mode', op: 'eq', value: 'bounded' }] }, constraints: { min: 2, max: 20 }, tooltip: 'Base' },
    { id: 'narrow', column: 'value', when: { all: [{ field: 'mode', op: 'eq', value: 'bounded' }] }, constraints: { max: 5 }, tooltip: 'Narrow' },
  ] });
  assert.throws(() => coerceGridChanges(data, { mode: 'open', value: 1 }, { mode: 'bounded', value: '8' }), /outside allowed numeric range/);
  assert.deepEqual(coerceGridChanges(data, { mode: 'open', value: 1 }, { mode: 'bounded', value: '4' }), { mode: 'bounded', value: 4 });
  assert.deepEqual(cellRules(data, { mode: 'bounded', value: 4 }, 'value').matched, ['base', 'narrow']);
  assert.equal(cellRules(data, { mode: 'bounded', value: 4 }, 'value').tooltip, 'Narrow');
});
