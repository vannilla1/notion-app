const {
  mapNodeChains,
  treeMissingIds,
  createNestedUpdate,
  reminderProjection,
  MAX_DEPTH
} = require('../../utils/nestedTaskUpdate');

/**
 * nestedTaskUpdate — cielené zápisy plánovača termínov do vnorených
 * podúloh (náhrada prepisu celého poľa zo zastaraného snapshotu).
 */
describe('nestedTaskUpdate', () => {
  const tree = [
    { id: 'a', title: 'A', subtasks: [{ id: 'a1', title: 'A1', subtasks: [] }] },
    { id: 'b', title: 'B' }
  ];

  it('mapNodeChains vráti reťaz id od koreňa pre každý uzol', () => {
    const chains = mapNodeChains(tree, 'subtasks');
    expect(chains.get(tree[0])).toEqual([{ arr: 'subtasks', id: 'a' }]);
    expect(chains.get(tree[0].subtasks[0])).toEqual([
      { arr: 'subtasks', id: 'a' },
      { arr: 'subtasks', id: 'a1' }
    ]);
    const contactChains = mapNodeChains([{ id: 't', subtasks: [{ id: 's' }] }], 'tasks');
    expect([...contactChains.values()][1]).toEqual([
      { arr: 'tasks', id: 't' },
      { arr: 'subtasks', id: 's' }
    ]);
  });

  it('treeMissingIds odhalí uzol bez id aj vo vnorenej úrovni', () => {
    expect(treeMissingIds(tree)).toBe(false);
    expect(treeMissingIds([{ id: 'x', subtasks: [{ title: 'bez id' }] }])).toBe(true);
    expect(treeMissingIds(undefined)).toBe(false);
  });

  it('createNestedUpdate skladá cesty cez arrayFilters a zdieľa identifikátory', () => {
    const chains = mapNodeChains(tree, 'subtasks');
    const marks = createNestedUpdate();
    expect(marks.isEmpty()).toBe(true);
    marks.set([], 'lastUrgencyLevel', 'danger');
    marks.set(chains.get(tree[0]), 'reminderSent', true);
    marks.set(chains.get(tree[0].subtasks[0]), 'lastUrgencyLevel', 'overdue');
    marks.addToSet(chains.get(tree[0].subtasks[0]), 'timeRemindersSent', [15], []);
    marks.addToSet(chains.get(tree[0].subtasks[0]), 'timeRemindersSent', [60, 15], []);

    const { update, options } = marks.build();
    expect(update.$set).toEqual({
      lastUrgencyLevel: 'danger',
      'subtasks.$[n0].reminderSent': true,
      'subtasks.$[n0].subtasks.$[n1].lastUrgencyLevel': 'overdue'
    });
    expect(update.$addToSet).toEqual({
      'subtasks.$[n0].subtasks.$[n1].timeRemindersSent': { $each: [15, 60] }
    });
    expect(options.arrayFilters).toEqual([{ 'n0.id': 'a' }, { 'n1.id': 'a1' }]);
  });

  it('addToSet nad null poľom (legacy) použije $set, aby update nezlyhal', () => {
    const marks = createNestedUpdate();
    marks.addToSet([{ arr: 'tasks', id: 't' }], 'timeRemindersSent', [30], null);
    const { update } = marks.build();
    expect(update.$set).toEqual({ 'tasks.$[n0].timeRemindersSent': [30] });
    expect(update.$addToSet).toBeUndefined();
  });

  it('bez arrayFilters vráti prázdne options (len koreňové polia)', () => {
    const marks = createNestedUpdate();
    marks.set([], 'reminderSent', true);
    expect(marks.build().options).toEqual({});
  });

  it('reminderProjection pokrýva všetky úrovne a nenačíta súbory ani popis', () => {
    const projection = reminderProjection('tasks.');
    expect(projection['tasks.dueDate']).toBe(1);
    expect(projection[`tasks.${'subtasks.'.repeat(MAX_DEPTH)}timeRemindersSent`]).toBe(1);
    expect(Object.keys(projection).some((k) => /files|description/.test(k))).toBe(false);
  });
});
