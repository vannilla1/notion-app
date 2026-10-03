const { withServerSubtaskFiles, countSubtaskNodes } = require('../../utils/subtaskFiles');

/**
 * PUT úlohy nesmie prevziať files[] podúloh z tela požiadavky — inak sa dá
 * podstrčiť cudzie fileId (a potom ho stiahnuť/zmazať) a klientska kópia bez
 * `data` by prepísala serverovú prílohu uloženú v base64 fallbacku.
 */
describe('withServerSubtaskFiles', () => {
  const serverFile = { id: 'f-own', originalName: 'fotka.jpg', size: 10, data: 'BASE64' };
  const existing = [
    { id: 's1', title: 'A', files: [serverFile], subtasks: [{ id: 's1a', title: 'A1', files: [{ id: 'f-deep' }] }] },
    { id: 's2', title: 'B', files: [] }
  ];

  it('ignoruje files[] z požiadavky a berie serverové podľa ID', () => {
    const incoming = [
      { id: 's1', title: 'A (upravené)', files: [{ id: 'f-foreign' }], subtasks: [{ id: 's1a', title: 'A1', files: [] }] },
      { id: 's2', title: 'B', files: [{ id: 'f-injected' }] }
    ];
    const out = withServerSubtaskFiles(incoming, existing);
    expect(out[0].title).toBe('A (upravené)');
    expect(out[0].files).toEqual([serverFile]);         // vrátane data
    expect(out[0].subtasks[0].files).toEqual([{ id: 'f-deep' }]);
    expect(out[1].files).toEqual([]);                    // podstrčené fileId zahodené
  });

  it('presun podúlohy pod iného rodiča zachová jej prílohy', () => {
    const incoming = [
      { id: 's2', title: 'B', subtasks: [{ id: 's1a', title: 'A1 presunutá' }] },
      { id: 's1', title: 'A' }
    ];
    const out = withServerSubtaskFiles(incoming, existing);
    expect(out[0].subtasks[0].files).toEqual([{ id: 'f-deep' }]);
    expect(out[1].files).toEqual([serverFile]);
  });

  it('nová podúloha začína bez príloh, aj keď klient nejaké pošle', () => {
    const out = withServerSubtaskFiles([{ id: 'new', title: 'N', files: [{ id: 'f-x' }] }], existing);
    expect(out[0].files).toEqual([]);
  });

  it('objekt namiesto poľa (top-level aj vnorený) nepodstrčí files[]', () => {
    const planted = { id: 'p1', title: 'x', files: [{ id: 'f-victim' }] };
    // top-level objekt → ignoruje sa, ostáva serverový strom
    expect(withServerSubtaskFiles(planted, existing)).toBe(existing);
    // array-like objekt
    expect(withServerSubtaskFiles({ 0: planted, length: 1 }, existing)).toBe(existing);
    // vnorený objekt → nahradí sa prázdnym poľom
    const out = withServerSubtaskFiles([{ id: 's1', subtasks: planted }], existing);
    expect(out[0].subtasks).toEqual([]);
    expect(JSON.stringify(out)).not.toMatch(/f-victim/);
  });

  it('funguje s Mongoose subdokumentmi (toObject) a prázdnymi vstupmi', () => {
    const sub = { toObject: () => ({ id: 's9', files: [{ id: 'f9' }] }) };
    expect(withServerSubtaskFiles([{ id: 's9' }], [sub])[0].files).toEqual([{ id: 'f9' }]);
    expect(withServerSubtaskFiles(undefined, existing)).toBe(existing);
    expect(withServerSubtaskFiles([], existing)).toEqual([]);
    expect(withServerSubtaskFiles([{ id: 's1' }], undefined)[0].files).toEqual([]);
  });

  it('stav pripomienok, copiedFrom a createdAt berie zo servera; pri zmene termínu ich vynuluje', () => {
    const server = [{
      id: 'r1', title: 'R', dueDate: '2026-10-10', dueTime: '10:00',
      reminderSent: true, timeRemindersSent: [15], createdAt: '2026-01-01T00:00:00.000Z',
      copiedFrom: { contactId: 'c1', taskId: 't1' }
    }];
    const same = withServerSubtaskFiles([{ id: 'r1', title: 'R', dueDate: '2026-10-10', dueTime: '10:00', reminderSent: false, timeRemindersSent: [], createdAt: 'x', copiedFrom: { contactId: 'evil' } }], server);
    expect(same[0].timeRemindersSent).toEqual([15]);
    expect(same[0].createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(same[0].copiedFrom).toEqual({ contactId: 'c1', taskId: 't1' });
    const moved = withServerSubtaskFiles([{ id: 'r1', title: 'R', dueDate: '2026-10-11', dueTime: '10:00' }], server);
    expect(moved[0].timeRemindersSent).toEqual([]);
  });

  it('whitelist polí, typy a limity', () => {
    const out = withServerSubtaskFiles([{
      id: 'w1', title: 'x'.repeat(600), completed: 'ano', priority: 'urgent', dueTime: '25:99',
      assignedTo: ['507f1f77bcf86cd799439011', { $ne: 1 }, 'bad'], hacked: true
    }], []);
    expect(out[0].title.length).toBe(500);
    expect(out[0].completed).toBe(false);
    expect(out[0].priority).toBeNull();
    expect(out[0].dueTime).toBe('');
    expect(out[0].assignedTo).toEqual(['507f1f77bcf86cd799439011']);
    expect(out[0]).not.toHaveProperty('hacked');
  });

  it('duplicitné ID dostane nové a hĺbka stromu je obmedzená', () => {
    const dup = withServerSubtaskFiles([{ id: 'd1' }, { id: 'd1' }], []);
    expect(dup[0].id).toBe('d1');
    expect(dup[1].id).not.toBe('d1');
    let deep = { id: 'n0' };
    let cur = deep;
    for (let i = 1; i < 20; i++) { cur.subtasks = [{ id: `n${i}` }]; cur = cur.subtasks[0]; }
    expect(countSubtaskNodes(withServerSubtaskFiles([deep], []))).toBe(10);
  });
});
