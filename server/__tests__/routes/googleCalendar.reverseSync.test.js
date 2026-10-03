process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-minimum-32-characters-long-xxx';
const mongoose = require('mongoose');
const User = require('../../models/User');
const Task = require('../../models/Task');
const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');

/**
 * Spätná synchronizácia z Google Kalendára nesmie vracať CRM do starého stavu:
 *  - prvý beh bez syncTokenu (nový kanál, po 410) nič neaplikuje,
 *  - udalosť staršia než posledná zmena v CRM sa ignoruje,
 *  - úloha priradená iným sa z cudzieho kalendára nemení.
 */
const mockEventsList = jest.fn();
jest.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: jest.fn().mockImplementation(() => ({ setCredentials: jest.fn(), generateAuthUrl: jest.fn() })) },
    calendar: jest.fn().mockReturnValue({ events: { list: (...a) => mockEventsList(...a) } }),
    tasks: jest.fn().mockReturnValue({})
  }
}));

describe('Google Calendar — poistky spätnej synchronizácie', () => {
  let processCalendarChanges, user, ws, task;
  const HOUR = 60 * 60 * 1000;

  beforeAll(async () => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3001/api/google-calendar/callback';
    ({ _processCalendarChanges: processCalendarChanges } = require('../../routes/googleCalendar'));
    await User.init(); await Task.init(); await Workspace.init(); await WorkspaceMember.init();
  });

  beforeEach(async () => {
    mockEventsList.mockReset();
    user = await User.create({ username: 'gcal', email: 'gcal@test.com', password: 'x', subscription: { plan: 'pro' } });
    ws = await Workspace.create({ name: 'Firma', slug: `firma-${Date.now()}`, ownerId: user._id });
    await WorkspaceMember.create({ workspaceId: ws._id, userId: user._id, role: 'owner' });
    task = await Task.create({
      workspaceId: ws._id, userId: user._id, title: 'Projekt', completed: false,
      dueDate: '2026-10-10', modifiedAt: new Date(Date.now() - 2 * HOUR).toISOString()
    });
    await User.updateOne({ _id: user._id }, { $set: {
      'googleCalendar.enabled': true,
      'googleCalendar.accessToken': 'at',
      'googleCalendar.refreshToken': 'rt',
      'googleCalendar.tokenExpiry': new Date(Date.now() + 24 * HOUR),
      'googleCalendar.calendarId': 'primary',
      [`googleCalendar.syncedTaskIds.${task._id}`]: 'evt-1'
    } });
    user = await User.findById(user._id);
  });

  const event = (over = {}) => ({
    id: 'evt-1', status: 'confirmed', summary: 'Projekt (z Google)',
    start: { date: '2026-10-20' }, updated: new Date().toISOString(),
    extendedProperties: { private: { completed: 'true' } }, ...over
  });

  it('prvý beh bez syncTokenu nič neaplikuje, len uloží token', async () => {
    mockEventsList.mockResolvedValue({ data: { items: [event()], nextSyncToken: 'tok-1' } });
    await processCalendarChanges(user);
    const t = await Task.findById(task._id).lean();
    expect(t.completed).toBe(false);
    expect(t.dueDate).toBe('2026-10-10');
    expect(t.title).toBe('Projekt');
    expect((await User.findById(user._id).lean()).googleCalendar.syncToken).toBe('tok-1');
  });

  it('novšia zmena z Google sa prevezme; staršia než zmena v CRM nie', async () => {
    user.googleCalendar.syncToken = 'tok-1';
    await user.save();
    mockEventsList.mockResolvedValueOnce({ data: { items: [event({ updated: new Date(Date.now() - 3 * HOUR).toISOString() })], nextSyncToken: 'tok-2' } });
    await processCalendarChanges(user);
    expect((await Task.findById(task._id).lean()).completed).toBe(false); // zastaraná udalosť

    mockEventsList.mockResolvedValueOnce({ data: { items: [event()], nextSyncToken: 'tok-3' } });
    await processCalendarChanges(user);
    const t = await Task.findById(task._id).lean();
    expect(t.completed).toBe(true);
    expect(t.dueDate).toBe('2026-10-20');
  });

  it('po 410 (expirovaný syncToken) sa novšia zmena z Google aplikuje, nezahodí', async () => {
    user.googleCalendar.syncToken = 'tok-old';
    await user.save();
    mockEventsList
      .mockRejectedValueOnce(Object.assign(new Error('Gone'), { code: 410 }))
      .mockResolvedValueOnce({ data: { items: [event()], nextSyncToken: 'tok-new' } });
    await processCalendarChanges(user);
    const t = await Task.findById(task._id).lean();
    expect(t.completed).toBe(true);
    expect((await User.findById(user._id).lean()).googleCalendar.syncToken).toBe('tok-new');
  });

  it('úloha kontaktu bez modifiedAt — zmena inej úlohy toho istého kontaktu nezablokuje zmenu z Google', async () => {
    const Contact = require('../../models/Contact');
    const contact = await Contact.create({
      workspaceId: ws._id, userId: user._id, name: 'Klient',
      tasks: [
        { id: 'ct-a', title: 'A', dueDate: '2026-10-10', createdAt: new Date(Date.now() - 5 * HOUR).toISOString() },
        { id: 'ct-b', title: 'B', dueDate: '2026-10-10', createdAt: new Date(Date.now() - 5 * HOUR).toISOString() }
      ]
    });
    await Contact.updateOne({ _id: contact._id }, { $set: { 'tasks.$[].modifiedAt': null } });
    await User.updateOne({ _id: user._id }, { $set: {
      'googleCalendar.syncToken': 'tok-1',
      'googleCalendar.syncedTaskIds.ct-a': 'evt-a',
      'googleCalendar.syncedTaskIds.ct-b': 'evt-b'
    } });
    user = await User.findById(user._id);
    const editedAt = new Date(Date.now() - HOUR).toISOString();
    mockEventsList.mockResolvedValue({ data: { nextSyncToken: 'tok-2', items: [
      event({ id: 'evt-a', summary: 'A', start: { date: '2026-10-12' }, updated: editedAt, extendedProperties: { private: { completed: 'false' } } }),
      event({ id: 'evt-b', summary: 'B', start: { date: '2026-10-13' }, updated: editedAt, extendedProperties: { private: { completed: 'false' } } })
    ] } });
    await processCalendarChanges(user);
    const c = await Contact.findById(contact._id).lean();
    expect(c.tasks.find(t => t.id === 'ct-a').dueDate).toBe('2026-10-12');
    expect(c.tasks.find(t => t.id === 'ct-b').dueDate).toBe('2026-10-13');
  });

  it('úloha priradená inému sa z tohto kalendára nemení', async () => {
    await Task.updateOne({ _id: task._id }, { $set: { assignedTo: [new mongoose.Types.ObjectId()] } });
    user.googleCalendar.syncToken = 'tok-1';
    await user.save();
    mockEventsList.mockResolvedValue({ data: { items: [event()], nextSyncToken: 'tok-2' } });
    await processCalendarChanges(user);
    expect((await Task.findById(task._id).lean()).completed).toBe(false);
  });
});
