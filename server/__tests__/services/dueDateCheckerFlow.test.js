jest.mock('../../models/Task', () => ({ find: jest.fn(), findById: jest.fn(), collection: { updateOne: jest.fn(), findOne: jest.fn() } }));
jest.mock('../../models/Contact', () => ({ find: jest.fn(), findById: jest.fn(), collection: { updateOne: jest.fn(), findOne: jest.fn() } }));
jest.mock('../../models/User', () => ({ find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })) }));
jest.mock('../../services/notificationService', () => ({ createNotification: jest.fn(async () => ({})) }));
/**
 * dueDateChecker — tok jedného behu s mockovanými modelmi: stav pripomienok
 * sa zapisuje cielene (arrayFilters, nie celé pole) a PRED odoslaním; keď
 * zápis zlyhá, notifikácia sa neodošle (inak by chodila každých 5 min).
 * lastUrgencyLevel 'overdue' → ranné okno 06:00 nepridá urgency notifikácie.
 */
const Task = require('../../models/Task');
const Contact = require('../../models/Contact');
const notificationService = require('../../services/notificationService');
const { checkDueDates } = require('../../services/dueDateChecker');

const chain = (docs) => {
  const q = { lean: () => q, batchSize: () => q, maxTimeMS: () => q, cursor: () => ({ async *[Symbol.asyncIterator]() { for (const d of docs) yield d; } }) };
  return q;
};
const uid = '64b000000000000000000001';
const soon = () => {
  const d = new Date(Date.now() + 10 * 60 * 1000);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bratislava', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  return { dueDate: `${g('year')}-${g('month')}-${g('day')}`, dueTime: `${g('hour')}:${g('minute')}` };
};

test('time reminder: cielený zápis pred odoslaním; zlyhanie zápisu = bez odoslania', async () => {
  const s = soon();
  const task = { _id: 'T1', title: 'Úloha', completed: false, createdBy: uid, assignedTo: [], workspaceId: 'W',
    subtasks: [{ id: 'sub-1', title: 'Pod', completed: false, ...s, lastUrgencyLevel: 'overdue', timeReminders: [15], timeRemindersSent: [] }] };
  Task.find.mockReturnValue(chain([task]));
  Contact.find.mockReturnValue(chain([{ _id: 'C1', name: 'K', userId: uid, workspaceId: 'W',
    tasks: [{ id: 'ct-1', title: 'KÚ', completed: false, ...s, lastUrgencyLevel: 'overdue', timeReminders: [15], timeRemindersSent: null }] }]));
  Task.collection.updateOne.mockResolvedValue({ modifiedCount: 1 });
  Contact.collection.updateOne.mockRejectedValue(new Error('boom'));
  const User = require('../../models/User');
  User.find.mockImplementation(() => ({ select: () => ({ lean: async () => [{ _id: uid }] }) }));

  await checkDueDates();
  const [filter, update, options] = Task.collection.updateOne.mock.calls[0];
  expect(filter).toEqual({ _id: 'T1' });
  expect(update).toEqual({ $addToSet: { 'subtasks.$[n0].timeRemindersSent': { $each: [15] } } });
  expect(options).toEqual({ arrayFilters: [{ 'n0.id': 'sub-1' }] });
  const [, cUpdate] = Contact.collection.updateOne.mock.calls[0];
  expect(cUpdate).toEqual({ $set: { 'tasks.$[n0].timeRemindersSent': [15] } });
  // Úloha: 1 notifikácia; kontakt: zápis zlyhal → žiadna
  expect(notificationService.createNotification).toHaveBeenCalledTimes(1);
  expect(notificationService.createNotification.mock.calls[0][0].data.subtaskId).toBe('sub-1');
});
